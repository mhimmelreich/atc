// filepath: server/dayTracks.ts
// Tagesaufzeichnung: alle Landungen und Starts eines Platzes mit ihrer Spur im Umkreis (120 NM),
// damit WATCH einen ganzen Tag auf einmal als Linien zeigen kann. Quelle ist derselbe adsb.lol-Abruf
// wie fürs Radar (ODbL), alle 15 s. Gespeichert wird je Platz und Ortsdatum eine Datei mit einer
// Zeile JSON je Flug (Format siehe DayFlight), ältere Tage werden nach KEEP_DAYS gelöscht.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import { snapshotAt, routeOf, type Snapshot } from './routes/traffic.js';
import { airportPos } from './routes/opendata.js';

const DATA_DIR = process.env.DAYTRACK_DIR ?? 'data/daytracks';
const AIRPORTS = (process.env.DAYTRACK_AIRPORTS ?? 'EDDF').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const POLL_MS = 15_000;
const LOST_MS = 10 * 60_000;      // so lange nicht gesehen → Flug abgeschlossen (außer Reichweite)
const LANDED_DONE_MS = 60_000;    // nach dem Aufsetzen noch kurz das Ausrollen mitnehmen
const EVENT_NM = 5;               // Landung bzw. Start zählt nur so nah am Platz
const KEEP_DAYS = 30;

/** Ein Flug in der Datei: Punkte [lat, lng, ALT in ft (null am Boden), Sekunden seit t0] */
export interface DayFlight {
  hex: string;
  cs: string;
  type?: string;
  dir: 'in' | 'out';
  /** Start- bzw. Zielplatz laut Route */
  other?: string;
  /** Zeit des ersten Punkts (ms) */
  t0: number;
  p: Array<[number, number, number | null, number]>;
}

interface Active {
  hex: string;
  cs: string;
  type?: string;
  dir?: 'in' | 'out';
  other?: string;
  pts: Array<[number, number, number | null, number]>; // Zeit hier noch absolut (ms)
  lastSeen: number;
  airborne: boolean;
  landedAt?: number;
}

const active = new Map<string, Map<string, Active>>(); // ICAO → hex → Flug

const R_NM = 3440.065;
function distNM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ortsdatum (Zeitzone des Servers, TZ=Europe/Berlin) als YYYY-MM-DD */
const localDate = (ms: number) => new Date(ms).toLocaleDateString('sv-SE');

/** Richtung aus der Route: Platz am Ende → Anflug, am Anfang → Abflug, mittendrin nach Steig-/Sinkflug */
function dirFromRoute(icao: string, route: string | undefined, vs: number | null): { dir?: 'in' | 'out'; other?: string } {
  if (!route) return {};
  const codes = route.split('-');
  const first = codes.indexOf(icao), last = codes.lastIndexOf(icao);
  if (last < 0) return {};
  if (last === codes.length - 1 && last > 0) return { dir: 'in', other: codes[last - 1] };
  if (first === 0 && codes.length > 1) return { dir: 'out', other: codes[1] };
  return (vs ?? 0) < 0 ? { dir: 'in', other: codes[last - 1] } : { dir: 'out', other: codes[first + 1] };
}

function finish(icao: string, f: Active): void {
  if (!f.dir || f.pts.length < 2) return;
  const t0 = f.pts[0][3];
  const flight: DayFlight = {
    hex: f.hex, cs: f.cs, ...(f.type ? { type: f.type } : {}), dir: f.dir, ...(f.other ? { other: f.other } : {}),
    t0, p: f.pts.map(([la, lo, alt, t]) => [la, lo, alt, Math.round((t - t0) / 1000)]),
  };
  // Tag der Landung bzw. des Starts
  const day = localDate(f.dir === 'in' ? f.pts[f.pts.length - 1][3] : t0);
  try {
    const dir = join(DATA_DIR, icao);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${day}.ndjson`), JSON.stringify(flight) + '\n');
  } catch (err) {
    console.error('daytracks: speichern', (err as Error).message);
  }
}

function record(icao: string, apt: { lat: number; lng: number }, snap: Snapshot): void {
  const flights = active.get(icao) ?? new Map<string, Active>();
  active.set(icao, flights);
  for (const a of snap.aircraft) {
    const ts = Math.round(snap.fetchedAt - a.seenPos * 1000);
    const near = distNM(a.lat, a.lng, apt.lat, apt.lng) < EVENT_NM;
    let f = flights.get(a.hex);
    if (!f) {
      f = { hex: a.hex, cs: a.callsign, type: a.type, pts: [], lastSeen: ts, airborne: !a.ground };
      flights.set(a.hex, f);
    }
    if (f.cs !== a.callsign && !/^[0-9A-F]{6}$/.test(a.callsign)) f.cs = a.callsign;
    if (!f.dir) Object.assign(f, dirFromRoute(icao, routeOf(a.callsign), a.vs));
    // Ereignisse am Platz sind sicherer als die Route
    const down = a.ground || (a.altFt !== null && a.altFt <= 0); // gelandet: ALT von über 0 auf 0 bzw. Boden
    if (down && f.airborne && near) { f.dir = 'in'; f.landedAt = ts; }
    if (!a.ground && !f.airborne && near && f.pts.length > 0) f.dir = 'out';
    f.airborne = !down;
    const last = f.pts[f.pts.length - 1];
    if (!last || ts > last[3]) f.pts.push([Math.round(a.lat * 1e4) / 1e4, Math.round(a.lng * 1e4) / 1e4, down ? null : Math.round((a.altFt ?? 0) / 25) * 25, ts]);
    // Vor dem Start am Boden (Parken, Rollen) nur die letzten Punkte behalten
    if (!f.dir && down && f.pts.length > 12) f.pts.splice(0, f.pts.length - 12);
    f.lastSeen = ts;
  }
  const now = snap.fetchedAt;
  for (const [hex, f] of flights) {
    const landedDone = f.landedAt !== undefined && now - f.landedAt > LANDED_DONE_MS;
    if (landedDone || now - f.lastSeen > LOST_MS) {
      finish(icao, f);
      flights.delete(hex);
    }
  }
}

function prune(): void {
  const cutoff = localDate(Date.now() - KEEP_DAYS * 86_400_000);
  for (const icao of existsSync(DATA_DIR) ? readdirSync(DATA_DIR) : []) {
    for (const file of readdirSync(join(DATA_DIR, icao))) {
      if (file.slice(0, 10) < cutoff) rmSync(join(DATA_DIR, icao, file), { force: true });
    }
  }
}

export function startDayTracks(): void {
  const positions = new Map<string, { lat: number; lng: number }>();
  const tick = async () => {
    for (const icao of AIRPORTS) {
      try {
        let pos = positions.get(icao);
        if (!pos) {
          pos = await airportPos(icao);
          if (!pos) continue;
          positions.set(icao, pos);
        }
        const snap = await snapshotAt(pos.lat, pos.lng);
        if (snap) record(icao, pos, snap);
      } catch (err) {
        console.error('daytracks:', (err as Error).message);
      }
    }
  };
  setInterval(() => void tick(), POLL_MS).unref();
  void tick();
  prune();
  setInterval(prune, 6 * 3600_000).unref();
}

// ── Abfrage ──────────────────────────────────────────────────────────────────

export const dayTracksRouter = Router();

/** Plätze mit Aufzeichnung und ihre Tage */
dayTracksRouter.get('/', (_req, res) => {
  const out: Record<string, string[]> = {};
  for (const icao of AIRPORTS) {
    const dir = join(DATA_DIR, icao);
    out[icao] = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, 10)).sort() : [];
  }
  res.json({ airports: out });
});

/** Alle Flüge eines Tages (heute samt den laufenden), ?dir=in|out|all */
dayTracksRouter.get('/:icao', (req, res) => {
  const icao = req.params.icao.toUpperCase();
  const date = String(req.query.date ?? localDate(Date.now()));
  const want = req.query.dir === 'in' || req.query.dir === 'out' ? req.query.dir : 'all';
  if (!/^[A-Z0-9]{3,4}$/.test(icao) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'Platz oder Datum ungültig' }); return; }
  if (!AIRPORTS.includes(icao)) { res.json({ icao, date, recorded: false, flights: [] }); return; }
  const flights: DayFlight[] = [];
  const file = join(DATA_DIR, icao, `${date}.ndjson`);
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try { flights.push(JSON.parse(line) as DayFlight); } catch { /* halbe Zeile beim Schreiben */ }
    }
  }
  if (date === localDate(Date.now())) {
    for (const f of active.get(icao)?.values() ?? []) {
      if (!f.dir || f.pts.length < 2) continue;
      const t0 = f.pts[0][3];
      flights.push({ hex: f.hex, cs: f.cs, ...(f.type ? { type: f.type } : {}), dir: f.dir, ...(f.other ? { other: f.other } : {}), t0, p: f.pts.map(([la, lo, alt, t]) => [la, lo, alt, Math.round((t - t0) / 1000)]) });
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ icao, date, recorded: true, flights: want === 'all' ? flights : flights.filter((f) => f.dir === want) });
});
