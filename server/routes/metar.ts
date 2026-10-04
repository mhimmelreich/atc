// Wetter am Platz: METAR von aviationweather.gov (NOAA/NWS, gemeinfrei) für QNH, Funk und Landerichtung.
// Jeder Platz wird höchstens alle 10 Minuten abgefragt, alle Spieler teilen sich die Antwort.
import { Router } from 'express';
import type { Weather } from '../../src/types/weather';

const router = Router();

const UPSTREAM = 'https://aviationweather.gov/api/data/metar';
const USER_AGENT = 'atc-game (games.himmelreich.cloud)';
const TTL_MS = 10 * 60_000;
const ERROR_TTL_MS = 2 * 60_000; // nach einem Fehler nicht gleich wieder fragen
const MAX_ENTRIES = 500;

interface RawMetar {
  icaoId?: string;
  obsTime?: number;
  wdir?: number | string;
  wspd?: number;
  wgst?: number;
  altim?: number;
  rawOb?: string;
}

const cache = new Map<string, { weather: Weather | null; at: number; failed: boolean }>();
const pending = new Map<string, Promise<Weather | null>>();

function toWeather(m: RawMetar): Weather | null {
  if (!m.icaoId || !m.rawOb) return null;
  // USA und Kanada melden den Luftdruck in inHg (A3027 = 30.27), die übrigen als QNH in hPa
  const inHg = /\sA(\d{4})(\s|$)/.exec(m.rawOb);
  return {
    icao: m.icaoId,
    time: (m.obsTime ?? 0) * 1000,
    qnh: typeof m.altim === 'number' ? Math.floor(m.altim) : null,
    altimeterInHg: inHg ? Number(inHg[1]) / 100 : null,
    windDir: typeof m.wdir === 'number' ? m.wdir : null,
    // Geschwindigkeiten liefert die API in Knoten, auch bei Plätzen mit MPS im METAR
    windKt: m.wspd ?? 0,
    gustKt: m.wgst ?? null,
    raw: m.rawOb,
  };
}

async function fetchMetar(icao: string): Promise<Weather | null> {
  const res = await fetch(`${UPSTREAM}?ids=${icao}&format=json`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  // 204: der Platz hat kein METAR
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`aviationweather HTTP ${res.status}`);
  const list = await res.json() as RawMetar[];
  return toWeather(list.find((m) => m.icaoId === icao) ?? list[0] ?? {});
}

router.get('/:icao', async (req, res) => {
  const icao = req.params.icao.toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(icao)) { res.status(400).json({ error: 'Ungültiger ICAO-Code' }); return; }

  const now = Date.now();
  let entry = cache.get(icao);
  if (!entry || now - entry.at > (entry.failed ? ERROR_TTL_MS : TTL_MS)) {
    let request = pending.get(icao);
    if (!request) {
      request = fetchMetar(icao).finally(() => pending.delete(icao));
      pending.set(icao, request);
    }
    try {
      entry = { weather: await request, at: Date.now(), failed: false };
    } catch (err) {
      console.error('metar:', (err as Error).message);
      // Bei Fehlern den letzten Stand behalten
      entry = { weather: entry?.weather ?? null, at: Date.now(), failed: true };
    }
    cache.set(icao, entry);
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }

  if (!entry.weather) {
    res.status(entry.failed ? 503 : 404).json({ error: entry.failed ? 'Wetter nicht verfügbar' : `Kein METAR für ${icao}` });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(entry.weather);
});

export default router;
