// filepath: src/ui/FavRadar.tsx
// Favoriten-Radar: eigene Orte (GPS oder Koordinaten) speichern und für jeden ein rundes Radarbild
// in Draufsicht zeigen, Nord oben, mit einstellbarem Umkreis und Höhenband. Echtverkehr von adsb.lol (ODbL).
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { fetchLiveTraffic, fetchTrace, type TracePoint } from '@/services/LiveTrafficService';
import { fetchAreaAirports, type AreaAirport } from '@/services/AirportDataService';
import { fetchWeather, WEATHER_POLL_MS } from '@/services/WeatherService';
import { estimateHearing, AUDIBLE_DBA, type HearResult } from '@/game/Hearing';
import type { Weather } from '@/types/weather';
import { airlineName } from '@/game/Airlines';
import { drawPlanform, planform } from '@/game/aircraftPlanform';
import { regCountry, typeName, typeSeats } from '@/game/aircraftInfo';
import { LiveSmoother } from '@/game/LiveSmoother';
import type { LiveAircraft } from '@/types/live';
import { bearingBetween, destinationPoint, distanceNM } from '@/utils/geo';

export interface Favorite {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Umkreis in NM */
  radiusNm: number;
  /** Höhenband in ft (barometrisch, wie gesendet) */
  altMin: number;
  altMax: number;
  /** Mitte folgt der aktuellen GPS-Position des Geräts */
  gps?: boolean;
}

interface Prefs { layout: 'single' | 'grid'; ga: boolean; hear: boolean; vector: boolean; vectorAlpha: number; trail: boolean; trailAlpha: number; selected: string | null }

const FAV_KEY = 'atc-favorites-v1';
const PREF_KEY = 'atc-favradar-v2';
const PREF_KEY_V1 = 'atc-favradar-v1'; // v1: HÖREN war standardmäßig aus
const MAX_RADIUS = 100;
const HISTORY = 6;           // Verlaufspunkte je Ziel (wie auf echten Radarschirmen)
const VECTOR_MIN = 1;        // Geschwindigkeitsvektor: Position in 1 min
const VECTOR_GAP_PX = 10;    // Vektor beginnt erst so weit vom Symbol
const EMERGENCY: Record<string, string> = { '7500': 'HIJACK', '7600': 'RADIO', '7700': 'EMERG' };
const C = {
  bg: '#020a04', ring: '#0f3a1c', ringText: '#2f7a4a', rose: '#2f7a4a',
  airline: '#7dffb4', hear: '#ffd27a', ga: '#d6d27a', sel: '#78d7ff', emerg: '#ff4444', text: '#9fc8a8',
};

function loadFavs(): Favorite[] {
  try { const v = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function loadPrefs(): Prefs {
  try {
    const v2 = localStorage.getItem(PREF_KEY);
    const stored = JSON.parse(v2 ?? localStorage.getItem(PREF_KEY_V1) ?? '{}');
    if (!v2) delete stored.hear;
    return { layout: 'single', ga: true, hear: true, vector: false, vectorAlpha: 0.5, trail: true, trailAlpha: 0.5, selected: null, ...stored };
  } catch { return { layout: 'single', ga: true, hear: true, vector: false, vectorAlpha: 0.5, trail: true, trailAlpha: 0.5, selected: null }; }
}
function save(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* privates Fenster */ } }

/** "50.0379, 8.5622", "50.0379 8.5622" oder "50°02'16"N 8°33'44"E" */
export function parseCoords(text: string): { lat: number; lng: number } | null {
  const t = text.trim().replace(/,(?=\s*-?\d+\.\d+\s*$)/, ' ').replace(/(\d),(\d)/g, '$1.$2');
  const dms = [...t.matchAll(/(\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*["″]\s*)?([NSEWO])/gi)];
  let lat: number, lng: number;
  if (dms.length === 2) {
    const v = dms.map((m) => {
      const d = Number(m[1]) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600;
      return { d: /[SW]/i.test(m[4]) ? -d : d, isLat: /[NS]/i.test(m[4]) };
    });
    const a = v.find((x) => x.isLat), b = v.find((x) => !x.isLat);
    if (!a || !b) return null;
    lat = a.d; lng = b.d;
  } else {
    const nums = t.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length !== 2) return null;
    [lat, lng] = nums.map(Number);
  }
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

const fl3 = (ft: number) => Math.max(0, Math.round(ft / 100)).toString().padStart(3, '0');
const altText = (a: LiveAircraft) => (a.ground || a.altFt === null ? 'GND' : a.altFt < 5000 ? `${Math.round(a.altFt / 100) * 100} ft` : `FL${fl3(a.altFt)}`);
const isGa = (a: LiveAircraft) => !/^[A-Z]{3}\d[0-9A-Z]{0,3}$/.test(a.callsign) && !/^A[2-6]$/.test(a.category ?? '');
const CATEGORY: Record<string, string> = {
  A1: 'leicht', A2: 'klein', A3: 'mittel', A4: 'B757', A5: 'schwer', A6: 'Hochleistung', A7: 'Hubschrauber',
  B1: 'Segelflugzeug', B4: 'Ultraleicht', B6: 'Drohne', B3: 'Fallschirm',
};

function inBand(a: LiveAircraft, f: Favorite): boolean {
  const alt = a.ground || a.altFt === null ? 0 : a.altFt;
  return alt >= Math.min(f.altMin, f.altMax) && alt <= Math.max(f.altMin, f.altMax);
}

/** Ringabstand: 3 bis 6 Ringe */
function ringStep(r: number): number {
  for (const s of [1, 2, 5, 10, 20, 25, 50]) if (r / s <= 6) return s;
  return 50;
}

// ── Ein rundes Radarbild ─────────────────────────────────────────────────────
function Scope({ fav, ga, hear, vector, vectorAlpha, trail, trailAlpha, pollMs, compact, onSelectFav, gpsAcc }: {
  /** GPS LIVE: Genauigkeit in m, null = noch keine Position; undefined = fester Ort */
  gpsAcc?: number | null;
  fav: Favorite; ga: boolean; hear: boolean; vector: boolean; vectorAlpha: number; trail: boolean; trailAlpha: number; pollMs: number; compact: boolean; onSelectFav?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(300);
  const [traffic, setTraffic] = useState<LiveAircraft[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [selHex, setSelHex] = useState<string | null>(null);
  const [info, setInfo] = useState<InfoRef | null>(null);
  // Flugbahn des gewählten Flugs seit dem Start (adsb.lol-Trace), alle 30 s erneuert
  const [trace, setTrace] = useState<TracePoint[]>([]);
  useEffect(() => {
    setTrace([]);
    if (!selHex) return; // auch ohne BAHN: der Anfang der Flugbahn verrät den Startplatz
    let alive = true;
    const load = () => fetchTrace(selHex).then((t) => { if (alive) setTrace(t); }).catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [selHex]);
  // Startplatz aus dem Anfang der Flugbahn (am Boden oder tief), falls die Route unbekannt ist
  const [originGuess, setOriginGuess] = useState<string | null>(null);
  const t0 = trace[0];
  useEffect(() => {
    setOriginGuess(null);
    if (!t0 || (t0.altFt !== null && t0.altFt > 3000)) return;
    let alive = true;
    fetch(`${import.meta.env.BASE_URL}api/opendata/nearest?lat=${t0.lat}&lon=${t0.lng}&any=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { icao: string; distNM: number } | null) => { if (alive && d && d.distNM <= 5) setOriginGuess(d.icao); })
      .catch(() => {});
    return () => { alive = false; };
  }, [t0?.lat, t0?.lng, t0?.altFt]);
  const [, tick] = useState(0);
  const [fields, setFields] = useState<AreaAirport[]>([]);
  useEffect(() => {
    let alive = true;
    fetchAreaAirports(fav.lat, fav.lng, Math.max(fav.radiusNm, 30)).then((a) => { if (alive) setFields(a); }).catch(() => { if (alive) setFields([]); });
    return () => { alive = false; };
  }, [fav.lat, fav.lng, fav.radiusNm]);
  const history = useRef(new Map<string, Array<{ lat: number; lng: number }>>());
  const smoother = useRef(new LiveSmoother());
  const hits = useRef<Array<{ hex: string; x: number; y: number }>>([]);

  // Größe: quadratisch, so breit wie Platz ist
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = compact ? w : Math.min(w, window.innerHeight - 110);
      setSize(Math.max(200, Math.floor(Math.min(w, h))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact]);

  // Abfrage
  useEffect(() => {
    let alive = true;
    const load = () => document.hidden ? undefined : fetchLiveTraffic(fav.lat, fav.lng, { nm: fav.radiusNm + 1, all: true })
      .then((list) => {
        if (!alive) return;
        for (const a of list) {
          const h = history.current.get(a.hex) ?? [];
          const last = h[h.length - 1];
          if (!last || last.lat !== a.lat || last.lng !== a.lng) h.push({ lat: a.lat, lng: a.lng });
          if (h.length > HISTORY + 1) h.shift();
          history.current.set(a.hex, h);
        }
        const seen = new Set(list.map((a) => a.hex));
        for (const k of history.current.keys()) if (!seen.has(k)) history.current.delete(k);
        setTraffic(list); setUpdatedAt(Date.now()); setError(false);
      })
      .catch(() => { if (alive) setError(true); });
    load();
    const id = setInterval(load, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [fav.lat, fav.lng, fav.radiusNm, pollMs]);

  // Ziele laufend weiterrechnen (geglättet, siehe LiveSmoother)
  // HÖREN: das wahrscheinlich hörbare Ziel pulsiert, dafür flüssiger zeichnen
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), hear ? 66 : 100); return () => clearInterval(id); }, [hear]);

  // Wind und QNH vom nächstgelegenen Flughafen, der ein METAR meldet (bei GPS LIVE mit dem Standort neu gesucht),
  // Bodenhöhe vom nächsten Platz
  const byDist = fields.map((f) => ({ f, d: distanceNM(fav.lat, fav.lng, f.lat, f.lng) })).sort((x, y) => x.d - y.d);
  const groundField = byDist[0]?.f;
  const metarKey = byDist.filter(({ f }) => /^[A-Z]{4}$/.test(f.ident)).slice(0, 8).map(({ f }) => f.ident).join(',');
  const [wx, setWx] = useState<Weather | null>(null);
  useEffect(() => {
    if (!metarKey) { setWx(null); return; }
    let alive = true;
    const load = async () => {
      for (const icao of metarKey.split(',')) {
        const w = await fetchWeather(icao);
        if (!alive) return;
        if (w) { setWx(w); return; }
      }
      setWx(null);
    };
    load();
    const id = setInterval(load, WEATHER_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [metarKey]);

  const now = Date.now();
  const smooth = smoother.current;
  const shown = new Map(traffic.map((a) => [a.hex, smooth.at(a, now)]));
  smooth.keep(shown.keys());
  const visible = traffic
    .map((a) => ({ ...a, altFt: shown.get(a.hex)!.alt }))
    .filter((a) => (ga || !isGa(a)) && inBand(a, fav))
    .map((a) => { const p = shown.get(a.hex)!; return { a, p: { lat: p.lat, lng: p.lng }, dist: distanceNM(fav.lat, fav.lng, p.lat, p.lng) }; })
    .filter((v) => v.dist <= fav.radiusNm)
    .sort((x, y) => x.dist - y.dist);
  const selected = visible.find((v) => v.a.hex === selHex) ?? null;
  // Hören zählt unabhängig von Höhenband und Radius (Schall kennt keine Filter), GA-Schalter gilt
  const heard = hear ? estimateHearing(traffic.filter((a) => ga || !isGa(a)), {
    lat: fav.lat, lng: fav.lng, elevFt: groundField?.elevFt ?? 0,
    windFrom: wx?.windDir ?? null, windKt: wx?.windKt ?? 0, qnh: wx?.qnh ?? null,
  }, now) : [];
  const loudest = heard[0] && heard[0].dba >= AUDIBLE_DBA ? heard[0] : null;

  // Zeichnen
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size * dpr; cv.height = size * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = size / 2, cy = size / 2, R = size / 2 - 14;
    const scale = R / fav.radiusNm;
    const toXY = (lat: number, lng: number) => {
      const d = distanceNM(fav.lat, fav.lng, lat, lng) * scale;
      const b = (bearingBetween(fav.lat, fav.lng, lat, lng) * Math.PI) / 180;
      return { x: cx + d * Math.sin(b), y: cy - d * Math.cos(b) };
    };
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = C.bg;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // Entfernungsringe
    const step = ringStep(fav.radiusNm);
    ctx.font = '10px "Courier New", monospace';
    ctx.strokeStyle = C.ring; ctx.fillStyle = C.ringText; ctx.lineWidth = 1;
    for (let r = step; r < fav.radiusNm + 0.01; r += step) {
      ctx.beginPath(); ctx.arc(cx, cy, r * scale, 0, Math.PI * 2); ctx.stroke();
      const a = Math.PI / 4;
      ctx.fillText(`${r}`, cx + r * scale * Math.sin(a) + 2, cy - r * scale * Math.cos(a) - 2);
    }
    // Kompassrose am Rand
    ctx.strokeStyle = C.rose; ctx.fillStyle = C.rose;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 5) {
      const rad = (d * Math.PI) / 180, len = d % 30 === 0 ? 9 : d % 10 === 0 ? 6 : 3;
      ctx.beginPath();
      ctx.moveTo(cx + R * Math.sin(rad), cy - R * Math.cos(rad));
      ctx.lineTo(cx + (R - len) * Math.sin(rad), cy - (R - len) * Math.cos(rad));
      ctx.stroke();
      if (d % 30 === 0) {
        const t = d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10).padStart(2, '0');
        ctx.fillText(t, cx + (R + 8) * Math.sin(rad), cy - (R + 8) * Math.cos(rad));
      }
    }
    // Flugplätze: Bahnen maßstäblich, Kennung daneben
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.lineCap = 'butt'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '10px "Courier New", monospace';
    for (const f of fields) {
      const big = f.kind !== 'S';
      ctx.strokeStyle = big ? '#8fa59a' : '#62786c';
      ctx.lineWidth = f.kind === 'L' ? 3 : f.kind === 'M' ? 2.5 : 1.5;
      for (const [a1, b1, a2, b2] of f.runways) {
        const p1 = toXY(a1, b1), p2 = toXY(a2, b2);
        // Bei großem Radius wären Bahnen nur Punkte: mindestens 6 px lang
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const k = len < 6 && len > 0 ? 6 / len : 1;
        const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        ctx.beginPath();
        ctx.moveTo(mx + (p1.x - mx) * k, my + (p1.y - my) * k);
        ctx.lineTo(mx + (p2.x - mx) * k, my + (p2.y - my) * k);
        ctx.stroke();
      }
      const c = toXY(f.lat, f.lng);
      if (f.runways.length === 0) { ctx.strokeStyle = '#62786c'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.stroke(); }
      if (big || (!compact && fav.radiusNm <= 40)) {
        ctx.fillStyle = big ? '#8fa59a' : '#62786c';
        ctx.fillText(f.ident, c.x + 8, c.y + 8);
      }
    }
    ctx.restore();

    // Flugbahn des gewählten Flugs (geschätzte Abschnitte gestrichelt), bis zur aktuellen Position
    const selNow = visible.find((v) => v.a.hex === selHex);
    if (trail && trace.length > 1) {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      ctx.strokeStyle = C.sel; ctx.lineWidth = 1.5; ctx.globalAlpha = trailAlpha; ctx.lineJoin = 'round';
      for (let i = 1; i < trace.length; i++) {
        const a = toXY(trace[i - 1].lat, trace[i - 1].lng), b = toXY(trace[i].lat, trace[i].lng);
        ctx.setLineDash(trace[i].est ? [4, 4] : []);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      if (selNow) {
        const a = toXY(trace[trace.length - 1].lat, trace[trace.length - 1].lng), b = toXY(selNow.p.lat, selNow.p.lng);
        ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.restore();
    }

    // Nordpfeil oben links
    {
      const nx = 14, ny = compact ? 50 : 56;
      ctx.fillStyle = '#9fd8b0'; ctx.strokeStyle = '#9fd8b0'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(nx, ny - 14); ctx.lineTo(nx + 6, ny + 4); ctx.lineTo(nx, ny); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(nx, ny - 14); ctx.lineTo(nx - 6, ny + 4); ctx.lineTo(nx, ny); ctx.closePath(); ctx.stroke();
      ctx.font = 'bold 12px "Courier New", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('N', nx, ny + 17);
    }

    // Mitte: der Favorit
    ctx.strokeStyle = '#ff6ec7'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6); ctx.stroke();

    // Ziele (nur im Kreis)
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    hits.current = [];
    for (const { a, p } of visible) {
      const { x, y } = toXY(p.lat, p.lng);
      const emerg = a.squawk ? EMERGENCY[a.squawk] : undefined;
      const col = emerg ? C.emerg : a.hex === selHex ? C.sel : isGa(a) ? C.ga : C.airline;
      // Verlauf
      ctx.fillStyle = col;
      const h = history.current.get(a.hex) ?? [];
      h.slice(0, -1).forEach((q, i) => {
        const s = toXY(q.lat, q.lng);
        ctx.globalAlpha = 0.25 + (0.5 * (i + 1)) / h.length;
        ctx.fillRect(s.x - 1, s.y - 1, 2, 2);
      });
      ctx.globalAlpha = 1;
      // Geschwindigkeitsvektor (1 min)
      // (abschaltbar, beginnt 10 px vor dem Symbol, damit es frei bleibt)
      if (vector && !a.ground && a.gs && a.track !== null) {
        const e = destinationPoint(p.lat, p.lng, a.track, (a.gs * VECTOR_MIN) / 60);
        const q = toXY(e.lat, e.lng);
        const len = Math.hypot(q.x - x, q.y - y);
        const gap = Math.max(VECTOR_GAP_PX, (planform(a.type, a.category).length * (compact ? 0.4 : 0.5)) / 2 + 4);
        if (len > gap) {
          ctx.strokeStyle = col; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + ((q.x - x) / len) * gap, y + ((q.y - y) / len) * gap);
          ctx.lineTo(q.x, q.y);
          ctx.globalAlpha = vectorAlpha; ctx.stroke(); ctx.globalAlpha = 1;
        }
      }
      // Symbol; das wahrscheinlich gehörte Ziel pulsiert
      const pulse = loudest?.hex === a.hex ? (1 + Math.sin(now / 250)) / 2 : null;
      const pf = planform(a.type, a.category);
      const ringR = Math.max(11, (Math.max(pf.length, pf.span) * (compact ? 0.4 : 0.5)) / 2 + 5);
      if (pulse !== null) {
        ctx.strokeStyle = C.hear; ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.35 + 0.5 * pulse;
        ctx.beginPath(); ctx.arc(x, y, ringR + 5 * pulse, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((((a.track ?? 0) * Math.PI) / 180));
      ctx.fillStyle = col;
      // Größe nach echtem Typ: alle im selben Maßstab (px je Meter), Triebwerke in echter Zahl
      const half = drawPlanform(ctx, pf, (compact ? 0.4 : 0.5) * (pulse !== null ? 1 + 0.2 * pulse : 1), 8, C.bg);
      ctx.restore();
      // Datenblock: Rufzeichen / Höhe (FL) Trend Geschwindigkeit (kt/10) / Typ
      const trend = a.vs === null || Math.abs(a.vs) < 300 ? ' ' : a.vs > 0 ? '↑' : '↓';
      const l2 = `${a.ground || a.altFt === null ? 'GND' : fl3(a.altFt)}${trend}${a.gs !== null ? String(Math.round(a.gs / 10)).padStart(2, '0') : ''}`;
      ctx.fillStyle = col;
      ctx.font = `${compact ? 10 : 11}px "Courier New", monospace`;
      const lx = x + Math.max(9, half + 3);
      ctx.fillText(emerg ? `${a.callsign} ${emerg}` : a.callsign, lx, y - 4);
      ctx.fillText(l2, lx, y + 7);
      if (!compact && a.type) ctx.fillText(a.type, lx, y + 18);
      hits.current.push({ hex: a.hex, x, y });
    }
    ctx.restore();
    // HÖREN: hörbare Flieger, die nicht im Bild sind (außerhalb von Radius oder Höhenband), als Marke am Rand
    if (hear) {
      const onScope = new Set(visible.map((v) => v.a.hex));
      const byHex = new Map(traffic.map((a) => [a.hex, a]));
      ctx.font = `${compact ? 9 : 10}px "Courier New", monospace`;
      for (const h of heard.filter((x) => x.dba >= AUDIBLE_DBA && !onScope.has(x.hex)).slice(0, 4)) {
        const a = byHex.get(h.hex);
        if (!a) continue;
        const q = shown.get(a.hex) ?? a;
        const brg = (bearingBetween(fav.lat, fav.lng, q.lat, q.lng) * Math.PI) / 180;
        const inside = distanceNM(fav.lat, fav.lng, q.lat, q.lng) <= fav.radiusNm;
        const r = inside ? Math.min(R - 10, distanceNM(fav.lat, fav.lng, q.lat, q.lng) * scale) : R - 10;
        const x = cx + r * Math.sin(brg), y = cy - r * Math.cos(brg);
        const pulse = loudest?.hex === a.hex ? (1 + Math.sin(now / 250)) / 2 : 0.5;
        ctx.save();
        ctx.translate(x, y); ctx.rotate(brg);
        ctx.fillStyle = C.hear; ctx.globalAlpha = 0.5 + 0.5 * pulse;
        ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 3); ctx.lineTo(-5, 3); ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.fillStyle = C.hear;
        const lx = x - Math.sin(brg) * 14, ly = y + Math.cos(brg) * 14;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`♪ ${a.callsign} ${Math.round(distanceNM(fav.lat, fav.lng, q.lat, q.lng))} NM`, lx, ly);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      }
    }
    ctx.strokeStyle = '#1a5a30'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  });

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best: string | null = null, bestD = 18;
    for (const h of hits.current) { const d = Math.hypot(h.x - x, h.y - y); if (d < bestD) { bestD = d; best = h.hex; } }
    setSelHex(best);
    if (onSelectFav && !best) onSelectFav();
  };

  const age = updatedAt === null ? null : Math.round((now - updatedAt) / 1000);
  // VON / NACH: Route aus der Routendatenbank, sonst geschätzt (Startplatz aus der Flugbahn, Ziel aus Sinkflug und Kurs)
  let legs: Legs = {};
  if (selected) {
    const a = selected.a;
    if (a.route) {
      let codes = a.route.split('-');
      // Die Routendatenbank kennt nur das Rufzeichen; manche Airlines fliegen Hin- und Rückflug unter demselben
      // (z. B. CFG081 EDDF–VTBS, landet aber gerade in EDDF). Passt die Flugphase zur Gegenrichtung: umdrehen.
      const rel = (code: string) => {
        const f = fields.find((x) => x.ident === code);
        if (!f) return null;
        const d = distanceNM(selected.p.lat, selected.p.lng, f.lat, f.lng);
        const off = a.track === null ? 90 : Math.abs(((bearingBetween(selected.p.lat, selected.p.lng, f.lat, f.lng) - a.track + 540) % 360) - 180);
        return { d, off };
      };
      const low = !a.ground && a.altFt !== null && a.altFt < 10000;
      const first = rel(codes[0]), last = rel(codes[codes.length - 1]);
      const reversed = codes.length > 1 && (
        (originGuess !== null && originGuess === codes[codes.length - 1] && originGuess !== codes[0])
        || (low && (a.vs ?? 0) < -300 && first !== null && first.d < 40 && first.off < 60)
        || (low && (a.vs ?? 0) > 300 && last !== null && last.d < 40 && last.off > 120));
      if (reversed) codes = [...codes].reverse();
      legs = { from: { code: codes[0], guess: reversed }, to: { code: codes[codes.length - 1], guess: reversed }, via: codes.slice(1, -1) };
    } else {
      if (originGuess) legs.from = { code: originGuess, guess: true };
      if (!a.ground && a.altFt !== null && a.altFt < 12000 && (a.vs ?? 0) < -300 && a.track !== null) {
        const kinds = isGa(a) ? 'LMS' : 'LM';
        const dest = fields
          .filter((f) => kinds.includes(f.kind) && f.ident !== originGuess)
          .map((f) => ({ f, d: distanceNM(selected.p.lat, selected.p.lng, f.lat, f.lng), b: bearingBetween(selected.p.lat, selected.p.lng, f.lat, f.lng) }))
          .filter((x) => x.d < 60 && (x.d < 6 || Math.abs(((x.b - a.track! + 540) % 360) - 180) < 40))
          .sort((x, y) => x.d - y.d)[0];
        if (dest) legs.to = { code: dest.f.ident, guess: true };
      }
    }
  }
  const names = useAirportNames([legs.from?.code, legs.to?.code, ...(legs.via ?? [])]);
  // Zusatzinfos in die vier Ecken des Quadrats, die der Kreis frei lässt
  const fs = compact ? 10 : 11;
  const cornerW = Math.round(size * 0.34);
  const corner = (pos: CSSProperties): CSSProperties => ({
    position: 'absolute', maxWidth: cornerW, fontSize: fs, lineHeight: 1.3, color: C.text, ...pos,
  });
  return (
    <div ref={wrapRef} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <canvas ref={canvasRef} onClick={onClick} style={{ width: size, height: size, cursor: 'crosshair', display: 'block' }} />
        {info && <InfoModal info={info} fav={fav} onClose={() => setInfo(null)} />}
        {/* oben links: Name (Nordpfeil darunter im Bild) */}
        <div style={corner({ left: 0, top: 0 })}>
          <span style={{ color: '#ff9ed8', fontWeight: 'bold', cursor: onSelectFav ? 'pointer' : undefined }} onClick={onSelectFav}>★ {fav.name}</span>
          {gpsAcc !== undefined && <div style={{ color: gpsAcc === null ? '#ffaa00' : '#7fa88c' }}>{gpsAcc === null ? 'GPS sucht…' : `GPS LIVE ±${Math.round(gpsAcc)} m`}</div>}
        </div>
        {/* oben rechts: Stand */}
        <div style={corner({ right: 0, top: 0, textAlign: 'right' })}>
          <div style={{ color: C.airline }}>{visible.length} AC</div>
          <div>{fav.radiusNm} NM · {fav.altMin}–{fav.altMax} ft</div>
          <div style={{ color: error ? '#ffaa00' : C.text }}>{error ? 'keine Daten' : age === null ? 'lädt…' : `vor ${age} s`}</div>
        </div>
        {/* unten links: Hören */}
        {(
          <div style={corner({ left: 0, bottom: 0 })}>
            <HearPanel hear={hear} heard={heard} traffic={traffic} visible={new Set(visible.map((v) => v.a.hex))} wx={wx} field={wx?.icao} compact={compact} onSelect={setSelHex} />
          </div>
        )}
        {/* unten rechts: gewählter Flieger, sonst die nächsten */}
        <div style={corner({ right: 0, bottom: 0, textAlign: 'right' })}>
          {selected ? <Details v={selected} fav={fav} legs={legs} names={names} onClose={() => setSelHex(null)} onInfo={setInfo} /> : !compact && visible.slice(0, 6).map(({ a, dist }) => (
            <div key={a.hex} onClick={() => setSelHex(a.hex)} style={{ cursor: 'pointer', color: isGa(a) ? C.ga : C.airline, whiteSpace: 'nowrap' }}>
              {a.callsign} {altText(a)} {dist.toFixed(1)} NM {String(Math.round(bearingBetween(fav.lat, fav.lng, a.lat, a.lng))).padStart(3, '0')}°
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HearPanel({ hear, heard, traffic, visible, wx, field, compact, onSelect }: {
  hear: boolean; heard: HearResult[]; traffic: LiveAircraft[]; visible: Set<string>; wx: Weather | null; field?: string; compact: boolean; onSelect: (hex: string) => void;
}) {
  const byHex = new Map(traffic.map((a) => [a.hex, a]));
  const top = heard.filter((h) => h.dba >= AUDIBLE_DBA).slice(0, compact ? 1 : 3);
  const wind = !wx ? 'Wind ?' : wx.windDir === null ? `Wind VRB/${wx.windKt} kt` : `Wind ${String(wx.windDir).padStart(3, '0')}°/${wx.windKt} kt`;
  const gust = wx?.gustKt ? ` G${wx.gustKt}` : '';
  const qnh = wx?.qnh ? `QNH ${Math.round(wx.qnh)} hPa${wx.altimeterInHg ? ` (${wx.altimeterInHg.toFixed(2)} inHg)` : ''}` : 'QNH ?';
  return (
    <>
      {hear && <div style={{ color: C.hear }}>♪ HÖREN</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0' }}>
        <WindRose wx={wx} size={compact ? 30 : 40} />
        <div>
          <div>{wind}{gust}{wx && field ? ` · ${field}` : ''}</div>
          <div>{qnh}</div>
        </div>
      </div>
      {hear && top.length === 0 && <div>kein Flieger hörbar (&lt;{AUDIBLE_DBA} dB(A))</div>}
      {top.map((h, i) => {
        const a = byHex.get(h.hex);
        return (
          <div key={h.hex} onClick={() => onSelect(h.hex)} style={{ cursor: 'pointer', color: i === 0 ? C.hear : C.text }}>
            {a?.callsign ?? h.hex} {a?.type ?? ''} ≈{Math.round(h.dba)} dB(A) {Math.round(h.p * 100)} %
            {i === 0 && <span> · Schall {Math.round(h.delayS)} s alt</span>}
            {!visible.has(h.hex) && ' · nicht im Bild'}
          </div>
        );
      })}
    </>
  );
}

/** Windrose: Ring mit Himmelsrichtungen, Pfeil fliegt mit dem Wind (von der gemeldeten Richtung zur Mitte und weiter) */
function WindRose({ wx, size }: { wx: Weather | null; size: number }) {
  const r = size / 2 - 1, c = size / 2;
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30);
  const dir = wx?.windDir ?? null;
  const calm = !wx || wx.windKt === 0;
  const len = r * 0.85;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: 'none' }}>
      <circle cx={c} cy={c} r={r} fill="none" stroke={C.rose} strokeWidth={1} />
      {ticks.map((t) => {
        const a = (t * Math.PI) / 180, k = t % 90 === 0 ? 0.72 : 0.85;
        return <line key={t} x1={c + Math.sin(a) * r * k} y1={c - Math.cos(a) * r * k} x2={c + Math.sin(a) * r} y2={c - Math.cos(a) * r} stroke={C.rose} strokeWidth={1} />;
      })}
      <text x={c} y={c - r * 0.42} fill={C.text} fontSize={size * 0.22} textAnchor="middle" dominantBaseline="middle">N</text>
      {calm ? <circle cx={c} cy={c} r={2} fill={C.text} />
        : dir === null ? <circle cx={c} cy={c} r={r * 0.4} fill="none" stroke={C.hear} strokeDasharray="2 2" />
        : (() => {
          // Pfeil von der Windherkunft durch die Mitte (zeigt, wohin der Wind weht)
          const a = (dir * Math.PI) / 180;
          const x0 = c + Math.sin(a) * len, y0 = c - Math.cos(a) * len, x1 = c - Math.sin(a) * len, y1 = c + Math.cos(a) * len;
          const h = size * 0.16, b = Math.atan2(y1 - y0, x1 - x0);
          return (
            <g stroke={C.hear} fill={C.hear} strokeWidth={1.6}>
              <line x1={x0} y1={y0} x2={x1} y2={y1} />
              <polygon points={`${x1},${y1} ${x1 - h * Math.cos(b - 0.45)},${y1 - h * Math.sin(b - 0.45)} ${x1 - h * Math.cos(b + 0.45)},${y1 - h * Math.sin(b + 0.45)}`} stroke="none" />
              <circle cx={x0} cy={y0} r={1.8} stroke="none" />
            </g>
          );
        })()}
    </svg>
  );
}

type InfoRef = { kind: 'type' | 'reg' | 'airport'; value: string; a: LiveAircraft };

interface Legs { from?: { code: string; guess: boolean }; to?: { code: string; guess: boolean }; via?: string[] }

// Flughafennamen (OurAirports) für VON / NACH, im Modul zwischengespeichert
const apNames = new Map<string, string | null>();
function useAirportNames(codes: Array<string | undefined>): Record<string, string> {
  const [, bump] = useState(0);
  const key = codes.filter(Boolean).join(',');
  useEffect(() => {
    const missing = key.split(',').filter((c) => c && !apNames.has(c));
    if (missing.length === 0) return;
    for (const c of missing) apNames.set(c, null);
    fetch(`${import.meta.env.BASE_URL}api/opendata/names?icao=${missing.join(',')}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: Record<string, { name: string }>) => { for (const [c, v] of Object.entries(d)) apNames.set(c, v.name); bump((n) => n + 1); })
      .catch(() => {});
  }, [key]);
  const out: Record<string, string> = {};
  for (const c of key.split(',')) { const n = apNames.get(c); if (n) out[c] = n; }
  return out;
}

function Details({ v, fav, legs, names, onClose, onInfo }: { v: { a: LiveAircraft; p: { lat: number; lng: number }; dist: number }; fav: Favorite; legs: Legs; names: Record<string, string>; onClose: () => void; onInfo: (i: InfoRef) => void }) {
  const { a, p, dist } = v;
  const airline = airlineName(a.callsign);
  const link = (kind: InfoRef['kind'], value: string) => (
    <span onClick={() => onInfo({ kind, value, a })} style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 2 }} title="Info">{value}</span>
  );
  const rows: Array<[string, React.ReactNode]> = [];
  const leg = (l?: { code: string; guess: boolean }) => l
    ? <span title={l.guess ? 'geschätzt aus Flugbahn und Flugphase' : undefined}>{l.guess && '≈ '}{link('airport', l.code)}{names[l.code] && <span style={{ color: '#9fc8e0' }}> {shortName(names[l.code])}</span>}</span>
    : <span style={{ color: '#4f8a60' }}>unbekannt</span>;
  rows.push(['VON', leg(legs.from)]);
  if (legs.via?.length) rows.push(['ÜBER', <>{legs.via.map((c, i) => <span key={c}>{i > 0 && ', '}{link('airport', c)}</span>)}</>]);
  rows.push(['NACH', leg(legs.to)]);
  if (a.type) rows.push(['TYP', link('type', a.type)]);
  if (a.category) rows.push(['KLASSE', CATEGORY[a.category] ?? a.category]);
  if (a.reg) rows.push(['KENNZ.', link('reg', a.reg)]);
  rows.push(['HÖHE', altText(a)]);
  if (a.vs !== null && Math.abs(a.vs) >= 100) rows.push(['RATE', `${a.vs > 0 ? '↑' : '↓'} ${Math.abs(Math.round(a.vs / 100) * 100)} ft/min`]);
  if (a.selAltFt) rows.push(['GEWÄHLT', `${a.selAltFt} ft`]);
  rows.push(['GS', a.gs !== null ? `${Math.round(a.gs)} kt` : '–']);
  rows.push(['KURS', a.track !== null ? `${String(Math.round(a.track)).padStart(3, '0')}°` : '–']);
  if (a.squawk) rows.push(['SQUAWK', `${a.squawk}${EMERGENCY[a.squawk] ? ` ${EMERGENCY[a.squawk]}` : ''}`]);
  rows.push(['VON ★', `${dist.toFixed(1)} NM · ${String(Math.round(bearingBetween(fav.lat, fav.lng, p.lat, p.lng))).padStart(3, '0')}°`]);
  return (
    <div style={{ color: '#cde', textAlign: 'left' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: C.sel, fontWeight: 'bold' }}>
        <span>{a.callsign}{airline && <span style={{ color: '#9fc8e0', fontWeight: 'normal' }}> · {airline}</span>}</span>
        <span onClick={onClose} style={{ cursor: 'pointer', color: '#4f8a60' }} title="Schließen">✕</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10 }}>
        {rows.map(([k, val]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span style={{ color: '#4f8a60' }}>{k}</span>
            <span style={{ textAlign: 'right' }}>{val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface AirportInfo {
  icao: string; iata: string | null; name: string; city: string | null; country: string | null; type: string; scheduled: boolean;
  lat: number; lng: number; elevationFt: number | null; wikipedia: string | null; home: string | null;
  runways: Array<{ name: string; lengthM: number | null; widthM: number | null; surface: string | null; lighted: boolean }>;
  freqs: Array<{ type: string; name: string; mhz: number }>;
}
/** "Frankfurt am Main Airport" → "Frankfurt am Main" (Platz in der Ecke ist knapp) */
const shortName = (n: string) => n.replace(/\s+(International\s+)?(Airport|Airfield|Flughafen|Aeropuerto|Aéroport|Aeroporto)\b.*$/i, '').slice(0, 22);
const AP_TYPE: Record<string, string> = { large_airport: 'Großflughafen', medium_airport: 'Regionalflughafen', small_airport: 'Flugplatz', heliport: 'Hubschrauberlandeplatz', seaplane_base: 'Wasserflugplatz' };

/** Info in der Bildschirmmitte: Flugzeugtyp, Kennzeichen oder Flughafen */
function InfoModal({ info, fav, onClose }: { info: InfoRef; fav: Favorite; onClose: () => void }) {
  const [ap, setAp] = useState<AirportInfo | null | 'error'>(null);
  useEffect(() => {
    if (info.kind !== 'airport') return;
    setAp(null);
    fetch(`${import.meta.env.BASE_URL}api/opendata/info/${info.value}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: AirportInfo) => setAp(d)).catch(() => setAp('error'));
  }, [info.kind, info.value]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }; window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true); }, [onClose]);

  const rows: Array<[string, React.ReactNode]> = [];
  let title = info.value;
  const ext = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer" style={{ color: '#78d7ff' }}>{text}</a>;
  if (info.kind === 'type') {
    const pf = planform(info.value, info.a.category);
    title = typeName(info.value) ?? info.value;
    rows.push(['ICAO-TYP', info.value]);
    rows.push(['LÄNGE', `${pf.length.toFixed(1)} m`]);
    rows.push([pf.kind === 'heli' ? 'ROTOR' : 'SPANNWEITE', `${pf.span.toFixed(1)} m`]);
    const eng = { jet: 'Strahltriebwerke', turboprop: 'Turboprop', piston1: 'Kolbenmotor', piston2: 'Kolbenmotoren', heli: 'Turbine/Kolben', glider: 'ohne Motor' }[pf.kind];
    rows.push(['ANTRIEB', pf.engines > 0 ? `${pf.engines} × ${eng}${pf.rearEngines ? ' (hinten)' : ''}` : eng]);
    const seats = typeSeats(info.value);
    if (seats) rows.push(['PASSAGIERE', seats]);
    if (info.a.category) rows.push(['ADS-B', `${info.a.category} · ${CATEGORY[info.a.category] ?? ''}`]);
    rows.push(['MEHR', ext(`https://de.wikipedia.org/w/index.php?search=${encodeURIComponent(typeName(info.value) ?? info.value)}`, 'Wikipedia')]);
  } else if (info.kind === 'reg') {
    title = info.value;
    rows.push(['LAND', regCountry(info.value) ?? '?']);
    rows.push(['TYP', typeName(info.a.type) ?? info.a.type ?? '?']);
    const airline = airlineName(info.a.callsign);
    if (airline) rows.push(['BETREIBER', airline]);
    rows.push(['RUFZEICHEN', info.a.callsign]);
    rows.push(['ICAO-ADRESSE', info.a.hex.toUpperCase()]);
    rows.push(['FOTOS', ext(`https://www.planespotters.net/search?q=${encodeURIComponent(info.value)}`, 'planespotters.net')]);
    rows.push(['VERLAUF', ext(`https://globe.adsb.lol/?icao=${info.a.hex}`, 'globe.adsb.lol')]);
  } else if (ap === null) {
    rows.push(['', 'lädt…']);
  } else if (ap === 'error') {
    rows.push(['', 'keine Daten zu diesem Flughafen']);
  } else {
    title = ap.name;
    rows.push(['ICAO / IATA', `${ap.icao}${ap.iata ? ` / ${ap.iata}` : ''}`]);
    if (ap.city || ap.country) rows.push(['ORT', [ap.city, ap.country].filter(Boolean).join(', ')]);
    rows.push(['ART', `${AP_TYPE[ap.type] ?? ap.type}${ap.scheduled ? ', Linienverkehr' : ''}`]);
    if (ap.elevationFt !== null) rows.push(['HÖHE', `${ap.elevationFt} ft`]);
    rows.push(['VON ★', `${Math.round(distanceNM(fav.lat, fav.lng, ap.lat, ap.lng))} NM · ${String(Math.round(bearingBetween(fav.lat, fav.lng, ap.lat, ap.lng))).padStart(3, '0')}°`]);
    for (const r of ap.runways) rows.push([`BAHN ${r.name}`, [r.lengthM && `${r.lengthM} m`, r.widthM && `× ${r.widthM} m`, r.surface].filter(Boolean).join(' ')]);
    for (const f of ap.freqs.slice(0, 6)) rows.push([f.type, `${f.mhz.toFixed(3)} ${f.name ?? ''}`]);
    if (ap.wikipedia) rows.push(['MEHR', ext(ap.wikipedia, 'Wikipedia')]);
  }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ minWidth: 280, maxWidth: 440, width: '100%', maxHeight: '80vh', overflowY: 'auto', background: '#06140c', border: '1px solid #1a5a30', padding: 14, fontSize: 12, color: '#cde', fontFamily: '"Courier New", monospace' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
          <span style={{ color: C.sel, fontWeight: 'bold', fontSize: 14 }}>{title}</span>
          <span onClick={onClose} style={{ cursor: 'pointer', color: '#4f8a60' }} title="Schließen (Esc)">✕</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 14, rowGap: 2 }}>
          {rows.map(([k, val], i) => (
            <div key={i} style={{ display: 'contents' }}>
              <span style={{ color: '#4f8a60' }}>{k}</span>
              <span style={{ textAlign: 'right' }}>{val}</span>
            </div>
          ))}
        </div>
        {info.kind === 'airport' && <div style={{ fontSize: 10, color: '#3a6a4a', marginTop: 8 }}>Daten: OurAirports (gemeinfrei)</div>}
      </div>
    </div>
  );
}

// ── Favoriten bearbeiten ─────────────────────────────────────────────────────
function Editor({ fav, onChange, onDelete }: { fav: Favorite; onChange: (f: Favorite) => void; onDelete: () => void }) {
  const [coords, setCoords] = useState(`${fav.lat.toFixed(5)}, ${fav.lng.toFixed(5)}`);
  const [coordErr, setCoordErr] = useState(false);
  useEffect(() => { setCoords(`${fav.lat.toFixed(5)}, ${fav.lng.toFixed(5)}`); setCoordErr(false); }, [fav.id, fav.lat, fav.lng]);
  const num = (k: 'radiusNm' | 'altMin' | 'altMax', v: string, min: number, max: number) => {
    const n = Number(v);
    if (v !== '' && Number.isFinite(n)) onChange({ ...fav, [k]: Math.min(max, Math.max(min, Math.round(n))) });
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 11, color: C.text }}>
      <label>NAME <input value={fav.name} onChange={(e) => onChange({ ...fav, name: e.target.value.slice(0, 24) })} style={{ ...INPUT, width: 110 }} /></label>
      <label title="Dezimalgrad oder Grad/Minuten/Sekunden; z. B. aus Google Maps kopiert">KOORD
        <input value={coords} onChange={(e) => { setCoords(e.target.value); setCoordErr(false); }}
          onBlur={() => { const c = parseCoords(coords); if (c) onChange({ ...fav, ...c }); else setCoordErr(true); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={{ ...INPUT, width: 170, borderColor: coordErr ? '#ff6644' : '#1a4428' }} />
      </label>
      <label>RADIUS <input type="number" min={2} max={MAX_RADIUS} value={fav.radiusNm} onChange={(e) => num('radiusNm', e.target.value, 2, MAX_RADIUS)} style={{ ...INPUT, width: 50 }} /> NM</label>
      <input type="range" min={2} max={MAX_RADIUS} value={fav.radiusNm} onChange={(e) => num('radiusNm', e.target.value, 2, MAX_RADIUS)} style={{ width: 90 }} />
      <label>HÖHE <input type="number" min={0} max={60000} step={500} value={fav.altMin} onChange={(e) => num('altMin', e.target.value, 0, 60000)} style={{ ...INPUT, width: 64 }} />
        {' – '}<input type="number" min={0} max={60000} step={500} value={fav.altMax} onChange={(e) => num('altMax', e.target.value, 0, 60000)} style={{ ...INPUT, width: 64 }} /> ft</label>
      <label title="Mitte folgt immer der aktuellen GPS-Position dieses Geräts"><input type="checkbox" checked={!!fav.gps} onChange={(e) => onChange({ ...fav, gps: e.target.checked })} /> GPS LIVE</label>
      <button onClick={onDelete} style={{ ...BTN, color: '#ff8866', borderColor: '#553322' }}>LÖSCHEN</button>
    </div>
  );
}

// ── GPS LIVE: Favorit folgt der Position des Geräts ──────────────────────────
const GPS_MIN_MOVE_NM = 0.03; // ~50 m: kleinere Sprünge (GPS-Rauschen) ignorieren
function useLivePosition(on: boolean): { lat: number; lng: number; acc: number } | null {
  const [pos, setPos] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  useEffect(() => {
    if (!on || !navigator.geolocation) { setPos(null); return; }
    const id = navigator.geolocation.watchPosition(
      (p) => setPos((old) => (old && distanceNM(old.lat, old.lng, p.coords.latitude, p.coords.longitude) < GPS_MIN_MOVE_NM
        ? old : { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy })),
      () => {},
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [on]);
  return pos;
}

/** Scope mit GPS LIVE: Mitte = aktuelle Position (bis sie da ist: gespeicherte) */
function LiveScope(props: Parameters<typeof Scope>[0]) {
  const pos = useLivePosition(!!props.fav.gps);
  const fav = pos ? { ...props.fav, lat: pos.lat, lng: pos.lng } : props.fav;
  return <Scope {...props} fav={fav} gpsAcc={props.fav.gps ? (pos?.acc ?? null) : undefined} />;
}

// ── Teilen: Favorit als Link (?fav=lat,lon,Radius,Höhe von,Höhe bis,Name) ──
export function favFromUrl(search: string): Favorite | null {
  const v = new URLSearchParams(search).get('fav');
  if (!v) return null;
  const [lat, lng, r, lo, hi, ...name] = v.split(',');
  const n = [lat, lng, r, lo, hi].map(Number);
  if (n.some((x) => !Number.isFinite(x)) || Math.abs(n[0]) > 90 || Math.abs(n[1]) > 180) return null;
  return {
    id: 'shared', name: name.join(',').slice(0, 24) || 'Geteilt', lat: n[0], lng: n[1],
    radiusNm: Math.min(MAX_RADIUS, Math.max(2, Math.round(n[2]))), altMin: Math.max(0, n[3]), altMax: Math.min(60000, n[4]),
  };
}

function favUrl(f: Favorite): string {
  const v = [f.lat.toFixed(5), f.lng.toFixed(5), f.radiusNm, f.altMin, f.altMax, f.name].join(',');
  return `${location.origin}${import.meta.env.BASE_URL}?fav=${encodeURIComponent(v)}`;
}

// ── Gesamtansicht ─────────────────────────────────────────────────────────────
export function FavRadar({ onClose, isMobile, shared: sharedIn }: { onClose: () => void; isMobile: boolean; shared?: Favorite | null }) {
  const [favs, setFavs] = useState<Favorite[]>(loadFavs);
  const [prefs, setPrefs] = useState<Prefs>(() => (sharedIn ? { ...loadPrefs(), selected: 'shared', layout: 'single' } : loadPrefs()));
  // Geteilter Favorit aus dem Link: nur angezeigt, bis er gespeichert wird
  const [shared, setShared] = useState<Favorite | null>(sharedIn ?? null);
  const [gpsMsg, setGpsMsg] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [alphaMenu, setAlphaMenu] = useState<'vector' | 'trail' | null>(null);
  useEffect(() => save(FAV_KEY, favs), [favs]);
  useEffect(() => save(PREF_KEY, prefs), [prefs]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const current: Favorite | null = (prefs.selected === 'shared' ? shared : null) ?? favs.find((f) => f.id === prefs.selected) ?? favs[0] ?? shared;
  const setPref = (p: Partial<Prefs>) => setPrefs((o) => ({ ...o, ...p }));
  const update = (f: Favorite) => (f.id === 'shared' ? setShared(f) : setFavs((list) => list.map((x) => (x.id === f.id ? f : x))));
  const saveShared = () => {
    if (!shared) return;
    const f = { ...shared, id: Date.now().toString(36) };
    setFavs((l) => [...l, f]);
    setShared(null);
    setPref({ selected: f.id });
  };
  const share = async (f: Favorite) => {
    const url = favUrl(f);
    try {
      if (navigator.share) { await navigator.share({ title: `Radar ${f.name}`, url }); return; }
    } catch (e) { if ((e as Error).name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(url); setGpsMsg('Link kopiert'); } catch { window.prompt('Link zum Radar:', url); }
  };
  const add = (lat: number, lng: number, gps = false) => {
    const f: Favorite = { id: Date.now().toString(36), name: gps ? 'Mein Standort' : `Favorit ${favs.length + 1}`, lat, lng, radiusNm: 25, altMin: 0, altMax: 45000, ...(gps ? { gps: true } : {}) };
    setFavs((l) => [...l, f]);
    setPref({ selected: f.id, layout: 'single' });
    setEdit(true);
  };
  const addGps = () => {
    if (!navigator.geolocation) { setGpsMsg('GPS nicht verfügbar'); return; }
    setGpsMsg('GPS sucht…');
    navigator.geolocation.getCurrentPosition(
      (pos) => { setGpsMsg(`GPS ±${Math.round(pos.coords.accuracy)} m`); add(pos.coords.latitude, pos.coords.longitude, true); },
      (err) => setGpsMsg(err.code === err.PERMISSION_DENIED ? 'GPS nicht erlaubt' : 'Standort nicht gefunden'),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  const addCoords = () => {
    const t = window.prompt('Koordinaten (z. B. 50.0379, 8.5622 aus Google Maps):');
    if (!t) return;
    const c = parseCoords(t);
    if (c) add(c.lat, c.lng); else setGpsMsg('Koordinaten nicht erkannt');
  };
  const remove = (id: string) => {
    if (!window.confirm('Favorit löschen?')) return;
    setFavs((l) => l.filter((f) => f.id !== id));
    setPref({ selected: null });
  };

  const grid = prefs.layout === 'grid' && favs.length > 1;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 70, background: '#010603', overflowY: 'auto', fontFamily: '"Courier New", monospace', color: C.text, padding: isMobile ? 8 : 14, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ color: '#00cc66', fontWeight: 'bold', fontSize: 13, marginRight: 6 }}>★ FAVORITEN-RADAR</span>
        <button onClick={addGps} style={BTN} title="Aktuelle Position des Geräts als Favorit">+ GPS</button>
        <button onClick={addCoords} style={BTN} title="Favorit aus Koordinaten">+ KOORD</button>
        {favs.length > 1 && (['single', 'grid'] as const).map((l) => (
          <button key={l} onClick={() => setPref({ layout: l })} style={{ ...BTN, ...(prefs.layout === l ? ACTIVE : {}) }}>{l === 'single' ? 'EINZELN' : 'ALLE'}</button>
        ))}
        <button onClick={() => setPref({ ga: !prefs.ga })} style={{ ...BTN, ...(prefs.ga ? ACTIVE : {}) }} title="Kleinflieger, Hubschrauber, Segler zeigen">GA</button>
        <AlphaToggle label="VEKTOR" title="Geschwindigkeitsvektor: Strich bis zur Position in 1 Minute (Rechtsklick: Deckkraft)"
          on={prefs.vector} alpha={prefs.vectorAlpha} open={alphaMenu === 'vector'} onOpen={(o) => setAlphaMenu(o ? 'vector' : null)}
          onToggle={(on) => setPref({ vector: on })} onAlpha={(a) => setPref({ vectorAlpha: a })} />
        <AlphaToggle label="BAHN" title="Flugbahn des gewählten Flugs seit dem Start (Rechtsklick: Deckkraft)"
          on={prefs.trail} alpha={prefs.trailAlpha} open={alphaMenu === 'trail'} onOpen={(o) => setAlphaMenu(o ? 'trail' : null)}
          onToggle={(on) => setPref({ trail: on })} onAlpha={(a) => setPref({ trailAlpha: a })} />
        <button onClick={() => setPref({ hear: !prefs.hear })} style={{ ...BTN, ...(prefs.hear ? { ...ACTIVE, color: C.hear, borderColor: '#aa8844' } : {}) }} title="Schätzen, welchen Flieger man am Favoriten gerade hört (Wind, Höhe, Tempo)">♪ HÖREN</button>
        {current && !grid && <button onClick={() => setEdit((e) => !e)} style={{ ...BTN, ...(edit ? ACTIVE : {}) }}>EINSTELLEN</button>}
        {current && !grid && <button onClick={() => void share(current)} style={BTN} title="Link zu diesem Radar teilen oder kopieren">TEILEN</button>}
        {current?.id === 'shared' && <button onClick={saveShared} style={{ ...BTN, color: '#ff9ed8', borderColor: '#aa4488' }} title="Geteilten Favoriten in diesem Browser speichern">★ SPEICHERN</button>}
        {gpsMsg && <span style={{ fontSize: 10, color: gpsMsg.startsWith('GPS ±') || gpsMsg === 'Link kopiert' ? '#7fa88c' : '#ffaa00' }}>{gpsMsg}</span>}
        <button onClick={onClose} style={{ ...BTN, marginLeft: 'auto' }} title="Zurück (Esc)">✕</button>
      </div>

      {favs.length + (shared ? 1 : 0) > 1 && !grid && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {[...favs, ...(shared ? [shared] : [])].map((f) => (
            <button key={f.id} onClick={() => setPref({ selected: f.id })} style={{ ...BTN, ...(current?.id === f.id ? { ...ACTIVE, color: '#ff9ed8', borderColor: '#aa4488' } : {}) }}>{f.id === 'shared' ? '↗' : '★'} {f.name}</button>
          ))}
        </div>
      )}

      {current && !grid && edit && <div style={{ marginBottom: 8 }}><Editor fav={current} onChange={update} onDelete={() => remove(current.id)} /></div>}

      {favs.length === 0 && !shared && (
        <div style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 560 }}>
          Noch keine Favoriten. <b>+ GPS</b> speichert die aktuelle Position dieses Geräts, <b>+ KOORD</b> einen beliebigen Ort
          (Koordinaten z. B. per Rechtsklick in Google Maps kopieren). Für jeden Favoriten gibt es ein rundes Radarbild, Nord oben,
          mit einstellbarem Umkreis und Höhenband. Die Favoriten bleiben in diesem Browser gespeichert.
        </div>
      )}

      {grid ? (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${isMobile ? 260 : 340}px, 1fr))`, gap: 14 }}>
          {favs.map((f) => (
            <LiveScope key={f.id} fav={f} ga={prefs.ga} hear={prefs.hear} vector={prefs.vector} vectorAlpha={prefs.vectorAlpha} trail={prefs.trail} trailAlpha={prefs.trailAlpha} pollMs={10_000} compact onSelectFav={() => setPref({ selected: f.id, layout: 'single' })} />
          ))}
        </div>
      ) : current && <LiveScope key={current.id} fav={current} ga={prefs.ga} hear={prefs.hear} vector={prefs.vector} vectorAlpha={prefs.vectorAlpha} trail={prefs.trail} trailAlpha={prefs.trailAlpha} pollMs={5000} compact={false} />}

      <div style={{ fontSize: 10, color: '#3a6a4a', marginTop: 10 }}>
        Bahnen: OurAirports · Datenblock: Rufzeichen / Höhe in 100 ft, Trend, Geschwindigkeit in 10 kt / Typ · VEKTOR = Strich bis zur Position in 1 min · Symbole in echter Größe und Triebwerkszahl ·
        <span style={{ color: C.airline }}> Linie</span> · <span style={{ color: C.ga }}>GA</span> · <span style={{ color: C.emerg }}>Notfall-Squawk</span> ·
        Daten: <a href="https://adsb.lol" target="_blank" rel="noreferrer" style={{ color: '#4f8a60' }}>adsb.lol</a> (ODbL)
      </div>
    </div>
  );
}

/** Schalter mit Deckkraft-Regler per Rechtsklick (am Handy langes Drücken) */
function AlphaToggle({ label, title, on, alpha, open, onOpen, onToggle, onAlpha }: {
  label: string; title: string; on: boolean; alpha: number; open: boolean;
  onOpen: (open: boolean) => void; onToggle: (on: boolean) => void; onAlpha: (a: number) => void;
}) {
  return (
    <span style={{ position: 'relative' }}>
      <button onClick={() => onToggle(!on)}
        onContextMenu={(e) => { e.preventDefault(); onToggle(true); onOpen(!open); }}
        style={{ ...BTN, ...(on ? ACTIVE : {}) }} title={title}>{label}</button>
      {open && on && (
        <div onMouseLeave={() => onOpen(false)} style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 5, background: '#06140c', border: '1px solid #1a4428', padding: '6px 8px', fontSize: 11, color: C.text, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
          DECKKRAFT
          <input type="range" min={10} max={100} step={5} value={Math.round(alpha * 100)}
            onChange={(e) => onAlpha(Number(e.target.value) / 100)} style={{ width: 110 }} />
          <span style={{ width: 34, textAlign: 'right' }}>{Math.round(alpha * 100)} %</span>
          <span onClick={() => onOpen(false)} style={{ cursor: 'pointer', color: '#4f8a60' }}>✕</span>
        </div>
      )}
    </span>
  );
}

const BTN: CSSProperties = {
  background: 'transparent', border: '1px solid #1a4428', color: '#00cc66',
  fontFamily: '"Courier New", monospace', fontSize: 11, padding: '3px 8px', cursor: 'pointer', borderRadius: 2,
};
const ACTIVE: CSSProperties = { background: '#0a3020', borderColor: '#00cc66', color: '#00ff88' };
const INPUT: CSSProperties = {
  background: '#06140c', border: '1px solid #1a4428', color: '#cde', fontFamily: '"Courier New", monospace', fontSize: 11, padding: '2px 4px',
};
