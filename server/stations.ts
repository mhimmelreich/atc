// Funkstellen eines Platzes (Anflugkontrolle und Turm): Rufname und Frequenz aus den Frequenzlisten
// von Navigraph bzw. OurAirports. Die Beschreibungen sind uneinheitlich ("LANGEN RADAR", "SOCAL APP",
// "FRANKFURT TOWER / TURM (SOUTH)", "FRANKFURT", "RWY 18C/36L"), daraus wird ein Rufname gebaut.
import type { Airport, Station } from '../src/types/airport';

export interface FrequencyEntry {
  kind: 'approach' | 'departure' | 'tower';
  /** Vorrang innerhalb der Art, kleiner gewinnt: Arrival vor Director vor Approach */
  rank: number;
  /** Art für den Rufnamen, z. B. "Arrival" */
  role: string;
  /** Beschreibung aus den Daten */
  label: string;
  mhz: number;
}

// Sprechfunk im Flugfunkband, ohne Navigations- und UHF-Frequenzen
const VHF_MIN_MHZ = 118;
const VHF_MAX_MHZ = 137;
const ABBREVIATIONS: Record<string, string> = { APP: 'APPROACH', ARR: 'ARRIVAL', DIR: 'DIRECTOR', DEP: 'DEPARTURE', TWR: 'TOWER' };
const FUNCTION_WORD = /^(APPROACH|ARRIVAL|DIRECTOR|DEPARTURE|RADAR|FINAL|CONTROL|TOWER)$/;
// Zusätze, die nicht zum Rufnamen gehören ("TOWER NORTH", "LCL RADAR", "APP SECONDARY")
const NOISE = new Set(['NORTH', 'SOUTH', 'EAST', 'WEST', 'NORD', 'SÜD', 'SUD', 'OST', 'LCL', 'ALT', 'MAIN', 'PRIMARY', 'SECONDARY', 'INITIAL', 'CONTACT']);

// Kürzel ohne Vokal bleiben groß (HCF), sonst Wortanfänge groß: "COLOGNE-BONN" → "Cologne-Bonn"
const nameCase = (w: string): string =>
  w.length <= 3 && !/[AEIOUY]/.test(w)
    ? w
    : w.toLowerCase().replace(/(^|-)(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());

/** Rufname aus der Beschreibung; ohne Ortsnamen ("APP", "Tower", "RWY 18C") undefined */
export function stationName(label: string, role: string): string | undefined {
  const words = label.split(/[/(]/)[0].toUpperCase().replace(/[^\p{L}\s-]/gu, ' ')
    .split(/\s+/).filter((w) => w && !NOISE.has(w)).map((w) => ABBREVIATIONS[w] ?? w);
  const fn = words.findIndex((w) => FUNCTION_WORD.test(w));
  const place = fn >= 0 ? words.slice(0, fn) : words;
  if (place.length === 0 || place.includes('RWY')) return undefined;
  return [...place.map(nameCase), fn >= 0 ? nameCase(words[fn]) : role].join(' ');
}

/** Je Art die bevorzugte Stelle, bei mehreren Frequenzen die niedrigste */
export function pickStations(entries: FrequencyEntry[]): Airport['stations'] {
  const out: NonNullable<Airport['stations']> = {};
  for (const kind of ['approach', 'departure', 'tower'] as const) {
    // Abflüge: eigene Departure-Frequenz, sonst die Radar-/Approach-Stelle (z. B. "Langen Radar"), nicht Arrival/Director
    const pick = (e: FrequencyEntry) => e.kind === kind || (kind === 'departure' && e.kind === 'approach' && e.role === 'Approach');
    const best = entries
      .filter((e) => pick(e) && e.mhz >= VHF_MIN_MHZ && e.mhz < VHF_MAX_MHZ)
      .sort((a, b) => (a.kind === kind ? 0 : 10) + a.rank - ((b.kind === kind ? 0 : 10) + b.rank) || a.mhz - b.mhz)[0];
    if (!best) continue;
    const name = stationName(best.label, best.role);
    const station: Station = { ...(name ? { name } : {}), role: best.role, mhz: Math.round(best.mhz * 1000) / 1000 };
    out[kind] = station;
  }
  return out.approach || out.tower ? out : undefined;
}
