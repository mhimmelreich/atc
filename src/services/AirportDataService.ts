// filepath: src/services/AirportDataService.ts
import type { Airport, OsmWay } from '@/types/airport';
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
  // Fetch Overpass geometry
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/airport/${upper}`);
    if (res.ok) {
      const osmData: OverpassResponse = await res.json();
      const merged = mergeOsmData(baseAirport, osmData);
      return { airport: merged, waypoints, stars, source };
    }
  } catch (err) {
    console.warn(`Overpass fetch failed for ${upper}:`, err);
  }

  return { airport: baseAirport, waypoints, stars, source };
}

// ── OSM Merge ─────────────────────────────────────────────────────────────────
function mergeOsmData(base: Airport, osm: OverpassResponse): Airport {
  const ways = osm.elements.filter((e): e is OverpassElement & { geometry: Array<{ lat: number; lon: number }> } =>
    e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length >= 2
  );
  const nodes = osm.elements.filter((e) => e.type === 'node' && e.lat != null && e.lon != null);

  const taxiways: OsmWay[] = [];
  const aprons: OsmWay[] = [];
  const terminals: OsmWay[] = [];

  for (const w of ways) {
    const tag = w.tags?.aeroway ?? '';
    const way: OsmWay = {
      id: w.id,
      geometry: w.geometry.map((p) => ({ lat: p.lat, lng: p.lon })),
      tags: w.tags ?? {},
    };
    if (tag === 'taxiway' || tag === 'taxilane') taxiways.push(way);
    else if (tag === 'apron')    aprons.push(way);
    else if (tag === 'terminal') terminals.push(way);
  }

  const holdingPoints = nodes
    .filter((n) => n.tags?.aeroway === 'holding_position')
    .map((n) => ({ lat: n.lat!, lng: n.lon!, name: n.tags?.ref }));

  return {
    ...base,
    layer: { taxiways, aprons, terminals, holdingPoints },
  };
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
