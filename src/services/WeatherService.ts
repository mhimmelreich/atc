// Wetter am Platz (Server-Route /api/metar, Daten von aviationweather.gov)
import type { Weather } from '@/types/weather';

export const WEATHER_POLL_MS = 10 * 60_000;

/** METAR des Platzes; null, wenn der Platz keins hat oder der Dienst nicht antwortet */
export async function fetchWeather(icao: string): Promise<Weather | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/metar/${icao.toUpperCase()}`);
    if (!res.ok) return null;
    return await res.json() as Weather;
  } catch {
    return null;
  }
}
