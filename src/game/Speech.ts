// filepath: src/game/Speech.ts
// Bausteine der Funk-Aussprache nach ICAO: Ziffern einzeln, Buchstaben im Buchstabieralphabet.
// Der Sprechtext darf nur Buchstaben, Ziffern, Leerzeichen und , . ' - enthalten (Prüfung im Sprachdienst).
export const DIGITS = ['zero', 'one', 'two', 'tree', 'four', 'fife', 'six', 'seven', 'eight', 'niner'];

export const NATO: Record<string, string> = {
  A: 'Alfa', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel',
  I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa',
  Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey',
  X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
};

const SIDE: Record<string, string> = { L: 'left', R: 'right', C: 'center' };

export const spellDigits = (s: string): string =>
  s.split('').filter((c) => /\d/.test(c)).map((c) => DIGITS[Number(c)]).join(' ');

/** Kennungen Zeichen für Zeichen: "DF406" → "Delta Foxtrot four zero six" */
export const spellAlnum = (s: string): string =>
  s.toUpperCase().split('').filter((c) => /[A-Z0-9]/.test(c))
    .map((c) => (/\d/.test(c) ? DIGITS[Number(c)] : NATO[c])).join(' ');

export const titleCase = (s: string): string =>
  s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());

/** Umlaute und Akzente für die englische Stimme entfernen: "Düsseldorf" → "Dusseldorf" */
export const plain = (s: string): string =>
  s.replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s,.'-]/gu, ' ');

/** Fünf-Buchstaben-Fixe als Wort, Navaid-Kennungen und Fixe mit Ziffern buchstabiert */
export const spokenFix = (id: string): string => (/^[A-Z]{4,5}$/.test(id) ? titleCase(id) : spellAlnum(id));

export const pad3 = (n: number): string => String(Math.round(n) % 360 || 360).padStart(3, '0');

export function spokenRunway(rwy: string): string {
  const m = /^(\d{1,2})([LRC]?)$/.exec(rwy);
  return m ? `${spellDigits(m[1])}${m[2] ? ` ${SIDE[m[2]]}` : ''}` : spellAlnum(rwy);
}

/** Über der Übergangshöhe Flugfläche, darunter Höhe in Fuß */
export function altitudePhrase(ft: number, transitionAltitudeFt: number): { text: string; spoken: string } {
  if (ft > transitionAltitudeFt) {
    const fl = Math.round(ft / 100);
    // Volle Hunderter spricht man "flight level one hundred"
    const spoken = fl % 100 === 0 ? `${DIGITS[fl / 100]} hundred` : spellDigits(String(fl));
    return { text: `FL${String(fl).padStart(3, '0')}`, spoken: `flight level ${spoken}` };
  }
  const rounded = Math.round(ft / 100) * 100;
  const thousands = Math.floor(rounded / 1000);
  const hundreds = (rounded % 1000) / 100;
  const words = [
    thousands > 0 ? `${spellDigits(String(thousands))} thousand` : '',
    hundreds > 0 ? `${DIGITS[hundreds]} hundred` : '',
  ].filter(Boolean).join(' ');
  return { text: `${rounded} ft`, spoken: `${words || 'zero'} feet` };
}

/** Frequenz nach ICAO: alle sechs Ziffern, nur zwei Nullen am Ende entfallen ("118.780", "118.1") */
export function frequencyPhrase(mhz: number): { text: string; spoken: string } {
  const full = mhz.toFixed(3);
  const text = full.endsWith('00') ? full.slice(0, -2) : full;
  const [whole, decimals] = text.split('.');
  return { text, spoken: `${spellDigits(whole)} decimal ${spellDigits(decimals)}` };
}

/** Rufnamen für die englische Stimme: Kürzel wie "HCF" Buchstabe für Buchstabe */
export const spokenName = (name: string): string =>
  plain(name).replace(/\b[A-Z]{2,3}\b/g, (abbr) => abbr.split('').join(' '));
