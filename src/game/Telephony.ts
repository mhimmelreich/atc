// filepath: src/game/Telephony.ts
// Funk-Rufnamen der Airlines (DLH427 → "Lufthansa 427"): eingebaute Liste für den Spielverkehr,
// alle weiteren vom Server (OpenFlights airlines.dat, ODbL)
import { plain, spellAlnum, titleCase } from './Speech';

const BUILTIN: Record<string, string> = {
  DLH: 'LUFTHANSA', EZY: 'EASY', RYR: 'RYANAIR', BAW: 'SPEEDBIRD', AFL: 'AEROFLOT', UAE: 'EMIRATES',
  THY: 'TURKISH', SWR: 'SWISS', KLM: 'KLM', IBE: 'IBERIA', AUA: 'AUSTRIAN', SAS: 'SCANDINAVIAN',
  TAP: 'AIR PORTUGAL', VKG: 'VIKING', CFG: 'CONDOR', TUI: 'TUI JET',
  // In OpenFlights veraltet oder falsch geschrieben
  OCN: 'DISCOVER', DLA: 'DOLOMITI', ITY: 'ITARROW', BEL: 'BEELINE', VOE: 'VOLOTEA', ENT: 'ENTER', RJA: 'JORDANIAN',
};

// Rufnamen, die die Sprachausgabe sonst verschluckt ("Condor" klang wie "Cond"): Lautschrift für Piper
const CALLSIGN_PHONEMES: Record<string, string> = {
  condor: 'kˈɔnˌdɔːɹ',
};

let table: Record<string, string> = { ...BUILTIN };
let loading: Promise<void> | null = null;

/** Vollständige Liste einmalig nachladen; bis dahin (oder bei Fehler) gilt die eingebaute */
export function loadTelephony(): Promise<void> {
  loading ??= fetch(`${import.meta.env.BASE_URL}api/opendata/telephony`)
    .then((res) => (res.ok ? res.json() : {}))
    .then((map: Record<string, string>) => { table = { ...map, ...BUILTIN }; })
    .catch(() => { /* eingebaute Liste genügt */ });
  return loading;
}

export interface SpokenCallsign {
  text: string;
  spoken: string;
}

export function radioCallsign(callsign: string): SpokenCallsign {
  const m = /^([A-Z]{3})(\d[0-9A-Z]*)$/.exec(callsign);
  const name = m ? table[m[1]] : undefined;
  if (!m || !name) return { text: callsign, spoken: spellAlnum(callsign) };
  // Kurze Rufnamen wie KLM werden buchstabiert gesprochen
  const short = name.length <= 3;
  return {
    text: `${short ? name : titleCase(name)} ${m[2]}`,
    spoken: `${short ? name.split('').join(' ') : withPhonemes(plain(titleCase(name)))} ${spellAlnum(m[2])}`,
  };
}

const withPhonemes = (s: string): string =>
  s.replace(/\p{L}+/gu, (w) => (CALLSIGN_PHONEMES[w.toLowerCase()] ? `[[ ${CALLSIGN_PHONEMES[w.toLowerCase()]} ]]` : w));
