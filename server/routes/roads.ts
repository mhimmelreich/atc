// Autobahnen rund um einen Platz aus OpenStreetMap (ODbL) über Overpass, als Orientierungslinien mit
// Nummer (A3, A5 …). Richtungsfahrbahnen und Abschnitte gleicher Nummer zusammengefügt, vereinfacht
// und auf Platte zwischengespeichert wie die Bauwerke.
import { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { overpass, simplify } from './towns.js';

const router = Router();

const DATA_DIR = process.env.ROADS_DIR ?? 'data/roads';
const RADIUS_M = 90_000;
const MAX_AGE_MS = 30 * 86400_000;
const SIMPLIFY_DEG = 0.0004; // etwa 40 m
const GRID_DEG = 0.5;
const WAIT_MS = 20_000;

export interface Road {
  /** Nummer laut OSM (z. B. "A 5"), mehrere mit ";" */
  ref: string;
  lines: Array<Array<[number, number]>>;
}

const pending = new Map<string, Promise<string>>();

async function fetchRoads(lat: number, lon: number): Promise<Road[]> {
  const els = await overpass(`[out:json][timeout:120];way(around:${RADIUS_M},${lat},${lon})[highway=motorway];out tags geom;`);
  const byRef = new Map<string, Array<Array<[number, number]>>>();
  for (const e of els as Array<{ tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number } | null> }>) {
    if (!e.geometry) continue;
    const ref = (e.tags?.ref ?? '').replace(/\s+/g, ' ').trim();
    const pts = e.geometry.filter((g): g is { lat: number; lon: number } => !!g).map((g) => [g.lat, g.lon] as [number, number]);
    if (pts.length < 2) continue;
    byRef.set(ref, [...(byRef.get(ref) ?? []), pts]);
  }
  const roads: Road[] = [];
  for (const [ref, ways] of byRef) {
    const lines = joinLines(ways)
      .map((l) => simplify(l, SIMPLIFY_DEG).map(([la, lo]) => [Math.round(la * 1e4) / 1e4, Math.round(lo * 1e4) / 1e4] as [number, number]))
      .filter((l) => l.length >= 2);
    if (lines.length) roads.push({ ref, lines });
  }
  return roads;
}

/** Abschnitte, die sich an den Enden berühren, zu langen Linien verbinden (an beiden Enden) */
function joinLines(ways: Array<Array<[number, number]>>): Array<Array<[number, number]>> {
  const key = (p: [number, number]) => `${p[0]},${p[1]}`;
  const rest = ways.map((w) => [...w]);
  const out: Array<Array<[number, number]>> = [];
  while (rest.length) {
    const line = rest.shift()!;
    for (let grown = true; grown;) {
      grown = false;
      for (let i = 0; i < rest.length; i++) {
        const w = rest[i];
        const s0 = key(line[0]), s1 = key(line[line.length - 1]), w0 = key(w[0]), w1 = key(w[w.length - 1]);
        if (w0 === s1) line.push(...w.slice(1));
        else if (w1 === s1) line.push(...w.slice(0, -1).reverse());
        else if (w1 === s0) line.unshift(...w.slice(0, -1));
        else if (w0 === s0) line.unshift(...w.slice(1).reverse());
        else continue;
        rest.splice(i, 1);
        grown = true;
        break;
      }
    }
    out.push(line);
  }
  return out;
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
  let job = pending.get(key);
  if (!job) {
    job = fetchRoads(gLat, gLon)
      .then((roads) => {
        const body = JSON.stringify({ source: 'OpenStreetMap', license: 'ODbL 1.0', roads });
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(file, body);
        return body;
      })
      .finally(() => pending.delete(key));
    job.catch((err: Error) => console.error('roads:', err.message));
    pending.set(key, job);
  }
  const done = await Promise.race([job.then((b) => b, () => null), new Promise<undefined>((ok) => setTimeout(ok, WAIT_MS))]);
  if (done === undefined) { res.status(202).json({ pending: true }); return; }
  if (done !== null) { res.setHeader('Cache-Control', 'public, max-age=86400'); res.type('json').send(done); return; }
  if (existsSync(file)) { res.type('json').send(readFileSync(file, 'utf8')); return; }
  res.status(503).json({ error: 'Autobahnen nicht verfügbar' });
});

export default router;
