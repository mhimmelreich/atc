// Markante Bauwerke rund um einen Platz (Hochhäuser, Türme, Schornsteine, große Stadien) aus OpenStreetMap (ODbL)
// über Overpass: Grundriss, Höhe und Name. Auf Platte zwischengespeichert wie die Ortschaften.
import { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { overpass, simplify, stitch, type OsmElement } from './towns.js';

const WIKIDATA = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'atc-game (games.himmelreich.cloud)';

const router = Router();

const DATA_DIR = process.env.LANDMARKS_DIR ?? 'data/landmarks';
const RADIUS_M = 60_000;
const MIN_HEIGHT_M = 100;          // Hochhäuser, Türme und Schornsteine ab dieser Höhe
const STADIUM_MIN_CAPACITY = 15_000; // nur große Stadien; Plätze aus OSM (capacity) oder Wikidata (P1083)
const STADIUM_HEIGHT_M = 35;        // wenn OSM keine Höhe kennt
const MAX_AGE_MS = 30 * 86400_000;
const SIMPLIFY_DEG = 0.00003;       // etwa 3 m
const GRID_DEG = 0.5;
const WAIT_MS = 20_000;

export interface Landmark {
  name: string | null;
  kind: 'building' | 'tower' | 'stadium';
  /** Höhe über Grund in Metern */
  heightM: number;
  lat: number;
  lng: number;
  /** Grundriss als [lat, lng]-Ringe; leer bei Punkten (z. B. Sendemast als Knoten) */
  rings: Array<Array<[number, number]>>;
}

const pending = new Map<string, Promise<string>>();

/** "257", "145 m", "140,5" → Meter; Fuß-Angaben umrechnen */
function heightOf(tags: Record<string, string>): number {
  const raw = tags.height ?? '';
  const n = Number(raw.replace(',', '.').replace(/\s*m$/i, ''));
  if (Number.isFinite(n) && n > 0) return n;
  const ft = raw.match(/^([\d.]+)\s*(ft|')$/i);
  if (ft) return Number(ft[1]) * 0.3048;
  const levels = Number(tags['building:levels']);
  return Number.isFinite(levels) && levels > 0 ? levels * 3.5 : 0;
}

type Geom = Array<{ lat: number; lon: number } | null> | undefined;
const toPts = (g: Geom) => (g ?? []).filter((p): p is { lat: number; lon: number } => !!p).map((p) => [p.lat, p.lon] as [number, number]);
const round = (v: number) => Math.round(v * 1e5) / 1e5;

function ringsOf(el: OsmElement & { geometry?: Geom }): Landmark['rings'] {
  let rings: Array<Array<[number, number]>>;
  if (el.type === 'way') rings = [toPts(el.geometry)];
  else if (el.type === 'relation') {
    rings = stitch((el.members ?? []).filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => toPts(m.geometry)));
  } else return [];
  return rings
    .filter((r) => r.length >= 4)
    .map((r) => simplify(r, SIMPLIFY_DEG).map(([la, lo]) => [round(la), round(lo)] as [number, number]));
}

/** Zuschauerplätze aus Wikidata (P1083, CC0); die Fläche in OSM unterscheidet Bundesliga-Stadion und Sportplatz nicht */
async function wikidataCapacities(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const valid = [...new Set(ids.filter((id) => /^Q\d+$/.test(id)))];
  if (valid.length === 0) return out;
  const query = `SELECT ?item ?cap WHERE { VALUES ?item { ${valid.map((id) => `wd:${id}`).join(' ')} } ?item wdt:P1083 ?cap }`;
  try {
    const res = await fetch(WIKIDATA, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `query=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
    const data = (await res.json()) as { results: { bindings: Array<{ item: { value: string }; cap: { value: string } }> } };
    for (const b of data.results.bindings) {
      const id = b.item.value.split('/').pop()!;
      const cap = Math.round(Number(b.cap.value));
      if (Number.isFinite(cap) && cap > (out.get(id) ?? 0)) out.set(id, cap);
    }
  } catch (err) {
    console.error('landmarks: Wikidata:', (err as Error).message);
  }
  return out;
}

/** Grundfläche in m² (Schuhbandformel, lokal eben) */
function areaM2(rings: Landmark['rings']): number {
  let sum = 0;
  for (const r of rings) {
    const k = Math.cos((r[0][0] * Math.PI) / 180);
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][1] + r[i][1]) * k * (r[j][0] - r[i][0]);
    sum += Math.abs(a / 2);
  }
  return sum * 111_320 ** 2;
}

const capacityOf = (tags: Record<string, string>) => Number((tags.capacity ?? '').replace(/[ .,]/g, '')) || 0;

function centre(el: OsmElement, rings: Landmark['rings']): [number, number] {
  if (el.lat !== undefined && el.lon !== undefined) return [el.lat, el.lon];
  const r = rings[0];
  return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
}

async function fetchLandmarks(lat: number, lon: number): Promise<Landmark[]> {
  const dLat = RADIUS_M / 111_000, dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const bbox = `${(lat - dLat).toFixed(3)},${(lon - dLon).toFixed(3)},${(lat + dLat).toFixed(3)},${(lon + dLon).toFixed(3)}`;
  // Höhe ab 100 m schon in der Abfrage (dreistellig), sonst kommen zehntausende Gebäude mit Höhenangabe
  const h = '[height~"^[1-9][0-9][0-9]([.,][0-9]+)?( ?m)?$"]';
  const els = (await overpass(
    `[out:json][timeout:110];(nwr(${bbox})[building]${h};nwr(${bbox})[man_made~"^(tower|chimney)$"]${h};` +
    `wr(${bbox})[leisure=stadium][name];);out geom qt;`,
  )) as Array<OsmElement & { geometry?: Geom }>;

  const wdCap = await wikidataCapacities(
    els.filter((e) => e.tags?.leisure === 'stadium' && !capacityOf(e.tags) && e.tags.wikidata).map((e) => e.tags!.wikidata),
  );
  const out: Landmark[] = [];
  for (const el of els) {
    const t = el.tags ?? {};
    const rings = ringsOf(el);
    const stadium = t.leisure === 'stadium';
    const tower = !!t.man_made;
    let heightM = heightOf(t);
    if (stadium) {
      const cap = capacityOf(t) || (t.wikidata ? wdCap.get(t.wikidata) ?? 0 : 0);
      if (rings.length === 0 || cap < STADIUM_MIN_CAPACITY) continue;
      if (!(heightM > 0 && heightM < 100)) heightM = STADIUM_HEIGHT_M;
    } else if (heightM < MIN_HEIGHT_M || heightM > 700) continue;
    // Gebäude ohne Namen ab 100 m sind meist Fehlerfassungen; Türme und Schornsteine dürfen namenlos sein
    if (!tower && !stadium && !t.name) continue;
    // Hütten, Schuppen usw. über 100 m sind Tippfehler (z. B. Geländehöhe statt Gebäudehöhe)
    // Ein Hochhaus über 100 m mit weniger als 300 m² Grundfläche gibt es nicht (z. B. Grillhütte mit Geländehöhe)
    if (!tower && !stadium && areaM2(rings) < 300) continue;
    if (!tower && !stadium && /^(hut|shed|cabin|shelter|garage|garages|roof|barn|kiosk|toilets|house|bungalow)$/.test(t.building ?? '')) continue;
    if (!tower && !stadium && rings.length === 0) continue;
    const [cLat, cLng] = centre(el, rings);
    out.push({ name: t.name ?? null, kind: stadium ? 'stadium' : tower ? 'tower' : 'building', heightM: Math.round(heightM), lat: round(cLat), lng: round(cLng), rings });
  }
  // Höchste zuerst; ein Hochhaus, das zugleich als Turm erfasst ist, nur einmal
  out.sort((a, b) => b.heightM - a.heightM);
  return out.filter((l, i) => !out.slice(0, i).some((o) => o.name && o.name === l.name && Math.abs(o.lat - l.lat) < 0.002 && Math.abs(o.lng - l.lng) < 0.003));
}

router.get('/', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.status(400).json({ error: 'lat und lon fehlen' });
    return;
  }
  const gLat = Math.round(lat / GRID_DEG) * GRID_DEG;
  const gLon = Math.round(lon / GRID_DEG) * GRID_DEG;
  const key = `${gLat.toFixed(1)}_${gLon.toFixed(1)}`;
  const file = join(DATA_DIR, `${key}.json`);
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < MAX_AGE_MS) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('json').send(readFileSync(file, 'utf8'));
    return;
  }
  // Erste Abfrage kann länger dauern als ein Proxy wartet: dann 202, der Client fragt wieder
  let job = pending.get(key);
  if (!job) {
    job = fetchLandmarks(gLat, gLon)
      .then((landmarks) => {
        // Leer ist ein gültiges Ergebnis (Platz ohne Hochhäuser) und wird auch gespeichert
        const body = JSON.stringify({ source: 'OpenStreetMap', license: 'ODbL 1.0', landmarks });
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(file, body);
        return body;
      })
      .finally(() => pending.delete(key));
    job.catch((err: Error) => console.error('landmarks:', err.message));
    pending.set(key, job);
  }
  const done = await Promise.race([job.then((body) => body, () => null), new Promise<undefined>((ok) => setTimeout(ok, WAIT_MS))]);
  if (done === undefined) { res.status(202).json({ pending: true }); return; }
  if (done !== null) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('json').send(done);
    return;
  }
  if (existsSync(file)) { res.type('json').send(readFileSync(file, 'utf8')); return; }
  res.status(503).json({ error: 'Bauwerke nicht verfügbar' });
});

export default router;
