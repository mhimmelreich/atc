// filepath: src/game/StarMatch.ts
// WATCH: Welche STAR fliegt ein echter Anflug? ADS-B sendet sie nicht und Flugpläne sind nicht öffentlich,
// also wird die Flugbahn mit den STARs des Platzes verglichen: überflogene Punkte und Abstand zur Strecke.
import type { STAR, Waypoint } from '@/types/navdata';

/** Punkt gilt als überflogen, wenn die Flugbahn so nah daran vorbeiführt */
const PASS_NM = 2.5;
/** Flugbahnpunkte so nah an der STAR-Strecke zählen als "auf der STAR" */
const ON_ROUTE_NM = 3;
/** Vor dem ersten Punkt: Kurs höchstens so weit neben dem Eintrittspunkt */
const ENTRY_MAX_DEV_DEG = 10;
const ENTRY_MAX_NM = 80;
/** Letzte Minuten der Flugbahn für die Frage, ob er noch auf der STAR ist oder Vektoren fliegt */
const RECENT_MS = 3 * 60_000;

export interface StarGuess {
  /** Anzeigename der Prozedur, z. B. "KERAX 6A" */
  name: string;
  /** Bahnen, für die diese STAR gilt (bei gleichem Verlauf mehrere) */
  runways: string[];
  /** on: auf der STAR; entry: fliegt auf ihren Eintrittspunkt zu; vectors: hat sie verlassen (Radarvektoren) */
  status: 'on' | 'entry' | 'vectors';
  /** Nächster Punkt der STAR (bei on/entry) */
  next?: string;
  /** Überflogene STAR-Punkte */
  passed: number;
}

interface Pt { lat: number; lng: number; ts?: number }

/**
 * Wahrscheinliche STAR aus der bisherigen Flugbahn (älteste zuerst, letzter Punkt = jetzt) und dem Kurs.
 * activeRunwayIds: bei gleichem Verlauf wird die Variante der aktiven Bahn bevorzugt.
 */
export function guessStar(track: Pt[], heading: number | null, stars: STAR[], activeRunwayIds: string[]): StarGuess | null {
  if (track.length === 0 || stars.length === 0) return null;
  const ref = track[track.length - 1];
  const cosLat = Math.cos((ref.lat * Math.PI) / 180);
  const xy = (p: { lat: number; lng: number }) => ({ x: (p.lng - ref.lng) * 60 * cosLat, y: (p.lat - ref.lat) * 60 });
  const pts = track.map(xy);
  const now = ref.ts ?? Date.now();
  const recent = track.map((p, i) => ({ p: pts[i], ts: p.ts })).filter((q) => q.ts !== undefined && now - q.ts <= RECENT_MS).map((q) => q.p);

  type Scored = { star: STAR; passed: number; lastPassed: number; onRoute: number; recentOff: boolean };
  const scored: Scored[] = [];
  for (const star of stars) {
    const wps = star.waypoints.map(xy);
    if (wps.length === 0) continue;
    // Überflogene Punkte: Abstand der Flugbahn (als Linienzug) zum Punkt
    let passed = 0;
    let lastPassed = -1;
    wps.forEach((w, i) => {
      if (distToPolyline(w, pts) < PASS_NM) { passed++; lastPassed = i; }
    });
    // Anteil der Flugbahnpunkte auf der STAR-Strecke
    const onRoute = wps.length > 1 ? pts.filter((p) => distToPolyline(p, wps) < ON_ROUTE_NM).length : 0;
    const recentOff = recent.length >= 3 && wps.length > 1 && recent.every((p) => distToPolyline(p, wps) > ON_ROUTE_NM);
    scored.push({ star, passed, lastPassed, onRoute, recentOff });
  }

  const best = scored
    .filter((s) => s.passed >= 2 || (s.passed === 1 && s.onRoute >= 3))
    .sort((a, b) => b.passed - a.passed || b.onRoute - a.onRoute)[0];
  if (best) {
    const group = scored.filter((s) => s.passed === best.passed && s.onRoute === best.onRoute && procName(s.star) === procName(best.star));
    const pick = group.find((s) => activeRunwayIds.includes(s.star.runway)) ?? best;
    const status = pick.recentOff ? 'vectors' : 'on';
    const next = status === 'on' ? pick.star.waypoints[pick.lastPassed + 1]?.name : undefined;
    return { name: procName(pick.star), runways: runwaysOf(group.map((s) => s.star)), status, next, passed: pick.passed };
  }

  // Noch kein Punkt überflogen: fliegt er genau auf den Eintrittspunkt einer STAR zu?
  if (heading === null) return null;
  let entry: { star: STAR; wp: Waypoint; dev: number } | null = null;
  for (const star of stars) {
    const wp = star.waypoints[0];
    if (!wp) continue;
    const w = xy(wp);
    const dist = Math.hypot(w.x, w.y);
    if (dist > ENTRY_MAX_NM || dist < PASS_NM) continue;
    const brg = (Math.atan2(w.x, w.y) * 180) / Math.PI;
    const dev = Math.abs(((brg - heading + 540) % 360) - 180);
    if (dev < ENTRY_MAX_DEV_DEG && (!entry || dev < entry.dev)) entry = { star, wp, dev };
  }
  if (!entry) return null;
  const same = stars.filter((s) => procName(s) === procName(entry!.star) && s.waypoints[0]?.id === entry!.wp.id);
  return { name: procName(entry.star), runways: runwaysOf(same), status: 'entry', next: entry.wp.name, passed: 0 };
}

/** Prozedurname ohne Bahn, z. B. "KERAX 6A" */
function procName(star: STAR): string {
  return star.fullName ?? (star.name ?? star.id).replace(/\/.*$/, '');
}

function runwaysOf(stars: STAR[]): string[] {
  return [...new Set(stars.map((s) => s.runway).filter((r) => r && r !== 'ALL'))].sort();
}

function distToPolyline(p: { x: number; y: number }, line: Array<{ x: number; y: number }>): number {
  if (line.length === 1) return Math.hypot(p.x - line[0].x, p.y - line[0].y);
  let min = Infinity;
  for (let i = 1; i < line.length; i++) min = Math.min(min, distToSegment(p, line[i - 1], line[i]));
  return min;
}

function distToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
