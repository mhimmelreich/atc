// filepath: src/game/GameEngine.ts
import type { Airport, Runway } from '@/types/airport';
import type { Aircraft, ATCCommand, ConflictPair, TrailPoint } from '@/types/aircraft';
import type { LiveAircraft, LiveInbound, LiveStatus, TrafficMode } from '@/types/live';
import type { Waypoint, STAR } from '@/types/navdata';
import type { RadioMessage } from '@/types/radio';
import type { Weather } from '@/types/weather';
import { AircraftManager } from './AircraftManager';
import { inbound, callsIn, liveToAircraft, liveId, hexOf, landingRunway, type Inbound, type TakeoverContext } from './LiveTraffic';
import { RadarRenderer, DEFAULT_DISPLAY, type DisplayOptions, type RenderOptions } from './RadarRenderer';
import { Scene3DRenderer, DEFAULT_CAMERA, PITCH_MIN, PITCH_MAX, type Camera3D } from './Scene3DRenderer';
import { headingDiff } from '@/utils/aviation';
import { pad3 } from './Speech';
import { destinationPoint, distanceNM } from '@/utils/geo';
import { SCORE_LANDING, SCORE_GOAROUND, SCORE_SEPARATION_VIOLATION, SCORE_COLLISION } from './constants';

const RADIO_LOG_SIZE = 50;
const LIVE_TRAIL_MAX = 20;
const LIVE_EXTRAPOLATE_MAX_S = 30;
// Landerichtung aus dem Wind: erst ab etwas Wind; umgestellt wird erst bei mehr als 2 kt Rückenwind (Gegenrichtung)
const WIND_MIN_KT = 3;
const WIND_SWITCH_KT = 4;
// Landerichtung aus dem echten Verkehr: Landungen der letzten 10 Minuten je Richtung
const LIVE_FINALS_MEMORY_MS = 10 * 60_000;
const LIVE_FINALS_SWITCH = 2;
// Bahnen gleicher Betriebsrichtung (Parallelbahnen)
const SAME_DIRECTION_DEG = 20;

/** Woher die aktiven Bahnen kommen: Standard, Wind (METAR), echte Landungen (LIVE) oder von Hand */
export type RunwaySource = 'default' | 'wind' | 'live' | 'manual';

export interface GameState {
  score: number;
  landings: number;
  violations: number;
  aircraft: Aircraft[];
  conflicts: ConflictPair[];
  selectedId: string | null;
  paused: boolean;
  timeScale: number;
  sweepEnabled: boolean;
  rangeNM: number;
  trailLength: number;
  /** aircraftId → queued command types not yet executed (reaction delay) */
  pendingCmdTypes: Record<string, string[]>;
  display: DisplayOptions;
  /** Active landing runway IDs — only these runways' ILS is available (empty = all) */
  activeRunwayIds: string[];
  /** Letzte Funkmeldungen, älteste zuerst */
  radio: RadioMessage[];
  trafficMode: TrafficMode;
  live: LiveStatus;
  /** Rufzeichen der echten Flieger (für Warnungen) */
  liveNames: Record<string, string>;
  /** Wetter am Platz (METAR), null solange unbekannt */
  weather: Weather | null;
  runwaySource: RunwaySource;
}

export { type DisplayOptions };

type StateCallback = (state: GameState) => void;

export interface SessionData {
  icao: string;
  savedAt: number;
  score: number;
  landings: number;
  violations: number;
  rangeNM: number;
  trailLength: number;
  sweepEnabled: boolean;
  timeScale: number;
  display: DisplayOptions;
  activeRunwayIds: string[];
  runwaySource?: RunwaySource;
  trafficMode?: TrafficMode;
  /** Übernommene echte Flieger: ihr echtes Gegenstück bleibt ausgeblendet */
  liveHexes?: string[];
  viewLat: number;
  viewLng: number;
  aircraft: import('@/types/aircraft').Aircraft[];
  pendingCommands: Array<{ id: string; cmd: import('@/types/aircraft').ATCCommand; remainingMs: number }>;
}

export class GameEngine {
  private manager: AircraftManager;
  private renderer: RadarRenderer | null = null;
  private scene3d: Scene3DRenderer | null = null;
  /** 3D-Ansicht statt Radar; Kamera dreht und neigt sich um den Blickpunkt */
  view3D = false;
  camera: Camera3D = { ...DEFAULT_CAMERA };
  airport: Airport | null = null;        // public for hit-test in RadarCanvas
  viewLat = 0;                           // public: view centre (pan target)
  viewLng = 0;
  private currentIcao = '';
  private previewHdg: { aircraftId: string; targetHdg: number; direction?: 'left' | 'right' } | null = null;
  private previewAlt: { aircraftId: string; targetAlt: number } | null = null;
  private waypoints: Waypoint[] = [];
  private stars: STAR[] = [];
  private conflicts: ConflictPair[] = [];
  private state: GameState = {
    score: 0, landings: 0, violations: 0,
    aircraft: [], conflicts: [],
    selectedId: null, paused: false, timeScale: 1,
    sweepEnabled: false, rangeNM: 80, trailLength: 6,
    pendingCmdTypes: {},
    display: { ...DEFAULT_DISPLAY },
    activeRunwayIds: [],
    radio: [],
    trafficMode: 'sim',
    live: { count: 0, inbound: 0, updatedAt: null, error: false },
    liveNames: {},
    weather: null,
    runwaySource: 'default',
  };
  get rangeNM(): number { return this.state.rangeNM; }
  private onStateChange: StateCallback;
  private rafId: number | null = null;
  private lastTs: number | null = null;
  private conflictCooldowns = new Set<string>();
  private liveTraffic: LiveAircraft[] = [];
  private liveTrails = new Map<string, TrailPoint[]>();
  private liveInbound = new Map<string, Inbound>(); // hex → Anflug zum gewählten Platz
  private takenOver = new Set<string>();             // hex der übernommenen echten Flieger
  private liveFrame: LiveAircraft[] = [];            // echte Flieger im letzten Bild (für Klicks)
  private liveFinals = new Map<string, { heading: number; at: number }>(); // hex → Bahnkurs, zuletzt im Endanflug gesehen

  constructor(onStateChange: StateCallback) {
    this.onStateChange = onStateChange;
    this.manager = new AircraftManager();

    this.manager.on((event) => {
      switch (event.type) {
        case 'landing':
          this.state = { ...this.state, score: this.state.score + SCORE_LANDING, landings: this.state.landings + 1 };
          break;
        case 'goaround':
          this.state = { ...this.state, score: this.state.score + SCORE_GOAROUND };
          break;
        case 'conflict': {
          const key = [event.pair!.a, event.pair!.b].sort().join(':');
          if (!this.conflictCooldowns.has(key)) {
            this.conflictCooldowns.add(key);
            const penalty = event.pair!.type === 'conflict' ? SCORE_COLLISION : SCORE_SEPARATION_VIOLATION;
            this.state = { ...this.state, score: this.state.score + penalty, violations: this.state.violations + 1 };
            setTimeout(() => this.conflictCooldowns.delete(key), 10000);
          }
          this.conflicts = [...this.conflicts.filter((c) => !samePair(c, event.pair!)), event.pair!];
          break;
        }
        case 'warning':
          this.conflicts = [...this.conflicts.filter((c) => !samePair(c, event.pair!)), event.pair!];
          break;
        case 'clear':
          if (event.pair) this.conflicts = this.conflicts.filter((c) => !samePair(c, event.pair!));
          break;
        case 'radio':
          this.state = { ...this.state, radio: [...this.state.radio.slice(1 - RADIO_LOG_SIZE), event.message!] };
          break;
      }
    });
  }

  attachCanvas(canvas: HTMLCanvasElement): void {
    this.renderer = new RadarRenderer(canvas);
    this.scene3d = new Scene3DRenderer(canvas);
  }

  resizeCanvas(w: number, h: number): void {
    this.renderer?.resize(w, h);
    this.scene3d?.resize(w, h);
  }

  setAirport(airport: Airport, waypoints: Waypoint[], stars: STAR[] = []): void {
    this.currentIcao = airport.icao;
    this.airport = airport;
    this.waypoints = waypoints;
    this.stars = stars;
    this.viewLat = airport.lat;
    this.viewLng = airport.lng;
    this.manager.setAirport(airport, stars);
    // Default: all ILS landing runways of the primary direction (lowest heading group)
    const ilsRunways = airport.runways.filter((r) => r.ils && r.role !== 'departure');
    const activeRunwayIds = ilsRunways.length > 0
      ? this.pickPrimaryDirection(ilsRunways).map((r) => r.id)
      : [];
    this.state = { ...this.state, activeRunwayIds, radio: [], weather: null, runwaySource: 'default' };
    this.manager.setSpawnStars(this.activeStars());
    this.clearLive();
    this.liveFinals.clear();
    if (this.state.trafficMode === 'sim') for (let i = 0; i < 3; i++) this.manager.forceSpawn();
  }

  /** SIM: erfundener Verkehr; LIVE: echte Flieger (adsb.lol), kein erfundener Verkehr, Echtzeit */
  setTrafficMode(mode: TrafficMode): void {
    if (mode === this.state.trafficMode) return;
    this.state = { ...this.state, trafficMode: mode, selectedId: null, timeScale: mode === 'live' ? 1 : this.state.timeScale };
    this.manager.setSpawning(mode === 'sim');
    this.manager.clearTraffic();
    this.clearLive();
    this.liveFinals.clear();
    if (mode === 'sim' && this.airport) for (let i = 0; i < 3; i++) this.manager.forceSpawn();
    this.trySave();
  }

  setLiveTraffic(list: LiveAircraft[]): void {
    if (this.state.trafficMode !== 'live') return;
    this.liveTraffic = list;
    // Spur aus den gemeldeten Positionen
    const trails = new Map<string, TrailPoint[]>();
    for (const ac of list) {
      if (ac.ground) continue;
      const trail = this.liveTrails.get(ac.hex) ?? [];
      const last = trail[trail.length - 1];
      trails.set(ac.hex, !last || last.ts < ac.ts ? [...trail, { lat: ac.lat, lng: ac.lng, ts: ac.ts }].slice(-LIVE_TRAIL_MAX) : trail);
    }
    this.liveTrails = trails;
    this.detectRunwayInUse(list);

    // Anflüge zum gewählten Platz; zwischen 40 und 15 NM melden sie sich (nächster zuerst)
    this.liveInbound.clear();
    const calls: Array<{ ac: LiveAircraft; dist: number }> = [];
    const airport = this.airport;
    if (airport) {
      for (const ac of list) {
        const inb = this.takenOver.has(ac.hex) ? null : inbound(ac, airport);
        if (!inb) continue;
        this.liveInbound.set(ac.hex, inb);
        if (callsIn(ac, inb, airport)) calls.push({ ac, dist: distanceNM(ac.lat, ac.lng, airport.lat, airport.lng) });
      }
      calls.sort((a, b) => a.dist - b.dist);
      const ctx = this.takeoverContext(airport);
      this.manager.setAnnouncements(calls.map(({ ac }) => liveToAircraft(ac, ctx, this.liveInbound.get(ac.hex)?.origin)));
    }

    const liveNames: Record<string, string> = {};
    for (const ac of list) liveNames[liveId(ac.hex)] = ac.callsign;
    this.state = {
      ...this.state,
      live: { count: trails.size, inbound: this.liveInbound.size, updatedAt: Date.now(), error: false },
      liveNames,
    };
  }

  /** Wetter vom Platz: echtes QNH und Wind im Funk, Landerichtung nach dem Wind */
  setWeather(weather: Weather | null): void {
    if (weather && weather.icao !== this.airport?.icao) return;
    this.state = { ...this.state, weather };
    this.manager.setWeather(weather);
    this.runwayFromWind();
  }

  setLiveError(): void {
    this.state = { ...this.state, live: { ...this.state.live, error: true } };
  }

  private clearLive(): void {
    this.liveTraffic = [];
    this.liveTrails.clear();
    this.liveInbound.clear();
    this.takenOver.clear();
    this.liveFrame = [];
    this.state = { ...this.state, live: { count: 0, inbound: 0, updatedAt: null, error: false }, liveNames: {} };
  }

  /** Echten Anflug übernehmen: er wird lotsbar, sein echtes Gegenstück verschwindet vom Radar */
  private takeOver(id: string): boolean {
    const hex = hexOf(id);
    const inb = hex ? this.liveInbound.get(hex) : undefined;
    const ac = hex ? this.liveFrame.find((a) => a.hex === hex) : undefined;
    if (!hex || !inb || !ac || !this.airport || this.state.trafficMode !== 'live') return false;
    this.takenOver.add(hex);
    this.liveInbound.delete(hex);
    this.manager.adopt(liveToAircraft(ac, this.takeoverContext(this.airport), inb.origin, this.manager.announcedAs(id)));
    this.trySave();
    return true;
  }

  private takeoverContext(airport: Airport): TakeoverContext {
    return { airport, stars: this.activeStars(), activeRunwayIds: this.state.activeRunwayIds };
  }

  /** Übernehmbare echte Anflüge an ihrer aktuellen Position (für Klicks aufs Radar) */
  liveTargets(): Array<{ id: string; lat: number; lng: number; altitudeFt: number }> {
    return this.liveFrame
      .filter((ac) => this.liveInbound.has(ac.hex))
      .map((ac) => ({ id: liveId(ac.hex), lat: ac.lat, lng: ac.lng, altitudeFt: ac.altFt ?? 0 }));
  }

  /** Anflüge fürs Radarbild: Startplatz, geschätzt, schon gemeldet */
  private inboundView(): Map<string, LiveInbound> {
    const view = new Map<string, LiveInbound>();
    for (const [hex, inb] of this.liveInbound) {
      view.set(hex, { origin: inb.origin, guess: inb.kind === 'guess', called: !!this.manager.announcedAs(liveId(hex)) });
    }
    return view;
  }

  /** Echte Flieger auf die aktuelle Zeit vorausgerechnet (zwischen zwei Abfragen) */
  private liveNow(): LiveAircraft[] {
    const now = Date.now();
    const out: LiveAircraft[] = [];
    for (const ac of this.liveTraffic) {
      // Übernommene Flieger lotst der Spieler, ihr echtes Gegenstück wird nicht gezeigt
      if (ac.ground || this.takenOver.has(ac.hex)) continue;
      const dt = Math.min(LIVE_EXTRAPOLATE_MAX_S, Math.max(0, (now - ac.ts) / 1000));
      if (ac.gs === null || ac.track === null || dt === 0) { out.push(ac); continue; }
      const p = destinationPoint(ac.lat, ac.lng, ac.track, (ac.gs * dt) / 3600);
      const altFt = ac.altFt !== null && ac.vs !== null ? ac.altFt + (ac.vs * dt) / 60 : ac.altFt;
      out.push({ ...ac, lat: p.lat, lng: p.lng, altFt });
    }
    return out;
  }

  start(): void {
    if (this.rafId !== null) return;
    this.lastTs = null;
    const loop = (ts: number) => {
      if (this.lastTs === null) this.lastTs = ts;
      const dt = Math.min((ts - this.lastTs) / 1000, 0.1);
      this.lastTs = ts;

      // Echter Verkehr: auf jetzt vorausgerechnet, Hindernis für die Staffelung
      const live = this.state.trafficMode === 'live' ? this.liveNow() : [];
      this.liveFrame = live;
      this.manager.setObstacles(live.flatMap((ac) => (ac.altFt === null ? [] : [{ id: liveId(ac.hex), lat: ac.lat, lng: ac.lng, altitudeFt: ac.altFt }])));

      if (!this.state.paused) this.manager.update(dt * this.state.timeScale, ts);

      const aircraft = this.manager.getAll();
      const pendingCmdTypes: Record<string, string[]> = {};
      for (const ac of aircraft) {
        const types = this.manager.getPendingTypes(ac.id);
        if (types.size > 0) pendingCmdTypes[ac.id] = Array.from(types);
      }

      // Remove conflicts where either aircraft has left the radar
      const present = new Set([...aircraft.map((ac) => ac.id), ...live.map((ac) => liveId(ac.hex))]);
      this.conflicts = this.conflicts.filter((c) => present.has(c.a) && present.has(c.b));

      this.state = { ...this.state, aircraft, conflicts: this.conflicts, pendingCmdTypes };
      this.onStateChange(this.state);

      if (this.renderer && this.airport) {
        const opts: RenderOptions = {
          now: ts,
          airport: this.airport,
          aircraft,
          conflicts: this.conflicts,
          waypoints: this.state.display.allNavaids ? this.waypoints : this.activeWaypoints(),
          selectedId: this.state.selectedId,
          sweepEnabled: this.state.sweepEnabled,
          rangeNM: this.state.rangeNM,
          trailLength: this.state.trailLength,
          viewLat: this.viewLat,
          viewLng: this.viewLng,
          previewHeading: this.previewHdg,
          previewAltitude: this.previewAlt,
          stars: this.activeStars(),
          display: this.state.display,
          activeRunwayIds: this.state.activeRunwayIds,
          live: this.state.trafficMode === 'live' ? { aircraft: live, trails: this.liveTrails, inbound: this.inboundView() } : undefined,
        };
        if (this.view3D && this.scene3d) this.scene3d.render(opts, this.camera);
        else this.renderer.render(opts);
      }

      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  pause():  void { this.state = { ...this.state, paused: true }; }
  resume(): void { this.state = { ...this.state, paused: false }; }
  // LIVE läuft in Echtzeit, sonst laufen eigene und echte Flieger auseinander
  setTimeScale(s: number):    void { this.state = { ...this.state, timeScale: this.state.trafficMode === 'live' ? 1 : s }; this.trySave(); }
  setSweep(enabled: boolean): void { this.state = { ...this.state, sweepEnabled: enabled };                          this.trySave(); }
  setRange(nm: number):       void { this.state = { ...this.state, rangeNM: Math.max(2, Math.min(200, nm)) };        this.trySave(); }
  setTrailLength(n: number):  void { this.state = { ...this.state, trailLength: n };                                 this.trySave(); }

  private trySave(): void {
    if (this.currentIcao) this.saveSession(this.currentIcao);
  }

  adjustRange(factor: number): void {
    this.setRange(this.state.rangeNM * factor);
  }

  /** Pan view by NM offsets (dxNM east-positive, dyNM north-positive). */
  pan(dxNM: number, dyNM: number): void {
    const cosLat = Math.cos((this.viewLat * Math.PI) / 180);
    this.viewLat += dyNM / 60;
    this.viewLng -= dxNM / (60 * cosLat);
  }

  setView3D(on: boolean): void { this.view3D = on; }

  /** Kamera drehen (Grad nach rechts) und neigen (Grad nach oben) */
  orbit3D(dYaw: number, dPitch: number): void {
    const yaw = (((this.camera.yaw + dYaw) % 360) + 360) % 360;
    const pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.camera.pitch + dPitch));
    this.camera = { yaw, pitch };
  }

  /** Blickpunkt in der 3D-Ansicht verschieben: Bildschirmpixel, relativ zur Blickrichtung */
  pan3D(dxPx: number, dyPx: number): void {
    if (!this.scene3d) return;
    const nm = this.scene3d.nmPerPx(this.state.rangeNM);
    const yaw = (this.camera.yaw * Math.PI) / 180;
    // Ziehen nach rechts schiebt die Szene mit, der Blickpunkt wandert nach links; nach unten → nach vorn
    const sinP = Math.max(0.3, Math.sin((this.camera.pitch * Math.PI) / 180));
    const right = -dxPx * nm;
    const fwd = (dyPx * nm) / sinP;
    const east = right * Math.cos(yaw) + fwd * Math.sin(yaw);
    const north = -right * Math.sin(yaw) + fwd * Math.cos(yaw);
    this.pan(-east, north);
  }

  /** Bildposition eines Punkts in der 3D-Ansicht (CSS px), null hinter der Kamera */
  project3D(lat: number, lng: number, altFt: number): { x: number; y: number } | null {
    return this.scene3d?.project(lat, lng, altFt) ?? null;
  }

  resetCamera(): void { this.camera = { ...DEFAULT_CAMERA }; }

  resetView(): void {
    if (this.airport) {
      this.viewLat = this.airport.lat;
      this.viewLng = this.airport.lng;
    }
    this.setRange(80);
  }

  setPreviewHeading(aircraftId: string | null, targetHdg: number | null, direction?: 'left' | 'right'): void {
    this.previewHdg = aircraftId && targetHdg !== null ? { aircraftId, targetHdg, direction } : null;
  }

  setDisplay(patch: Partial<DisplayOptions>): void {
    this.state = { ...this.state, display: { ...this.state.display, ...patch } };
    this.trySave();
  }

  /** Bahnen mit ILS, auf denen gelandet werden darf */
  private landingRunways(): Runway[] {
    return this.airport?.runways.filter((r) => r.ils && r.role !== 'departure') ?? [];
  }

  /** Alle Landebahnen einer Betriebsrichtung aktivieren; ein Wechsel steht im Funk-Log */
  private applyDirection(heading: number, source: RunwaySource, reason: string): void {
    const ids = this.landingRunways().filter((r) => Math.abs(headingDiff(r.heading, heading)) < SAME_DIRECTION_DEG).map((r) => r.id);
    if (ids.length === 0) return;
    const current = this.state.activeRunwayIds;
    const changed = ids.length !== current.length || ids.some((id) => !current.includes(id));
    this.state = { ...this.state, activeRunwayIds: ids, runwaySource: source };
    if (changed) {
      this.manager.setSpawnStars(this.activeStars());
      this.manager.info(`Landerichtung ${ids.join(' ')} (${reason})`);
      this.manager.reassignStars(this.activeStars(), this.state.timeScale);
    }
    this.trySave();
  }

  /** Landerichtung mit dem meisten Gegenwind, solange weder Hand noch echter Verkehr entschieden haben */
  private runwayFromWind(): void {
    const w = this.state.weather;
    const source = this.state.runwaySource;
    if (!w || w.windDir === null || w.windKt < WIND_MIN_KT || (source !== 'default' && source !== 'wind')) return;
    const windDir = w.windDir;
    // Wind und Bahnkurse sind rechtweisend
    const headwind = (r: Runway) => w.windKt * Math.cos(((windDir - r.heading) * Math.PI) / 180);
    const runways = this.landingRunways();
    const best = runways.reduce<Runway | null>((b, r) => (!b || headwind(r) > headwind(b) ? r : b), null);
    if (!best) return;
    const active = runways.filter((r) => this.state.activeRunwayIds.includes(r.id));
    const current = active.length > 0 ? Math.max(...active.map(headwind)) : -Infinity;
    if (headwind(best) - current > WIND_SWITCH_KT) {
      this.applyDirection(best.heading, 'wind', `Wind ${pad3(windDir)}° ${Math.round(w.windKt)} kt`);
    } else {
      this.state = { ...this.state, runwaySource: 'wind' };
    }
  }

  /**
   * LIVE: Landerichtung der echten Flieger übernehmen. Wechsel erst, wenn in 10 Minuten mindestens zwei
   * in der anderen Richtung gelandet sind und keiner in der aktuellen.
   */
  private detectRunwayInUse(list: LiveAircraft[]): void {
    const airport = this.airport;
    if (!airport) return;
    const now = Date.now();
    for (const ac of list) {
      const rwy = landingRunway(ac, airport);
      if (rwy) this.liveFinals.set(ac.hex, { heading: rwy.heading, at: now });
    }
    for (const [hex, f] of this.liveFinals) if (now - f.at > LIVE_FINALS_MEMORY_MS) this.liveFinals.delete(hex);
    if (this.state.runwaySource === 'manual') return;

    const groups: Array<{ heading: number; count: number }> = [];
    for (const f of this.liveFinals.values()) {
      const g = groups.find((x) => Math.abs(headingDiff(x.heading, f.heading)) < SAME_DIRECTION_DEG);
      if (g) g.count++;
      else groups.push({ heading: f.heading, count: 1 });
    }
    const active = this.landingRunways().filter((r) => this.state.activeRunwayIds.includes(r.id));
    const isActive = (heading: number) => active.some((r) => Math.abs(headingDiff(r.heading, heading)) < SAME_DIRECTION_DEG);
    const current = groups.filter((g) => isActive(g.heading)).reduce((n, g) => n + g.count, 0);
    const other = groups.filter((g) => !isActive(g.heading)).sort((a, b) => b.count - a.count)[0];
    if (current === 0 && other && other.count >= LIVE_FINALS_SWITCH) {
      this.applyDirection(other.heading, 'live', 'echter Verkehr');
    } else if (current >= LIVE_FINALS_SWITCH && this.state.runwaySource !== 'live') {
      this.state = { ...this.state, runwaySource: 'live' };
      this.trySave();
    }
  }

  /** Landerichtung wieder automatisch wählen (nach Wind und, bei LIVE, nach dem echten Verkehr) */
  setRunwayAuto(): void {
    this.state = { ...this.state, runwaySource: 'default' };
    this.detectRunwayInUse([]);
    this.runwayFromWind();
    this.trySave();
  }

  toggleActiveRunway(id: string): void {
    const ids = this.state.activeRunwayIds;
    let next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    const rwy = this.airport?.runways.find((r) => r.id === id);
    const opposite = (x: string) => {
      const o = this.airport?.runways.find((r) => r.id === x);
      return !!(o && rwy && Math.abs(headingDiff(o.heading, rwy.heading)) > 90);
    };
    if (!ids.includes(id) && ids.some(opposite)) {
      // Betriebsrichtungswechsel: Bahnen der Gegenrichtung auf ihre Gegenbahn umstellen, keine gemischten Richtungen
      const flipped = ids.map((x) => (opposite(x) ? this.airport!.runways.find((r) => r.id === x)!.recipId : x));
      next = [...new Set([...flipped, id])];
    }
    // Von Hand gewählt: keine automatische Umstellung mehr, bis AUTO gedrückt wird
    this.state = { ...this.state, activeRunwayIds: next, runwaySource: 'manual' };
    this.manager.setSpawnStars(this.activeStars());
    this.manager.reassignStars(this.activeStars(), this.state.timeScale);
    this.trySave();
  }

  /** Funkfeuer sowie Punkte auf den STARs der aktiven Bahnen */
  private activeWaypoints(): Waypoint[] {
    const onStar = new Set(this.activeStars().flatMap((s) => s.waypoints.map((w) => w.id)));
    return this.waypoints.filter((w) => w.type === 'vor' || w.type === 'ndb' || onStar.has(w.id));
  }

  /** STARs für die aktiven Bahnen (oder "ALL"); ohne Treffer alle STARs */
  private activeStars(): STAR[] {
    const ids = this.state.activeRunwayIds;
    const matching = this.stars.filter((s) => s.runway === 'ALL' || ids.includes(s.runway));
    return matching.length > 0 ? matching : this.stars;
  }

  /** Pick all ILS runways whose heading is closest to the median heading of the set. */
  private pickPrimaryDirection(runways: import('@/types/airport').Runway[]): import('@/types/airport').Runway[] {
    if (runways.length === 0) return [];
    // Group by reciprocal pairs: heading vs heading+180
    // Just pick the group whose heading is smallest (conventional: lower number = primary)
    const sorted = [...runways].sort((a, b) => a.heading - b.heading);
    const primaryHdg = sorted[0].heading;
    // All runways within 20° of the primary heading
    return runways.filter((r) => Math.abs(r.heading - primaryHdg) < 20);
  }

  setPreviewAltitude(aircraftId: string | null, targetAlt: number | null): void {
    this.previewAlt = aircraftId && targetAlt !== null ? { aircraftId, targetAlt } : null;
  }

  selectAircraft(id: string | null): void {
    // Klick auf einen echten Anflug übernimmt ihn
    if (id && !this.manager.get(id)) this.takeOver(id);
    this.state = { ...this.state, selectedId: id && this.manager.get(id) ? id : null };
  }
  applyCommand(id: string, cmd: ATCCommand): void { this.manager.applyCommand(id, cmd, this.state.timeScale); }
  getSelectedAircraft(): Aircraft | undefined {
    if (!this.state.selectedId) return undefined;
    return this.manager.get(this.state.selectedId);
  }

  private static SESSION_KEY = 'atc-session-v1';

  saveSession(icao: string): void {
    try {
      const data = {
        icao,
        savedAt: Date.now(),
        score: this.state.score,
        landings: this.state.landings,
        violations: this.state.violations,
        rangeNM: this.state.rangeNM,
        trailLength: this.state.trailLength,
        sweepEnabled: this.state.sweepEnabled,
        timeScale: this.state.timeScale,
        display: this.state.display,
        activeRunwayIds: this.state.activeRunwayIds,
        runwaySource: this.state.runwaySource,
        trafficMode: this.state.trafficMode,
        liveHexes: [...this.takenOver],
        viewLat: this.viewLat,
        viewLng: this.viewLng,
        aircraft: this.manager.exportAircraft(),
        pendingCommands: this.manager.exportPendingCommands(),
      };
      localStorage.setItem(GameEngine.SESSION_KEY, JSON.stringify(data));
    } catch { /* storage unavailable */ }
  }

  static loadSession(): SessionData | null {
    try {
      const raw = localStorage.getItem(GameEngine.SESSION_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw) as SessionData;
      // Discard sessions older than 4 hours
      if (Date.now() - data.savedAt > 4 * 60 * 60 * 1000) return null;
      return data;
    } catch { return null; }
  }

  restoreSession(data: SessionData): void {
    this.state = {
      ...this.state,
      score: data.score,
      landings: data.landings,
      violations: data.violations,
      rangeNM: data.rangeNM,
      trailLength: data.trailLength,
      sweepEnabled: data.sweepEnabled,
      timeScale: data.trafficMode === 'live' ? 1 : data.timeScale ?? 1,
      display: { ...DEFAULT_DISPLAY, ...data.display },
      activeRunwayIds: data.activeRunwayIds ?? [],
      runwaySource: data.runwaySource ?? 'default',
      trafficMode: data.trafficMode ?? 'sim',
    };
    this.manager.setSpawning(this.state.trafficMode === 'sim');
    this.manager.setSpawnStars(this.activeStars());
    this.takenOver = new Set(data.liveHexes ?? []);
    this.viewLat = data.viewLat;
    this.viewLng = data.viewLng;
    this.manager.importAircraft(data.aircraft);
    this.manager.importPendingCommands(data.pendingCommands);
  }
}

/** Dasselbe Flieger-Paar, egal in welcher Reihenfolge */
function samePair(x: ConflictPair, y: ConflictPair): boolean {
  return (x.a === y.a && x.b === y.b) || (x.a === y.b && x.b === y.a);
}
