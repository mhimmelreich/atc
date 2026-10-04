// Umrisse und Namen von Ortschaften rund um einen Punkt (WATCH), aus OpenStreetMap (ODbL) über Overpass.
// Gemeindegrenzen (admin_level 8) mit Einwohnerzahl ab TOWN_MIN_POP; vereinfacht und auf Platte zwischengespeichert.
import { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const router = Router();

const DATA_DIR = process.env.TOWNS_DIR ?? 'data/towns';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const USER_AGENT = 'atc-game (games.himmelreich.cloud)';
const RADIUS_M = 110_000;
const TOWN_MIN_POP = 5000;
const MAX_AGE_MS = 30 * 86400_000;
const SIMPLIFY_DEG = 0.0015; // etwa 150 m
const GRID_DEG = 0.5;        // Abfragen auf ein Raster runden, damit benachbarte Standorte denselben Stand teilen

export interface Town {
  name: string;
  pop: number;
  lat: number;
  lng: number;
  /** Außenringe als [lat, lng]-Ketten */
  rings: Array<Array<[number, number]>>;
}

interface OsmMember {
  type: 'way' | 'node' | 'relation';
  role: string;
  lat?: number;
  lon?: number;
  geometry?: Array<{ lat: number; lon: number } | null>;
}

const pending = new Map<string, Promise<string>>();
const WAIT_MS = 20_000;

/** Wege der Außengrenze zu geschlossenen Ringen zusammensetzen */
function stitch(ways: Array<Array<[number, number]>>): Array<Array<[number, number]>> {
  const rest = ways.filter((w) => w.length > 1).map((w) => [...w]);
  const rings: Array<Array<[number, number]>> = [];
  const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
  while (rest.length) {
    const ring = rest.shift()!;
    let grown = true;
    while (!same(ring[0], ring[ring.length - 1]) && grown) {
      grown = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < rest.length; i++) {
        const w = rest[i];
        if (same(w[0], end)) ring.push(...w.slice(1));
        else if (same(w[w.length - 1], end)) ring.push(...w.slice(0, -1).reverse());
        else continue;
        rest.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

/** Douglas-Peucker in Grad (für kurze Strecken genau genug) */
function simplify(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length <= 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, idx = -1;
    const [ay, ax] = pts[a], [by, bx] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][1] - dx * pts[i][0] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  members?: OsmMember[];
}

async function overpass(query: string): Promise<OsmElement[]> {
  let lastErr: Error | null = null;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(130_000),
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      return ((await res.json()) as { elements?: OsmElement[] }).elements ?? [];
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error('Overpass nicht erreichbar');
}

const popOf = (tags?: Record<string, string>) => Number((tags?.population ?? '').replace(/[ .,]/g, ''));

/** Außenringe einer Grenz-Relation, vereinfacht */
function ringsOf(rel: OsmElement): Town['rings'] {
  const outer = (rel.members ?? [])
    .filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry)
    .map((m) => m.geometry!.filter((g): g is { lat: number; lon: number } => !!g).map((g) => [g.lat, g.lon] as [number, number]));
  return stitch(outer)
    .map((r) => simplify(r, SIMPLIFY_DEG).map(([la, lo]) => [Math.round(la * 1e4) / 1e4, Math.round(lo * 1e4) / 1e4] as [number, number]))
    .filter((r) => r.length >= 4);
}

/** Liegt der Punkt in einem der Ringe? (Strahlverfahren) */
function inside(lat: number, lng: number, rings: Town['rings']): boolean {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

const escapeRe = (s: string) => s.replace(/[\\^$.*+?()[\]{}|"]/g, (c) => (c === '"' ? '\\"' : `\\\\${c}`));

/**
 * Ortschaften mit Einwohnerzahl (die steht zuverlässig am Ortsknoten, place=city/town/village) und als Umriss
 * die gleichnamige Gemeindegrenze, in der der Knoten liegt: Gemeinde (admin_level 8), bei kreisfreien Städten
 * die Stadt auf Ebene 6. Ohne passende Grenze bleibt es beim Namen.
 */
async function fetchTowns(lat: number, lon: number): Promise<Town[]> {
  // Rechteck statt Umkreis: für Overpass deutlich schneller, vor allem bei Grenz-Relationen
  const dLat = RADIUS_M / 111_000, dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const bbox = `${(lat - dLat).toFixed(3)},${(lon - dLon).toFixed(3)},${(lat + dLat).toFixed(3)},${(lon + dLon).toFixed(3)}`;
  const nodes = await overpass(`[out:json][timeout:110];node(${bbox})[place~"^(city|town|village)$"][name][population](if:number(t["population"])>=${TOWN_MIN_POP});out tags qt;`);
  const towns = nodes.map((n) => ({ name: n.tags!.name, pop: popOf(n.tags), lat: n.lat!, lng: n.lon! })).filter((t) => t.pop >= TOWN_MIN_POP);
  const names = [...new Set(towns.map((t) => t.name))];
  const rels: OsmElement[] = [];
  for (let i = 0; i < names.length; i += 150) {
    const re = names.slice(i, i + 150).map(escapeRe).join('|');
    rels.push(...await overpass(`[out:json][timeout:110];rel(${bbox})[boundary=administrative][admin_level~"^(6|8)$"][name~"^(${re})$"];out geom qt;`));
  }
  const bounds = rels
    .filter((r) => r.tags?.admin_level === '8' || (r.tags?.['de:place'] !== 'county' && !/kreis/i.test(r.tags?.name ?? '')))
    .map((r) => ({ name: r.tags!.name, level: r.tags!.admin_level, rings: ringsOf(r) }))
    .filter((b) => b.rings.length > 0);
  return towns.map((t) => {
    const own = bounds.filter((b) => b.name === t.name && inside(t.lat, t.lng, b.rings)).sort((a, b) => Number(b.level) - Number(a.level))[0];
    return { ...t, lat: Math.round(t.lat * 1e4) / 1e4, lng: Math.round(t.lng * 1e4) / 1e4, rings: own?.rings ?? [] };
  });
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
  // Die erste Abfrage dauert oft länger als ein Proxy wartet: dann 202, der Client fragt wieder
  let job = pending.get(key);
  if (!job) {
    job = fetchTowns(gLat, gLon)
      .then((towns) => {
        const body = JSON.stringify({ source: 'OpenStreetMap', license: 'ODbL 1.0', towns });
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(file, body);
        return body;
      })
      .finally(() => pending.delete(key));
    job.catch((err: Error) => console.error('towns:', err.message));
    pending.set(key, job);
  }
  const done = await Promise.race([job.then((body) => body, () => null), new Promise<undefined>((ok) => setTimeout(ok, WAIT_MS))]);
  if (done === undefined) { res.status(202).json({ pending: true }); return; }
  if (done !== null) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('json').send(done);
    return;
  }
  // Lieber veraltet als gar nicht
  if (existsSync(file)) { res.type('json').send(readFileSync(file, 'utf8')); return; }
  res.status(503).json({ error: 'Ortschaften nicht verfügbar' });
});

export default router;
