// Ortschaften mit Umriss und Einwohnerzahl rund um einen Punkt (Server-Route /api/towns, OpenStreetMap unter ODbL)
export interface Town {
  name: string;
  pop: number;
  lat: number;
  lng: number;
  /** Außenringe als [lat, lng]-Ketten; leer, wenn OSM keine Gemeindegrenze hat */
  rings: Array<Array<[number, number]>>;
}

/** Beim ersten Mal sammelt der Server die Orte erst (202): dann nach kurzer Pause noch einmal fragen */
export async function fetchTowns(lat: number, lng: number, isStopped: () => boolean = () => false): Promise<Town[]> {
  for (let attempt = 0; attempt < 15 && !isStopped(); attempt++) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/towns?lat=${lat.toFixed(2)}&lon=${lng.toFixed(2)}`);
    if (res.status === 202 || res.status === 504) { await new Promise((ok) => setTimeout(ok, 8000)); continue; }
    if (!res.ok) throw new Error(`Ortschaften: HTTP ${res.status}`);
    return ((await res.json()) as { towns: Town[] }).towns;
  }
  throw new Error('Ortschaften: keine Antwort');
}
