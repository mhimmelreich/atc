// filepath: src/game/GameEngine.ts
import type { Airport } from '@/types/airport';
import type { Aircraft, ATCCommand, ConflictPair, TrailPoint } from '@/types/aircraft';
import type { LiveAircraft, LiveStatus, TrafficMode } from '@/types/live';
import type { Waypoint, STAR } from '@/types/navdata';
import type { RadioMessage } from '@/types/radio';
import { AircraftManager } from './AircraftManager';
import { RadarRenderer, DEFAULT_DISPLAY, type DisplayOptions } from './RadarRenderer';
import { headingDiff } from '@/utils/aviation';
import { destinationPoint } from '@/utils/geo';
import { SCORE_LANDING, SCORE_GOAROUND, SCORE_SEPARATION_VIOLATION, SCORE_COLLISION } from './constants';

const RADIO_LOG_SIZE = 50;
const LIVE_TRAIL_MAX = 20;
const LIVE_EXTRAPOLATE_MAX_S = 30;

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
  trafficMode?: TrafficMode;
  viewLat: number;
  viewLng: number;
  aircraft: import('@/types/aircraft').Aircraft[];
  pendingCommands: Array<{ id: string; cmd: import('@/types/aircraft').ATCCommand; remainingMs: number }>;
}

export class GameEngine {
  private manager: AircraftManager;
  private renderer: RadarRenderer | null = null;
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
    live: { count: 0, updatedAt: null, error: false },
  };
  get rangeNM(): number { return this.state.rangeNM; }
  private onStateChange: StateCallback;
  private rafId: number | null = null;
  private lastTs: number | null = null;
  private conflictCooldowns = new Set<string>();
  private liveTraffic: LiveAircraft[] = [];
  private liveTrails = new Map<string, TrailPoint[]>();

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
          const existing = this.conflicts.find((c) => c.a === event.pair!.a && c.b === event.pair!.b);
          if (!existing) this.conflicts = [...this.conflicts, event.pair!];
          break;
        }
        case 'warning': {
          const existing = this.conflicts.find((c) => c.a === event.pair!.a && c.b === event.pair!.b);
          if (!existing) this.conflicts = [...this.conflicts, event.pair!];
          break;
        }
        case 'clear':
          if (event.pair) {
            this.conflicts = this.conflicts.filter(
              (c) => !(c.a === event.pair!.a && c.b === event.pair!.b)
            );
          }
          break;
        case 'radio':
          this.state = { ...this.state, radio: [...this.state.radio.slice(1 - RADIO_LOG_SIZE), event.message!] };
          break;
      }
    });
  }

  attachCanvas(canvas: HTMLCanvasElement): void {
    this.renderer = new RadarRenderer(canvas);
  }

  resizeCanvas(w: number, h: number): void {
    this.renderer?.resize(w, h);
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
    this.state = { ...this.state, activeRunwayIds, radio: [] };
    this.manager.setSpawnStars(this.activeStars());
    this.clearLive();
    if (this.state.trafficMode === 'sim') for (let i = 0; i < 3; i++) this.manager.forceSpawn();
  }

  /** SIM: erfundener Verkehr; LIVE: echte Flieger (adsb.lol), kein erfundener Verkehr */
  setTrafficMode(mode: TrafficMode): void {
    if (mode === this.state.trafficMode) return;
    this.state = { ...this.state, trafficMode: mode, selectedId: null };
    this.manager.setSpawning(mode === 'sim');
    this.manager.clearTraffic();
    this.clearLive();
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
    this.state = { ...this.state, live: { count: trails.size, updatedAt: Date.now(), error: false } };
  }

  setLiveError(): void {
    this.state = { ...this.state, live: { ...this.state.live, error: true } };
  }

  private clearLive(): void {
    this.liveTraffic = [];
    this.liveTrails.clear();
    this.state = { ...this.state, live: { count: 0, updatedAt: null, error: false } };
  }

  /** Echte Flieger auf die aktuelle Zeit vorausgerechnet (zwischen zwei Abfragen) */
  private liveNow(): LiveAircraft[] {
    const now = Date.now();
    const out: LiveAircraft[] = [];
    for (const ac of this.liveTraffic) {
      if (ac.ground) continue;
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

      if (!this.state.paused) this.manager.update(dt * this.state.timeScale, ts);

      const aircraft = this.manager.getAll();
      const pendingCmdTypes: Record<string, string[]> = {};
      for (const ac of aircraft) {
        const types = this.manager.getPendingTypes(ac.id);
        if (types.size > 0) pendingCmdTypes[ac.id] = Array.from(types);
      }

      // Remove conflicts where either aircraft has left the radar
      this.conflicts = this.conflicts.filter((c) => {
        return aircraft.some((ac) => ac.id === c.a) && aircraft.some((ac) => ac.id === c.b);
      });

      this.state = { ...this.state, aircraft, conflicts: this.conflicts, pendingCmdTypes };
      this.onStateChange(this.state);

      if (this.renderer && this.airport) {
        this.renderer.render({
          now: ts,
          airport: this.airport,
          aircraft,
          conflicts: this.conflicts,
          waypoints: this.waypoints,
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
          live: this.state.trafficMode === 'live' ? { aircraft: this.liveNow(), trails: this.liveTrails } : undefined,
        });
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
  setTimeScale(s: number):    void { this.state = { ...this.state, timeScale: s };                                    this.trySave(); }
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
    this.state = { ...this.state, activeRunwayIds: next };
    this.manager.setSpawnStars(this.activeStars());
    this.trySave();
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

  selectAircraft(id: string | null): void { this.state = { ...this.state, selectedId: id }; }
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
        trafficMode: this.state.trafficMode,
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
      timeScale: data.timeScale ?? 1,
      display: data.display ?? { ...DEFAULT_DISPLAY },
      activeRunwayIds: data.activeRunwayIds ?? [],
      trafficMode: data.trafficMode ?? 'sim',
    };
    this.manager.setSpawning(this.state.trafficMode === 'sim');
    this.manager.setSpawnStars(this.activeStars());
    this.viewLat = data.viewLat;
    this.viewLng = data.viewLng;
    this.manager.importAircraft(data.aircraft);
    this.manager.importPendingCommands(data.pendingCommands);
  }
}
