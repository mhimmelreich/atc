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

/** Position jetzt, aus der letzten Meldung mit Kurs und Geschwindigkeit weitergerechnet (höchstens 30 s) */
function posNow(a: LiveAircraft, now: number): { lat: number; lng: number } {
  if (a.ground || a.gs === null || a.track === null) return a;
  const dt = Math.min(30, Math.max(0, (now - a.ts) / 1000));
  return destinationPoint(a.lat, a.lng, a.track, (a.gs * dt) / 3600);
}

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
function Scope({ fav, ga, hear, vector, vectorAlpha, trail, trailAlpha, pollMs, compact, onSelectFav }: {
  fav: Favorite; ga: boolean; hear: boolean; vector: boolean; vectorAlpha: number; trail: boolean; trailAlpha: number; pollMs: number; compact: boolean; onSelectFav?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(300);
  const [traffic, setTraffic] = useState<LiveAircraft[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [selHex, setSelHex] = useState<string | null>(null);
  // Flugbahn des gewählten Flugs seit dem Start (adsb.lol-Trace), alle 30 s erneuert
  const [trace, setTrace] = useState<TracePoint[]>([]);
  useEffect(() => {
    setTrace([]);
    if (!trail || !selHex) return;
    let alive = true;
    const load = () => fetchTrace(selHex).then((t) => { if (alive) setTrace(t); }).catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [trail, selHex]);
  const [, tick] = useState(0);
  const [fields, setFields] = useState<AreaAirport[]>([]);
  useEffect(() => {
    let alive = true;
    fetchAreaAirports(fav.lat, fav.lng, Math.max(fav.radiusNm, 30)).then((a) => { if (alive) setFields(a); }).catch(() => { if (alive) setFields([]); });
    return () => { alive = false; };
  }, [fav.lat, fav.lng, fav.radiusNm]);
  const history = useRef(new Map<string, Array<{ lat: number; lng: number }>>());
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
    history.current.clear();
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

  // Ziele jede Sekunde weiterrechnen
  // HÖREN: das wahrscheinlich hörbare Ziel pulsiert, dafür flüssiger zeichnen
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), hear ? 66 : 1000); return () => clearInterval(id); }, [hear]);

  // Wind und QNH vom nächsten großen oder mittleren Platz (METAR), Bodenhöhe vom nächsten Platz
  const near = (kinds: string) => fields.filter((f) => kinds.includes(f.kind))
    .map((f) => ({ f, d: distanceNM(fav.lat, fav.lng, f.lat, f.lng) })).sort((x, y) => x.d - y.d)[0]?.f;
  const metarField = near('LM');
  const groundField = near('LMS');
  const [wx, setWx] = useState<Weather | null>(null);
  useEffect(() => {
    if (!hear || !metarField) { setWx(null); return; }
    let alive = true;
    const load = () => fetchWeather(metarField.ident).then((w) => { if (alive) setWx(w); });
    load();
    const id = setInterval(load, WEATHER_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [hear, metarField?.ident]);

  const now = Date.now();
  const visible = traffic
    .filter((a) => (ga || !isGa(a)) && inBand(a, fav))
    .map((a) => { const p = posNow(a, now); return { a, p, dist: distanceNM(fav.lat, fav.lng, p.lat, p.lng) }; })
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
      const nx = 14, ny = compact ? 34 : 38;
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
        {/* oben links: Name (Nordpfeil darunter im Bild) */}
        <div style={corner({ left: 0, top: 0 })}>
          <span style={{ color: '#ff9ed8', fontWeight: 'bold', cursor: onSelectFav ? 'pointer' : undefined }} onClick={onSelectFav}>★ {fav.name}</span>
        </div>
        {/* oben rechts: Stand */}
        <div style={corner({ right: 0, top: 0, textAlign: 'right' })}>
          <div style={{ color: C.airline }}>{visible.length} AC</div>
          <div>{fav.radiusNm} NM · {fav.altMin}–{fav.altMax} ft</div>
          <div style={{ color: error ? '#ffaa00' : C.text }}>{error ? 'keine Daten' : age === null ? 'lädt…' : `vor ${age} s`}</div>
        </div>
        {/* unten links: Hören */}
        {hear && (
          <div style={corner({ left: 0, bottom: 0 })}>
            <HearPanel heard={heard} traffic={traffic} visible={new Set(visible.map((v) => v.a.hex))} wx={wx} field={metarField?.ident} compact={compact} onSelect={setSelHex} />
          </div>
        )}
        {/* unten rechts: gewählter Flieger, sonst die nächsten */}
        <div style={corner({ right: 0, bottom: 0, textAlign: 'right' })}>
          {selected ? <Details v={selected} fav={fav} onClose={() => setSelHex(null)} /> : !compact && visible.slice(0, 6).map(({ a, dist }) => (
            <div key={a.hex} onClick={() => setSelHex(a.hex)} style={{ cursor: 'pointer', color: isGa(a) ? C.ga : C.airline, whiteSpace: 'nowrap' }}>
              {a.callsign} {altText(a)} {dist.toFixed(1)} NM {String(Math.round(bearingBetween(fav.lat, fav.lng, a.lat, a.lng))).padStart(3, '0')}°
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HearPanel({ heard, traffic, visible, wx, field, compact, onSelect }: {
  heard: HearResult[]; traffic: LiveAircraft[]; visible: Set<string>; wx: Weather | null; field?: string; compact: boolean; onSelect: (hex: string) => void;
}) {
  const byHex = new Map(traffic.map((a) => [a.hex, a]));
  const top = heard.filter((h) => h.dba >= AUDIBLE_DBA).slice(0, compact ? 1 : 3);
  const wind = !wx ? 'Wind ?' : wx.windDir === null ? `Wind VRB/${wx.windKt} kt` : `Wind ${String(wx.windDir).padStart(3, '0')}°/${wx.windKt} kt`;
  return (
    <>
      <div style={{ color: C.hear }}>♪ HÖREN · {wind}{wx && field ? ` ${field}` : ''}</div>
      {top.length === 0 && <div>kein Flieger hörbar (&lt;{AUDIBLE_DBA} dB(A))</div>}
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

function Details({ v, fav, onClose }: { v: { a: LiveAircraft; p: { lat: number; lng: number }; dist: number }; fav: Favorite; onClose: () => void }) {
  const { a, p, dist } = v;
  const airline = airlineName(a.callsign);
  const row = (k: string, val: string | null | undefined) => val ? <div><span style={{ color: '#4f8a60' }}>{k} </span>{val}</div> : null;
  return (
    <div style={{ color: '#cde' }}>
      <div style={{ color: C.sel, fontWeight: 'bold' }}>
        {a.callsign}{airline && <span style={{ color: '#9fc8e0', fontWeight: 'normal' }}> · {airline}</span>}
        <span onClick={onClose} style={{ cursor: 'pointer', color: '#4f8a60', marginLeft: 6 }} title="Schließen">✕</span>
      </div>
      {row('ROUTE', a.route?.replace(/-/g, ' → '))}
      {row('TYP', [a.type, a.category ? CATEGORY[a.category] ?? a.category : null].filter(Boolean).join(' · '))}
      {row('KENNZ.', a.reg)}
      {row('HÖHE', `${altText(a)}${a.vs !== null && Math.abs(a.vs) >= 100 ? ` ${a.vs > 0 ? '↑' : '↓'}${Math.abs(Math.round(a.vs / 100) * 100)} ft/min` : ''}`)}
      {row('GEWÄHLT', a.selAltFt ? `${a.selAltFt} ft` : null)}
      {row('GS/KURS', `${a.gs ?? '–'} kt · ${a.track !== null ? String(Math.round(a.track)).padStart(3, '0') + '°' : '–'}`)}
      {row('SQUAWK', a.squawk ? `${a.squawk}${EMERGENCY[a.squawk] ? ` (${EMERGENCY[a.squawk]})` : ''}` : null)}
      {row('VON ★', `${dist.toFixed(1)} NM · ${String(Math.round(bearingBetween(fav.lat, fav.lng, p.lat, p.lng))).padStart(3, '0')}°`)}
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
      <button onClick={onDelete} style={{ ...BTN, color: '#ff8866', borderColor: '#553322' }}>LÖSCHEN</button>
    </div>
  );
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
  const add = (lat: number, lng: number) => {
    const f: Favorite = { id: Date.now().toString(36), name: `Favorit ${favs.length + 1}`, lat, lng, radiusNm: 25, altMin: 0, altMax: 45000 };
    setFavs((l) => [...l, f]);
    setPref({ selected: f.id, layout: 'single' });
    setEdit(true);
  };
  const addGps = () => {
    if (!navigator.geolocation) { setGpsMsg('GPS nicht verfügbar'); return; }
    setGpsMsg('GPS sucht…');
    navigator.geolocation.getCurrentPosition(
      (pos) => { setGpsMsg(`GPS ±${Math.round(pos.coords.accuracy)} m`); add(pos.coords.latitude, pos.coords.longitude); },
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
            <Scope key={f.id} fav={f} ga={prefs.ga} hear={prefs.hear} vector={prefs.vector} vectorAlpha={prefs.vectorAlpha} trail={prefs.trail} trailAlpha={prefs.trailAlpha} pollMs={10_000} compact onSelectFav={() => setPref({ selected: f.id, layout: 'single' })} />
          ))}
        </div>
      ) : current && <Scope key={current.id} fav={current} ga={prefs.ga} hear={prefs.hear} vector={prefs.vector} vectorAlpha={prefs.vectorAlpha} trail={prefs.trail} trailAlpha={prefs.trailAlpha} pollMs={5000} compact={false} />}

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
