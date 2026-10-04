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

const pending = new Map<string, Promise<Town[]>>();

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

/**
 * Ortschaften mit Einwohnerzahl (die steht zuverlässig am Ortsknoten, place=city/town/village) und als Umriss
 * die kleinste Gemeindegrenze, in der der Knoten liegt: Gemeinde (admin_level 8), bei kreisfreien Städten die
 * Stadt auf Ebene 6 (nicht der Landkreis). Ohne passende Grenze bleibt es beim Namen.
 */
async function fetchTowns(lat: number, lon: number): Promise<Town[]> {
  const q1 = `[out:json][timeout:110];node(around:${RADIUS_M},${lat},${lon})[place~"^(city|town|village)$"][name][population](if:number(t["population"])>=${TOWN_MIN_POP})->.p;`
    + `foreach.p->.n(.n out tags;.n is_in->.a;rel(pivot.a)[boundary=administrative][admin_level~"^(6|8)$"];out tags qt;);`;
  const els = await overpass(q1);
  const towns: Array<Omit<Town, 'rings'> & { relId?: number }> = [];
  let cur: (typeof towns)[number] | null = null;
  let level6: number | undefined;
  for (const e of els) {
    if (e.type === 'node') {
      if (cur && cur.relId === undefined) cur.relId = level6;
      cur = { name: e.tags!.name, pop: popOf(e.tags), lat: e.lat!, lng: e.lon! };
      level6 = undefined;
      towns.push(cur);
    } else if (e.type === 'relation' && cur) {
      const t = e.tags ?? {};
      if (t.admin_level === '8' && cur.relId === undefined) cur.relId = e.id;
      // Ebene 6 nur für die Stadt selbst, nicht für den Landkreis drumherum
      else if (t.admin_level === '6' && t['de:place'] !== 'county' && !/kreis/i.test(t.name ?? '') && (t.name === cur.name || t['de:place'] === 'city')) level6 = e.id;
    }
  }
  if (cur && cur.relId === undefined) cur.relId = level6;

  const ids = [...new Set(towns.map((t) => t.relId).filter((id): id is number => id !== undefined))];
  const geoms = new Map<number, Town['rings']>();
  for (let i = 0; i < ids.length; i += 200) {
    const rels = await overpass(`[out:json][timeout:110];rel(id:${ids.slice(i, i + 200).join(',')});out geom qt;`);
    for (const r of rels) geoms.set(r.id, ringsOf(r));
  }
  return towns.map(({ relId, ...t }) => ({
    ...t, lat: Math.round(t.lat * 1e4) / 1e4, lng: Math.round(t.lng * 1e4) / 1e4,
    rings: relId !== undefined ? geoms.get(relId) ?? [] : [],
  }));
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
  try {
    let job = pending.get(key);
    if (!job) {
      job = fetchTowns(gLat, gLon).finally(() => pending.delete(key));
      pending.set(key, job);
    }
    const towns = await job;
    const body = JSON.stringify({ source: 'OpenStreetMap', license: 'ODbL 1.0', towns });
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, body);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('json').send(body);
  } catch (err) {
    console.error('towns:', (err as Error).message);
    // Lieber veraltet als gar nicht
    if (existsSync(file)) { res.type('json').send(readFileSync(file, 'utf8')); return; }
    res.status(503).json({ error: 'Ortschaften nicht verfügbar' });
  }
});

export default router;
