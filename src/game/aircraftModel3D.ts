// filepath: src/game/aircraftModel3D.ts
// Kleine 3D-Flugzeugmodelle für die 3D-Ansicht: Rumpf, Flügel, Leitwerk und 2 oder 4 Triebwerke,
// Größe nach Typ (Regional, Mittelstrecke, Großraum, A380). Maße in Metern, grob nach dem Vorbild;
// gezeichnet wird in fester Bildschirmgröße je Klasse, sonst wären sie im Radarmaßstab unsichtbar.

export type ModelClass = 'small' | 'medium' | 'heavy' | 'super';

export interface ModelShape {
  cls: ModelClass;
  engines: 2 | 4;
  /** Triebwerke hinten am Rumpf (CRJ, Embraer 135/145, MD-80, B717), dann T-Leitwerk */
  rearEngines: boolean;
  /** Propeller-Turboprop mit Schulterdecker-Flügel (ATR, Dash 8) */
  turboprop: boolean;
  length: number;
  span: number;
}

const FOUR = /^(A34\w|A38\w|B74\w|A124|A225|IL96|IL76|C17|A400|B46\w|RJ\d\w|K35R|E3TF|VC10)$/;
const HEAVY = /^(A30\w|A310|A33\w|A34\w|A35\w|B74\w|B76\w|B77\w|B78\w|MD11|DC10|IL96|IL76|A124|A225|C17|A400|KC10|K35R|B52)$/;
const SMALL = /^(CRJ\w|E1[3-9]\d|E2[89]\d|E75\w|E17\w|DH8\w|AT[4-7]\w|SF34|D328|J328|F50|F70|F100|JS41|B190|BCS\d|B46\w|RJ\d\w|SB20|AT[4-7])$/;
const REAR = /^(CRJ\w|E135|E145|E35L|MD8\w|MD9\w|B712|F70|F100|GLF\w|GL\d\w|CL\d\d|DC9\w)$/;
const PROP = /^(DH8\w|AT[4-7]\w|SF34|D328|F50|JS41|B190|SB20|A400|C130|Q400)$/;

/** Form nach ICAO-Typ (unbekannt: Mittelstrecke mit 2 Triebwerken) */
export function modelShape(type?: string): ModelShape {
  const t = (type ?? '').toUpperCase();
  const engines = FOUR.test(t) ? 4 : 2;
  const cls: ModelClass = /^A38\w$/.test(t) ? 'super' : HEAVY.test(t) ? 'heavy' : SMALL.test(t) ? 'small' : 'medium';
  const dims = { small: [30, 27], medium: [38, 35], heavy: [64, 61], super: [73, 80] }[cls];
  return { cls, engines, rearEngines: REAR.test(t), turboprop: PROP.test(t), length: dims[0], span: dims[1] };
}

/** Spannweite im Bild (px) je Klasse */
export const SCREEN_SPAN_PX: Record<ModelClass, number> = { small: 15, medium: 18, heavy: 24, super: 28 };

/** Fläche des Modells: Punkte in Metern als [vor, rechts, oben] (Bug zeigt nach vorn) */
export type Face = Array<[number, number, number]>;

const cache = new Map<string, Face[]>();

/** Flächen des Modells (zwischengespeichert je Form) */
export function modelFaces(s: ModelShape): Face[] {
  const key = `${s.cls}${s.engines}${s.rearEngines}${s.turboprop}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const L = s.length, S = s.span;
  const D = L * 0.11;            // Rumpfdurchmesser, etwas dicker als echt, damit er klein noch wirkt
  const r = D / 2;
  const faces: Face[] = [];

  // Rumpf: Rauten-Querschnitt (oben, rechts, unten, links), Bugspitze vorn, Heck oben auslaufend
  const ring = (f: number, k: number, du = 0): Face => [[f, 0, r * k + du], [f, r * k, du], [f, 0, -r * k + du], [f, -r * k, du]];
  const nose: [number, number, number] = [L / 2, 0, -r * 0.15];
  const tail: [number, number, number] = [-L / 2, 0, r * 0.55];
  const a = ring(L * 0.34, 1), b = ring(-L * 0.28, 1), c = ring(-L * 0.42, 0.55, r * 0.35);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    faces.push([nose, a[i], a[j]]);
    faces.push([a[i], b[i], b[j], a[j]]);
    faces.push([b[i], c[i], c[j], b[j]]);
    faces.push([c[i], tail, c[j]]);
  }

  // Flügel: Tiefdecker mit Pfeilung, Turboprop als gerader Schulterdecker
  const wu = s.turboprop ? r * 0.85 : -r * 0.35;
  const sweep = s.turboprop ? L * 0.02 : L * 0.17;
  const rootLE = L * 0.12, rootTE = -L * 0.08, tipChord = (rootLE - rootTE) * (s.turboprop ? 0.6 : 0.3);
  const tipLE = rootLE - sweep;
  for (const side of [1, -1]) {
    faces.push([[rootLE, side * r, wu], [tipLE, side * S / 2, wu + S * 0.02], [tipLE - tipChord, side * S / 2, wu + S * 0.02], [rootTE, side * r, wu]]);
  }

  // Leitwerk: Höhenruder (beim Heckantrieb oben als T-Leitwerk) und Seitenruder
  const finH = S * (s.cls === 'small' ? 0.2 : 0.16);
  const htU = s.rearEngines ? r * 0.35 + finH : r * 0.4;
  const htSpan = S * 0.19;
  for (const side of [1, -1]) {
    faces.push([[-L * 0.36, side * r * 0.4, htU], [-L * 0.45, side * htSpan, htU], [-L * 0.49, side * htSpan, htU], [-L * 0.46, side * r * 0.4, htU]]);
  }
  faces.push([[-L * 0.3, 0, r * 0.6], [-L * 0.42, 0, r * 0.35 + finH], [-L * 0.49, 0, r * 0.35 + finH], [-L * 0.5, 0, r * 0.55]]);

  // Triebwerke: kleine Gondeln (Rauten-Prisma mit Einlauf vorn)
  const nacR = s.turboprop ? D * 0.26 : D * (s.cls === 'heavy' || s.cls === 'super' ? 0.42 : 0.36);
  const nacL = L * (s.turboprop ? 0.13 : 0.11);
  const nacelle = (f: number, rr: number, u: number) => {
    const front = [[f, rr, u + nacR], [f, rr + nacR, u], [f, rr, u - nacR], [f, rr - nacR, u]] as Face;
    const back = front.map(([, y, z]) => [f - nacL, (y - rr) * 0.75 + rr, (z - u) * 0.75 + u] as [number, number, number]);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; faces.push([front[i], back[i], back[j], front[j]]); }
    faces.push(front);
  };
  if (s.rearEngines) {
    for (const side of [1, -1]) nacelle(-L * 0.25, side * (r + nacR * 1.1), r * 0.3);
  } else {
    const spots = s.engines === 4 ? [0.25, 0.42] : [s.turboprop ? 0.24 : 0.32];
    for (const k of spots) {
      for (const side of [1, -1]) {
        const y = side * k * S;
        const le = rootLE - sweep * ((Math.abs(y) - r) / (S / 2 - r)); // Flügelvorderkante an dieser Stelle
        nacelle(le + nacL * (s.turboprop ? 0.55 : 0.6), y, s.turboprop ? wu - nacR * 0.2 : wu - nacR * 1.05);
      }
    }
  }
  cache.set(key, faces);
  return faces;
}
