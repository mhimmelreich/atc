// filepath: src/services/LiveTrafficService.ts
// Echter Verkehr um den Platz (Server-Route /api/traffic, Daten von adsb.lol unter ODbL)
import type { LiveAircraft } from '@/types/live';

export const LIVE_POLL_MS = 5000;

export async function fetchLiveTraffic(lat: number, lng: number): Promise<LiveAircraft[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}api/traffic?lat=${lat.toFixed(2)}&lon=${lng.toFixed(2)}`);
  if (!res.ok) throw new Error(`Live-Verkehr: HTTP ${res.status}`);
  const data = await res.json() as { aircraft: Array<Omit<LiveAircraft, 'ts'> & { age: number }> };
  const now = Date.now();
  return data.aircraft.map(({ age, ...a }) => ({ ...a, ts: now - age * 1000 }));
}
