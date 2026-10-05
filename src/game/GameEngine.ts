// filepath: src/game/GameEngine.ts
import type { Airport, AirportLayer, Runway } from '@/types/airport';
import type { Aircraft, ATCCommand, ConflictPair, TrailPoint } from '@/types/aircraft';
import type { LiveAircraft, LiveInbound, LiveStatus, TrafficMode, WatchFilter } from '@/types/live';
import type { DayFlight } from '@/services/LiveTrafficService';
import type { Waypoint, STAR } from '@/types/navdata';
import type { RadioMessage } from '@/types/radio';
import type { Weather } from '@/types/weather';
import { AircraftManager } from './AircraftManager';
import { inbound, callsIn, liveToAircraft, liveId, hexOf, landingRunway, type Inbound, type TakeoverContext } from './LiveTraffic';
import { RadarRenderer, DEFAULT_DISPLAY, type DisplayOptions, type RenderOptions } from './RadarRenderer';
import { Scene3DRenderer, DEFAULT_CAMERA, ALT_SCALES, DEFAULT_ALT_SCALE, PITCH_MIN, PITCH_MAX, type Camera3D } from './Scene3DRenderer';
import { headingDiff } from '@/utils/aviation';
import { guessStar, type StarGuess } from './StarMatch';
import type { Town } from '@/services/TownService';
import type { Landmark } from '@/services/LandmarkService';
import type { Road } from '@/services/RoadService';
import { pad3 } from './Speech';
import { destinationPoint, distanceNM } from '@/utils/geo';
import { SCORE_LANDING, SCORE_GOAROUND, SCORE_SEPARATION_VIOLATION, SCORE_COLLISION } from './constants';

const RADIO_LOG_SIZE = 50;
const LIVE_TRAIL_MAX = 120;
// WATCH: längere Spur (etwa 12 Minuten), damit sich die STAR erkennen lässt
const WATCH_TRAIL_MAX = 180;
// WATCH: für den STAR-Vergleich nur der Teil der Flugbahn in Platznähe
const STAR_MATCH_NM = 120;
const LIVE_EXTRAPOLATE_MAX_S = 30;
// Landerichtung aus dem Wind: wie in echt bleibt die Vorzugsrichtung, bis der Rückenwind (mit Böen) mehr als 5 kt beträgt
const TAILWIND_MAX_KT = 5;
// Vorzugsrichtung ohne bessere Daten: West (Westwetterlage; z. B. Frankfurt Betriebsrichtung 25)
const PREFERRED_HEADING = 270;
// Landerichtung aus dem echten Verkehr: Landungen der letzten 10 Minuten je Richtung
const LIVE_FINALS_MEMORY_MS = 10 * 60_000;
const LIVE_FINALS_SWITCH = 2;
// Bahnen gleicher Betriebsrichtung (Parallelbahnen)
const SAME_DIRECTION_DEG = 20;
// WATCH: Start erkannt, solange der Flieger nah am Platz, tief und steigend ist
const DEPARTURE_MAX_NM = 8;
const DEPARTURE_MAX_FT = 5000;
const DEPARTURE_MIN_VS = 500;
const WATCH_EVENT_MEMORY_MS = 15 * 60_000;

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
  /** WATCH: echte Flieger im aktuellen Bild (für Liste und Detailanzeige) */
  watch: LiveAircraft[];
  /** WATCH: Anflüge und Abflüge des gewählten Platzes, nach hex */
  watchRoles: Record<string, LiveInbound>;
  /** Gelandet = abgeschlossen: kam aus ALT > 0 auf ALT 0 bzw. Boden (hex) */
  watchLanded: string[];
  /** WATCH: Standort des Zuschauers per GPS (null: am gewählten Platz) */
  spectator: Spectator | null;
}

export interface Spectator { lat: number; lng: number; accuracyM: number }

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
    watch: [],
    watchRoles: {},
    watchLanded: [],
    spectator: null,
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
  private watchFilter: WatchFilter = 'all';          // WATCH: nur Anflüge, nur Abflüge oder alle
  private liveFrame: LiveAircraft[] = [];            // echte Flieger im letzten Bild (für Klicks)
  private liveFinals = new Map<string, { heading: number; at: number }>(); // hex → Bahnkurs, zuletzt im Endanflug gesehen
  private track: RenderOptions['track'] = null;                            // WATCH: Flugbahn des gewählten Fliegers
  private starGuesses = new Map<string, StarGuess>();
  private roads: Road[] = [];                                               // Autobahnen als Orientierung
  private landmarks: Landmark[] = [];                                       // markante Bauwerke rund um den Platz
  private towns: Town[] = [];                                               // WATCH: Ortschaften (schon nach Einwohnern gefiltert)                       // WATCH: hex → wahrscheinliche STAR
  private liveDepartures = new Map<string, number>();
  private liveAirborne = new Set<string>();                                 // hex mit zuletzt ALT > 0
  private liveLanded = new Set<string>();                                   // hex: von ALT > 0 auf 0 gekommen → gelandet, abgeschlossen                       // WATCH: hex → zuletzt beim Start gesehen
  private liveOutbound = new Map<string, string | undefined>();              // WATCH: hex → Zielplatz der Abflüge

  /** Echte Flieger auf dem Radar (LIVE zum Lotsen, WATCH nur zum Zuschauen) */
  private get liveMode(): boolean { return this.state.trafficMode !== 'sim'; }
  private get watching(): boolean { return this.state.trafficMode === 'watch'; }

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
    try {
      const v = Number(localStorage.getItem(GameEngine.ALT_SCALE_KEY));
      if ((ALT_SCALES as readonly number[]).includes(v)) this.scene3d.altScale = v;
    } catch { /* nur Komfort */ }
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
    // WATCH mit GPS: Blick auf den Zuschauer statt auf den Platz
    const center = this.watching && this.state.spectator ? this.state.spectator : airport;
    this.viewLat = center.lat;
    this.viewLng = center.lng;
    this.manager.setAirport(airport, stars);
    // Standard: alle ILS-Landebahnen der Vorzugsrichtung
    const ilsRunways = airport.runways.filter((r) => r.ils && r.role !== 'departure');
    const activeRunwayIds = ilsRunways.length > 0
      ? this.pickPrimaryDirection(ilsRunways).map((r) => r.id)
      : [];
    this.state = { ...this.state, activeRunwayIds, radio: [], weather: null, runwaySource: 'default' };
    this.manager.setSpawnStars(this.activeStars());
    this.clearLive();
    this.liveFinals.clear();
    this.liveDepartures.clear();
    this.liveAirborne.clear();
    this.liveLanded.clear();
    if (this.state.trafficMode === 'sim') for (let i = 0; i < 3; i++) this.manager.forceSpawn();
  }

  /**
   * SIM: erfundener Verkehr; LIVE: echte Flieger (adsb.lol), kein erfundener Verkehr, Echtzeit;
   * WATCH: nur echte Flieger in Echtzeit zum Zuschauen, ohne Lotsen, Funk der Piloten und Punkte
   */
  setTrafficMode(mode: TrafficMode): void {
    if (mode === this.state.trafficMode) return;
    this.state = { ...this.state, trafficMode: mode, selectedId: null, spectator: mode === 'watch' ? this.state.spectator : null, timeScale: mode !== 'sim' ? 1 : this.state.timeScale, paused: false };
    this.manager.setSpawning(mode === 'sim');
    this.manager.clearTraffic();
    this.manager.setAnnouncements([]);
    this.clearLive();
    this.liveFinals.clear();
    this.liveDepartures.clear();
    this.liveAirborne.clear();
    this.liveLanded.clear();
    if (mode === 'sim' && this.airport) for (let i = 0; i < 3; i++) this.manager.forceSpawn();
    this.trySave();
  }

  setLiveTraffic(list: LiveAircraft[]): void {
    if (!this.liveMode) return;
    this.liveTraffic = list;
    // Spur aus den gemeldeten Positionen
    const trails = new Map<string, TrailPoint[]>();
    for (const ac of list) {
      if (ac.ground) continue;
      const trail = this.liveTrails.get(ac.hex) ?? [];
      const last = trail[trail.length - 1];
      trails.set(ac.hex, !last || last.ts < ac.ts ? [...trail, { lat: ac.lat, lng: ac.lng, ts: ac.ts }].slice(-(this.watching ? WATCH_TRAIL_MAX : LIVE_TRAIL_MAX)) : trail);
    }
    this.liveTrails = trails;
    this.detectRunwayInUse(list);
    if (this.watching) this.detectDepartures(list);

    this.detectLandings(list);
    // Anflüge zum gewählten Platz; zwischen 60 und 25 NM melden sie sich (nächster zuerst)
    this.liveInbound.clear();
    const calls: Array<{ ac: LiveAircraft; dist: number }> = [];
    const airport = this.airport;
    if (airport) {
      for (const ac of list) {
        const inb = this.takenOver.has(ac.hex) || this.liveLanded.has(ac.hex) ? null : inbound(ac, airport, this.watching);
        if (!inb) continue;
        this.liveInbound.set(ac.hex, inb);
        if (callsIn(ac, inb, airport)) calls.push({ ac, dist: distanceNM(ac.lat, ac.lng, airport.lat, airport.lng) });
      }
      calls.sort((a, b) => a.dist - b.dist);
      const ctx = this.takeoverContext(airport);
      // WATCH: niemand ruft an, es wird nur zugeschaut
      this.manager.setAnnouncements(this.watching ? [] : calls.map(({ ac }) => liveToAircraft(ac, ctx, this.liveInbound.get(ac.hex)?.origin)));
      if (this.watching) this.updateStarGuesses(list);
      // WATCH: Abflüge laut Route (gewählter Platz vor dem Ziel)
      this.liveOutbound.clear();
      if (this.watching) {
        for (const ac of list) {
          if (!ac.route || this.liveInbound.has(ac.hex)) continue;
          const codes = ac.route.split('-');
          const idx = codes.indexOf(airport.icao);
          if (idx >= 0 && idx < codes.length - 1) this.liveOutbound.set(ac.hex, codes[idx + 1]);
        }
      }
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
    this.liveOutbound.clear();
    this.starGuesses.clear();
    this.takenOver.clear();
    this.liveFrame = [];
    this.state = { ...this.state, live: { count: 0, inbound: 0, updatedAt: null, error: false }, liveNames: {}, watch: [], watchRoles: {} };
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

  /** Übernehmbare echte Anflüge (WATCH: alle echten Flieger) an ihrer aktuellen Position (für Klicks aufs Radar) */
  liveTargets(): Array<{ id: string; lat: number; lng: number; altitudeFt: number }> {
    return this.liveFrame
      .filter((ac) => this.watching || this.liveInbound.has(ac.hex))
      .map((ac) => ({ id: liveId(ac.hex), lat: ac.lat, lng: ac.lng, altitudeFt: ac.altFt ?? 0 }));
  }

  /** Anflüge fürs Radarbild: Startplatz, geschätzt, schon gemeldet */
  private inboundView(): Map<string, LiveInbound> {
    const view = new Map<string, LiveInbound>();
    for (const [hex, inb] of this.liveInbound) {
      view.set(hex, { origin: inb.origin, guess: inb.kind === 'guess', called: !!this.manager.announcedAs(liveId(hex)), star: this.starGuesses.get(hex) });
    }
    for (const [hex, dest] of this.liveOutbound) view.set(hex, { guess: false, called: false, out: true, dest });
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
      let live = this.liveMode ? this.liveNow() : [];
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

      const roles = this.liveMode ? this.inboundView() : new Map<string, LiveInbound>();
      // WATCH-Filter IN/OUT: nur diese Flieger zeigen und anklickbar machen
      if (this.watching && this.watchFilter !== 'all') {
        const wantOut = this.watchFilter === 'out';
        live = live.filter((ac) => { const r = roles.get(ac.hex); return !!r && !!r.out === wantOut; });
        this.liveFrame = live;
      }
      // WATCH: gewählter Flieger weg (gelandet, außer Reichweite) → Auswahl aufheben
      let selectedId = this.state.selectedId;
      if (this.watching && selectedId && !live.some((ac) => liveId(ac.hex) === selectedId)) selectedId = null;
      this.state = {
        ...this.state, aircraft, conflicts: this.conflicts, pendingCmdTypes, selectedId,
        watch: this.watching ? live : this.state.watch.length ? [] : this.state.watch,
        watchRoles: this.watching ? Object.fromEntries(roles) : this.state.watch.length ? {} : this.state.watchRoles,
        watchLanded: this.watching ? [...this.liveLanded] : [],
      };
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
          live: this.liveMode ? { aircraft: live, trails: this.liveTrails, inbound: roles } : undefined,
          spectator: this.watching ? this.state.spectator : null,
          towns: this.watching ? this.towns : undefined,
          dayTracks: this.watching ? this.visibleDayTracks() : undefined,
          landmarks: this.state.display.landmarks !== false ? this.landmarks : undefined,
          roads: this.state.display.roads !== false ? this.roads : undefined,
          track: this.watching && this.track && selectedId === liveId(this.track.hex) ? this.track : null,
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
  setTimeScale(s: number):    void { this.state = { ...this.state, timeScale: this.liveMode ? 1 : s }; this.trySave(); }
  setSweep(enabled: boolean): void { this.state = { ...this.state, sweepEnabled: enabled };                          this.trySave(); }
  setRange(nm: number):       void { this.state = { ...this.state, rangeNM: Math.max(0.15, Math.min(200, nm)) };        this.trySave(); this.saveCameraSoon(); }
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
    this.saveCameraSoon();
  }

  // ── Kamera (Ausschnitt, Zoom, 3D-Blickwinkel) übersteht ein Neuladen, je Platz ──
  private static CAMERA_KEY = 'atc-camera-v1';
  private cameraTimer: ReturnType<typeof setTimeout> | null = null;

  private saveCameraSoon(): void {
    if (this.cameraTimer) return;
    this.cameraTimer = setTimeout(() => { this.cameraTimer = null; this.saveCamera(); }, 500);
  }

  /** Sofort speichern (auch beim Verlassen der Seite) */
  saveCamera(): void {
    if (!this.currentIcao) return;
    try {
      localStorage.setItem(GameEngine.CAMERA_KEY, JSON.stringify({
        icao: this.currentIcao, viewLat: this.viewLat, viewLng: this.viewLng,
        rangeNM: this.state.rangeNM, yaw: this.camera.yaw, pitch: this.camera.pitch,
      }));
    } catch { /* nur Komfort */ }
  }

  /** Gespeicherte Kamera übernehmen, wenn sie zum Platz gehört */
  restoreCamera(icao: string): void {
    try {
      const c = JSON.parse(localStorage.getItem(GameEngine.CAMERA_KEY) ?? 'null') as
        { icao: string; viewLat: number; viewLng: number; rangeNM: number; yaw: number; pitch: number } | null;
      if (!c || c.icao !== icao || ![c.viewLat, c.viewLng, c.rangeNM, c.yaw, c.pitch].every(Number.isFinite)) return;
      this.viewLat = c.viewLat;
      this.viewLng = c.viewLng;
      this.state = { ...this.state, rangeNM: Math.max(0.15, Math.min(200, c.rangeNM)) };
      this.camera = { yaw: c.yaw, pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, c.pitch)) };
    } catch { /* kaputter Eintrag: Standard */ }
  }

  setView3D(on: boolean): void { this.view3D = on; }

  /** 3D: Überhöhung der Höhen umschalten (×4, ×2, ×1 = maßstabsgetreu), im Browser gemerkt */
  cycleAltScale(): number {
    if (!this.scene3d) return DEFAULT_ALT_SCALE;
    const i = ALT_SCALES.indexOf(this.scene3d.altScale as (typeof ALT_SCALES)[number]);
    this.scene3d.altScale = ALT_SCALES[(i + 1) % ALT_SCALES.length];
    try { localStorage.setItem(GameEngine.ALT_SCALE_KEY, String(this.scene3d.altScale)); } catch { /* nur Komfort */ }
    return this.scene3d.altScale;
  }
  get altScale(): number { return this.scene3d?.altScale ?? DEFAULT_ALT_SCALE; }
  private static readonly ALT_SCALE_KEY = 'atc-alt-scale';

  /** Kamera drehen (Grad nach rechts) und neigen (Grad nach oben) */
  orbit3D(dYaw: number, dPitch: number): void {
    const yaw = (((this.camera.yaw + dYaw) % 360) + 360) % 360;
    const pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.camera.pitch + dPitch));
    this.camera = { yaw, pitch };
    this.saveCameraSoon();
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

  resetCamera(): void { this.camera = { ...DEFAULT_CAMERA }; this.saveCameraSoon(); }

  /** WATCH: Standort des Zuschauers (GPS) setzen oder löschen (dann gilt der gewählte Platz) */
  /** WATCH: vergangene Flugbahn des gewählten Fliegers (null: keine) */
  setTrack(track: RenderOptions['track']): void {
    this.track = track ?? null;
    if (this.watching) this.updateStarGuesses(this.liveTraffic);
  }

  /** WATCH: wahrscheinliche STAR jedes Anflugs aus seiner Flugbahn (beim gewählten die ganze, sonst die Spur) */
  private updateStarGuesses(list: LiveAircraft[]): void {
    this.starGuesses.clear();
    const airport = this.airport;
    if (!airport || this.stars.length === 0) return;
    for (const ac of list) {
      if (!this.liveInbound.has(ac.hex)) continue;
      const history: Array<{ lat: number; lng: number; altFt?: number | null; ts?: number }> =
        this.track?.hex === ac.hex ? this.track.points : this.liveTrails.get(ac.hex) ?? [];
      const near = history.filter((p) => distanceNM(p.lat, p.lng, airport.lat, airport.lng) < STAR_MATCH_NM);
      const guess = guessStar([...near, { lat: ac.lat, lng: ac.lng, ts: ac.ts }], ac.track, this.stars, this.state.activeRunwayIds);
      if (guess) this.starGuesses.set(ac.hex, guess);
    }
  }

  /** WATCH TAG: Starts und Landungen eines Tages als Linien (null: aus) */
  private dayTracks: DayFlight[] | null = null;
  setDayTracks(flights: DayFlight[] | null): void { this.dayTracks = flights; }
  private visibleDayTracks(): DayFlight[] | undefined {
    if (!this.dayTracks) return undefined;
    return this.watchFilter === 'all' ? this.dayTracks : this.dayTracks.filter((f) => f.dir === this.watchFilter);
  }

  /** WATCH: Ortschaften fürs Radarbild */
  setTowns(towns: Town[]): void { this.towns = towns; }
  setLandmarks(landmarks: Landmark[]): void { this.landmarks = landmarks; }
  setRoads(roads: Road[]): void { this.roads = roads; }
  /** OSM-Gelände (Terminals, Vorfeld …) kommt nach dem Platz */
  setAirportLayer(icao: string, layer: AirportLayer): void {
    if (this.airport?.icao === icao) this.airport = { ...this.airport, layer };
  }

  /** Blick auf einen Punkt richten (z. B. Suchtreffer) */
  centerOn(lat: number, lng: number): void { this.viewLat = lat; this.viewLng = lng; this.saveCameraSoon(); }

  /** WATCH: Anzeige auf Anflüge (in) oder Abflüge (out) beschränken */
  setWatchFilter(f: WatchFilter): void { this.watchFilter = f; }

  setSpectator(pos: Spectator | null): void {
    this.state = { ...this.state, spectator: pos };
    const center = pos ?? this.airport;
    if (center) { this.viewLat = center.lat; this.viewLng = center.lng; }
  }

  resetView(): void {
    const center = (this.watching && this.state.spectator) || this.airport;
    if (center) {
      this.viewLat = center.lat;
      this.viewLng = center.lng;
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

  /** Vorzugsrichtung, außer der Rückenwind dort ist zu stark; dann die Richtung mit dem meisten Gegenwind */
  private runwayFromWind(): void {
    const w = this.state.weather;
    const source = this.state.runwaySource;
    if (!w || w.windDir === null || (source !== 'default' && source !== 'wind')) return;
    const windDir = w.windDir;
    const windKt = Math.max(w.windKt, w.gustKt ?? 0);
    // Wind und Bahnkurse sind rechtweisend
    const headwind = (r: Runway) => windKt * Math.cos(((windDir - r.heading) * Math.PI) / 180);
    const runways = this.landingRunways();
    const preferred = this.pickPrimaryDirection(runways);
    if (preferred.length === 0) return;
    const prefHead = Math.max(...preferred.map(headwind));
    const target = prefHead >= -TAILWIND_MAX_KT
      ? preferred[0]
      : runways.reduce<Runway>((b, r) => (headwind(r) > headwind(b) ? r : b), runways[0]);
    const active = runways.filter((r) => this.state.activeRunwayIds.includes(r.id));
    const onTarget = active.some((r) => Math.abs(headingDiff(r.heading, target.heading)) < SAME_DIRECTION_DEG);
    if (!onTarget) {
      this.applyDirection(target.heading, 'wind', `Wind ${pad3(windDir)}° ${Math.round(w.windKt)} kt`);
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
      if (!rwy) continue;
      // WATCH: jeden Endanflug einmal im Log melden
      if (this.watching && !this.liveFinals.has(ac.hex)) {
        this.manager.info(`${ac.callsign}${ac.type ? ` (${ac.type})` : ''} im Endanflug ${rwy.id}`, liveId(ac.hex), ac.callsign);
      }
      this.liveFinals.set(ac.hex, { heading: rwy.heading, at: now });
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

  /**
   * Gelandet und damit abgeschlossen: ALT kommt von über 0 auf 0 (bzw. Boden). Steigt er wieder,
   * ist es ein neuer Flug. WATCH meldet die Landung im Log.
   */
  private detectLandings(list: LiveAircraft[]): void {
    const seen = new Set<string>();
    for (const ac of list) {
      seen.add(ac.hex);
      if (!ac.ground && ac.altFt !== null && ac.altFt > 0) {
        this.liveAirborne.add(ac.hex);
        this.liveLanded.delete(ac.hex);
      } else if ((ac.ground || (ac.altFt !== null && ac.altFt <= 0)) && this.liveAirborne.delete(ac.hex)) {
        this.liveLanded.add(ac.hex);
        if (this.watching) this.manager.info(`${ac.callsign}${ac.type ? ` (${ac.type})` : ''} gelandet`, liveId(ac.hex), ac.callsign);
      }
    }
    for (const hex of this.liveAirborne) if (!seen.has(hex)) this.liveAirborne.delete(hex);
    for (const hex of this.liveLanded) if (!seen.has(hex)) this.liveLanded.delete(hex);
  }

  /** WATCH: Starts vom gewählten Platz einmal im Log melden (nah, tief, steigend) */
  private detectDepartures(list: LiveAircraft[]): void {
    const airport = this.airport;
    if (!airport) return;
    const now = Date.now();
    for (const ac of list) {
      if (ac.ground || ac.altFt === null || (ac.vs ?? 0) < DEPARTURE_MIN_VS) continue;
      if (ac.altFt - airport.elevationFt > DEPARTURE_MAX_FT) continue;
      if (distanceNM(ac.lat, ac.lng, airport.lat, airport.lng) > DEPARTURE_MAX_NM) continue;
      if (!this.liveDepartures.has(ac.hex)) {
        const dest = this.liveOutbound.get(ac.hex);
        this.manager.info(`${ac.callsign}${ac.type ? ` (${ac.type})` : ''} gestartet${dest ? `, nach ${dest}` : ''}`, liveId(ac.hex), ac.callsign);
      }
      this.liveDepartures.set(ac.hex, now);
    }
    for (const [hex, at] of this.liveDepartures) if (now - at > WATCH_EVENT_MEMORY_MS) this.liveDepartures.delete(hex);
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
    // Bahn, deren Kurs der Vorzugsrichtung am nächsten liegt, samt Parallelbahnen
    const primary = [...runways].sort((a, b) => Math.abs(headingDiff(a.heading, PREFERRED_HEADING)) - Math.abs(headingDiff(b.heading, PREFERRED_HEADING)))[0];
    return runways.filter((r) => Math.abs(headingDiff(r.heading, primary.heading)) < SAME_DIRECTION_DEG);
  }

  setPreviewAltitude(aircraftId: string | null, targetAlt: number | null): void {
    this.previewAlt = aircraftId && targetAlt !== null ? { aircraftId, targetAlt } : null;
  }

  selectAircraft(id: string | null): void {
    // WATCH: echten Flieger nur auswählen (Details in der Seitenleiste)
    if (this.watching) {
      this.state = { ...this.state, selectedId: id && this.liveFrame.some((ac) => liveId(ac.hex) === id) ? id : null };
      return;
    }
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
      timeScale: data.trafficMode && data.trafficMode !== 'sim' ? 1 : data.timeScale ?? 1,
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
