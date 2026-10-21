// filepath: server/routes/traffic.ts
// Echter Verkehr über adsb.fi (Open Data, nur private Nutzung, Quellenhinweis im Spiel), Ersatz adsb.lol (ODbL).
// adsb.lol erlaubt seit Oktober 2026 nur noch 500 Abfragen am Tag je IP, zu wenig für Spiel und Tagesaufzeichnung.
// Alle Spieler am selben Platz teilen sich eine Abfrage: Antwort 5 s zwischengespeichert.
// Die Flugroute (Start- und Zielplatz) kommt von der Routen-Abfrage der adsb.lol-API (adsb.im,
// Daten aus VRS standing-data, CC0).
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { fillGap, type GapPoint } from '../nat.js';

const router = Router();

// Quellen in Reihenfolge; dieselben readsb-Felder ("ac"). adsb.fi: höchstens 1 Abfrage pro Sekunde
const UPSTREAMS: Array<{ name: string; url: (lat: number, lon: number, nm: number) => string; gapMs: number; nextAt: number; blockedUntil: number }> = [
  { name: 'adsb.fi', url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${nm}`, gapMs: 1100, nextAt: 0, blockedUntil: 0 },
  { name: 'adsb.lol', url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`, gapMs: 0, nextAt: 0, blockedUntil: 0 },
];
const BLOCK_429_MS = 5 * 60_000; // nach 429 ohne Angabe der Wartezeit die Quelle so lange auslassen
const BLOCK_ERR_MS = 15_000;
const USER_AGENT = 'atc-game (games.himmelreich.cloud)';
const RADIUS_NM = 120;
const TTL_MS = 5000;
const REUSE_MS = TTL_MS; // Favoriten-Radar nutzt eine gleich frische Abfrage in der Nähe mit (nicht älter als sonst)
const MAX_POS_AGE_S = 30; // ältere Positionen sind kein brauchbares Radarziel mehr
const RETRY_AFTER_MS = 15_000; // nach einem Fehler adsb.lol eine Weile in Ruhe lassen
const STALE_MS = 30_000;       // so lange darf bei Fehlern der letzte Stand ausgeliefert werden
const UPSTREAM_PER_MIN = 40;   // Obergrenze für Abfragen bei adsb.lol, egal wie viele Plätze angefragt werden

const ROUTE_URL = 'https://adsb.im/api/0/routeset';
const ROUTE_TTL_MS = 6 * 3600_000;   // Routen ändern sich kaum
const ROUTE_MISS_TTL_MS = 3600_000;  // unbekannte Rufzeichen später noch einmal versuchen
const ROUTE_BATCH = 100;
const ROUTE_MIN_INTERVAL_MS = 15_000; // freundlich zur kostenlosen API: neue Rufzeichen gesammelt abfragen
const AIRLINE_CALLSIGN = /^[A-Z]{3}\d[0-9A-Z]{0,3}$/;

interface RawAircraft {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | 'ground';
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  nav_altitude_mcp?: number;
  geom_rate?: number;
  squawk?: string;
  lat?: number;
  lon?: number;
  seen_pos?: number;
  category?: string;
}

export interface LiveAircraftDto {
  hex: string;
  callsign: string;
  type?: string;
  reg?: string;
  lat: number;
  lng: number;
  altFt: number | null;
  ground: boolean;
  gs: number | null;
  track: number | null;
  vs: number | null;
  squawk?: string;
  /** Im Autopiloten gewählte Höhe (MCP/FCU), also die zuletzt freigegebene Höhe */
  selAltFt?: number;
  /** ADS-B-Kategorie (A1 leicht … A5 schwer, A7 Hubschrauber, B1 Segler …) */
  category?: string;
  /** Flugroute als ICAO-Kette, z. B. "EIDW-EDDF" (nur wenn bekannt und zur Position passend) */
  route?: string;
  /** Alter der Position in Sekunden zum Zeitpunkt der Antwort */
  age: number;
}

export interface Snapshot {
  fetchedAt: number;
  /** Datenquelle (adsb.fi oder adsb.lol) */
  source: string;
  aircraft: Array<Omit<LiveAircraftDto, 'age'> & { seenPos: number }>;
  /** Übriger Verkehr (Kleinflieger, Hubschrauber …), nur fürs Favoriten-Radar */
  others: Snapshot['aircraft'];
}

const cache = new Map<string, { snapshot?: Snapshot; pending?: Promise<Snapshot | undefined>; failedAt?: number }>();
let upstreamCalls: number[] = [];

// ── Routen ───────────────────────────────────────────────────────────────────
const routes = new Map<string, { codes: string | null; at: number }>();
let routeLookup: Promise<void> | null = null;
let routeLookupAt = 0;

const routeFresh = (r: { codes: string | null; at: number } | undefined, now: number) =>
  !!r && now - r.at < (r.codes ? ROUTE_TTL_MS : ROUTE_MISS_TTL_MS);

/** Fehlende Routen im Hintergrund nachladen; sie erscheinen mit der nächsten Abfrage */
function lookupRoutes(aircraft: Snapshot['aircraft']): void {
  const now = Date.now();
  if (routeLookup || now - routeLookupAt < ROUTE_MIN_INTERVAL_MS) return;
  for (const [cs, r] of routes) if (!routeFresh(r, now)) routes.delete(cs);
  const missing = aircraft
    .filter((a) => !a.ground && AIRLINE_CALLSIGN.test(a.callsign) && !routes.has(a.callsign))
    .slice(0, ROUTE_BATCH);
  if (missing.length === 0) return;
  routeLookupAt = now;
  routeLookup = fetch(ROUTE_URL, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ planes: missing.map((a) => ({ callsign: a.callsign, lat: a.lat, lng: a.lng })) }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`adsb.im HTTP ${res.status}`))))
    .then((list: Array<{ callsign?: string; airport_codes?: string; plausible?: boolean } | null>) => {
      const found = new Map(list.filter((r) => r?.callsign).map((r) => [r!.callsign!, r!]));
      const at = Date.now();
      for (const a of missing) {
        const r = found.get(a.callsign);
        // Unplausibel heißt: Position passt nicht zur Route (z. B. Rufzeichen mit anderer Strecke)
        const codes = r?.airport_codes && r.airport_codes !== 'unknown' && r.plausible !== false ? r.airport_codes : null;
        routes.set(a.callsign, { codes, at });
      }
    })
    .catch((err: Error) => console.error('routes:', err.message))
    .finally(() => { routeLookup = null; });
}

function distNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}

function allowUpstream(now: number): boolean {
  upstreamCalls = upstreamCalls.filter((t) => now - t < 60_000);
  if (upstreamCalls.length >= UPSTREAM_PER_MIN) return false;
  upstreamCalls.push(now);
  return true;
}

/**
 * Nur Verkehr, der für die Anflugkontrolle zählt: Kategorien A2–A6 (Jets, Turboprops, Heavies)
 * oder ein Airline-Rufzeichen wie DLH4AB. Kleinflieger, Ultraleicht, Segelflieger, Hubschrauber,
 * Ballone und Bodenfahrzeuge würden das Radar nur füllen.
 */
function isRelevant(a: RawAircraft, callsign: string): boolean {
  const cat = a.category ?? '';
  if (/^(A7|B|C)/.test(cat)) return false;
  return /^A[2-6]$/.test(cat) || AIRLINE_CALLSIGN.test(callsign);
}

function mapAircraft(a: RawAircraft): (Snapshot['aircraft'][number] & { relevant: boolean }) | null {
  if (typeof a.lat !== 'number' || typeof a.lon !== 'number' || (a.seen_pos ?? 0) > MAX_POS_AGE_S) return null;
  const callsign = (a.flight ?? '').trim() || a.r || a.hex.toUpperCase();
  // Bodenfahrzeuge, Hindernisse und Ballone sind kein Luftverkehr
  if (/^(C|B2)/.test(a.category ?? '')) return null;
  const relevant = isRelevant(a, callsign);
  const ground = a.alt_baro === 'ground';
  const track = a.track ?? a.true_heading;
  return {
    hex: a.hex,
    callsign,
    ...(a.t ? { type: a.t } : {}),
    ...(a.r ? { reg: a.r } : {}),
    lat: a.lat,
    lng: a.lon,
    altFt: typeof a.alt_baro === 'number' ? a.alt_baro : null,
    ground,
    gs: a.gs ?? null,
    track: track ?? null,
    vs: a.baro_rate ?? a.geom_rate ?? null,
    ...(a.squawk ? { squawk: a.squawk } : {}),
    // Gerät meldet z. B. 4992 statt 5000: auf 100 ft runden
    ...(typeof a.nav_altitude_mcp === 'number' && a.nav_altitude_mcp > 0 ? { selAltFt: Math.round(a.nav_altitude_mcp / 100) * 100 } : {}),
    ...(a.category ? { category: a.category } : {}),
    seenPos: a.seen_pos ?? 0,
    relevant,
  };
}

/** Erste Quelle, die gerade nicht gesperrt ist; nach 429 so lange auslassen, wie sie verlangt */
async function fetchUpstream(lat: number, lon: number): Promise<{ source: string; data: { ac?: RawAircraft[] } }> {
  let lastErr = new Error('keine Quelle frei');
  for (const u of UPSTREAMS) {
    const now = Date.now();
    if (now < u.blockedUntil) continue;
    // Abstand zwischen zwei Abfragen derselben Quelle einhalten (mehrere Plätze gleichzeitig)
    const wait = Math.max(0, u.nextAt - now);
    u.nextAt = now + wait + u.gapMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(u.url(lat, lon, RADIUS_NM), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? res.headers.get('retry-after'));
        const ms = Number.isFinite(reset) && reset > 0 ? Math.min(reset * 1000, 86_400_000) : BLOCK_429_MS;
        u.blockedUntil = Date.now() + ms;
        console.error(`traffic: ${u.name} HTTP 429, ausgesetzt für ${Math.round(ms / 60_000)} min`);
        lastErr = new Error(`${u.name} HTTP 429`);
        continue;
      }
      if (!res.ok) throw new Error(`${u.name} HTTP ${res.status}`);
      return { source: u.name, data: await res.json() as { ac?: RawAircraft[] } };
    } catch (err) {
      if (u.blockedUntil < Date.now()) u.blockedUntil = Date.now() + BLOCK_ERR_MS;
      lastErr = err as Error;
      console.error('traffic:', u.name, lastErr.message);
    }
  }
  throw lastErr;
}

async function fetchSnapshot(lat: number, lon: number): Promise<Snapshot> {
  const { source, data } = await fetchUpstream(lat, lon);
  const aircraft: Snapshot['aircraft'] = [];
  const others: Snapshot['aircraft'] = [];
  for (const raw of data.ac ?? []) {
    const m = mapAircraft(raw);
    if (!m) continue;
    const { relevant, ...a } = m;
    (relevant ? aircraft : others).push(a);
  }
  return { fetchedAt: Date.now(), source, aircraft, others };
}

/**
 * Verkehr um einen Punkt: gemeinsamer Zwischenspeicher für alle Spieler und die Tagesaufzeichnung,
 * undefined, wenn nichts Brauchbares da ist (Fehler und auch der letzte Stand zu alt)
 */
export async function snapshotAt(lat: number, lon: number, needNm?: number): Promise<Snapshot | undefined> {
  // Favoriten-Radar mit kleinerem Umkreis: eine frische Abfrage in der Nähe, die ihn ganz abdeckt, mitbenutzen
  // (schont das Abfrage-Limit bei adsb.lol, wenn mehrere Favoriten nah beieinander liegen)
  if (needNm !== undefined) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (!v.snapshot || now - v.snapshot.fetchedAt > REUSE_MS) continue;
      const [cLat, cLon] = k.split(',').map(Number);
      if (distNm(lat, lon, cLat, cLon) + needNm <= RADIUS_NM) return v.snapshot;
    }
  }
  // Auf 0,05° (≈ 3 NM) gerundet: Spieler und Tagesaufzeichnung am selben Platz teilen sich eine Abfrage,
  // auch wenn ihre Platzkoordinaten (Navigraph, OurAirports) leicht abweichen; bei 120 NM Umkreis egal
  const qLat = Math.round(lat * 20) / 20;
  const qLon = Math.round(lon * 20) / 20;
  const key = `${qLat},${qLon}`;
  const now = Date.now();

  // Alte Plätze aufräumen
  for (const [k, v] of cache) {
    if (!v.pending && now - (v.snapshot?.fetchedAt ?? v.failedAt ?? 0) > 60_000) cache.delete(k);
  }

  const entry = cache.get(key) ?? {};
  cache.set(key, entry);
  const fresh = entry.snapshot !== undefined && now - entry.snapshot.fetchedAt <= TTL_MS;
  const resting = entry.failedAt !== undefined && now - entry.failedAt < RETRY_AFTER_MS;
  if (!fresh && !resting && (entry.pending || allowUpstream(now))) {
    // Gleichzeitige Anfragen warten auf dieselbe Abfrage
    entry.pending ??= fetchSnapshot(qLat, qLon)
      .then((snapshot) => { entry.snapshot = snapshot; entry.failedAt = undefined; return snapshot; })
      .catch(() => { entry.failedAt = Date.now(); return undefined; })
      .finally(() => { entry.pending = undefined; });
    await entry.pending;
  }

  // Nach einem Fehler noch kurz den letzten Stand liefern
  const snapshot = entry.snapshot;
  if (!snapshot || Date.now() - snapshot.fetchedAt > STALE_MS) return undefined;
  lookupRoutes(snapshot.aircraft);
  return snapshot;
}

/** Bekannte Flugroute eines Rufzeichens als ICAO-Kette (z. B. "EGLL-EDDF"), sonst undefined */
export function routeOf(callsign: string): string | undefined {
  return routes.get(callsign)?.codes ?? undefined;
}

// Eigenes Limit vor dem allgemeinen: der Client fragt alle 5 s
router.use(rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }));

router.get('/', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.status(400).json({ error: 'lat und lon fehlen' });
    return;
  }
  // Favoriten-Radar: nm = gewünschter Umkreis, all=1 auch Kleinflieger, Hubschrauber, Segler
  const nm = Number(req.query.nm);
  const all = req.query.all === '1';
  const snapshot = await snapshotAt(lat, lon, Number.isFinite(nm) && nm > 0 && nm <= RADIUS_NM ? nm : undefined);
  if (!snapshot) {
    res.status(503).json({ error: 'Live-Verkehr nicht verfügbar' });
    return;
  }
  const sinceFetch = (Date.now() - snapshot.fetchedAt) / 1000;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    source: snapshot.source,
    ...(snapshot.source === 'adsb.lol' ? { license: 'ODbL 1.0' } : {}),
    aircraft: (all ? [...snapshot.aircraft, ...snapshot.others] : snapshot.aircraft).map(({ seenPos, ...a }) => {
      const route = routes.get(a.callsign)?.codes;
      return { ...a, ...(route ? { route } : {}), age: Math.round((seenPos + sinceFetch) * 10) / 10 };
    }),
  });
});

// ── Vergangene Flugbahn eines Fliegers (WATCH) ─────────────────────────────
// Spur des laufenden Flugs aus den Trace-Dateien von adsb.lol (dieselben Daten, ODbL): der ganze Tag
// (trace_full, wird seltener erneuert) plus die letzten Minuten (trace_recent). Nur auf Klick, 60 s zwischengespeichert.
const TRACE_URL = 'https://adsb.lol/data/traces';
const TRACE_TTL_MS = 60_000;
const TRACE_MAX_POINTS = 800;
const TRACE_PER_MIN = 30;
const traces = new Map<string, { at: number; points: OutPoint[] }>();
let traceCalls: number[] = [];

/** [lat, lng, altFt (null am Boden), Zeitpunkt in ms] */
type TracePoint = [number, number, number | null, number];
/** wie TracePoint, mit 1 am Ende für geschätzte Punkte (Lücke ohne Empfang, z. B. über dem Atlantik) */
type OutPoint = TracePoint | GapPoint;

interface TraceFile {
  timestamp: number;
  trace: Array<[number, number, number, number | 'ground' | null, number | null, number | null, number, ...unknown[]]>;
}

async function fetchTrace(hex: string, kind: 'full' | 'recent'): Promise<TraceFile | null> {
  const res = await fetch(`${TRACE_URL}/${hex.slice(-2)}/trace_${kind}_${hex}.json`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`adsb.lol trace HTTP ${res.status}`);
  return res.json() as Promise<TraceFile>;
}

/** Punkte ab dem Beginn des letzten Flugabschnitts (readsb: Flag 2 = neuer Abschnitt) */
function currentLeg(files: Array<TraceFile | null>): OutPoint[] {
  const all: Array<{ ts: number; p: TracePoint; newLeg: boolean }> = [];
  for (const f of files) {
    if (!f) continue;
    for (const t of f.trace) {
      const ts = (f.timestamp + t[0]) * 1000;
      const alt = typeof t[3] === 'number' ? t[3] : null;
      all.push({ ts, p: [t[1], t[2], alt, Math.round(ts)], newLeg: (t[6] & 2) !== 0 });
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  const dedup = all.filter((x, i) => i === 0 || x.ts > all[i - 1].ts);
  let start = 0;
  dedup.forEach((x, i) => { if (x.newLeg) start = i; });
  let leg = dedup.slice(start).map((x) => x.p);
  // Am Boden vor dem Start abschneiden: Spur beginnt mit dem Abheben (bzw. dem ersten Punkt in der Luft davor)
  const firstAir = leg.findIndex((p) => p[2] !== null);
  if (firstAir > 1) leg = leg.slice(firstAir - 1);
  if (leg.length > TRACE_MAX_POINTS) {
    const step = leg.length / TRACE_MAX_POINTS;
    leg = Array.from({ length: TRACE_MAX_POINTS }, (_, i) => leg[Math.floor(i * step)]).concat([leg[leg.length - 1]]);
  }
  // Große Lücken ohne Empfang (Ozean) über NAT-Tracks bzw. den Großkreis schätzen
  const out: OutPoint[] = [];
  leg.forEach((p, i) => { if (i > 0) out.push(...fillGap(leg[i - 1], p)); out.push(p); });
  return out;
}

router.get('/trace/:hex', async (req, res) => {
  const hex = req.params.hex.toLowerCase();
  if (!/^~?[0-9a-f]{6}$/.test(hex)) { res.status(400).json({ error: 'Ungültige Kennung' }); return; }
  const now = Date.now();
  const hit = traces.get(hex);
  if (hit && now - hit.at < TRACE_TTL_MS) { res.json({ points: hit.points }); return; }
  traceCalls = traceCalls.filter((t) => now - t < 60_000);
  if (traceCalls.length >= TRACE_PER_MIN) { res.status(429).json({ error: 'Zu viele Abfragen' }); return; }
  traceCalls.push(now);
  try {
    const files = await Promise.all([fetchTrace(hex, 'full'), fetchTrace(hex, 'recent')]);
    const points = currentLeg(files);
    for (const [k, v] of traces) if (now - v.at > TRACE_TTL_MS) traces.delete(k);
    traces.set(hex, { at: now, points });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ points });
  } catch (err) {
    console.error('trace:', (err as Error).message);
    res.status(503).json({ error: 'Flugbahn nicht verfügbar' });
  }
});

export default router;
