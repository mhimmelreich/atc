// filepath: src/game/Phraseology.ts
// Sprechfunk zwischen Lotse und Piloten: Text fürs Funk-Log und Sprechtext für die Sprachausgabe
import type { Aircraft, ATCCommand } from '@/types/aircraft';
import type { Airport, Station } from '@/types/airport';
import type { STAR } from '@/types/navdata';
import type { RadioVoiceKey } from '@/types/radio';
import type { Weather } from '@/types/weather';
import { headingDiff, normaliseHdg } from '@/utils/aviation';
import { radioCallsign } from './Telephony';
import {
  DIGITS, NATO, altitudePhrase, frequencyPhrase, pad3, spellAlnum, spellDigits, spokenFix, spokenName, spokenRunway, titleCase,
} from './Speech';

export interface Phrase {
  text: string;
  spoken: string;
}

export interface RadioContext {
  /** Anflugkontrolle, z. B. "Frankfurt Arrival" */
  station: Phrase;
  /** Turm, z. B. "Frankfurt Tower" */
  tower: Phrase;
  /** Frequenz des Turms, falls bekannt */
  towerFreq: Phrase | null;
  /** ATIS-Kennbuchstabe */
  atis: string;
  /** Luftdruck für Höhen unter der Übergangshöhe: "QNH 1013" bzw. "altimeter 2992" */
  pressure: Phrase;
  /** Bodenwind für die Landefreigabe (nur mit Wetter) */
  wind: Phrase | null;
  transitionAltitudeFt: number;
  stars: STAR[];
}

export const phrase = (text: string, spoken = text): Phrase => ({ text, spoken });
export const join = (parts: Phrase[]): Phrase => ({
  text: parts.map((p) => p.text).join(', '),
  spoken: parts.map((p) => p.spoken).join(', '),
});
export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Ort im Rufnamen aus der Stadt: "Frankfurt am Main" → "Frankfurt" */
function placeName(airport: Airport): string {
  const base = (airport.city || airport.name)
    .split(/\s+(?:am|an|im|de|del|la)\s+|[/,(]/i)[0]
    .replace(/\b(international|intl|airport|airfield|regional|rgnl|municipal)\b/gi, '')
    .trim();
  return titleCase(base || airport.icao);
}

export interface StationInfo {
  name: string;
  /** Frequenz wie gesprochen, z. B. "118.505"; null, wenn unbekannt */
  freq: string | null;
}

/** Rufnamen und Frequenzen von Anflugkontrolle und Turm; fehlt der Name in den Daten, nach der Stadt */
export function stations(airport: Airport): { approach: StationInfo; departure: StationInfo; tower: StationInfo } {
  const info = (s: Station | undefined, role: string): StationInfo => ({
    name: s?.name ?? `${placeName(airport)} ${s?.role ?? role}`,
    freq: s ? frequencyPhrase(s.mhz).text : null,
  });
  const dep = airport.stations?.departure ?? (airport.stations?.approach?.role === 'Approach' ? airport.stations.approach : undefined);
  return { approach: info(airport.stations?.approach, 'Approach'), departure: info(dep, 'Departure'), tower: info(airport.stations?.tower, 'Tower') };
}

// USA, Kanada und der US-Pazifik stellen den Höhenmesser in inHg ein
const INHG_REGION = /^[KCP]/;
const HPA_PER_INHG = 33.8639;

/** "QNH 1027" bzw. "altimeter 3027"; ohne Wetter ein plausibler Wert */
function pressurePhrase(icao: string, weather: Weather | null, fallbackQnh: number): Phrase {
  const qnh = weather?.qnh ?? fallbackQnh;
  const inHg = weather ? weather.altimeterInHg : INHG_REGION.test(icao) ? qnh / HPA_PER_INHG : null;
  if (inHg !== null) {
    const v = String(Math.round(inHg * 100));
    return phrase(`altimeter ${v}`, `altimeter ${spellDigits(v)}`);
  }
  return phrase(`QNH ${qnh}`, `Q N H ${spellDigits(String(qnh))}`);
}

/** Bodenwind wie vom Turm: missweisend, auf 10° gerundet ("wind 350° 3 kt", "wind calm", "wind variable 2 kt") */
export function windPhrase(w: Weather, magneticVariation: number): Phrase {
  if (w.windKt < 1) return phrase('wind calm');
  const speed = String(Math.round(w.windKt));
  const gust = w.gustKt ? String(Math.round(w.gustKt)) : null;
  const gustText = gust ? ` gusting ${gust} kt` : '';
  const gustSpoken = gust ? ` gusting ${spellDigits(gust)} knots` : '';
  if (w.windDir === null) {
    return phrase(`wind variable ${speed} kt${gustText}`, `wind variable ${spellDigits(speed)} knots${gustSpoken}`);
  }
  const dir = pad3(Math.round(normaliseHdg(w.windDir - magneticVariation) / 10) * 10);
  return phrase(`wind ${dir}° ${speed} kt${gustText}`, `wind ${spellDigits(dir)} degrees ${spellDigits(speed)} knots${gustSpoken}`);
}

export function radioContext(airport: Airport, stars: STAR[], weather: Weather | null = null, now = new Date()): RadioContext {
  const { approach, tower } = stations(airport);
  const towerMhz = airport.stations?.tower?.mhz;
  const day = Math.floor(now.getTime() / 86_400_000);
  return {
    station: phrase(approach.name, spokenName(approach.name)),
    tower: phrase(tower.name, spokenName(tower.name)),
    towerFreq: towerMhz ? frequencyPhrase(towerMhz) : null,
    // ATIS wechselt stündlich
    atis: String.fromCharCode(65 + ((hash(airport.icao) + now.getUTCHours()) % 26)),
    pressure: pressurePhrase(airport.icao, weather, 1003 + (hash(`${airport.icao}${day}`) % 25)),
    wind: weather ? windPhrase(weather, airport.magneticVariation) : null,
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
      if (cmd.value <= ta && ac.altitudeFt > ta) parts.push(ctx.pressure);
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
    case 'tower': {
      const freq = ctx.towerFreq;
      return {
        atc: phrase(`contact ${ctx.tower.text}${freq ? ` ${freq.text}` : ''}`, `contact ${ctx.tower.spoken}${freq ? ` ${freq.spoken}` : ''}`),
        readback: freq ? phrase(`tower ${freq.text}`, `tower ${freq.spoken}`) : phrase('contact tower'),
      };
    }
    case 'land':
      if (!runwayId) return null;
      return {
        // Mit dem aktuellen Bodenwind, wie vom Turm
        atc: join([...(ctx.wind ? [ctx.wind] : []), phrase(`runway ${runwayId}, cleared to land`, `runway ${spokenRunway(runwayId)}, cleared to land`)]),
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

/** Meldung beim Turm nach der Übergabe: "Frankfurt Tower, Lufthansa 4YC, established ILS runway 07L" */
export function towerCall(ac: Aircraft, ctx: RadioContext, runwayId: string): Phrase {
  const est = ac.state === 'established' ? 'established ' : '';
  return join([ctx.tower, radioCallsign(ac.callsign), phrase(`${est}ILS runway ${runwayId}`, `${est}I L S runway ${spokenRunway(runwayId)}`)]);
}

export const goAroundCall = (ac: Aircraft): Phrase => pilotReport(ac, phrase('going around'));

export const endOfStarCall = (ac: Aircraft): Phrase =>
  pilotReport(ac, phrase('end of STAR, request vectors', 'end of star, request vectors'));

export const sayAgainCall = (ac: Aircraft): Phrase => pilotReport(ac, phrase('say again'));

export interface Voice {
  voice: RadioVoiceKey;
  speaker: number;
}

/** Lotsen: Approach spricht mit der Stimme "joe", der Turm mit einer britischen Sprecherin (VCTK p250) */
export const APPROACH_VOICE: Voice = { voice: 'atc', speaker: 0 };
export const TOWER_VOICE: Voice = { voice: 'gb', speaker: 3 };

/** Feste Stimme je Rufzeichen: etwa 40 % britisch, sonst amerikanisch, Sprecher aus dem Stimmmodell (ohne die Turmstimme) */
export function pilotVoice(callsign: string): Voice {
  const h = hash(callsign);
  if (h % 5 >= 2) return { voice: 'us', speaker: (h >>> 4) % 904 };
  const speaker = (h >>> 4) % 108;
  return { voice: 'gb', speaker: speaker >= TOWER_VOICE.speaker ? speaker + 1 : speaker };
}
