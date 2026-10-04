// filepath: server/routes/traffic.ts
// Echter Verkehr über adsb.lol (Daten unter ODbL, Quellenhinweis im Spiel).
// Alle Spieler am selben Platz teilen sich eine Abfrage: Antwort 5 s zwischengespeichert.
// Die Flugroute (Start- und Zielplatz) kommt von der Routen-Abfrage der adsb.lol-API (adsb.im,
// Daten aus VRS standing-data, CC0).
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

const router = Router();

const UPSTREAM = 'https://api.adsb.lol/v2/point';
const USER_AGENT = 'atc-game (games.himmelreich.cloud)';
const RADIUS_NM = 120;
const TTL_MS = 5000;
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
  /** Flugroute als ICAO-Kette, z. B. "EIDW-EDDF" (nur wenn bekannt und zur Position passend) */
  route?: string;
  /** Alter der Position in Sekunden zum Zeitpunkt der Antwort */
  age: number;
}

interface Snapshot {
  fetchedAt: number;
  aircraft: Array<Omit<LiveAircraftDto, 'age'> & { seenPos: number }>;
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

function mapAircraft(a: RawAircraft): Snapshot['aircraft'][number] | null {
  if (typeof a.lat !== 'number' || typeof a.lon !== 'number' || (a.seen_pos ?? 0) > MAX_POS_AGE_S) return null;
  const callsign = (a.flight ?? '').trim() || a.r || a.hex.toUpperCase();
  if (!isRelevant(a, callsign)) return null;
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
    seenPos: a.seen_pos ?? 0,
  };
}

async function fetchSnapshot(lat: number, lon: number): Promise<Snapshot> {
  const res = await fetch(`${UPSTREAM}/${lat}/${lon}/${RADIUS_NM}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`adsb.lol HTTP ${res.status}`);
  const data = await res.json() as { ac?: RawAircraft[] };
  const aircraft = (data.ac ?? []).map(mapAircraft).filter((a): a is NonNullable<typeof a> => a !== null);
  return { fetchedAt: Date.now(), aircraft };
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
  const qLat = Math.round(lat * 100) / 100;
  const qLon = Math.round(lon * 100) / 100;
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
      .catch((err: Error) => { entry.failedAt = Date.now(); console.error('traffic:', err.message); return undefined; })
      .finally(() => { entry.pending = undefined; });
    await entry.pending;
  }

  // Nach einem Fehler noch kurz den letzten Stand liefern
  const snapshot = entry.snapshot;
  if (!snapshot || Date.now() - snapshot.fetchedAt > STALE_MS) {
    res.status(503).json({ error: 'Live-Verkehr nicht verfügbar' });
    return;
  }
  lookupRoutes(snapshot.aircraft);
  const sinceFetch = (Date.now() - snapshot.fetchedAt) / 1000;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    source: 'adsb.lol',
    license: 'ODbL 1.0',
    aircraft: snapshot.aircraft.map(({ seenPos, ...a }) => {
      const route = routes.get(a.callsign)?.codes;
      return { ...a, ...(route ? { route } : {}), age: Math.round((seenPos + sinceFetch) * 10) / 10 };
    }),
  });
});

export default router;
