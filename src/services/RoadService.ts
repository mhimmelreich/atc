// Autobahnen rund um den Platz als Orientierungslinien (Server-Route /api/roads, OpenStreetMap unter ODbL)
export interface Road {
  /** Nummer, z. B. "A 5" (mehrere mit ";") */
  ref: string;
  /** Linien als [lat, lng]-Ketten */
  lines: Array<Array<[number, number]>>;
}

/** Beim ersten Mal sammelt der Server die Autobahnen erst (202): dann nach kurzer Pause noch einmal fragen */
export async function fetchRoads(lat: number, lng: number, isStopped: () => boolean = () => false): Promise<Road[]> {
  for (let attempt = 0; attempt < 30 && !isStopped(); attempt++) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/roads?lat=${lat.toFixed(2)}&lon=${lng.toFixed(2)}`);
    if (res.status === 202 || res.status === 503 || res.status === 504) { await new Promise((ok) => setTimeout(ok, 8000)); continue; }
    if (!res.ok) throw new Error(`Autobahnen: HTTP ${res.status}`);
    return ((await res.json()) as { roads: Road[] }).roads;
  }
  throw new Error('Autobahnen: keine Antwort');
}

/** Kurzform fürs Schild: "A 5;A 67" → "A5" (erste Nummer) */
export function roadLabel(ref: string): string {
  return (ref.split(';')[0] ?? '').replace(/\s+/g, '');
}
