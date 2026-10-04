// Ortschaften mit Umriss und Einwohnerzahl rund um einen Punkt (Server-Route /api/towns, OpenStreetMap unter ODbL)
export interface Town {
  name: string;
  pop: number;
  lat: number;
  lng: number;
  /** Außenringe als [lat, lng]-Ketten; leer, wenn OSM keine Gemeindegrenze hat */
  rings: Array<Array<[number, number]>>;
}

export async function fetchTowns(lat: number, lng: number): Promise<Town[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}api/towns?lat=${lat.toFixed(2)}&lon=${lng.toFixed(2)}`);
  if (!res.ok) throw new Error(`Ortschaften: HTTP ${res.status}`);
  return ((await res.json()) as { towns: Town[] }).towns;
}
