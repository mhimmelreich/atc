// filepath: src/types/weather.ts
/** Wetter am Platz aus dem METAR (aviationweather.gov) */
export interface Weather {
  icao: string;
  /** Beobachtungszeit (Date.now()-Zeitstempel) */
  time: number;
  /** QNH in hPa */
  qnh: number | null;
  /** Höhenmessereinstellung in inHg, wenn der Platz sie so meldet (USA, Kanada) */
  altimeterInHg: number | null;
  /** Windrichtung rechtweisend in Grad; null bei umlaufendem Wind */
  windDir: number | null;
  windKt: number;
  gustKt: number | null;
  /** METAR im Klartext */
  raw: string;
}
