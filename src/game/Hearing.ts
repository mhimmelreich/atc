// filepath: src/game/Hearing.ts
// Favoriten-Radar HÖREN: Welchen Flieger hört man am Favoriten gerade am ehesten?
// Grobe Schallausbreitung im Freien (ISO 9613 vereinfacht), Pegel in dB(A) am Boden:
//   Schallleistung je Klasse und Flugphase − Kugelausbreitung − Luftdämpfung − Boden + Wind.
// Gehört wird der Schall, der den Flieger vor r/c Sekunden verlassen hat: gerechnet wird an der Position von damals.
// Wahrscheinlichkeit = Anteil an der gesamten Schallenergie aller Flieger.
import type { LiveAircraft } from '@/types/live';
import { bearingBetween, destinationPoint, distanceNM } from '@/utils/geo';

const C_MS = 340;            // Schallgeschwindigkeit
const FT = 0.3048;
const NM = 1852;
const AIR_DB_PER_M = 0.0025; // Luftdämpfung A-bewertet über größere Strecken (tiefe Frequenzen tragen weit), ~15 °C, 70 % Feuchte
/** Unter etwa diesem Pegel geht ein Flieger im Alltagslärm unter */
export const AUDIBLE_DBA = 40;

export interface HearInput {
  lat: number;
  lng: number;
  /** Bodenhöhe am Favoriten in ft */
  elevFt: number;
  /** Wind aus Richtung (rechtweisend) und Stärke; null = unbekannt oder umlaufend */
  windFrom: number | null;
  windKt: number;
  /** QNH für die Umrechnung der Druckhöhe (ADS-B sendet Standard 1013) */
  qnh: number | null;
}

export interface HearResult {
  hex: string;
  /** geschätzter Pegel am Favoriten in dB(A) */
  dba: number;
  /** Anteil an der Schallenergie 0..1 */
  p: number;
  /** Laufzeit des Schalls in s */
  delayS: number;
}

/** Schallleistungspegel (dB(A)) nach ADS-B-Kategorie bzw. Rufzeichen, grob nach Lärmzertifikaten */
function sourceLevel(a: LiveAircraft): number {
  switch (a.category) {
    case 'A5': return 152; // Heavy (B777, A350, B747)
    case 'A4': return 149; // B757
    case 'A3': return 146; // A320, B737
    case 'A2': return 141; // Regionaljets, Turboprops
    case 'A1': return 130; // Kleinflugzeug
    case 'A7': return 138; // Hubschrauber: laut, Rotorknall
    case 'B1': return 95;  // Segelflugzeug
    case 'B4': return 120; // Ultraleicht
    case 'A6': return 155; // Hochleistung (Militär)
    default: return /^[A-Z]{3}\d/.test(a.callsign) ? 146 : 132;
  }
}

export function estimateHearing(list: LiveAircraft[], at: HearInput, now: number): HearResult[] {
  const qnhFt = at.qnh ? (at.qnh - 1013.25) * 27 : 0;
  const out: Array<Omit<HearResult, 'p'>> = [];
  for (const a of list) {
    let lw = sourceLevel(a);
    const vs = a.vs ?? 0;
    const gs = a.gs ?? 0;
    // Flugphase: Startschub im Steigflug laut, Leerlauf im Sinkflug leiser; am Boden nur beim Startlauf
    if (a.ground || a.altFt === null) {
      if (gs < 40) continue;
      lw += 3;
    } else if (vs > 800) lw += 5;
    else if (vs < -500) lw -= 3;
    // Umströmungsgeräusch (Klappen, Fahrwerk) wächst mit der Geschwindigkeit; tief und schnell = laut
    if (gs > 0) lw += Math.max(-4, Math.min(3, 10 * Math.log10(Math.max(gs, 60) / 250)));

    const hAglFt = a.ground || a.altFt === null ? 0 : Math.max(0, a.altFt + qnhFt - at.elevFt);
    // Erst ungefähr, dann an der Position, von der der Schall jetzt ankommt
    let lat = a.lat, lng = a.lng, delay = 0;
    for (let i = 0; i < 2; i++) {
      const back = (gs * (Math.max(0, (now - a.ts) / 1000) - delay)) / 3600;
      const p = a.track !== null && gs > 0 ? destinationPoint(a.lat, a.lng, a.track, back) : a;
      lat = p.lat; lng = p.lng;
      const horiz = distanceNM(at.lat, at.lng, lat, lng) * NM;
      delay = Math.hypot(horiz, hAglFt * FT) / C_MS;
    }
    const horizM = distanceNM(at.lat, at.lng, lat, lng) * NM;
    const r = Math.max(30, Math.hypot(horizM, hAglFt * FT));
    if (r > 40 * NM) continue;
    const elevDeg = (Math.atan2(hAglFt * FT, horizM) * 180) / Math.PI;
    // Flacher Einfall: Boden- und Hindernisdämpfung, Wind wirkt stark; steil von oben kaum
    const grazing = Math.max(0, Math.min(1, 1 - elevDeg / 25));
    let l = lw - 20 * Math.log10(r) - 11 - AIR_DB_PER_M * r - 6 * grazing;
    // Wind: mit dem Wind wird Schall zum Boden gebeugt (lauter), gegen den Wind entsteht eine Schattenzone
    if (at.windFrom !== null && at.windKt > 0) {
      const toward = bearingBetween(lat, lng, at.lat, at.lng);
      const windTo = (at.windFrom + 180) % 360;
      const comp = at.windKt * Math.cos(((toward - windTo) * Math.PI) / 180);
      l += (comp > 0 ? Math.min(5, 0.35 * comp) : Math.max(-15, 0.9 * comp)) * grazing;
    }
    out.push({ hex: a.hex, dba: l, delayS: delay });
  }
  const total = out.reduce((s, x) => s + 10 ** (x.dba / 10), 0);
  return out
    .map((x) => ({ ...x, p: total > 0 ? 10 ** (x.dba / 10) / total : 0 }))
    .sort((x, y) => y.dba - x.dba);
}
