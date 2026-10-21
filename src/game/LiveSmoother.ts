// filepath: src/game/LiveSmoother.ts
// Echter Verkehr ohne Sprünge und ohne Gummiband:
// 1. Vorausrechnung mit Kurvenrate und Beschleunigung, geschätzt aus den letzten Meldungen (Kurve, Abbremsen
//    im Anflug, Beschleunigen beim Start werden mitgerechnet, die Abweichung bei der nächsten Meldung ist klein).
// 2. Die gezeigte Lage folgt der Rechnung mit einer Geschwindigkeit statt mit einem Versatz: quer zum Kurs wird
//    weich nachgeführt, längs des Kurses nie rückwärts. War die Anzeige voraus, wird der Flieger kurz langsamer.
// Am Boden wird ab ROLL_KT weitergerechnet (Startlauf, Ausrollen), langsamer gilt die gemeldete Position.
import type { LiveAircraft } from '@/types/live';

const MAX_S = 30;
/** Kurvenrate und Beschleunigung nur so lange weiterrechnen, danach geradeaus mit konstanter Geschwindigkeit */
const TURN_S = 20;
const ROLL_KT = 30;
/** Nachführzeit: in dieser Zeit wird eine Abweichung etwa ausgeglichen */
const TAU_S = 1.5;
/** Größere Abweichungen sind kein Rechenfehler, sondern ein Neuansatz (Lücke im Empfang): springen */
const SNAP_NM = 1.5;
const SNAP_FT = 1500;
const NM_PER_DEG = 60;

interface Report { ts: number; lat: number; lng: number; track: number | null; gs: number | null }
interface State {
  last: Report;
  turn: number;  // °/s
  accel: number; // kt/s
  lat: number; lng: number; alt: number | null;
  at: number;    // Zeit der letzten Anzeige
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

export class LiveSmoother {
  private states = new Map<string, State>();

  private moving(a: LiveAircraft): boolean {
    return a.gs !== null && a.track !== null && (!a.ground || a.gs >= ROLL_KT);
  }

  /** Rechnung: letzte Meldung mit Kurvenrate und Beschleunigung auf `now` weiter; dazu Kurs und Geschwindigkeit dann */
  private predict(a: LiveAircraft, s: State | undefined, now: number) {
    const alt = a.ground || a.altFt === null ? a.altFt
      : Math.max(0, a.altFt + ((a.vs ?? 0) * Math.min(MAX_S, Math.max(0, (now - a.ts) / 1000))) / 60);
    if (!this.moving(a)) return { lat: a.lat, lng: a.lng, alt, track: a.track ?? 0, gs: 0 };
    const dt = Math.min(MAX_S, Math.max(0, (now - a.ts) / 1000));
    const turn = s?.turn ?? 0, accel = s?.accel ?? 0;
    let lat = a.lat, lng = a.lng, trk = a.track as number, gs = a.gs as number;
    // in Schritten von höchstens 1 s, flach gerechnet (Strecken unter 5 NM)
    for (let t = 0; t < dt; ) {
      const h = Math.min(1, dt - t);
      const ramp = t < TURN_S ? 1 : 0;
      const trkMid = trk + (turn * ramp * h) / 2;
      const gsMid = Math.max(0, gs + (accel * ramp * h) / 2);
      const d = (gsMid * h) / 3600;
      const r = (trkMid * Math.PI) / 180;
      lat += (d * Math.cos(r)) / NM_PER_DEG;
      lng += (d * Math.sin(r)) / (NM_PER_DEG * Math.cos((lat * Math.PI) / 180));
      trk += turn * ramp * h;
      gs = Math.max(0, gs + accel * ramp * h);
      t += h;
    }
    return { lat, lng, alt, track: ((trk % 360) + 360) % 360, gs };
  }

  /** Geglättete Position und Höhe jetzt */
  at(a: LiveAircraft, now: number): { lat: number; lng: number; alt: number | null } {
    let s = this.states.get(a.hex);
    const report: Report = { ts: a.ts, lat: a.lat, lng: a.lng, track: a.track, gs: a.gs };
    if (s && Math.abs(s.last.ts - a.ts) > 500) {
      // Neue Meldung: Kurvenrate und Beschleunigung aus dem Vergleich mit der vorigen, leicht gemittelt
      const dt = (a.ts - s.last.ts) / 1000;
      if (dt >= 1 && dt <= 60) {
        const turn = s.last.track !== null && a.track !== null ? clamp(angDiff(a.track, s.last.track) / dt, -4, 4) : 0;
        const accel = s.last.gs !== null && a.gs !== null ? clamp((a.gs - s.last.gs) / dt, -4, 4) : 0;
        s.turn = Math.abs(turn) < 0.15 ? 0 : 0.3 * s.turn + 0.7 * turn;
        s.accel = Math.abs(accel) < 0.1 ? 0 : 0.3 * s.accel + 0.7 * accel;
      } else { s.turn = 0; s.accel = 0; }
      s.last = report;
    }
    const target = this.predict(a, s, now);
    if (!s) {
      s = { last: report, turn: 0, accel: 0, lat: target.lat, lng: target.lng, alt: target.alt, at: now };
      this.states.set(a.hex, s);
      return target;
    }
    const h = clamp((now - s.at) / 1000, 0, 0.5);
    s.at = now;
    // Abweichung Anzeige → Rechnung in NM (Nord, Ost)
    const cosLat = Math.cos((target.lat * Math.PI) / 180);
    const eN = (target.lat - s.lat) * NM_PER_DEG, eE = (target.lng - s.lng) * NM_PER_DEG * cosLat;
    if (Math.hypot(eN, eE) > SNAP_NM || !this.moving(a)) {
      s.lat = target.lat; s.lng = target.lng;
    } else {
      // Geschwindigkeit = Rechnung + Korrektur; längs des Kurses nie rückwärts, höchstens auf 40 % gebremst
      const r = (target.track * Math.PI) / 180;
      const ux = Math.sin(r), uy = Math.cos(r);
      const v = target.gs / 3600; // NM/s
      let vE = v * ux + eE / TAU_S, vN = v * uy + eN / TAU_S;
      const along = vE * ux + vN * uy;
      const minAlong = 0.4 * v;
      if (along < minAlong) { vE += (minAlong - along) * ux; vN += (minAlong - along) * uy; }
      s.lat += (vN * h) / NM_PER_DEG;
      s.lng += (vE * h) / (NM_PER_DEG * cosLat);
    }
    if (target.alt === null || s.alt === null || a.ground || Math.abs(target.alt - s.alt) > SNAP_FT) s.alt = target.alt;
    else s.alt = Math.max(0, s.alt + ((a.vs ?? 0) * h) / 60 + ((target.alt - s.alt) * h) / TAU_S);
    return { lat: s.lat, lng: s.lng, alt: s.alt === null ? null : Math.round(s.alt) };
  }

  /** Flieger vergessen, die nicht mehr gemeldet werden */
  keep(hexes: Iterable<string>): void {
    const keep = new Set(hexes);
    for (const k of this.states.keys()) if (!keep.has(k)) this.states.delete(k);
  }
}
