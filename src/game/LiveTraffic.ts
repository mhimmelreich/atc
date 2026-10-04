// filepath: src/game/LiveTraffic.ts
// Echte Flieger (LIVE): Anflüge zum gewählten Platz erkennen und zum Lotsen übernehmen
import type { Aircraft } from '@/types/aircraft';
import type { Airport, Runway } from '@/types/airport';
import type { LiveAircraft } from '@/types/live';
import type { STAR } from '@/types/navdata';
import { createAircraft } from './Aircraft';
import { typeData } from './constants';
import { headingDiff } from '@/utils/aviation';
import { bearingBetween, distanceNM } from '@/utils/geo';

// Erstanruf, solange der Anflug zwischen diesen Entfernungen zum Platz ist
const CALL_IN_MAX_NM = 40;
const CALL_IN_MIN_NM = 15;
const CALL_IN_MIN_FT = 4000;
// Näher am Platz hat der Tower den Flieger: keine Übernahme mehr
const TAKEOVER_MIN_NM = 8;
const STAR_SEARCH_NM = 80;
// Endanflug erkannt: höchstens so weit von der Schwelle und so weit neben der Anfluggrundlinie
const FINAL_MAX_NM = 20;
const FINAL_MAX_DEV_DEG = 3;

export const liveId = (hex: string): string => `live-${hex}`;
export const hexOf = (id: string): string | null => (id.startsWith('live-') ? id.slice(5) : null);

export interface Inbound {
  /** route: Ziel laut Flugroute; guess: ohne Route nach Lage, Höhe und Kurs geschätzt */
  kind: 'route' | 'guess';
  origin?: string;
}

/** Fliegt der echte Flieger den gewählten Platz an (und ist noch nicht beim Tower)? */
export function inbound(ac: LiveAircraft, airport: Airport): Inbound | null {
  if (ac.ground || ac.altFt === null) return null;
  const dist = distanceNM(ac.lat, ac.lng, airport.lat, airport.lng);
  if (dist < TAKEOVER_MIN_NM) return null;
  const vs = ac.vs ?? 0;
  const off = ac.track === null
    ? 180
    : Math.abs(headingDiff(ac.track, bearingBetween(ac.lat, ac.lng, airport.lat, airport.lng)));
  if (ac.route) {
    // Bei Zwischenlandungen steht der Platz mitten in der Route; als Start zählt er nicht
    const codes = ac.route.split('-');
    const idx = codes.lastIndexOf(airport.icao);
    if (idx <= 0 || vs > 1000 || (dist > 25 && off > 100)) return null;
    return { kind: 'route', origin: codes[idx - 1] };
  }
  // Ohne Route: tief oder im Sinkflug, nicht steigend und genau auf den Platz zu,
  // aber nicht viel tiefer als der Gleitpfad (sonst landet er eher auf einem Platz in der Nähe)
  const low = ac.altFt < 8000 || (ac.altFt < 15000 && vs < -300);
  const aboveGlidepath = ac.altFt - airport.elevationFt > dist * 150;
  return dist < 50 && low && aboveGlidepath && vs <= 300 && off < 30 ? { kind: 'guess' } : null;
}

/** Soll sich der Anflug jetzt bei Approach melden? Nur bei bekanntem Ziel, damit keine Fremden anrufen */
export function callsIn(ac: LiveAircraft, inb: Inbound, airport: Airport): boolean {
  const dist = distanceNM(ac.lat, ac.lng, airport.lat, airport.lng);
  return inb.kind === 'route' && dist <= CALL_IN_MAX_NM && dist >= CALL_IN_MIN_NM && (ac.altFt ?? 0) >= CALL_IN_MIN_FT;
}

/** Freigegebene Höhe beim Übernehmen: im Sinkflug etwa 2000 ft tiefer, aber nicht unter 4000 ft; sonst die aktuelle */
function takeoverLevel(altFt: number, vs: number): number {
  const level = Math.max(1000, Math.round(altFt / 1000) * 1000);
  if (vs > -300) return level;
  return Math.max(Math.min(level, 4000), Math.floor((altFt - 2000) / 1000) * 1000);
}

/** Nächster STAR-Punkt vor dem Flieger; bevorzugt die STAR, die der Pilot gemeldet hat */
function starEntry(lat: number, lng: number, track: number, stars: STAR[], preferId?: string): { starId: string; index: number } | null {
  const search = (list: STAR[]) => {
    let best: { starId: string; index: number; dist: number } | null = null;
    for (const star of list) {
      for (let index = 0; index < star.waypoints.length; index++) {
        const wp = star.waypoints[index];
        const dist = distanceNM(lat, lng, wp.lat, wp.lng);
        const ahead = Math.abs(headingDiff(track, bearingBetween(lat, lng, wp.lat, wp.lng))) < 70;
        if (ahead && dist < STAR_SEARCH_NM && (!best || dist < best.dist)) best = { starId: star.id, index, dist };
      }
    }
    return best;
  };
  const hit = (preferId ? search(stars.filter((s) => s.id === preferId)) : null) ?? search(stars);
  return hit && { starId: hit.starId, index: hit.index };
}

/** Fliegt er schon auf dem Localizer einer aktiven Bahn? Dann hat er die ILS-Freigabe längst */
function finalRunway(ac: LiveAircraft, airport: Airport, activeRunwayIds: string[]): Runway | undefined {
  const track = ac.track;
  if (track === null) return undefined;
  let best: { rwy: Runway; dev: number } | undefined;
  for (const rwy of airport.runways) {
    if (!rwy.ils || (activeRunwayIds.length > 0 && !activeRunwayIds.includes(rwy.id))) continue;
    const dist = distanceNM(ac.lat, ac.lng, rwy.thresholdLat, rwy.thresholdLng);
    const dev = Math.abs(headingDiff(rwy.heading, bearingBetween(ac.lat, ac.lng, rwy.thresholdLat, rwy.thresholdLng)));
    if (dist < FINAL_MAX_NM && dev < FINAL_MAX_DEV_DEG && Math.abs(headingDiff(track, rwy.heading)) < 20 && (!best || dev < best.dev)) {
      best = { rwy, dev };
    }
  }
  return best?.rwy;
}

export interface TakeoverContext {
  airport: Airport;
  /** STARs der aktiven Bahnen */
  stars: STAR[];
  activeRunwayIds: string[];
}

/**
 * Echten Flieger als lotsbaren Flieger anlegen: Lage aus den Live-Daten, weiter über die nächste STAR
 * oder, wenn er schon auf dem Endanflug ist, mit ILS-Freigabe. Hat er sich schon gemeldet (called),
 * gelten die gemeldete STAR und Höhe.
 */
export function liveToAircraft(ac: LiveAircraft, ctx: TakeoverContext, origin?: string, called?: Aircraft): Aircraft {
  const { airport } = ctx;
  const alt = Math.max(0, Math.round(ac.altFt ?? 0));
  const track = Math.round(ac.track ?? bearingBetween(ac.lat, ac.lng, airport.lat, airport.lng));
  const type = ac.type ?? 'A320';
  const gs = Math.round(ac.gs ?? typeData(type).cruiseKts);
  const final = finalRunway(ac, airport, ctx.activeRunwayIds);
  const entry = final ? null : starEntry(ac.lat, ac.lng, track, ctx.stars, called?.starId);
  return createAircraft({
    id: liveId(ac.hex),
    callsign: ac.callsign,
    type,
    lat: ac.lat,
    lng: ac.lng,
    altitudeFt: alt,
    headingDeg: track,
    speedKts: gs,
    verticalSpeedFpm: ac.vs ?? 0,
    targetHeading: track,
    targetAltitude: called && called.targetAltitude <= alt + 300 ? called.targetAltitude : takeoverLevel(alt, ac.vs ?? 0),
    // Unter FL100 höchstens 250 kt
    targetSpeed: alt < 10000 ? Math.min(gs, 250) : gs,
    state: entry ? 'enroute' : 'vectored',
    clearedILS: !!final,
    assignedRunway: final?.id,
    starId: entry?.starId,
    starLegIndex: entry?.index,
    liveHex: ac.hex,
    origin,
  });
}
