// filepath: src/game/RainRadar.ts
// Niederschlagsradar des Deutschen Wetterdienstes (WMS dwd:Niederschlagsradar, Radarverbund, alle 5 min neu).
// Frei nach GeoNutzV mit Quellenangabe. Abdeckung: Deutschland und Randgebiete, außerhalb bleibt das Bild leer.
// Das Bild wird für ein Rechteck in Grad (EPSG:4326) geholt; bei Breiten wie in Deutschland und Ausschnitten
// bis einige hundert NM passt das linear verzerrt gut genug auf die Radarprojektion.

const WMS = 'https://maps.dwd.de/geoserver/dwd/wms';
export const RAIN_CREDIT = 'Niederschlag: © DWD';
const SLOT_MS = 5 * 60_000;

export interface RainBox { north: number; south: number; west: number; east: number }

interface Entry { img: HTMLImageElement; ready: boolean; failed: boolean; box: RainBox }
const cache = new Map<string, Entry>();
const lastGood = new Map<string, Entry>();

export function rainBox(lat: number, lng: number, radiusNm: number): RainBox {
  const dLat = radiusNm / 60;
  const dLng = radiusNm / (60 * Math.cos((lat * Math.PI) / 180));
  return { north: lat + dLat, south: lat - dLat, west: lng - dLng, east: lng + dLng };
}

/**
 * Aktuelles Radarbild für den Kreis um lat/lng (quadratisch, px Bildpunkte) oder null, solange noch keins da ist.
 * Hält das vorige Bild, bis das neue geladen ist; alle 5 min ein neues.
 */
export function rainImage(lat: number, lng: number, radiusNm: number, px: number): { img: HTMLImageElement; box: RainBox } | null {
  const slot = Math.floor(Date.now() / SLOT_MS);
  const area = `${lat.toFixed(2)},${lng.toFixed(2)},${Math.round(radiusNm)},${px}`;
  const key = `${area}@${slot}`;
  let e = cache.get(key);
  if (!e) {
    const box = rainBox(lat, lng, radiusNm);
    const img = new Image();
    e = { img, ready: false, failed: false, box };
    const entry = e;
    img.onload = () => { entry.ready = true; lastGood.set(area, entry); };
    img.onerror = () => { entry.failed = true; };
    img.src = `${WMS}?service=WMS&version=1.1.1&request=GetMap&layers=dwd:Niederschlagsradar&styles=&srs=EPSG:4326`
      + `&bbox=${box.west.toFixed(4)},${box.south.toFixed(4)},${box.east.toFixed(4)},${box.north.toFixed(4)}`
      + `&width=${px}&height=${px}&format=image/png&transparent=true&t=${slot}`;
    cache.set(key, e);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
  }
  const use = e.ready ? e : lastGood.get(area);
  return use ? { img: use.img, box: use.box } : null;
}
