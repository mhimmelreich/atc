// filepath: src/game/AircraftManager.ts
import type { Aircraft, ATCCommand, ConflictPair } from '@/types/aircraft';
import type { Airport, Runway } from '@/types/airport';
import type { STAR } from '@/types/navdata';
import type { RadioMessage } from '@/types/radio';
import { createAircraft, updateAircraft } from './Aircraft';
import {
  radioContext, instruction, atcCall, readbackCall, initialCall, establishedCall, finalCall,
  goAroundCall, endOfStarCall, sayAgainCall, pilotVoice, type Phrase, type RadioContext,
} from './Phraseology';
import { distanceNM, destinationPoint, bearingBetween } from '@/utils/geo';
import { normaliseHdg } from '@/utils/aviation';
import {
  SEP_LATERAL_NM, SEP_VERTICAL_FT,
  WARN_LATERAL_NM, WARN_VERTICAL_FT,
  SPAWN_DISTANCE_NM, MAX_AIRCRAFT,
  AIRCRAFT_TYPES, CALLSIGN_PREFIXES,
  SPAWN_INTERVAL_MIN_S, SPAWN_INTERVAL_MAX_S,
} from './constants';

type EventType = 'landing' | 'goaround' | 'conflict' | 'warning' | 'clear' | 'radio';
type EventHandler = (event: { type: EventType; callsign?: string; pair?: ConflictPair; message?: RadioMessage }) => void;

const SPAWN_ATTEMPTS = 20;
const SPAWN_MIN_LATERAL_NM = 8;
const SPAWN_MIN_VERTICAL_FT = 2000;
const SPAWN_RETRY_S = 10;
// Funk: Erstanruf einige Sekunden nach dem Erscheinen, Anrufe mit Abstand nacheinander
const CALL_IN_MIN_S = 3;
const CALL_IN_MAX_S = 10;
const CALL_SPACING_S = 6;
const FINAL_CALL_NM = 4;

interface SpawnCandidate {
  lat: number;
  lng: number;
  initHdg: number;
  initAlt: number;
  starId?: string;
}

export class AircraftManager {
  private aircraft: Map<string, Aircraft> = new Map();
  private airport: Airport | null = null;
  private stars: STAR[] = [];
  private spawnStars: STAR[] = []; // STARs der aktiven Bahnen
  private listeners: EventHandler[] = [];
  private nextSpawnIn: number;
  private usedCallsigns = new Set<string>();
  // ATC reaction delay: pilot reads back, then acts (1–3 s)
  private pendingCommands: Array<{ id: string; cmd: ATCCommand; executeAt: number; readback?: Phrase }> = [];
  // Track active conflict/warning pairs to emit clear on resolution
  private activePairs = new Map<string, 'conflict' | 'warning'>(); // key: sorted ids
  private radio: RadioContext | null = null;
  private radioSeq = 0;
  private simTime = 0;
  private callIns = new Map<string, number>(); // aircraftId → Simulationszeit des Erstanrufs
  private lastCallAt = -Infinity;
  /** Im LIVE-Betrieb entsteht kein erfundener Verkehr */
  private spawning = true;

  constructor() {
    this.nextSpawnIn = this.randomSpawnInterval();
  }

  private randomSpawnInterval(): number {
    return (
      SPAWN_INTERVAL_MIN_S +
      Math.random() * (SPAWN_INTERVAL_MAX_S - SPAWN_INTERVAL_MIN_S)
    );
  }

  setAirport(airport: Airport, stars: STAR[] = []): void {
    this.airport = airport;
    this.stars = stars;
    this.spawnStars = stars;
    this.radio = radioContext(airport, stars);
    // Neuer Platz, neuer Verkehr: Flieger des alten Platzes nicht weiterfliegen lassen
    this.clearTraffic();
  }

  setSpawnStars(stars: STAR[]): void {
    this.spawnStars = stars;
  }

  setSpawning(enabled: boolean): void {
    this.spawning = enabled;
  }

  clearTraffic(): void {
    this.aircraft.clear();
    this.pendingCommands = [];
    this.activePairs.clear();
    this.callIns.clear();
  }

  on(handler: EventHandler): void {
    this.listeners.push(handler);
  }

  private emit(event: Parameters<EventHandler>[0]): void {
    this.listeners.forEach((h) => h(event));
  }

  getAll(): Aircraft[] {
    return Array.from(this.aircraft.values());
  }

  get(id: string): Aircraft | undefined {
    return this.aircraft.get(id);
  }

  applyCommand(id: string, cmd: ATCCommand, timeScale = 1): void {
    // Queue with pilot reaction delay (1–3 s), scaled by simulation speed.
    // Befehle an denselben Flieger in Reihenfolge ausführen (z. B. erst ILS, dann Landefreigabe)
    const delaySec = (1 + Math.random() * 2) / timeScale;
    const queued = this.pendingCommands.filter((c) => c.id === id);
    const executeAt = Math.max(performance.now() + delaySec * 1000, ...queued.map((c) => c.executeAt + 500 / timeScale));
    let readback: Phrase | undefined;
    const ac = this.aircraft.get(id);
    if (ac && this.radio) {
      // Landefreigabe direkt nach der ILS-Freigabe: Bahn aus dem noch wartenden ILS-Befehl
      const ils = queued.map((c) => c.cmd).filter((c) => c.type === 'ils').pop();
      const phrases = instruction(ac, cmd, this.radio, ils?.type === 'ils' ? ils.runwayId : ac.assignedRunway);
      if (phrases) {
        this.say('atc', ac, atcCall(ac, phrases.atc, !ac.identified));
        readback = readbackCall(ac, phrases.readback);
        // Wer angesprochen wurde, meldet sich nicht mehr erstmals
        this.aircraft.set(id, { ...ac, contacted: true, identified: true });
        this.callIns.delete(id);
      }
    }
    this.pendingCommands.push({ id, cmd, executeAt, readback });
  }

  private say(from: RadioMessage['from'], ac: Aircraft, phrase: Phrase): void {
    const voice = from === 'atc' ? { voice: 'atc' as const, speaker: 0 } : pilotVoice(ac.callsign);
    this.emit({
      type: 'radio',
      message: { id: ++this.radioSeq, ts: Date.now(), from, aircraftId: ac.id, callsign: ac.callsign, text: phrase.text, spoken: phrase.spoken, ...voice },
    });
  }

  private executeCommand(id: string, cmd: ATCCommand, readback?: Phrase): void {
    const ac = this.aircraft.get(id);
    if (!ac) return;
    let updated = { ...ac };
    let applied = true;
    switch (cmd.type) {
      case 'heading':
        updated = { ...updated, targetHeading: cmd.value, turnDirection: cmd.turnDirection, directTo: undefined, state: ac.state === 'enroute' || ac.state === 'goaround' ? 'vectored' : ac.state };
        break;
      case 'altitude':
        updated = { ...updated, targetAltitude: cmd.value };
        break;
      case 'speed':
        updated = { ...updated, targetSpeed: cmd.value };
        break;
      case 'ils': {
        const runway = this.airport?.runways.find((r) => r.id === cmd.runwayId);
        applied = !!runway;
        if (runway) {
          updated = {
            ...updated,
            clearedILS: true,
            assignedRunway: cmd.runwayId,
            directTo: undefined,
            // Bahnwechsel hebt eine erteilte Landefreigabe auf
            clearedToLand: ac.assignedRunway === cmd.runwayId ? ac.clearedToLand : false,
            state: ac.state === 'enroute' || ac.state === 'vectored' || ac.state === 'goaround' ? 'vectored' : ac.state,
          };
        }
        break;
      }
      case 'direct': {
        // Direct-to hebt eine Anflugfreigabe auf; der Flieger fliegt den Punkt direkt an
        const cleared = { ...updated, clearedILS: false, clearedToLand: false, assignedRunway: undefined, turnDirection: undefined };
        const star = ac.starId ? this.stars.find((s) => s.id === ac.starId) : undefined;
        const starIdx = star ? star.waypoints.findIndex((w) => w.id === cmd.waypointId) : -1;
        if (starIdx >= 0) {
          // Punkt liegt auf der eigenen STAR → Abkürzung, danach geht es mit der STAR weiter
          updated = { ...cleared, state: 'enroute', starLegIndex: starIdx, directTo: undefined };
        } else {
          updated = { ...cleared, state: 'vectored', directTo: { id: cmd.waypointId, lat: cmd.lat, lng: cmd.lng } };
        }
        break;
      }
      case 'star': {
        // Anflugpunkt + STAR: Punkt direkt anfliegen, danach der STAR folgen (hebt Anflugfreigabe auf)
        const star = this.stars.find((s) => s.id === cmd.starId);
        const idx = star ? star.waypoints.findIndex((w) => w.id === cmd.waypointId) : -1;
        applied = !!star && idx >= 0;
        if (star && idx >= 0) {
          updated = {
            ...updated,
            clearedILS: false, clearedToLand: false, assignedRunway: undefined, turnDirection: undefined,
            directTo: undefined, starId: star.id, starLegIndex: idx, state: 'enroute',
          };
        }
        break;
      }
      case 'land':
        // Landefreigabe nur für einen Flieger mit zugewiesenem ILS
        applied = ac.clearedILS && !!ac.assignedRunway;
        if (applied) updated = { ...updated, clearedToLand: true };
        break;
    }
    this.aircraft.set(id, updated);
    // Rücklesen; passt die Freigabe nicht zur Lage, fragt der Pilot nach
    if (!applied) this.say('pilot', ac, sayAgainCall(ac));
    else if (readback) this.say('pilot', ac, readback);
  }

  update(dt: number, now: number): void {
    if (!this.airport) return;

    this.simTime += dt;

    // Execute due pending commands
    const nowMs = performance.now();
    const due = this.pendingCommands.filter((c) => c.executeAt <= nowMs);
    this.pendingCommands  = this.pendingCommands.filter((c) => c.executeAt >  nowMs);
    for (const { id, cmd, readback } of due) this.executeCommand(id, cmd, readback);

    this.radioCallIns();

    // Spawn timer
    this.nextSpawnIn -= dt;
    if (this.spawning && this.nextSpawnIn <= 0 && this.aircraft.size < MAX_AIRCRAFT) {
      this.nextSpawnIn = this.spawnAircraft() ? this.randomSpawnInterval() : SPAWN_RETRY_S;
    }

    // Update all aircraft
    for (const [id, ac] of this.aircraft) {
      const runway = ac.assignedRunway
        ? this.airport.runways.find((r) => r.id === ac.assignedRunway)
        : undefined;
      const star = ac.starId ? this.stars.find((s) => s.id === ac.starId) : undefined;
      const { updated, remove } = updateAircraft(ac, dt, now, runway, star);
      if (remove) {
        this.aircraft.delete(id);
        // Clean up activePairs for removed aircraft
        for (const key of this.activePairs.keys()) {
          if (key.includes(id)) this.activePairs.delete(key);
        }
        if (updated.state === 'landed') {
          this.emit({ type: 'landing', callsign: updated.callsign });
        } else if (updated.state === 'goaround') {
          this.emit({ type: 'goaround', callsign: updated.callsign });
        }
      } else if (updated.state === 'goaround' && ac.state !== 'goaround') {
        // Durchstarten: Freigaben weg, Bahnkurs halten, auf 4000 ft steigen – der Lotse muss neu führen
        this.emit({ type: 'goaround', callsign: updated.callsign });
        this.say('pilot', updated, goAroundCall(updated));
        const typeData = AIRCRAFT_TYPES[updated.type];
        this.aircraft.set(id, {
          ...updated,
          clearedILS: false,
          clearedToLand: false,
          assignedRunway: undefined,
          targetHeading: runway ? Math.round(runway.heading) : updated.headingDeg,
          targetAltitude: Math.max(4000, Math.round(updated.altitudeFt / 1000) * 1000),
          targetSpeed: Math.min(200, typeData?.cruiseKts ?? 200),
          turnDirection: undefined,
        });
      } else {
        this.aircraft.set(id, updated);
        this.pilotReports(ac, updated, runway, star);
      }
    }

    this.checkSeparation();
  }

  /** Erstanrufe neuer Flieger, höchstens einer je Frame und mit Abstand zum letzten */
  private radioCallIns(): void {
    if (!this.radio || this.simTime - this.lastCallAt < CALL_SPACING_S) return;
    for (const [id, at] of this.callIns) {
      if (this.simTime < at) continue;
      this.callIns.delete(id);
      const ac = this.aircraft.get(id);
      if (!ac || ac.contacted) continue;
      this.aircraft.set(id, { ...ac, contacted: true });
      this.say('pilot', ac, initialCall(ac, this.radio));
      this.lastCallAt = this.simTime;
      return;
    }
  }

  /** Meldungen der Piloten: Localizer erfasst, kurzer Endanflug ohne Landefreigabe, Ende der STAR */
  private pilotReports(prev: Aircraft, next: Aircraft, runway?: Runway, star?: STAR): void {
    if (!next.contacted) return;
    if (runway && next.state === 'established') {
      if (prev.state !== 'established') this.say('pilot', next, establishedCall(next, runway.id));
      const before = distanceNM(prev.lat, prev.lng, runway.thresholdLat, runway.thresholdLng);
      const after = distanceNM(next.lat, next.lng, runway.thresholdLat, runway.thresholdLng);
      if (!next.clearedToLand && before >= FINAL_CALL_NM && after < FINAL_CALL_NM) {
        this.say('pilot', next, finalCall(next, runway.id, FINAL_CALL_NM));
      }
    }
    const end = star?.waypoints.length ?? Infinity;
    if ((prev.starLegIndex ?? 0) < end && (next.starLegIndex ?? 0) >= end
      && next.state === 'enroute' && !next.clearedILS && !next.directTo) {
      this.say('pilot', next, endOfStarCall(next));
    }
  }

  private checkSeparation(): void {
    const list = Array.from(this.aircraft.values());
    // Track which pairs are currently active this frame
    const currentPairs = new Set<string>();

    for (let i = 0; i < list.length; i++) {
      let conflictI = false;
      let warningI = false;
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const lat = distanceNM(a.lat, a.lng, b.lat, b.lng);
        const vert = Math.abs(a.altitudeFt - b.altitudeFt);
        const key = [a.id, b.id].sort().join(':');

        const isConflict = lat < SEP_LATERAL_NM && vert < SEP_VERTICAL_FT;
        const isWarning = !isConflict && lat < WARN_LATERAL_NM && vert < WARN_VERTICAL_FT;

        if (isConflict) {
          conflictI = true;
          currentPairs.add(key);
          const bUpdated = this.aircraft.get(b.id);
          if (bUpdated) this.aircraft.set(b.id, { ...bUpdated, conflict: true, warning: false });
          if (this.activePairs.get(key) !== 'conflict') {
            this.activePairs.set(key, 'conflict');
            this.emit({ type: 'conflict', pair: { a: a.id, b: b.id, type: 'conflict', lateralNM: lat, verticalFt: vert } });
          }
        } else if (isWarning) {
          warningI = true;
          currentPairs.add(key);
          const bUpdated = this.aircraft.get(b.id);
          if (bUpdated) this.aircraft.set(b.id, { ...bUpdated, conflict: false, warning: true });
          if (!this.activePairs.has(key)) {
            this.activePairs.set(key, 'warning');
            this.emit({ type: 'warning', pair: { a: a.id, b: b.id, type: 'warning', lateralNM: lat, verticalFt: vert } });
          } else if (this.activePairs.get(key) === 'conflict') {
            // downgrade conflict → warning
            this.activePairs.set(key, 'warning');
            this.emit({ type: 'warning', pair: { a: a.id, b: b.id, type: 'warning', lateralNM: lat, verticalFt: vert } });
          }
        } else {
          const bUpdated = this.aircraft.get(b.id);
          if (bUpdated) this.aircraft.set(b.id, { ...bUpdated, conflict: false, warning: false });
        }
      }
      const aUpdated = this.aircraft.get(list[i].id);
      if (aUpdated) {
        this.aircraft.set(list[i].id, { ...aUpdated, conflict: conflictI, warning: warningI && !conflictI });
      }
    }

    // Emit clear for pairs no longer active
    for (const [key, _] of this.activePairs) {
      if (!currentPairs.has(key)) {
        const [aId, bId] = key.split(':');
        this.activePairs.delete(key);
        this.emit({ type: 'clear', pair: { a: aId, b: bId, type: 'warning', lateralNM: 0, verticalFt: 0 } });
      }
    }
  }

  private spawnCandidate(): SpawnCandidate {
    const airport = this.airport!;
    let lat: number, lng: number, initHdg: number;
    let star: STAR | undefined;

    if (this.spawnStars.length > 0) {
      // Pick a random STAR and spawn 15–20 NM before its entry fix
      star = this.spawnStars[Math.floor(Math.random() * this.spawnStars.length)];
      const entryFix = star.waypoints[0];
      const nextFix = star.waypoints[1] ?? { lat: airport.lat, lng: airport.lng };
      // Inbound track: entry → next; spawn on reciprocal (behind the fix)
      const inboundBearing = bearingBetween(entryFix.lat, entryFix.lng, nextFix.lat, nextFix.lng);
      const spawnDist = 15 + Math.random() * 5;
      const spawnPos = destinationPoint(entryFix.lat, entryFix.lng, normaliseHdg(inboundBearing + 180), spawnDist);
      lat = spawnPos.lat;
      lng = spawnPos.lng;
      initHdg = Math.round(bearingBetween(lat, lng, entryFix.lat, entryFix.lng));
    } else {
      const pos = this.randomEntryPoint();
      lat = pos.lat;
      lng = pos.lng;
      initHdg = Math.round(bearingBetween(lat, lng, airport.lat, airport.lng));
    }

    // Altitude: at or above first STAR leg restriction (or random FL100–FL180)
    const firstAltRestr = star?.legs[0]?.altRestrictionFt;
    const initAlt = firstAltRestr
      ? firstAltRestr + Math.floor(Math.random() * 2000)
      : 10000 + Math.floor(Math.random() * 8000);

    return { lat, lng, initHdg, initAlt, starId: star?.id };
  }

  /** ≥ 1, wenn der Kandidat zu allen Flugzeugen seitlich oder vertikal genug Abstand hat */
  private separationScore(c: SpawnCandidate): number {
    let score = Infinity;
    for (const ac of this.aircraft.values()) {
      const lateral = distanceNM(c.lat, c.lng, ac.lat, ac.lng) / SPAWN_MIN_LATERAL_NM;
      const vertical = Math.abs(c.initAlt - ac.altitudeFt) / SPAWN_MIN_VERTICAL_FT;
      score = Math.min(score, Math.max(lateral, vertical));
    }
    return score;
  }

  /** Returns false if no conflict-free spawn position was found */
  private spawnAircraft(): boolean {
    if (!this.airport) return false;
    // Mehrere Kandidaten würfeln und den ersten mit sicherem Abstand zum Verkehr nehmen
    let spawn: SpawnCandidate | null = null;
    let bestSep = -1;
    for (let i = 0; i < SPAWN_ATTEMPTS; i++) {
      const cand = this.spawnCandidate();
      const sep = this.separationScore(cand);
      if (sep > bestSep) { spawn = cand; bestSep = sep; }
      if (sep >= 1) break;
    }
    // Kein freier Einstieg → später erneut versuchen statt einen Konflikt zu erzeugen
    if (!spawn || bestSep < 1) return false;
    const { lat, lng, initHdg, initAlt, starId } = spawn;
    const starLegIndex = 0;

    const types = Object.keys(AIRCRAFT_TYPES);
    const type = types[Math.floor(Math.random() * types.length)];
    const typeData = AIRCRAFT_TYPES[type];
    const callsign = this.generateCallsign();
    const id = `${callsign}-${Date.now()}`;

    const ac = createAircraft({
      id,
      callsign,
      type,
      lat,
      lng,
      altitudeFt: initAlt,
      headingDeg: initHdg,
      speedKts: typeData.cruiseKts,
      verticalSpeedFpm: 0,
      targetHeading: initHdg,
      targetAltitude: initAlt,
      targetSpeed: typeData.cruiseKts,
      state: 'enroute',
      clearedILS: false,
      starId,
      starLegIndex,
    });

    this.aircraft.set(id, ac);
    this.callIns.set(id, this.simTime + CALL_IN_MIN_S + Math.random() * (CALL_IN_MAX_S - CALL_IN_MIN_S));
    return true;
  }

  private randomEntryPoint(): { lat: number; lng: number } {
    if (!this.airport) return { lat: 0, lng: 0 };
    const bearing = Math.random() * 360;
    const dist = SPAWN_DISTANCE_NM * (0.55 + Math.random() * 0.45);
    return destinationPoint(this.airport.lat, this.airport.lng, bearing, dist);
  }

  private generateCallsign(): string {
    let callsign: string;
    let attempts = 0;
    do {
      const prefix = CALLSIGN_PREFIXES[Math.floor(Math.random() * CALLSIGN_PREFIXES.length)];
      const num = Math.floor(100 + Math.random() * 900);
      callsign = `${prefix}${num}`;
      attempts++;
    } while (this.usedCallsigns.has(callsign) && attempts < 50);
    this.usedCallsigns.add(callsign);
    return callsign;
  }

  /** Returns command types currently queued (reaction delay) for an aircraft */
  getPendingTypes(aircraftId: string): Set<ATCCommand['type']> {
    const out = new Set<ATCCommand['type']>();
    for (const c of this.pendingCommands) {
      if (c.id === aircraftId) out.add(c.cmd.type);
    }
    return out;
  }

  exportAircraft(): Aircraft[] {
    return Array.from(this.aircraft.values());
  }

  exportPendingCommands(): Array<{ id: string; cmd: ATCCommand; remainingMs: number }> {
    const now = performance.now();
    return this.pendingCommands
      .filter((c) => c.executeAt > now)
      .map((c) => ({ id: c.id, cmd: c.cmd, remainingMs: c.executeAt - now }));
  }

  importAircraft(aircraft: Aircraft[]): void {
    this.aircraft.clear();
    for (const ac of aircraft) {
      // Clear trails: rAF timestamps from prior session are incompatible with new session's now
      this.aircraft.set(ac.id, { ...ac, trail: [], conflict: false, warning: false });
      this.usedCallsigns.add(ac.callsign);
    }
    // Wer sich vor dem Neuladen noch nicht gemeldet hatte, ruft jetzt an
    this.callIns.clear();
    for (const ac of aircraft) {
      if (!ac.contacted) this.callIns.set(ac.id, this.simTime + CALL_IN_MIN_S + Math.random() * (CALL_IN_MAX_S - CALL_IN_MIN_S));
    }
  }

  importPendingCommands(commands: Array<{ id: string; cmd: ATCCommand; remainingMs: number }>): void {
    const now = performance.now();
    this.pendingCommands = commands.map((c) => ({ id: c.id, cmd: c.cmd, executeAt: now + c.remainingMs }));
  }

  /** Force-spawn for testing/demo */
  forceSpawn(): void {
    this.spawnAircraft();
  }
}
