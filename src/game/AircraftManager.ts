// filepath: src/game/AircraftManager.ts
import type { Aircraft, ATCCommand, ConflictPair } from '@/types/aircraft';
import type { Airport, Runway } from '@/types/airport';
import type { STAR } from '@/types/navdata';
import type { RadioMessage } from '@/types/radio';
import type { Weather } from '@/types/weather';
import { createAircraft, updateAircraft } from './Aircraft';
import {
  radioContext, instruction, atcCall, readbackCall, initialCall, establishedCall, finalCall, towerCall,
  goAroundCall, endOfStarCall, sayAgainCall, pilotVoice, APPROACH_VOICE, TOWER_VOICE, type Phrase, type RadioContext,
} from './Phraseology';
import { distanceNM, destinationPoint, bearingBetween } from '@/utils/geo';
import { normaliseHdg, headingDiff } from '@/utils/aviation';
import { ORIGINS } from './origins';
import {
  SEP_LATERAL_NM, SEP_VERTICAL_FT,
  WARN_LATERAL_NM, WARN_VERTICAL_FT,
  SPAWN_DISTANCE_NM, MAX_AIRCRAFT,
  AIRCRAFT_TYPES, CALLSIGN_PREFIXES, typeData,
  SPAWN_INTERVAL_MIN_S, SPAWN_INTERVAL_MAX_S,
} from './constants';

type EventType = 'landing' | 'goaround' | 'conflict' | 'warning' | 'clear' | 'radio';
type EventHandler = (event: { type: EventType; callsign?: string; pair?: ConflictPair; message?: RadioMessage }) => void;

/** Echter Flieger (LIVE), zu dem die gelotsten Flieger Abstand halten müssen */
export interface Traffic {
  id: string;
  lat: number;
  lng: number;
  altitudeFt: number;
}

const SPAWN_ATTEMPTS = 20;
const SPAWN_MIN_LATERAL_NM = 8;
const SPAWN_MIN_VERTICAL_FT = 2000;
const SPAWN_RETRY_S = 10;
// Funk: Erstanruf einige Sekunden nach dem Erscheinen, Anrufe mit Abstand nacheinander
const CALL_IN_MIN_S = 3;
const CALL_IN_MAX_S = 10;
const CALL_SPACING_S = 6;
const FINAL_CALL_NM = 4;
// Übernommene echte Flieger melden sich gleich
const ADOPT_CALL_MIN_S = 1;
const ADOPT_CALL_MAX_S = 3;
// Endanflug um den Platz: Abstand zu echtem Verkehr zählt dort nicht (Parallelbahnen, echter Tower)
const FINAL_ZONE_NM = 15;
// Nach der Übergabe meldet sich der Pilot nach dem Frequenzwechsel beim Turm
const TOWER_CALL_MIN_S = 3;
const TOWER_CALL_MAX_S = 6;
// SIM-Startplätze: nicht zu nah am Zielplatz
const ORIGIN_MIN_NM = 150;
// Bahnwechsel: neue STAR nur über einen Punkt in diesem Umkreis vor dem Flieger
const RESTAR_SEARCH_NM = 40;

interface SpawnCandidate {
  lat: number;
  lng: number;
  initHdg: number;
  initAlt: number;
  starId?: string;
  origin?: string;
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
  private towerCalls = new Map<string, number>(); // aircraftId → Simulationszeit der Meldung beim Turm
  private lastCallAt = -Infinity;
  /** Im LIVE-Betrieb entsteht kein erfundener Verkehr */
  private spawning = true;
  // LIVE: echte Anflüge, die sich melden sollen (wartend) bzw. gemeldet haben (Stand beim Anruf)
  private announcements = new Map<string, Aircraft>();
  private announced = new Map<string, Aircraft>();
  private obstacles: Traffic[] = [];

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
    // Wetter des neuen Platzes kommt nach (setWeather)
    this.radio = radioContext(airport, stars);
    // Neuer Platz, neuer Verkehr: Flieger des alten Platzes nicht weiterfliegen lassen
    this.clearTraffic();
  }

  /** Wetter vom Platz (METAR): echtes QNH und Bodenwind im Funk */
  setWeather(weather: Weather | null): void {
    if (this.airport) this.radio = radioContext(this.airport, this.stars, weather);
  }

  /** Hinweis des Spiels im Funk-Log, z. B. ein Wechsel der Landerichtung */
  info(text: string): void {
    this.emit({ type: 'radio', message: { id: ++this.radioSeq, ts: Date.now(), from: 'info', callsign: '', text, spoken: '', ...APPROACH_VOICE } });
  }

  setSpawnStars(stars: STAR[]): void {
    this.spawnStars = stars;
  }

  /**
   * Bahnwechsel: Flieger auf einer STAR der alten Richtung bekommen eine STAR der neuen,
   * möglichst über einen Punkt, den sie ohnehin noch anfliegen ("proceed direct …, then … arrival").
   */
  reassignStars(stars: STAR[], timeScale = 1): void {
    const ids = new Set(stars.map((s) => s.id));
    for (const ac of this.aircraft.values()) {
      if (ac.state !== 'enroute' || ac.clearedILS || ac.directTo || ac.tower || !ac.starId || ids.has(ac.starId)) continue;
      if (this.pendingCommands.some((c) => c.id === ac.id && c.cmd.type === 'star')) continue;
      const old = this.stars.find((s) => s.id === ac.starId);
      const remaining = old?.waypoints.slice(ac.starLegIndex ?? 0) ?? [];
      let pick: { starId: string; waypointId: string } | undefined;
      // Erster noch anzufliegender Punkt, auf dem auch eine neue STAR liegt
      for (const wp of remaining) {
        const st = stars.find((s) => s.waypoints.some((w) => w.id === wp.id));
        if (st) { pick = { starId: st.id, waypointId: wp.id }; break; }
      }
      // Sonst der nächste Punkt einer neuen STAR vor dem Flieger
      if (!pick) {
        let best = RESTAR_SEARCH_NM;
        for (const st of stars) {
          for (const w of st.waypoints) {
            const dist = distanceNM(ac.lat, ac.lng, w.lat, w.lng);
            const ahead = Math.abs(headingDiff(ac.headingDeg, bearingBetween(ac.lat, ac.lng, w.lat, w.lng))) < 90;
            if (ahead && dist < best) { best = dist; pick = { starId: st.id, waypointId: w.id }; }
          }
        }
      }
      if (pick) this.applyCommand(ac.id, { type: 'star', ...pick }, timeScale);
    }
  }

  setSpawning(enabled: boolean): void {
    this.spawning = enabled;
  }

  clearTraffic(): void {
    this.aircraft.clear();
    this.pendingCommands = [];
    this.activePairs.clear();
    this.callIns.clear();
    this.towerCalls.clear();
    this.announcements.clear();
    this.announced.clear();
    this.obstacles = [];
  }

  /** LIVE: echte Anflüge, die sich jetzt melden sollen (nächster zuerst); wer schon gerufen hat oder gelotst wird, fällt heraus */
  setAnnouncements(list: Aircraft[]): void {
    this.announcements = new Map(
      list.filter((ac) => !this.announced.has(ac.id) && !this.aircraft.has(ac.id)).map((ac) => [ac.id, ac]),
    );
  }

  /** Stand des Erstanrufs eines echten Fliegers, falls er sich schon gemeldet hat */
  announcedAs(id: string): Aircraft | undefined {
    return this.announced.get(id);
  }

  /** LIVE: echten Flieger übernehmen; hat er sich noch nicht gemeldet, ruft er gleich an */
  adopt(ac: Aircraft): void {
    const called = this.announced.has(ac.id);
    this.announcements.delete(ac.id);
    this.aircraft.set(ac.id, { ...ac, contacted: called });
    if (!called) this.callIns.set(ac.id, this.simTime + ADOPT_CALL_MIN_S + Math.random() * (ADOPT_CALL_MAX_S - ADOPT_CALL_MIN_S));
  }

  /** LIVE: echte Flieger, die nicht gelotst werden */
  setObstacles(list: Traffic[]): void {
    this.obstacles = list;
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

  /** Funkspruch auf der Frequenz, auf der der Flieger gerade ist (Approach oder Turm) */
  private say(from: 'atc' | 'pilot', ac: Aircraft, phrase: Phrase): void {
    const voice = from === 'pilot' ? pilotVoice(ac.callsign) : ac.tower ? TOWER_VOICE : APPROACH_VOICE;
    this.emit({
      type: 'radio',
      message: {
        id: ++this.radioSeq, ts: Date.now(), from, station: ac.tower ? 'twr' : 'app',
        aircraftId: ac.id, callsign: ac.callsign, text: phrase.text, spoken: phrase.spoken, ...voice,
      },
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
        // Direct-to hebt eine Anflugfreigabe auf; der Flieger fliegt den Punkt direkt an (wieder bei Approach)
        const cleared = { ...updated, clearedILS: false, clearedToLand: false, assignedRunway: undefined, turnDirection: undefined, tower: false };
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
            directTo: undefined, starId: star.id, starLegIndex: idx, state: 'enroute', tower: false,
          };
        }
        break;
      }
      case 'land':
        // Landefreigabe nur für einen Flieger mit zugewiesenem ILS
        applied = ac.clearedILS && !!ac.assignedRunway;
        if (applied) updated = { ...updated, clearedToLand: true };
        break;
      case 'tower':
        // Übergabe an den Turm erst mit ILS-Freigabe; nach dem Rücklesen wechselt der Pilot die Frequenz
        applied = ac.clearedILS && !!ac.assignedRunway && !ac.tower;
        if (applied) {
          updated = { ...updated, tower: true };
          this.towerCalls.set(id, this.simTime + TOWER_CALL_MIN_S + Math.random() * (TOWER_CALL_MAX_S - TOWER_CALL_MIN_S));
        }
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
        this.towerCalls.delete(id);
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
        // Durchstarten: Freigaben weg, Bahnkurs halten, auf 4000 ft steigen – der Lotse muss neu führen.
        // Der Turm gibt den Flieger gleich an Approach zurück
        this.emit({ type: 'goaround', callsign: updated.callsign });
        this.say('pilot', updated, goAroundCall(updated));
        this.towerCalls.delete(id);
        this.aircraft.set(id, {
          ...updated,
          clearedILS: false,
          clearedToLand: false,
          tower: false,
          assignedRunway: undefined,
          targetHeading: runway ? Math.round(runway.heading) : updated.headingDeg,
          targetAltitude: Math.max(4000, Math.round(updated.altitudeFt / 1000) * 1000),
          targetSpeed: Math.min(200, typeData(updated.type).cruiseKts),
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
    if (!this.radio) return;
    // Meldungen beim Turm nach der Übergabe kommen gleich, sie laufen auf einer anderen Frequenz
    for (const [id, at] of this.towerCalls) {
      if (this.simTime < at) continue;
      this.towerCalls.delete(id);
      const ac = this.aircraft.get(id);
      if (ac?.tower && ac.assignedRunway) this.say('pilot', ac, towerCall(ac, this.radio, ac.assignedRunway));
      break;
    }
    if (this.simTime - this.lastCallAt < CALL_SPACING_S) return;
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
    // Danach echte Anflüge, die noch niemand übernommen hat
    const live = this.announcements.values().next().value;
    if (live) {
      this.announcements.delete(live.id);
      this.announced.set(live.id, live);
      this.say('pilot', live, initialCall(live, this.radio));
      this.lastCallAt = this.simTime;
    }
  }

  /** Meldungen der Piloten: Localizer erfasst, kurzer Endanflug ohne Landefreigabe, Ende der STAR */
  private pilotReports(prev: Aircraft, next: Aircraft, runway?: Runway, star?: STAR): void {
    if (!next.contacted) return;
    if (runway && next.state === 'established') {
      // Beim Turm meldet sich der Pilot mit dem Anflug, nicht noch einmal "established"
      if (prev.state !== 'established' && !next.tower) this.say('pilot', next, establishedCall(next, runway.id));
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
    const flags = new Map(list.map((ac) => [ac.id, { conflict: false, warning: false }]));
    const currentPairs = new Set<string>();

    const check = (a: Traffic, b: Traffic) => {
      const lat = distanceNM(a.lat, a.lng, b.lat, b.lng);
      const vert = Math.abs(a.altitudeFt - b.altitudeFt);
      const type = lat < SEP_LATERAL_NM && vert < SEP_VERTICAL_FT ? 'conflict'
        : lat < WARN_LATERAL_NM && vert < WARN_VERTICAL_FT ? 'warning'
        : null;
      if (!type) return;
      const key = [a.id, b.id].sort().join(':');
      currentPairs.add(key);
      for (const id of [a.id, b.id]) {
        const f = flags.get(id);
        if (f) f[type] = true;
      }
      // Neu oder Wechsel zwischen Warnung und Konflikt melden
      if (this.activePairs.get(key) !== type) {
        this.activePairs.set(key, type);
        this.emit({ type, pair: { a: a.id, b: b.id, type, lateralNM: lat, verticalFt: vert } });
      }
    };

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) check(list[i], list[j]);
    }
    // Echter Verkehr zählt wie eigener, echte Flieger untereinander nicht
    for (const ac of list) {
      for (const o of this.obstacles) if (!this.finalZone(ac, o)) check(ac, o);
    }

    for (const ac of list) {
      const f = flags.get(ac.id)!;
      this.aircraft.set(ac.id, { ...ac, conflict: f.conflict, warning: f.warning && !f.conflict });
    }

    // Emit clear for pairs no longer active
    for (const key of this.activePairs.keys()) {
      if (!currentPairs.has(key)) {
        const [aId, bId] = key.split(':');
        this.activePairs.delete(key);
        this.emit({ type: 'clear', pair: { a: aId, b: bId, type: 'warning', lateralNM: 0, verticalFt: 0 } });
      }
    }
  }

  /** Im Endanflug lotst bei echtem Verkehr der echte Tower; Parallelanflüge wären sonst ständig "Konflikte" */
  private finalZone(ac: Aircraft, o: Traffic): boolean {
    return ac.clearedILS && !!this.airport && distanceNM(o.lat, o.lng, this.airport.lat, this.airport.lng) < FINAL_ZONE_NM;
  }

  private spawnCandidate(): SpawnCandidate {
    const airport = this.airport!;
    let lat: number, lng: number, initHdg: number;
    let star: STAR | undefined;
    // Startplatz würfeln; er bestimmt die Richtung, aus der der Flieger kommt
    const origins = ORIGINS.filter((o) => o.icao !== airport.icao && distanceNM(o.lat, o.lng, airport.lat, airport.lng) >= ORIGIN_MIN_NM);
    const origin = origins.length > 0 ? origins[Math.floor(Math.random() * origins.length)] : undefined;

    if (this.spawnStars.length > 0) {
      // Einflugpunkt in Richtung des Startplatzes, davon eine STAR der aktiven Bahnen; Start 15–20 NM davor
      star = origin ? this.starFrom(bearingBetween(airport.lat, airport.lng, origin.lat, origin.lng)) : undefined;
      star ??= this.spawnStars[Math.floor(Math.random() * this.spawnStars.length)];
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
      const pos = this.randomEntryPoint(origin && bearingBetween(airport.lat, airport.lng, origin.lat, origin.lng));
      lat = pos.lat;
      lng = pos.lng;
      initHdg = Math.round(bearingBetween(lat, lng, airport.lat, airport.lng));
    }

    // Altitude: at or above first STAR leg restriction (or random FL100–FL180)
    const firstAltRestr = star?.legs[0]?.altRestrictionFt;
    const initAlt = firstAltRestr
      ? firstAltRestr + Math.floor(Math.random() * 2000)
      : 10000 + Math.floor(Math.random() * 8000);

    return { lat, lng, initHdg, initAlt, starId: star?.id, origin: origin?.icao };
  }

  /** STAR der aktiven Bahnen, deren Einflugpunkt am besten in Richtung des Startplatzes liegt */
  private starFrom(bearing: number): STAR | undefined {
    const airport = this.airport!;
    const offset = (st: STAR) => {
      const fix = st.waypoints[0];
      return fix ? Math.abs(headingDiff(bearing, bearingBetween(airport.lat, airport.lng, fix.lat, fix.lng))) : Infinity;
    };
    const best = Math.min(...this.spawnStars.map(offset));
    if (!Number.isFinite(best)) return undefined;
    const fitting = this.spawnStars.filter((st) => offset(st) - best < 1);
    return fitting[Math.floor(Math.random() * fitting.length)];
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
    const { lat, lng, initHdg, initAlt, starId, origin } = spawn;
    const starLegIndex = 0;

    const types = Object.keys(AIRCRAFT_TYPES);
    const type = types[Math.floor(Math.random() * types.length)];
    const perf = AIRCRAFT_TYPES[type];
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
      speedKts: perf.cruiseKts,
      verticalSpeedFpm: 0,
      targetHeading: initHdg,
      targetAltitude: initAlt,
      targetSpeed: perf.cruiseKts,
      state: 'enroute',
      clearedILS: false,
      starId,
      starLegIndex,
      origin,
    });

    this.aircraft.set(id, ac);
    this.callIns.set(id, this.simTime + CALL_IN_MIN_S + Math.random() * (CALL_IN_MAX_S - CALL_IN_MIN_S));
    return true;
  }

  private randomEntryPoint(towards?: number): { lat: number; lng: number } {
    if (!this.airport) return { lat: 0, lng: 0 };
    const bearing = towards !== undefined ? towards + (Math.random() - 0.5) * 30 : Math.random() * 360;
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
