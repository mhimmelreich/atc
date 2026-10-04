// filepath: src/game/Phraseology.ts
// Sprechfunk zwischen Lotse und Piloten: Text fürs Funk-Log und Sprechtext für die Sprachausgabe
import type { Aircraft, ATCCommand } from '@/types/aircraft';
import type { Airport } from '@/types/airport';
import type { STAR } from '@/types/navdata';
import type { RadioVoiceKey } from '@/types/radio';
import { headingDiff } from '@/utils/aviation';
import { radioCallsign } from './Telephony';
import { DIGITS, NATO, altitudePhrase, pad3, plain, spellAlnum, spellDigits, spokenFix, spokenRunway, titleCase } from './Speech';

export interface Phrase {
  text: string;
  spoken: string;
}

export interface RadioContext {
  station: Phrase;
  /** ATIS-Kennbuchstabe */
  atis: string;
  qnh: number;
  transitionAltitudeFt: number;
  stars: STAR[];
}

const phrase = (text: string, spoken = text): Phrase => ({ text, spoken });
const join = (parts: Phrase[]): Phrase => ({
  text: parts.map((p) => p.text).join(', '),
  spoken: parts.map((p) => p.spoken).join(', '),
});
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function radioContext(airport: Airport, stars: STAR[], now = new Date()): RadioContext {
  // Rufname der Anflugkontrolle aus der Stadt: "Frankfurt am Main" → "Frankfurt Approach"
  const base = (airport.city || airport.name)
    .split(/\s+(?:am|an|im|de|del|la)\s+|[/,(]/i)[0]
    .replace(/\b(international|intl|airport|airfield|regional|rgnl|municipal)\b/gi, '')
    .trim();
  const station = `${titleCase(base || airport.icao)} Approach`;
  const day = Math.floor(now.getTime() / 86_400_000);
  return {
    station: phrase(station, plain(station)),
    // ATIS wechselt stündlich; QNH ohne Wetteranbindung: plausibler Wert je Platz und Tag
    atis: String.fromCharCode(65 + ((hash(airport.icao) + now.getUTCHours()) % 26)),
    qnh: 1003 + (hash(`${airport.icao}${day}`) % 25),
    transitionAltitudeFt: airport.transitionAltitudeFt,
    stars,
  };
}

/** "KERAX 6A" → gesprochen "Kerax six Alfa" */
export function starPhrase(star: STAR): Phrase {
  const name = star.fullName ?? star.name ?? star.id;
  const m = /^([A-Z]+) ?(\d)([A-Z]?)$/.exec(name);
  if (!m) return phrase(name, spellAlnum(name));
  return phrase(`${m[1]} ${m[2]}${m[3]}`, `${titleCase(m[1])} ${DIGITS[Number(m[2])]}${m[3] ? ` ${NATO[m[3]]}` : ''}`);
}

export interface Instruction {
  atc: Phrase;
  readback: Phrase;
}

/** Freigabe des Lotsen und das Rücklesen des Piloten (ohne Rufzeichen) */
export function instruction(ac: Aircraft, cmd: ATCCommand, ctx: RadioContext, runwayId = ac.assignedRunway): Instruction | null {
  switch (cmd.type) {
    case 'heading': {
      const hdg = pad3(cmd.value);
      const spoken = spellDigits(hdg);
      const diff = headingDiff(ac.headingDeg, cmd.value);
      if (!cmd.turnDirection && Math.abs(diff) < 5) {
        return { atc: phrase(`fly heading ${hdg}`, `fly heading ${spoken}`), readback: phrase(`heading ${hdg}`, `heading ${spoken}`) };
      }
      const dir = cmd.turnDirection ?? (diff >= 0 ? 'right' : 'left');
      return {
        atc: phrase(`turn ${dir} heading ${hdg}`, `turn ${dir} heading ${spoken}`),
        readback: phrase(`${dir} heading ${hdg}`, `${dir} heading ${spoken}`),
      };
    }
    case 'altitude': {
      const ta = ctx.transitionAltitudeFt;
      const alt = altitudePhrase(cmd.value, ta);
      const verb = cmd.value > ac.altitudeFt + 50 ? 'climb' : cmd.value < ac.altitudeFt - 50 ? 'descend' : 'maintain';
      const parts = [phrase(`${verb} ${alt.text}`, `${verb} ${cmd.value > ta ? '' : 'altitude '}${alt.spoken}`)];
      // Beim Sinken unter die Übergangshöhe gehört das QNH zur Freigabe
      if (cmd.value <= ta && ac.altitudeFt > ta) parts.push(phrase(`QNH ${ctx.qnh}`, `Q N H ${spellDigits(String(ctx.qnh))}`));
      const p = join(parts);
      return { atc: p, readback: p };
    }
    case 'speed': {
      const verb = cmd.value < ac.speedKts - 3 ? 'reduce speed' : cmd.value > ac.speedKts + 3 ? 'increase speed' : 'maintain speed';
      const p = phrase(`${verb} ${cmd.value} kt`, `${verb} ${spellDigits(String(cmd.value))} knots`);
      return { atc: p, readback: p };
    }
    case 'direct': {
      const fix = spokenFix(cmd.waypointId);
      return {
        atc: phrase(`proceed direct ${cmd.waypointId}`, `proceed direct ${fix}`),
        readback: phrase(`direct ${cmd.waypointId}`, `direct ${fix}`),
      };
    }
    case 'star': {
      const star = ctx.stars.find((s) => s.id === cmd.starId);
      if (!star) return null;
      const st = starPhrase(star);
      const route = phrase(`direct ${cmd.waypointId}, then ${st.text} arrival`, `direct ${spokenFix(cmd.waypointId)}, then ${st.spoken} arrival`);
      const expect = star.runway === 'ALL' ? [] : [phrase(`expect runway ${star.runway}`, `expect runway ${spokenRunway(star.runway)}`)];
      return {
        atc: join([phrase(`proceed ${route.text}`, `proceed ${route.spoken}`), ...expect]),
        readback: join([route, ...expect]),
      };
    }
    case 'ils': {
      const p = phrase(`cleared ILS approach runway ${cmd.runwayId}`, `cleared I L S approach runway ${spokenRunway(cmd.runwayId)}`);
      return { atc: p, readback: p };
    }
    case 'land':
      if (!runwayId) return null;
      return {
        atc: phrase(`runway ${runwayId}, cleared to land`, `runway ${spokenRunway(runwayId)}, cleared to land`),
        readback: phrase(`cleared to land runway ${runwayId}`, `cleared to land runway ${spokenRunway(runwayId)}`),
      };
  }
}

/** Lotse an Flieger: "Lufthansa 427, radar contact, descend FL080" */
export const atcCall = (ac: Aircraft, instr: Phrase, radarContact: boolean): Phrase =>
  join([radioCallsign(ac.callsign), ...(radarContact ? [phrase('radar contact')] : []), instr]);

/** Rücklesen: "Descend FL080, Lufthansa 427" */
export function readbackCall(ac: Aircraft, readback: Phrase): Phrase {
  const p = join([readback, radioCallsign(ac.callsign)]);
  return { text: capitalize(p.text), spoken: capitalize(p.spoken) };
}

/** Erstanruf: "Frankfurt Approach, Lufthansa 427, FL120 descending FL100, KERAX 6A arrival, information Bravo" */
export function initialCall(ac: Aircraft, ctx: RadioContext): Phrase {
  const level = altitudePhrase(ac.altitudeFt, ctx.transitionAltitudeFt);
  const parts = [ctx.station, radioCallsign(ac.callsign)];
  if (ac.targetAltitude < ac.altitudeFt - 300) {
    const target = altitudePhrase(ac.targetAltitude, ctx.transitionAltitudeFt);
    parts.push(phrase(`${level.text} descending ${target.text}`, `${level.spoken} descending ${target.spoken}`));
  } else {
    parts.push(level);
  }
  const star = ac.starId ? ctx.stars.find((s) => s.id === ac.starId) : undefined;
  if (star && ac.state === 'enroute') {
    const st = starPhrase(star);
    parts.push(phrase(`${st.text} arrival`, `${st.spoken} arrival`));
  }
  parts.push(phrase(`information ${NATO[ctx.atis]}`));
  return join(parts);
}

const pilotReport = (ac: Aircraft, report: Phrase): Phrase => join([radioCallsign(ac.callsign), report]);

export const establishedCall = (ac: Aircraft, runwayId: string): Phrase =>
  pilotReport(ac, phrase(`established ILS runway ${runwayId}`, `established I L S runway ${spokenRunway(runwayId)}`));

export const finalCall = (ac: Aircraft, runwayId: string, miles: number): Phrase =>
  pilotReport(ac, phrase(`${miles} miles final runway ${runwayId}`, `${DIGITS[miles]} miles final runway ${spokenRunway(runwayId)}`));

export const goAroundCall = (ac: Aircraft): Phrase => pilotReport(ac, phrase('going around'));

export const endOfStarCall = (ac: Aircraft): Phrase =>
  pilotReport(ac, phrase('end of STAR, request vectors', 'end of star, request vectors'));

export const sayAgainCall = (ac: Aircraft): Phrase => pilotReport(ac, phrase('say again'));

/** Feste Stimme je Rufzeichen: etwa 40 % britisch, sonst amerikanisch, Sprecher aus dem Stimmmodell */
export function pilotVoice(callsign: string): { voice: RadioVoiceKey; speaker: number } {
  const h = hash(callsign);
  return h % 5 < 2 ? { voice: 'gb', speaker: (h >>> 4) % 109 } : { voice: 'us', speaker: (h >>> 4) % 904 };
}
