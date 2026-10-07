// filepath: src/game/NextLander.ts
// WATCH: welcher echte Anflug landet voraussichtlich als nächster?
import type { Airport } from '@/types/airport';
import type { LiveAircraft, LiveInbound } from '@/types/live';
import { bearingBetween, destinationPoint, distanceNM } from '@/utils/geo';

/**
 * Anflug, der voraussichtlich als nächster landet, nach Flugstrecke bis zum Aufsetzen: Wer schon auf
 * dem Endanflug ist, landet zuerst (nach Entfernung zur Schwelle). Alle anderen reihen sich dahinter ein:
 * Strecke zum Eindrehpunkt auf der verlängerten Pistenachse einer aktiven Bahn (12 NM, mindestens 3 NM
 * hinter dem letzten auf dem Endanflug) plus der Endanflug selbst. So zählt ein Flieger im Gegenanflug
 * richtig weit, auch wenn er nah am Platz ist.
 */
export function nextLander(watch: LiveAircraft[], roles: Record<string, LiveInbound>, airport: Airport, landed: Set<string>, activeRunwayIds: string[]): LiveAircraft | null {
  const cands = watch.filter((ac) => {
    const role = roles[ac.hex];
    return role && !role.out && !landed.has(ac.hex) && !ac.ground && ac.altFt !== null && ac.altFt > 0;
  });
  const miles = new Map<string, number>();
  let lastFinal = 0;
  const ils = airport.runways.filter((r) => r.ils && r.role !== 'departure');
  for (const ac of cands) {
    const d = finalDistance(ac, ils.length ? ils : airport.runways);
    if (d === null) continue;
    miles.set(ac.hex, d);
    lastFinal = Math.max(lastFinal, d);
  }
  const active = ils.filter((r) => activeRunwayIds.includes(r.id));
  const runways = active.length ? active : ils.length ? ils : airport.runways;
  const join = Math.max(12, lastFinal + 3);
  const joins = runways.map((r) => destinationPoint(r.thresholdLat, r.thresholdLng, bearingBetween(r.endLat, r.endLng, r.thresholdLat, r.thresholdLng), join));
  for (const ac of cands) {
    if (miles.has(ac.hex)) continue;
    const toJoin = joins.length ? Math.min(...joins.map((j) => distanceNM(ac.lat, ac.lng, j.lat, j.lng))) : distanceNM(ac.lat, ac.lng, airport.lat, airport.lng);
    miles.set(ac.hex, toJoin + join);
  }
  let best: LiveAircraft | null = null;
  for (const ac of cands) if (!best || miles.get(ac.hex)! < miles.get(best.hex)!) best = ac;
  return best;
}

/** Auf dem Endanflug (bis 30 NM, auf der Pistenachse, Kurs wie die Bahn, nicht steigend): Entfernung zur Schwelle */
function finalDistance(ac: LiveAircraft, runways: Airport['runways']): number | null {
  return finalRunway(ac, runways)?.miles ?? null;
}

/** Bahn, auf deren Endanflug der Flieger ist, mit Entfernung zur Schwelle in NM */
export function finalRunway(ac: LiveAircraft, runways: Airport['runways']): { runway: Airport['runways'][number]; miles: number } | null {
  if (ac.track === null || (ac.vs ?? 0) > 300) return null;
  let best: { runway: Airport['runways'][number]; miles: number } | null = null;
  for (const r of runways) {
    const course = bearingBetween(r.thresholdLat, r.thresholdLng, r.endLat, r.endLng);
    const d = distanceNM(ac.lat, ac.lng, r.thresholdLat, r.thresholdLng);
    if (d > 30) continue;
    const dev = Math.abs(((bearingBetween(ac.lat, ac.lng, r.thresholdLat, r.thresholdLng) - course + 540) % 360) - 180);
    const trk = Math.abs(((ac.track - course + 540) % 360) - 180);
    // Seitlich höchstens ~0,7 NM von der Achse
    if (trk < 20 && dev < 30 && d * Math.sin((dev * Math.PI) / 180) < 0.7 && (best === null || d < best.miles)) best = { runway: r, miles: d };
  }
  return best;
}
