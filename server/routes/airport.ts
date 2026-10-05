// filepath: server/routes/airport.ts
// Flughafengelände aus OpenStreetMap (ODbL) über Overpass: Platzgrenze, Rollwege, Vorfelder, Terminals,
// Hangars, Tower, Gates, Haltepunkte. Overpass ist oft ausgelastet, daher Spiegel (overpass() in towns.ts)
// und Zwischenspeicher auf Platte (30 Tage). Die erste Abfrage kann länger dauern: dann 202, der Client
// fragt wieder.
import { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { overpass } from './towns.js';

const router = Router();

const DATA_DIR = process.env.AIRPORT_OSM_DIR ?? 'data/airport';
const MAX_AGE_MS = 30 * 86400_000;
const WAIT_MS = 8000;
/** Nur diese Tags braucht der Client */
const KEEP_TAGS = ['aeroway', 'building', 'name', 'ref', 'height', 'building:levels', 'man_made', 'tower:type', 'service', 'width'];

const pending = new Map<string, Promise<string>>();

interface Geo { lat: number; lon: number }
interface El { type: string; id: number; lat?: number; lon?: number; tags?: Record<string, string>; geometry?: Array<Geo | null>; members?: Array<{ type: string; role: string; geometry?: Array<Geo | null> }> }

async function fetchAirportOsm(icao: string): Promise<string> {
  const query = `[out:json][timeout:90];
wr["aeroway"="aerodrome"]["icao"="${icao}"]->.ad;
.ad map_to_area->.a;
(
  .ad;
  way(area.a)[aeroway~"^(taxiway|taxilane|apron|terminal|hangar|control_tower|tower)$"];
  rel(area.a)[aeroway~"^(apron|terminal|hangar)$"];
  way(area.a)[building~"^(terminal|hangar|control_tower)$"];
  way(area.a)[man_made=tower]["tower:type"~"observation|air_traffic_control|aircraft_control"];
  way(area.a)[man_made=tower][service=aircraft_control];
  node(area.a)[aeroway~"^(holding_position|gate|control_tower|tower|parking_position)$"];
  node(area.a)[man_made=tower][service=aircraft_control];
);
out geom;`;
  const elements = (await overpass(query)) as El[];
  const out: El[] = [];
  for (const e of elements) {
    const tags: Record<string, string> = {};
    for (const k of KEEP_TAGS) if (e.tags?.[k]) tags[k] = e.tags[k];
    const round = (g: Array<Geo | null>) => g.filter((p): p is Geo => !!p).map((p) => ({ lat: Math.round(p.lat * 1e6) / 1e6, lon: Math.round(p.lon * 1e6) / 1e6 }));
    if (e.type === 'node') out.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags });
    else if (e.type === 'way' && e.geometry) out.push({ type: 'way', id: e.id, tags, geometry: round(e.geometry) });
    else if (e.type === 'relation') {
      // Multipolygone: jeder Außenring als eigener Weg mit den Tags der Relation
      for (const [i, m] of (e.members ?? []).entries()) {
        if (m.type === 'way' && m.role !== 'inner' && m.geometry) out.push({ type: 'way', id: e.id * 1000 + i, tags, geometry: round(m.geometry) });
      }
    }
  }
  return JSON.stringify({ source: 'OpenStreetMap', license: 'ODbL 1.0', elements: out });
}

router.get('/:icao', async (req, res) => {
  const icao = req.params.icao.toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(icao)) { res.status(400).json({ error: 'ICAO ungültig' }); return; }
  const file = join(DATA_DIR, `${icao}.json`);
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < MAX_AGE_MS) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('json').send(readFileSync(file, 'utf8'));
    return;
  }
  let job = pending.get(icao);
  if (!job) {
    job = fetchAirportOsm(icao)
      .then((body) => {
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(file, body);
        return body;
      })
      .finally(() => pending.delete(icao));
    job.catch((err: Error) => console.error('airport osm:', icao, err.message));
    pending.set(icao, job);
  }
  const done = await Promise.race([job.then((b) => b, () => null), new Promise<undefined>((ok) => setTimeout(ok, WAIT_MS))]);
  if (done === undefined) { res.status(202).json({ pending: true }); return; }
  if (done !== null) { res.setHeader('Cache-Control', 'public, max-age=86400'); res.type('json').send(done); return; }
  // Abruf gescheitert: alter Stand ist besser als keiner
  if (existsSync(file)) { res.type('json').send(readFileSync(file, 'utf8')); return; }
  res.status(503).json({ error: 'Flughafengelände nicht verfügbar' });
});

export default router;
