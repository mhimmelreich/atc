// Markante Bauwerke (Hochhäuser, Türme, große Stadien) rund um den Platz (Server-Route /api/landmarks, OpenStreetMap unter ODbL)
export interface Landmark {
  name: string | null;
  kind: 'building' | 'tower' | 'stadium';
  /** Höhe über Grund in Metern */
  heightM: number;
  lat: number;
  lng: number;
  /** Grundriss als [lat, lng]-Ringe; leer bei Punkten */
  rings: Array<Array<[number, number]>>;
}

/** Bei geänderter Serverauswertung erhöhen, damit der Browser-Cache (1 Tag) nicht den alten Stand liefert */
const DATA_VERSION = 2;

/** Beim ersten Mal sammelt der Server die Bauwerke erst (202): dann nach kurzer Pause noch einmal fragen */
export async function fetchLandmarks(lat: number, lng: number, isStopped: () => boolean = () => false): Promise<Landmark[]> {
  for (let attempt = 0; attempt < 30 && !isStopped(); attempt++) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/landmarks?lat=${lat.toFixed(2)}&lon=${lng.toFixed(2)}&v=${DATA_VERSION}`);
    if (res.status === 202 || res.status === 503 || res.status === 504) { await new Promise((ok) => setTimeout(ok, 8000)); continue; }
    if (!res.ok) throw new Error(`Bauwerke: HTTP ${res.status}`);
    return ((await res.json()) as { landmarks: Landmark[] }).landmarks;
  }
  throw new Error('Bauwerke: keine Antwort');
}
