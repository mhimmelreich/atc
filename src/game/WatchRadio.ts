// filepath: src/game/WatchRadio.ts
// WATCH: Funkspruch zum gewählten echten Flug, so wie er in seiner Lage gerade typisch wäre. Den echten
// Funk gibt ADS-B nicht her; Wortlaut nach ICAO-Sprechfunk, Bahn und Höhen aus Position und Autopilot.
import type { Airport } from '@/types/airport';
import type { LiveAircraft, LiveInbound } from '@/types/live';
import type { RadioMessage } from '@/types/radio';
import type { Weather } from '@/types/weather';
import { bearingBetween, distanceNM } from '@/utils/geo';
import { finalRunway } from './NextLander';
import {
  APPROACH_VOICE, TOWER_VOICE, capitalize, join, phrase, pilotVoice, radioContext, stations, type Phrase, type Voice,
} from './Phraseology';
import { NATO, altitudePhrase, spokenName, spokenRunway } from './Speech';
import { radioCallsign } from './Telephony';

export type WatchCall = Omit<RadioMessage, 'id' | 'ts'>;

/** Ab dieser Entfernung zur Schwelle spricht der Endanflug schon mit dem Turm */
const TOWER_NM = 8;

const rwyPhrase = (id: string): Phrase => phrase(`runway ${id}`, `runway ${spokenRunway(id)}`);

/** Startlauf: auf einer Bahn, Kurs wie die Bahn, schneller als Rollen */
function takeoffRunway(ac: LiveAircraft, airport: Airport): string | null {
  if (ac.track === null || (ac.gs ?? 0) < 40) return null;
  for (const r of airport.runways) {
    const course = bearingBetween(r.thresholdLat, r.thresholdLng, r.endLat, r.endLng);
    if (Math.abs(((ac.track - course + 540) % 360) - 180) > 15) continue;
    const d = distanceNM(r.thresholdLat, r.thresholdLng, ac.lat, ac.lng);
    const off = ((bearingBetween(r.thresholdLat, r.thresholdLng, ac.lat, ac.lng) - course + 540) % 360) - 180;
    const along = d * Math.cos((off * Math.PI) / 180);
    const len = distanceNM(r.thresholdLat, r.thresholdLng, r.endLat, r.endLng);
    if (along > -0.1 && along < len && Math.abs(d * Math.sin((off * Math.PI) / 180)) < 0.05) return r.id;
  }
  return null;
}

/** Funkverkehr zum Flug (Pilot und Lotse) oder null, wenn in seiner Lage gerade keiner passt */
export function watchExchange(
  ac: LiveAircraft, role: LiveInbound | undefined, airport: Airport, activeRunwayIds: string[], weather: Weather | null,
): WatchCall[] | null {
  const ctx = radioContext(airport, [], weather);
  const st = stations(airport);
  const cs = radioCallsign(ac.callsign || ac.reg || ac.hex.toUpperCase());
  const csP: Phrase = { text: cs.text, spoken: cs.spoken };
  const pilot = pilotVoice(ac.callsign || ac.hex);
  const ta = airport.transitionAltitudeFt;
  const msg = (from: 'atc' | 'pilot', station: 'app' | 'twr', p: Phrase, v: Voice): WatchCall => ({
    from, station, aircraftId: `live-${ac.hex}`, callsign: ac.callsign, text: capitalize(p.text), spoken: capitalize(p.spoken), ...v,
  });
  const named = (name: string): Phrase => phrase(name, spokenName(name));
  const alt = ac.altFt ?? 0;

  // ── Abflug ──
  if (role?.out) {
    if (ac.ground || alt <= 0) {
      const rwy = takeoffRunway(ac, airport);
      if (!rwy) return null;
      return [
        msg('atc', 'twr', join([csP, ...(ctx.wind ? [ctx.wind] : []), phrase(`${rwyPhrase(rwy).text} cleared for take-off`, `${rwyPhrase(rwy).spoken} cleared for take off`)]), TOWER_VOICE),
        msg('pilot', 'twr', join([phrase(`cleared for take-off ${rwyPhrase(rwy).text}`, `cleared for take off ${rwyPhrase(rwy).spoken}`), csP]), pilot),
      ];
    }
    const dep = named(st.departure.name);
    const passing = altitudePhrase(alt, ta);
    const parts = [dep, csP, phrase(`passing ${passing.text}`, `passing ${passing.spoken}`)];
    const sel = ac.selAltFt;
    if (sel && sel > alt + 300) {
      const to = altitudePhrase(sel, ta);
      parts.push(phrase(`climbing ${to.text}`, `climbing ${to.spoken}`));
    }
    return [
      msg('pilot', 'app', join(parts), pilot),
      msg('atc', 'app', join([csP, dep, phrase('identified')]), APPROACH_VOICE),
    ];
  }

  // Überflüge ruft keine Anflug- oder Platzstelle
  if (!role || ac.ground || alt <= 0) return null;

  // ── Anflug auf dem Endanflug ──
  const ils = airport.runways.filter((r) => r.role !== 'departure');
  const fin = finalRunway(ac, ils);
  if (fin) {
    const rwy = rwyPhrase(fin.runway.id);
    if (fin.miles <= TOWER_NM) {
      const tower = named(st.tower.name);
      const ilsP = phrase(`ILS ${rwy.text}`, `I L S ${rwy.spoken}`);
      return [
        msg('pilot', 'twr', join([tower, csP, ilsP]), pilot),
        msg('atc', 'twr', join([csP, tower, ...(ctx.wind ? [ctx.wind] : []), phrase(`${rwy.text} cleared to land`, `${rwy.spoken} cleared to land`)]), TOWER_VOICE),
        msg('pilot', 'twr', join([phrase(`cleared to land ${rwy.text}`, `cleared to land ${rwy.spoken}`), csP]), pilot),
      ];
    }
    // Weiter draußen auf dem Localizer: Übergabe an den Turm
    const freq = ctx.towerFreq;
    const contact = freq ? phrase(`contact ${st.tower.name} ${freq.text}`, `contact ${spokenName(st.tower.name)} ${freq.spoken}`) : phrase(`contact ${st.tower.name}`, `contact ${spokenName(st.tower.name)}`);
    const back = freq ? phrase(`Tower ${freq.text}`, `tower ${freq.spoken}`) : phrase('Tower');
    return [
      msg('atc', 'app', join([csP, contact]), APPROACH_VOICE),
      msg('pilot', 'app', join([back, csP]), pilot),
    ];
  }

  // ── Anflug vor dem Endanflug: Erstanruf bei der Anflugkontrolle ──
  const app = named(st.approach.name);
  const level = altitudePhrase(alt, ta);
  const sel = ac.selAltFt;
  const descending = sel !== undefined && sel < alt - 300;
  const to = descending ? altitudePhrase(sel, ta) : null;
  const call = [app, csP, to ? phrase(`${level.text} descending ${to.text}`, `${level.spoken} descending ${to.spoken}`) : level, phrase(`information ${NATO[ctx.atis]}`)];
  const active = ils.find((r) => activeRunwayIds.includes(r.id) && r.ils) ?? ils.find((r) => activeRunwayIds.includes(r.id));
  const instr: Phrase[] = [];
  if (to) {
    const verb = sel! > ta ? 'descend' : 'descend to';
    instr.push(phrase(`${verb} ${to.text}`, `${verb} ${to.spoken}`));
    if (sel! <= ta) instr.push(ctx.pressure);
  }
  if (active) instr.push(phrase(`expect ILS approach ${rwyPhrase(active.id).text}`, `expect I L S approach ${rwyPhrase(active.id).spoken}`));
  const out: WatchCall[] = [
    msg('pilot', 'app', join(call), pilot),
    msg('atc', 'app', join([csP, app, phrase('identified'), ...instr]), APPROACH_VOICE),
  ];
  if (instr.length) out.push(msg('pilot', 'app', join([...instr, csP]), pilot));
  return out;
}
