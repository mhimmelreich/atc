// Freie Datenbasis aus OurAirports (gemeinfrei): Flughäfen, Bahnen, VOR/NDB und Funkfrequenzen weltweit.
// Die CSVs werden beim ersten Bedarf nach data/opendata/ geladen und alle 30 Tage erneuert.
// ILS gibt es dort nicht: für längere Hartbelagbahnen wird ein Standard-ILS (3°) angenommen.
import { Router } from 'express';
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import NodeCache from 'node-cache';
import type { Airport, Runway } from '../../src/types/airport';
import type { Waypoint } from '../../src/types/navdata';
import { pickStations, type FrequencyEntry } from '../stations.js';

const router = Router();
const cache = new NodeCache({ stdTTL: 86400 });

const DATA_DIR = process.env.OPENDATA_DIR ?? 'data/opendata';
const BASE_URL = 'https://davidmegginson.github.io/ourairports-data';
const FILES = ['airports', 'runways', 'navaids'] as const;
// Frequenzen sind Zugabe: fehlen sie, gibt es trotzdem Flughäfen
const FREQUENCY_FILE = 'airport-frequencies.csv';
const MAX_AGE_MS = 30 * 86400_000;
const FT_TO_M = 0.3048;
const NAVAID_RADIUS_NM = 50;
const ILS_MIN_LENGTH_M = 1500;
const MIN_LENGTH_M = 600; // kürzere Bahnen (Graspisten, Helipads) sind fürs Spiel irrelevant
const HARD_SURFACE = /ASP|CON|PEM|BIT|TAR|PAV/i;

type Row = Record<string, string>;
interface OpenData {
  airports: Map<string, Row>;
  runways: Map<string, Row[]>;
  navaids: Row[];
  frequencies: Map<string, Row[]>;
}

let data: OpenData | null = null;
let loading: Promise<OpenData> | null = null;

// ── CSV laden ────────────────────────────────────────────────────────────────
async function ensureFile(file: string, url: string): Promise<string> {
  const path = join(DATA_DIR, file);
  const fresh = existsSync(path) && Date.now() - statSync(path).mtimeMs < MAX_AGE_MS;
  if (fresh) return readFileSync(path, 'utf8');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, text);
    console.log(`opendata: ${file} aktualisiert`);
    return text;
  } catch (err) {
    // Download fehlgeschlagen → veraltete Datei ist besser als keine
    if (existsSync(path)) return readFileSync(path, 'utf8');
    throw err;
  }
}

/** Minimaler CSV-Parser (RFC 4180: Anführungszeichen, "" als Escape, Kommas/Zeilenumbrüche in Feldern) */
function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

async function loadData(): Promise<OpenData> {
  if (data) return data;
  loading ??= (async () => {
    const [[airports, runways, navaids], frequencyRows] = await Promise.all([
      Promise.all(FILES.map(async (f) => parseCsv(await ensureFile(`${f}.csv`, `${BASE_URL}/${f}.csv`)))),
      ensureFile(FREQUENCY_FILE, `${BASE_URL}/${FREQUENCY_FILE}`).then(parseCsv).catch((err: Error) => {
        console.warn('opendata: Frequenzen nicht verfügbar:', err.message);
        return [] as Row[];
      }),
    ]);
    const byIdent = new Map<string, Row>();
    for (const a of airports) {
      if (a.type === 'closed') continue;
      for (const code of [a.icao_code, a.gps_code, a.ident]) {
        if (code && !byIdent.has(code)) byIdent.set(code, a);
      }
    }
    const rwyByAirport = new Map<string, Row[]>();
    for (const r of runways) {
      if (r.closed === '1') continue;
      const list = rwyByAirport.get(r.airport_ident) ?? [];
      list.push(r);
      rwyByAirport.set(r.airport_ident, list);
    }
    const frequencies = new Map<string, Row[]>();
    for (const f of frequencyRows) {
      const list = frequencies.get(f.airport_ident) ?? [];
      list.push(f);
      frequencies.set(f.airport_ident, list);
    }
    data = { airports: byIdent, runways: rwyByAirport, navaids, frequencies };
    console.log(`opendata: ${byIdent.size} Flughäfen, ${runways.length} Bahnen, ${navaids.length} Navaids, ${frequencyRows.length} Frequenzen geladen`);
    return data;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Stadt eines Flughafens laut OurAirports, z. B. für den Rufnamen der Anflugkontrolle */
export async function cityOf(icao: string): Promise<string | undefined> {
  const d = await loadData();
  return d.airports.get(icao)?.municipality || undefined;
}

// ── Mapping ──────────────────────────────────────────────────────────────────
const num = (v: string | undefined): number | null => (v === undefined || v === '' ? null : Number(v));

function distanceNM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}

function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad)
    - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lng2 - lng1) * rad);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

function buildRunways(rows: Row[]): Runway[] {
  const out: Runway[] = [];
  for (const r of rows) {
    const le = { id: r.le_ident, lat: num(r.le_latitude_deg), lng: num(r.le_longitude_deg), elev: num(r.le_elevation_ft), off: num(r.le_displaced_threshold_ft) };
    const he = { id: r.he_ident, lat: num(r.he_latitude_deg), lng: num(r.he_longitude_deg), elev: num(r.he_elevation_ft), off: num(r.he_displaced_threshold_ft) };
    // Ohne Koordinaten beider Enden lässt sich die Bahn nicht zeichnen
    if (!le.id || !he.id || le.lat === null || le.lng === null || he.lat === null || he.lng === null) continue;

    const lengthM = Math.round((num(r.length_ft) ?? distanceNM(le.lat, le.lng, he.lat, he.lng) * 6076) * FT_TO_M);
    const widthM = Math.round((num(r.width_ft) ?? 148) * FT_TO_M);
    if (lengthM < MIN_LENGTH_M) continue;
    const withIls = lengthM >= ILS_MIN_LENGTH_M && HARD_SURFACE.test(r.surface);

    for (const [a, b] of [[le, he], [he, le]] as const) {
      const heading = Math.round(bearing(a.lat!, a.lng!, b.lat!, b.lng!) * 10) / 10;
      const recipHeading = Math.round(((heading + 180) % 360) * 10) / 10;
      out.push({
        id: a.id,
        recipId: b.id,
        heading,
        recipHeading,
        thresholdLat: a.lat!,
        thresholdLng: a.lng!,
        endLat: b.lat!,
        endLng: b.lng!,
        lengthM,
        widthM,
        elevationFt: a.elev ?? 0,
        ...(a.off ? { displacedThresholdM: Math.round(a.off * FT_TO_M) } : {}),
        // Angenommenes ILS: OurAirports kennt keine ILS-Daten (Frequenz 0 = unbekannt)
        ...(withIls ? { ils: { runway: a.id, localizerCourse: heading, glideslopeAngle: 3.0, frequencyMHz: 0, category: 'I' as const } } : {}),
      });
    }
  }
  return out;
}

// Frequenzarten bei OurAirports (Typ teils mit Zusatz wie "APP EAST"): Arrival vor Director vor Approach
const FREQUENCY_TYPES: Record<string, Omit<FrequencyEntry, 'label' | 'mhz'>> = {
  ARR: { kind: 'approach', rank: 0, role: 'Arrival' },
  DIR: { kind: 'approach', rank: 1, role: 'Director' },
  APP: { kind: 'approach', rank: 2, role: 'Approach' },
  'A/D': { kind: 'approach', rank: 3, role: 'Approach' },
  RDR: { kind: 'approach', rank: 4, role: 'Approach' },
  TWR: { kind: 'tower', rank: 0, role: 'Tower' },
};

function buildStations(rows: Row[]): Airport['stations'] {
  return pickStations(rows.flatMap((r) => {
    const type = FREQUENCY_TYPES[r.type.split(' ')[0].toUpperCase()];
    return type ? [{ ...type, label: r.description, mhz: Number(r.frequency_mhz) }] : [];
  }));
}

function navaidType(type: string): Waypoint['type'] | null {
  if (type.startsWith('VOR') || type === 'TACAN') return 'vor';
  if (type.startsWith('NDB')) return 'ndb';
  return null;
}

// ── Funk-Rufnamen der Airlines (OpenFlights, ODbL) ──────────────────────────
// ICAO-Präfix → Rufname, z. B. DLH → LUFTHANSA, BAW → SPEEDBIRD
const AIRLINES_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';
let telephony: Record<string, string> | null = null;

async function loadTelephony(): Promise<Record<string, string>> {
  if (telephony) return telephony;
  // airlines.dat hat keine Kopfzeile; \N steht für "leer"
  const rows = parseCsv(`id,name,alias,iata,icao,callsign,country,active\n${await ensureFile('airlines.dat', AIRLINES_URL)}`);
  const map: Record<string, string> = {};
  const active: Record<string, boolean> = {};
  for (const r of rows) {
    const icao = r.icao.toUpperCase();
    const callsign = r.callsign === '\\N' ? '' : r.callsign.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(icao) || !callsign) continue;
    const isActive = r.active === 'Y';
    // Aktive Airline schlägt eingestellte mit gleichem Präfix
    if (!map[icao] || (isActive && !active[icao])) { map[icao] = callsign; active[icao] = isActive; }
  }
  telephony = map;
  return map;
}

router.get('/telephony', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json(await loadTelephony());
  } catch (err) {
    console.error('opendata: Airline-Liste nicht verfügbar:', err);
    res.status(503).json({ error: 'Airline-Liste nicht verfügbar' });
  }
});

// Klarnamen von Flughäfen, z. B. für Start und Ziel eines Flugs: ?icao=EDDF,EGLL
router.get('/names', async (req, res) => {
  const codes = String(req.query.icao ?? '').toUpperCase().split(',').filter((c) => /^[A-Z0-9]{3,4}$/.test(c)).slice(0, 20);
  let d: OpenData;
  try {
    d = await loadData();
  } catch {
    res.status(503).json({ error: 'Flughafendaten nicht verfügbar' });
    return;
  }
  const names: Record<string, string> = {};
  for (const c of codes) { const a = d.airports.get(c); if (a?.name) names[c] = a.name; }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json(names);
});

// Nächster Verkehrsflughafen zu einer Position (Zuschauer per GPS)
router.get('/nearest', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.status(400).json({ error: 'lat und lon fehlen' });
    return;
  }
  let d: OpenData;
  try {
    d = await loadData();
  } catch {
    res.status(503).json({ error: 'Flughafendaten nicht verfügbar' });
    return;
  }
  // Nur Plätze mit ICAO-Code und Linienverkehr (große und mittlere Flughäfen)
  let best: { row: Row; dist: number } | null = null;
  for (const a of new Set(d.airports.values())) {
    if (!a.icao_code || a.scheduled_service !== 'yes' || (a.type !== 'large_airport' && a.type !== 'medium_airport')) continue;
    const dist = distanceNM(lat, lon, Number(a.latitude_deg), Number(a.longitude_deg));
    if (!best || dist < best.dist) best = { row: a, dist };
  }
  if (!best) { res.status(404).json({ error: 'Kein Flughafen gefunden' }); return; }
  res.json({ icao: best.row.icao_code, name: best.row.name, distNM: Math.round(best.dist * 10) / 10 });
});

// ── Route ────────────────────────────────────────────────────────────────────
router.get('/:icao', async (req, res) => {
  const icao = req.params.icao.toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(icao)) { res.status(400).json({ error: 'Ungültiger ICAO-Code' }); return; }

  const cached = cache.get(icao);
  if (cached) { res.json(cached); return; }

  let d: OpenData;
  try {
    d = await loadData();
  } catch (err) {
    console.error('opendata: Laden fehlgeschlagen:', err);
    res.status(503).json({ error: 'Freie Flughafendaten nicht verfügbar' });
    return;
  }

  const ap = d.airports.get(icao);
  const runways = ap ? buildRunways(d.runways.get(ap.ident) ?? []) : [];
  if (!ap || runways.length === 0) { res.status(404).json({ error: `Flughafen ${icao} nicht gefunden` }); return; }

  const lat = Number(ap.latitude_deg);
  const lng = Number(ap.longitude_deg);
  const waypoints: Waypoint[] = [];
  let magVar: number | null = null;
  let magDist = Infinity;
  for (const n of d.navaids) {
    const type = navaidType(n.type);
    const nLat = num(n.latitude_deg);
    const nLng = num(n.longitude_deg);
    if (!type || nLat === null || nLng === null) continue;
    const dist = distanceNM(lat, lng, nLat, nLng);
    if (dist > NAVAID_RADIUS_NM) continue;
    waypoints.push({ id: n.ident, name: `${n.ident} ${type.toUpperCase()}`, lat: nLat, lng: nLng, type });
    // Missweisung vom nächstgelegenen Navaid übernehmen
    const mv = num(n.magnetic_variation_deg);
    if (mv !== null && dist < magDist) { magVar = mv; magDist = dist; }
  }

  const stations = buildStations(d.frequencies.get(ap.ident) ?? []);
  const airport: Airport = {
    icao,
    name: ap.name,
    ...(ap.municipality ? { city: ap.municipality } : {}),
    ...(stations ? { stations } : {}),
    lat,
    lng,
    elevationFt: num(ap.elevation_ft) ?? 0,
    magneticVariation: Math.round((magVar ?? 0) * 10) / 10,
    transitionAltitudeFt: ['US', 'CA'].includes(ap.iso_country) ? 18000 : 5000,
    runways,
  };

  const body = { source: 'ourairports', airport, waypoints, stars: [] };
  cache.set(icao, body);
  res.json(body);
});

// Daten im Hintergrund vorladen, damit die erste Anfrage nicht warten muss
loadData().catch((err) => console.warn('opendata: Vorladen fehlgeschlagen:', err.message));

export default router;
