// filepath: src/game/LiveSmoother.ts
// Echter Verkehr ohne Sprünge: Zwischen zwei Abfragen wird mit Kurs, Geschwindigkeit und Steigrate weitergerechnet.
// Trifft eine neue Meldung ein, weicht die neue Rechnung meist etwas von der alten ab (Kurve, Abbremsen im Anflug,
// Beschleunigen beim Start). Statt zu springen wird diese Abweichung über BLEND_S Sekunden ausgeglichen.
// Am Boden wird ab ROLL_KT weitergerechnet (Startlauf, Ausrollen), langsamer gilt die gemeldete Position.
import type { LiveAircraft } from '@/types/live';
import { destinationPoint } from '@/utils/geo';

const MAX_S = 30;
const BLEND_S = 2.5;
const ROLL_KT = 30;
/** Größere Abweichungen sind keine Ungenauigkeit, sondern ein Neuansatz (Lücke im Empfang): springen */
const MAX_OFFSET_DEG = 0.03;
const MAX_OFFSET_FT = 1500;

interface State { ts: number; at: number; dLat: number; dLng: number; dAlt: number; shown: { lat: number; lng: number; alt: number | null } }

export class LiveSmoother {
  private states = new Map<string, State>();

  /** Rohe Rechnung: letzte Meldung auf `now` weitergerechnet */
  static predict(a: LiveAircraft, now: number): { lat: number; lng: number; alt: number | null } {
    const dt = Math.min(MAX_S, Math.max(0, (now - a.ts) / 1000));
    const moving = a.gs !== null && a.track !== null && (!a.ground || a.gs >= ROLL_KT);
    const p = moving ? destinationPoint(a.lat, a.lng, a.track as number, ((a.gs as number) * dt) / 3600) : a;
    const alt = a.ground || a.altFt === null ? a.altFt : Math.max(0, a.altFt + ((a.vs ?? 0) * dt) / 60);
    return { lat: p.lat, lng: p.lng, alt };
  }

  /** Geglättete Position und Höhe jetzt */
  at(a: LiveAircraft, now: number): { lat: number; lng: number; alt: number | null } {
    const raw = LiveSmoother.predict(a, now);
    let s = this.states.get(a.hex);
    if (!s || s.ts !== a.ts) {
      // Neue Meldung: Rest der alten Abweichung plus Unterschied zur bisher gezeigten Lage übernehmen
      const prev = s?.shown;
      let dLat = prev ? prev.lat - raw.lat : 0, dLng = prev ? prev.lng - raw.lng : 0;
      let dAlt = prev && prev.alt !== null && raw.alt !== null ? prev.alt - raw.alt : 0;
      if (Math.abs(dLat) > MAX_OFFSET_DEG || Math.abs(dLng) > MAX_OFFSET_DEG * 2) { dLat = 0; dLng = 0; }
      if (Math.abs(dAlt) > MAX_OFFSET_FT || a.ground) dAlt = 0;
      s = { ts: a.ts, at: now, dLat, dLng, dAlt, shown: raw };
      this.states.set(a.hex, s);
    }
    const k = Math.max(0, 1 - (now - s.at) / 1000 / BLEND_S);
    const f = k * k * (3 - 2 * k); // weich auslaufen
    const shown = {
      lat: raw.lat + s.dLat * f,
      lng: raw.lng + s.dLng * f,
      alt: raw.alt === null ? null : Math.max(0, raw.alt + s.dAlt * f),
    };
    s.shown = shown;
    return shown;
  }

  /** Flieger vergessen, die nicht mehr gemeldet werden */
  keep(hexes: Iterable<string>): void {
    const keep = new Set(hexes);
    for (const k of this.states.keys()) if (!keep.has(k)) this.states.delete(k);
  }
}
