// filepath: src/services/NavigraphService.ts
import type { Airport } from '@/types/airport';
import type { STAR, Waypoint } from '@/types/navdata';

export interface NavDataResponse {
  cycle: string | null;
  airport: Airport;
  waypoints: Waypoint[];
  stars: STAR[];
}

const KEY_STORAGE = 'atc-navdata-key';

/** Schlüssel für die private Navdata-Route: einmal per ?navkey=… aufrufen, danach im Browser gespeichert */
function navdataKey(): string {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('navkey');
    if (fromUrl) {
      localStorage.setItem(KEY_STORAGE, fromUrl);
      url.searchParams.delete('navkey');
      window.history.replaceState(null, '', url);
    }
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

/** Navigraph-AIRAC-Daten vom Server; null, wenn nicht installiert oder Flughafen unbekannt */
export async function fetchNavData(icao: string): Promise<NavDataResponse | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/navdata/${icao.toUpperCase()}`, {
      headers: { 'X-Navdata-Key': navdataKey() },
    });
    if (!res.ok) return null;
    return await res.json() as NavDataResponse;
  } catch {
    return null;
  }
}

/** Freie Flughafendaten (OurAirports): Bahnen und Navaids, keine STARs */
export async function fetchOpenData(icao: string): Promise<NavDataResponse | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/opendata/${icao.toUpperCase()}`);
    if (!res.ok) return null;
    return await res.json() as NavDataResponse;
  } catch {
    return null;
  }
}

/** true, wenn die private Navigraph-Route mit dem gespeicherten Schlüssel Daten liefert */
export async function fetchNavStatus(): Promise<boolean> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/navdata`, { headers: { 'X-Navdata-Key': navdataKey() } });
    if (!res.ok) return false;
    const body = await res.json() as { available?: boolean };
    return body.available === true;
  } catch {
    return false;
  }
}
