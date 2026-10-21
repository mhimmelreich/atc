// filepath: server/nat.ts
// Nordatlantik-Tracks (NAT OTS) aus den NAT-Track-Meldungen, die die FAA frei veröffentlicht
// (nms.aim.faa.gov, Daten der US-Regierung). Damit wird die Lücke in den ADS-B-Spuren über dem
// Atlantik geschätzt: Dort gibt es keine Empfänger, die Flüge melden ihre Position über ADS-C/CPDLC
// an den Track-Punkten (alle 10° Länge). Die Tracks gelten nur ein paar Stunden und werden neu
// veröffentlicht, deshalb sammelt der Server sie und hebt sie einige Tage auf.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NAT_URL = 'https://nms.aim.faa.gov/datanat/nat.json';
const USER_AGENT = 'atc-game (games.himmelreich.cloud)';
const DATA_DIR = process.env.NAT_DIR ?? 'data/nat';
const FILE = join(DATA_DIR, 'tracks.json');
const POLL_MS = 30 * 60_000;
const KEEP_MS = 4 * 24 * 3600_000;

export interface NatTrack {
  /** Track-Buchstabe, z. B. "T" */
  id: string;
  /** Gültig von / bis (ms) */
  from: number;
  to: number;
  east: boolean;
  west: boolean;
  /** Ozean-Punkte in Flugrichtung des Meldungstexts (West nach Ost bzw. Ost nach West) */
  points: Array<[number, number]>;
}

let tracks: NatTrack[] = [];

function load(): void {
  try { tracks = JSON.parse(readFileSync(FILE, 'utf8')) as NatTrack[]; } catch { tracks = []; }
}

function save(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(tracks));
  } catch (err) {
    console.error('nat: speichern', (err as Error).message);
  }
}

/** "52/50" = 52°N 50°W, "5030/50" = 52°30'N 50°W; Westlänge ist negativ */
function parseCoord(tok: string): [number, number] | null {
  const m = /^(\d{2})(\d{2})?\/(\d{2,3})$/.exec(tok);
  if (!m) return null;
  return [Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0), -Number(m[3])];
}

/** Track-Zeilen aus einem Meldungstext: "T TUDEP 52/50 55/40 56/30 57/20 SUNOT KESIX" + "EAST LVLS …" */
export function parseNatMessage(text: string, from: number, to: number): NatTrack[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: NatTrack[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Z]) (.+)$/.exec(lines[i]);
    if (!m) continue;
    const points = m[2].split(' ').map(parseCoord).filter((p): p is [number, number] => p !== null);
    if (points.length < 2) continue;
    const east = /^EAST LVLS (?!NIL)/.test(lines[i + 1] ?? '');
    const west = /^WEST LVLS (?!NIL)/.test(lines[i + 2] ?? '');
    out.push({ id: m[1], from, to, east, west, points });
  }
  return out;
}

async function poll(): Promise<void> {
  try {
    const res = await fetch(NAT_URL, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const msgs = await res.json() as Array<{ condition_message?: string; start_datetime?: string; end_datetime?: string; transaction_type?: string }>;
    const fresh: NatTrack[] = [];
    for (const msg of msgs) {
      if (msg.transaction_type !== 'NAT_TRACK' || !msg.condition_message) continue;
      const from = Date.parse(msg.start_datetime ?? '');
      const to = Date.parse(msg.end_datetime ?? '');
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      fresh.push(...parseNatMessage(msg.condition_message, from, to));
    }
    const key = (t: NatTrack) => `${t.id}@${t.from}`;
    const known = new Map(tracks.map((t) => [key(t), t]));
    for (const t of fresh) known.set(key(t), t); // Änderungen derselben Ausgabe überschreiben
    const now = Date.now();
    tracks = [...known.values()].filter((t) => now - t.to < KEEP_MS).sort((a, b) => a.from - b.from);
    save();
  } catch (err) {
    console.error('nat:', (err as Error).message);
  }
}

export function startNatPolling(): void {
  load();
  void poll();
  setInterval(() => void poll(), POLL_MS).unref();
}

// ── Lücke in einer Spur füllen ──────────────────────────────────────────────

const R_NM = 3440.065;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function distNM(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Punkt auf dem Großkreis zwischen a und b, f = 0…1 */
function gcPoint(a: [number, number], b: [number, number], f: number): [number, number] {
  const d = distNM(a, b) / R_NM;
  if (d < 1e-9) return a;
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const [la1, lo1, la2, lo2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
  const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
  const z = A * Math.sin(la1) + B * Math.sin(la2);
  return [deg(Math.atan2(z, Math.hypot(x, y))), deg(Math.atan2(y, x))];
}

function pathLength(pts: Array<[number, number]>): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += distNM(pts[i - 1], pts[i]);
  return s;
}

/** [lat, lng, altFt, ts, geschätzt?] */
export type GapPoint = [number, number, number | null, number, 1];

const GAP_MIN_S = 20 * 60;   // kürzere Lücken bleiben eine gerade Linie
const GAP_MIN_NM = 300;
const MAX_DETOUR = 1.08;     // Track darf höchstens so viel länger sein als der Großkreis
const GC_STEP_NM = 120;

/**
 * Wegpunkte für eine Lücke zwischen zwei echten Punkten: über einen passenden NAT-Track
 * (gültig zur Zeit der Lücke, richtige Richtung, kaum Umweg), sonst entlang des Großkreises.
 * Zeiten gleichmäßig nach Strecke, Höhe gleitend zwischen beiden Enden. Leer, wenn keine Lücke.
 */
export function fillGap(a: [number, number, number | null, number], b: [number, number, number | null, number]): GapPoint[] {
  const dt = (b[3] - a[3]) / 1000;
  const A: [number, number] = [a[0], a[1]], B: [number, number] = [b[0], b[1]];
  const direct = distNM(A, B);
  if (dt < GAP_MIN_S || direct < GAP_MIN_NM) return [];

  const eastbound = b[1] > a[1];
  const minLng = Math.min(a[1], b[1]), maxLng = Math.max(a[1], b[1]);
  let best: { len: number; pts: Array<[number, number]> } | null = null;
  for (const t of tracks) {
    if (t.to < a[3] || t.from > b[3]) continue;
    if (eastbound ? !t.east : !t.west) continue;
    const inside = t.points.filter((p) => p[1] > minLng && p[1] < maxLng).sort((p, q) => (eastbound ? p[1] - q[1] : q[1] - p[1]));
    if (inside.length < 2) continue;
    const len = pathLength([A, ...inside, B]);
    if (len > direct * MAX_DETOUR) continue;
    if (!best || len < best.len) best = { len, pts: inside };
  }

  // Stützpunkte: Track-Punkte, dazwischen Großkreis-Zwischenpunkte, damit die Linie auch in der
  // Karte (Mercator) wie ein Flugweg aussieht
  const corners: Array<[number, number]> = [A, ...(best?.pts ?? []), B];
  const pts: Array<[number, number]> = [];
  for (let i = 1; i < corners.length; i++) {
    const n = Math.max(1, Math.round(distNM(corners[i - 1], corners[i]) / GC_STEP_NM));
    for (let k = i === 1 ? 1 : 0; k < n; k++) pts.push(gcPoint(corners[i - 1], corners[i], k / n));
    if (i < corners.length - 1) pts.push(corners[i]);
  }
  const unique = pts.filter((p, i) => i === 0 || distNM(p, pts[i - 1]) > 1);
  const total = pathLength([A, ...unique, B]);
  let run = 0, prev = A;
  return unique.map((p) => {
    run += distNM(prev, p); prev = p;
    const f = run / total;
    const alt = a[2] !== null && b[2] !== null ? Math.round((a[2] + (b[2] - a[2]) * f) / 100) * 100 : a[2] ?? b[2];
    return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5, alt, Math.round(a[3] + (b[3] - a[3]) * f), 1];
  });
}
