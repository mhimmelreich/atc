// filepath: src/services/AirportDataService.ts
import type { Airport, AirportLayer, OsmWay } from '@/types/airport';
import { buildingHeightM } from '@/types/airport';
import type { Waypoint, STAR } from '@/types/navdata';
import { fetchNavData, fetchOpenData } from './NavigraphService';

// Vorschläge in der Auswahl; mit Navigraph-Daten ist jeder ICAO-Code möglich
export const AVAILABLE_AIRPORTS = ['EDDF', 'EDDM', 'EDDL', 'EDDH', 'EDDB', 'LSZH', 'LOWW', 'EGLL', 'LFPG', 'EHAM', 'KJFK'];

// ── Overpass Response Types ───────────────────────────────────────────────────
interface OverpassElement {
  type: 'way' | 'node';
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
  lat?: number;
  lon?: number;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

// ── Main fetch function ───────────────────────────────────────────────────────
export type AirportSource = 'navdata' | 'open' | 'generic';
export type SourcePreference = 'auto' | Exclude<AirportSource, 'generic'>;

interface ResolvedData { airport: Airport; waypoints: Waypoint[]; stars: STAR[] }

/** Lädt eine einzelne Quelle; null, wenn sie für diesen Platz nichts hat */
async function loadSource(source: Exclude<AirportSource, 'generic'>, icao: string): Promise<ResolvedData | null> {
  switch (source) {
    case 'navdata': {
      const d = await fetchNavData(icao);
      return d ? { airport: d.airport, waypoints: d.waypoints, stars: d.stars } : null;
    }
    case 'open': {
      const d = await fetchOpenData(icao);
      return d ? { airport: d.airport, waypoints: d.waypoints, stars: [] } : null;
    }
  }
}

// Auto: Navigraph (privat) → OurAirports (frei)
const AUTO_ORDER: Array<Exclude<AirportSource, 'generic'>> = ['navdata', 'open'];

export async function fetchAirportData(icao: string, preference: SourcePreference = 'auto'): Promise<ResolvedData & { source: AirportSource }> {
  const upper = icao.toUpperCase();

  // Gewählte Quelle zuerst; hat sie den Platz nicht, greift die Auto-Reihenfolge
  const order = preference === 'auto' ? AUTO_ORDER : [preference, ...AUTO_ORDER.filter((s) => s !== preference)];
  let resolved: ResolvedData | null = null;
  let source: AirportSource = 'generic';
  for (const s of order) {
    resolved = await loadSource(s, upper);
    if (resolved) { source = s; break; }
  }
  const { airport: baseAirport, waypoints, stars } = resolved ?? { airport: buildGenericAirport(upper), waypoints: [], stars: [] };
  // Das OSM-Gelände kommt getrennt (fetchAirportLayer), damit der Platz ohne Wartezeit auf Overpass lädt
  return { airport: baseAirport, waypoints, stars, source };
}

// ── OSM-Gelände ───────────────────────────────────────────────────────────────
/** Gelände des Platzes aus OSM; beim ersten Mal sammelt der Server noch (202), dann später erneut fragen */
export async function fetchAirportLayer(icao: string, isStopped: () => boolean = () => false): Promise<AirportLayer | null> {
  for (let attempt = 0; attempt < 30 && !isStopped(); attempt++) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/airport/${icao.toUpperCase()}`);
    if (res.status === 202 || res.status === 503 || res.status === 504) { await new Promise((ok) => setTimeout(ok, 10_000)); continue; }
    if (!res.ok) return null;
    return parseLayer((await res.json()) as OverpassResponse);
  }
  return null;
}

export function parseLayer(osm: OverpassResponse): AirportLayer {
  const ways = osm.elements.filter((e): e is OverpassElement & { geometry: Array<{ lat: number; lon: number }> } =>
    e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length >= 2
  );
  const nodes = osm.elements.filter((e) => e.type === 'node' && e.lat != null && e.lon != null);

  const taxiways: OsmWay[] = [];
  const aprons: OsmWay[] = [];
  const terminals: OsmWay[] = [];
  const hangars: OsmWay[] = [];
  const boundary: OsmWay[] = [];
  const towers: NonNullable<AirportLayer['towers']> = [];

  // Auf dem Platz sind Aussichts- bzw. Kontrolltürme praktisch immer Tower oder Vorfeldkontrolle
  const isTower = (t: Record<string, string>) => t.aeroway === 'control_tower' || t.aeroway === 'tower' || t.building === 'control_tower'
    || t.service === 'aircraft_control' || (t.man_made === 'tower' && /observation|traffic_control|aircraft_control/.test(t['tower:type'] ?? ''));
  const towerLabel = (t: Record<string, string>) => (/vorfeld|apron|rampco/i.test(t.name ?? '') ? 'APRON' : 'TWR');
  for (const w of ways) {
    const t = w.tags ?? {};
    const way: OsmWay = { id: w.id, geometry: w.geometry.map((p) => ({ lat: p.lat, lng: p.lon })), tags: t };
    if (t.aeroway === 'aerodrome') boundary.push(way);
    else if (isTower(t)) {
      const c = centroid(way);
      towers.push({ ...c, heightM: buildingHeightM(t, 60), footprint: way, label: towerLabel(t) });
    }
    else if (t.aeroway === 'taxiway' || t.aeroway === 'taxilane') taxiways.push(way);
    else if (t.aeroway === 'apron') aprons.push(way);
    else if (t.aeroway === 'terminal' || t.building === 'terminal') terminals.push(way);
    else if (t.aeroway === 'hangar' || t.building === 'hangar') hangars.push(way);
  }
  for (const n of nodes) {
    if (isTower(n.tags ?? {}) && !towers.some((t) => Math.abs(t.lat - n.lat!) < 0.001 && Math.abs(t.lng - n.lon!) < 0.0015)) {
      towers.push({ lat: n.lat!, lng: n.lon!, heightM: buildingHeightM(n.tags ?? {}, towerLabel(n.tags ?? {}) === 'APRON' ? 35 : 50), label: towerLabel(n.tags ?? {}) });
    }
  }
  const holdingPoints = nodes
    .filter((n) => n.tags?.aeroway === 'holding_position')
    .map((n) => ({ lat: n.lat!, lng: n.lon!, name: n.tags?.ref }));
  const gates = nodes
    .filter((n) => (n.tags?.aeroway === 'gate' || n.tags?.aeroway === 'parking_position') && n.tags?.ref)
    .map((n) => ({ lat: n.lat!, lng: n.lon!, ref: n.tags!.ref }));

  return { taxiways, aprons, terminals, holdingPoints, boundary, hangars, towers, gates };
}

function centroid(w: OsmWay): { lat: number; lng: number } {
  const g = w.geometry;
  return { lat: g.reduce((s, p) => s + p.lat, 0) / g.length, lng: g.reduce((s, p) => s + p.lng, 0) / g.length };
}

function buildGenericAirport(icao: string): Airport {
  return {
    icao, name: icao, lat: 51.5, lng: 0.0,
    elevationFt: 0, magneticVariation: 0, transitionAltitudeFt: 5000,
    runways: [{
      id: '27', recipId: '09', heading: 270, recipHeading: 90,
      thresholdLat: 51.5, thresholdLng: 0.02,
      endLat: 51.5, endLng: -0.02,
      lengthM: 3000, widthM: 45, elevationFt: 0,
      ils: { runway: '27', localizerCourse: 270, glideslopeAngle: 3.0, frequencyMHz: 109.9, category: 'I' },
    }],
  };
}
