// Umrisse und Namen von Ortschaften rund um einen Punkt (WATCH), aus OpenStreetMap (ODbL) über Overpass;
// fehlende Einwohnerzahlen aus Wikidata (CC0).
// Gemeindegrenzen (admin_level 8) mit Einwohnerzahl ab TOWN_MIN_POP; vereinfacht und auf Platte zwischengespeichert.
import { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const router = Router();

const DATA_DIR = process.env.TOWNS_DIR ?? 'data/towns';
// Hauptserver ist oft überlastet (504): abwechselnd ein Spiegel
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const OVERPASS_TRIES = 4;
const WIKIDATA = 'https://query.wikidata.org/sparql';
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

export interface OsmMember {
  type: 'way' | 'node' | 'relation';
  role: string;
  lat?: number;
  lon?: number;
  geometry?: Array<{ lat: number; lon: number } | null>;
}

const pending = new Map<string, Promise<string>>();
const WAIT_MS = 20_000;

/** Wege der Außengrenze zu geschlossenen Ringen zusammensetzen */
export function stitch(ways: Array<Array<[number, number]>>): Array<Array<[number, number]>> {
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
export function simplify(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length <= 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, idx = -1;
    const [ay, ax] = pts[a], [by, bx] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      // Geschlossener Ring: Anfang = Ende, dann Abstand zum Punkt statt zur Linie
      const d = len === 0
        ? Math.hypot(pts[i][1] - ax, pts[i][0] - ay)
        : Math.abs(dy * pts[i][1] - dx * pts[i][0] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  members?: OsmMember[];
}

export async function overpass(query: string): Promise<OsmElement[]> {
  // Overpass ist oft ausgelastet (429/504): mit wachsender Pause erneut versuchen, im Wechsel mit dem Spiegel
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < OVERPASS_TRIES; attempt++) {
    if (attempt > 0) await new Promise((ok) => setTimeout(ok, 15_000 * attempt));
    try {
      const res = await fetch(OVERPASS[attempt % OVERPASS.length], {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(130_000),
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const data = (await res.json()) as { elements?: OsmElement[]; remark?: string };
      // Überlastung oder Zeitüberschreitung meldet Overpass mit 200 und einem Hinweis statt Daten
      if (data.remark && /error|timeout|out of memory/i.test(data.remark)) throw new Error(`Overpass: ${data.remark}`);
      return data.elements ?? [];
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

function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
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


/** Einwohnerzahlen aus Wikidata (P1082, CC0) für Orte, bei denen OSM keine hat */
async function wikidataPopulations(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const valid = [...new Set(ids.filter((id) => /^Q\d+$/.test(id)))];
  for (let i = 0; i < valid.length; i += 300) {
    const query = `SELECT ?item ?pop WHERE { VALUES ?item { ${valid.slice(i, i + 300).map((id) => `wd:${id}`).join(' ')} } ?item wdt:P1082 ?pop }`;
    try {
      const res = await fetch(WIKIDATA, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `query=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
      const data = (await res.json()) as { results: { bindings: Array<{ item: { value: string }; pop: { value: string } }> } };
      for (const b of data.results.bindings) {
        const id = b.item.value.split('/').pop()!;
        const pop = Math.round(Number(b.pop.value));
        if (Number.isFinite(pop) && pop > (out.get(id) ?? 0)) out.set(id, pop);
      }
    } catch (err) {
      // Ohne Wikidata fehlen eben die Orte ohne Einwohnerzahl in OSM
      console.error('towns: Wikidata:', (err as Error).message);
    }
  }
  return out;
}

/**
 * Ortschaften als Gemeindegrenzen (admin_level 8, bei kreisfreien Städten die Stadt auf Ebene 6) mit Name und
 * Einwohnerzahl. Die Einwohnerzahl steht mal an der Grenze, mal am Ortsknoten (place=city/town/village), daher
 * beides. Beschriftet wird am gleichnamigen Ortsknoten innerhalb der Grenze, sonst in der Mitte.
 * Orte mit Einwohnerzahl, aber ohne Grenze in OSM, bekommen nur den Namen.
 */
async function fetchTowns(lat: number, lon: number): Promise<Town[]> {
  // Rechteck statt Umkreis: für Overpass deutlich schneller, vor allem bei Grenz-Relationen
  const dLat = RADIUS_M / 111_000, dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const bbox = `${(lat - dLat).toFixed(3)},${(lon - dLon).toFixed(3)},${(lat + dLat).toFixed(3)},${(lon + dLon).toFixed(3)}`;
  const index = await overpass(`[out:json][timeout:110];rel(${bbox})[boundary=administrative][admin_level~"^(6|8)$"][name];out tags qt;`);
  const nodes = await overpass(`[out:json][timeout:110];node(${bbox})[place~"^(city|town|village)$"][name];out tags qt;`);
  if (index.length === 0 && nodes.length === 0) throw new Error('Overpass lieferte nichts');

  const nodesByName = new Map<string, OsmElement[]>();
  for (const n of nodes) nodesByName.set(n.tags!.name, [...(nodesByName.get(n.tags!.name) ?? []), n]);
  const nodePop = (name: string) => Math.max(0, ...(nodesByName.get(name) ?? []).map((n) => popOf(n.tags) || 0));

  // Gemeinden und kreisfreie Städte (nicht die Landkreise); Einwohner von der Grenze, vom Ortsknoten oder aus Wikidata
  const munis = index
    .filter((r) => {
      const t = r.tags!;
      return t.admin_level === '8' || t['de:place'] === 'city' || (t['de:place'] !== 'county' && !/kreis/i.test(t.name));
    })
    .map((r) => ({ id: r.id, name: r.tags!.name, level: Number(r.tags!.admin_level), wikidata: r.tags!.wikidata, pop: popOf(r.tags) || nodePop(r.tags!.name) }));
  const wdPop = await wikidataPopulations(munis.filter((m) => !m.pop && m.wikidata).map((m) => m.wikidata!));
  const candidates = munis
    .map((m) => ({ ...m, pop: m.pop || (m.wikidata ? wdPop.get(m.wikidata) ?? 0 : 0) }))
    .filter((c) => c.pop >= TOWN_MIN_POP);
  // Kreisfreie Stadt auf Ebene 6 und gleichnamige Gemeinde auf 8 gibt es selten doppelt: Ebene 8 gewinnt
  const byName = new Map<string, (typeof candidates)[number]>();
  for (const c of candidates) { const o = byName.get(c.name); if (!o || c.level > o.level) byName.set(c.name, c); }
  const chosen = [...byName.values()];

  const geoms = new Map<number, Town['rings']>();
  const ids = chosen.map((c) => c.id);
  for (let i = 0; i < ids.length; i += 40) {
    const rels = await overpass(`[out:json][timeout:110];rel(id:${ids.slice(i, i + 40).join(',')});out geom qt;`);
    for (const r of rels) geoms.set(r.id, ringsOf(r));
  }

  const towns: Town[] = [];
  for (const c of chosen) {
    const rings = geoms.get(c.id) ?? [];
    if (rings.length === 0) continue;
    const node = (nodesByName.get(c.name) ?? []).find((n) => inside(n.lat!, n.lon!, rings));
    let tLat: number, tLng: number;
    if (node) { tLat = node.lat!; tLng = node.lon!; } else {
      const big = rings.reduce((a, b) => (b.length > a.length ? b : a));
      tLat = big.reduce((s, p) => s + p[0], 0) / big.length;
      tLng = big.reduce((s, p) => s + p[1], 0) / big.length;
    }
    if (distKm(lat, lon, tLat, tLng) > RADIUS_M / 1000) continue;
    towns.push({ name: c.name, pop: c.pop, lat: Math.round(tLat * 1e4) / 1e4, lng: Math.round(tLng * 1e4) / 1e4, rings });
  }
  // Orte mit Einwohnerzahl ohne passende Grenze: nur der Name
  const named = new Set(towns.map((t) => t.name));
  for (const n of nodes) {
    const pop = popOf(n.tags);
    if (pop >= TOWN_MIN_POP && !named.has(n.tags!.name) && distKm(lat, lon, n.lat!, n.lon!) <= RADIUS_M / 1000) {
      named.add(n.tags!.name);
      towns.push({ name: n.tags!.name, pop, lat: Math.round(n.lat! * 1e4) / 1e4, lng: Math.round(n.lon! * 1e4) / 1e4, rings: [] });
    }
  }
  return towns;
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
        if (towns.length === 0) throw new Error('keine Orte gefunden');
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
