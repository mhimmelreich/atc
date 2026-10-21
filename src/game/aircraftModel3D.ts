// filepath: src/game/aircraftModel3D.ts
// Kleine 3D-Flugzeugmodelle für die 3D-Ansicht: runder Rumpf mit Cockpitfenstern, gepfeilte Flügel mit
// Knick, V-Stellung und Winglets, runde Triebwerksgondeln mit Pylon, Leitwerk. Maße in Metern nach
// dem echten Typ; gezeichnet wird mit festem Bildmaßstab (px je Meter), damit die Größen zueinander
// stimmen, im Radarmaßstab wären sie sonst unsichtbar.

export type ModelClass = 'small' | 'medium' | 'heavy' | 'super';

export interface ModelShape {
  cls: ModelClass;
  engines: 2 | 4;
  /** Triebwerke hinten am Rumpf (CRJ, Embraer 135/145, MD-80, Businessjets), dann T-Leitwerk */
  rearEngines: boolean;
  /** Propeller-Turboprop mit Schulterdecker-Flügel (ATR, Dash 8) */
  turboprop: boolean;
  /** Oberdeck: vorn wie B747, durchgehend wie A380 */
  upperDeck?: 'hump' | 'full';
  /** Winglets (Sharklets, Blended); 787, 777, 747-8 haben keine (gebogene bzw. Raked Tips) */
  winglets: boolean;
  length: number;
  span: number;
  /** Rumpfdurchmesser in m */
  diameter: number;
}

type Dim = [length: number, span: number, diameter: number];
// Echte Abmessungen der häufigsten ICAO-Typen (Länge, Spannweite, Rumpfdurchmesser)
const DIMS: Record<string, Dim> = {
  A318: [31.4, 34.1, 3.95], A319: [33.8, 35.8, 3.95], A320: [37.6, 35.8, 3.95], A321: [44.5, 35.8, 3.95],
  A19N: [33.8, 35.8, 3.95], A20N: [37.6, 35.8, 3.95], A21N: [44.5, 35.8, 3.95],
  B736: [31.2, 34.3, 3.76], B737: [33.6, 35.8, 3.76], B738: [39.5, 35.8, 3.76], B739: [42.1, 35.8, 3.76],
  B37M: [35.6, 35.9, 3.76], B38M: [39.5, 35.9, 3.76], B39M: [42.2, 35.9, 3.76], B3XM: [43.8, 35.9, 3.76],
  B752: [47.3, 38.1, 3.76], B753: [54.4, 38.1, 3.76],
  B762: [48.5, 47.6, 5.03], B763: [54.9, 47.6, 5.03], B764: [61.4, 51.9, 5.03],
  B772: [63.7, 60.9, 6.2], B77L: [63.7, 64.8, 6.2], B773: [73.9, 60.9, 6.2], B77W: [73.9, 64.8, 6.2],
  B778: [70.9, 71.8, 6.2], B779: [76.7, 71.8, 6.2],
  B788: [56.7, 60.1, 5.77], B789: [62.8, 60.1, 5.77], B78X: [68.3, 60.1, 5.77],
  B744: [70.7, 64.4, 6.5], B748: [76.3, 68.4, 6.5], B74F: [70.7, 64.4, 6.5],
  A306: [54.1, 44.8, 5.64], A310: [46.7, 43.9, 5.64],
  A332: [58.8, 60.3, 5.64], A333: [63.7, 60.3, 5.64], A338: [58.8, 64.0, 5.64], A339: [63.7, 64.0, 5.64],
  A342: [59.4, 60.3, 5.64], A343: [63.7, 60.3, 5.64], A345: [67.9, 63.5, 5.64], A346: [75.3, 63.5, 5.64],
  A359: [66.8, 64.8, 5.96], A35K: [73.8, 64.8, 5.96], A388: [72.7, 79.8, 7.14],
  MD11: [61.6, 51.7, 6.0], DC10: [55.5, 50.4, 6.0],
  BCS1: [35.0, 35.1, 3.7], BCS3: [38.7, 35.1, 3.7],
  E170: [29.9, 26.0, 3.0], E175: [31.7, 26.0, 3.0], E190: [36.2, 28.7, 3.0], E195: [38.7, 28.7, 3.0],
  E290: [36.3, 33.7, 3.0], E295: [41.5, 35.1, 3.0], E75L: [31.7, 26.0, 3.0], E75S: [31.7, 26.0, 3.0],
  E135: [26.3, 20.0, 2.28], E145: [29.9, 20.0, 2.28],
  CRJ2: [26.8, 21.2, 2.69], CRJ7: [32.5, 23.2, 2.69], CRJ9: [36.2, 24.9, 2.69], CRJX: [39.1, 26.2, 2.69],
  F70: [30.9, 28.1, 3.3], F100: [35.5, 28.1, 3.3], B712: [37.8, 28.4, 3.34], MD82: [45.1, 32.9, 3.34], MD83: [45.1, 32.9, 3.34],
  AT43: [22.7, 24.6, 2.57], AT45: [22.7, 24.6, 2.57], AT75: [22.7, 24.6, 2.57], AT72: [27.2, 27.1, 2.57], AT76: [27.2, 27.1, 2.57],
  DH8A: [22.3, 25.9, 2.69], DH8C: [25.7, 27.4, 2.69], DH8D: [32.8, 28.4, 2.69], SB20: [27.3, 24.8, 2.4], SF34: [19.7, 21.4, 2.3],
  D328: [21.1, 21.0, 2.4], J328: [21.2, 21.0, 2.4], B190: [17.6, 17.7, 1.8], JS41: [19.3, 18.3, 2.0],
  A124: [69.1, 73.3, 7.3], IL76: [46.6, 50.5, 4.8], C17: [53.0, 51.8, 6.9], A400: [45.1, 42.4, 5.6], C130: [29.8, 40.4, 4.3],
  K35R: [41.5, 39.9, 3.7], B463: [31.0, 26.3, 3.56], RJ85: [28.6, 26.3, 3.56], RJ1H: [31.0, 26.3, 3.56],
  GLF5: [29.4, 28.5, 2.5], GLF6: [30.4, 30.4, 2.6], GLEX: [30.3, 28.7, 2.7], GL7T: [33.8, 31.7, 2.7], CL35: [20.9, 19.5, 2.2],
  CL60: [20.9, 19.6, 2.5], C56X: [16.0, 17.2, 1.7], C68A: [19.4, 22.0, 1.9], C700: [22.3, 21.0, 2.0], E55P: [15.6, 15.3, 1.6],
  F2TH: [20.2, 19.3, 2.4], FA7X: [23.2, 26.2, 2.4], FA8X: [24.5, 26.3, 2.4], LJ45: [17.7, 14.6, 1.6], PC24: [16.9, 17.0, 1.7],
};
const CLASS_DIMS: Record<ModelClass, Dim> = { small: [30, 27, 3.0], medium: [38, 35, 3.9], heavy: [64, 61, 6.0], super: [73, 80, 7.1] };

const FOUR = /^(A34\w|A38\w|B74\w|A124|A225|IL96|IL76|C17|A400|B46\w|RJ\d\w|K35R|E3TF|VC10|C130)$/;
const HEAVY = /^(A30\w|A310|A33\w|A34\w|A35\w|B74\w|B76\w|B77\w|B78\w|MD11|DC10|IL96|IL76|A124|A225|C17|A400|KC10|K35R|B52)$/;
const SMALL = /^(CRJ\w|E1[3-9]\d|E2[89]\d|E75\w|E17\w|DH8\w|AT[4-7]\w|SF34|D328|J328|F50|F70|F100|JS41|B190|BCS\d|B46\w|RJ\d\w|SB20|GLF\w|GLEX|GL\w\w|CL\d\d|C\d\d\w|E55P|F2TH|FA\w\w|LJ\d\d|PC24)$/;
const REAR = /^(CRJ\w|E135|E145|E35L|MD8\w|MD9\w|B712|F70|F100|GLF\w|GLEX|GL\d\w|CL\d\d|DC9\w|C56X|C68A|C700|E55P|F2TH|FA\w\w|LJ\d\d|PC24)$/;
const PROP = /^(DH8\w|AT[4-7]\w|SF34|D328|F50|JS41|B190|SB20|A400|C130|Q400)$/;
const NO_WINGLET = /^(B78\w|B77\w|B748|B764|A30\w|A310|A34\w|DC10|B712|MD8\w|F70|F100|B46\w|RJ\d\w|IL76|C17|C130|A400|K35R|AT\w\w|DH8\w|SF34|SB20|B190|JS41|D328|B736|B752|B753|B762|B763|A318|A319|A320|A321|A124)$/;

/** Form nach ICAO-Typ (unbekannt: Mittelstrecke mit 2 Triebwerken) */
export function modelShape(type?: string): ModelShape {
  const t = (type ?? '').toUpperCase();
  const engines = FOUR.test(t) ? 4 : 2;
  const cls: ModelClass = /^A38\w$/.test(t) ? 'super' : HEAVY.test(t) ? 'heavy' : SMALL.test(t) ? 'small' : 'medium';
  const [length, span, diameter] = DIMS[t] ?? CLASS_DIMS[cls];
  return {
    cls, engines, rearEngines: REAR.test(t), turboprop: PROP.test(t),
    upperDeck: /^A38\w$/.test(t) ? 'full' : /^B74\w$/.test(t) ? 'hump' : undefined,
    winglets: !NO_WINGLET.test(t), length, span, diameter,
  };
}

/** Bildmaßstab der Modelle: px je Meter Spannweite (A320 ≈ 18 px, A380 ≈ 40 px) */
export const MODEL_PX_PER_M = 0.5;
/** Kleinste Spannweite im Bild, damit Kleinflugzeuge nicht verschwinden */
export const MODEL_MIN_SPAN_PX = 8;

export type P3 = [number, number, number]; // [vor, rechts, oben] in Metern, Bug zeigt nach vorn
/** Fläche des Modells; tone < 1 dunkler (Fenster, Einlauf) */
export interface Face { p: P3[]; tone: number }

const cache = new Map<string, Face[]>();

/** Flächen des Modells (zwischengespeichert je Form) */
export function modelFaces(s: ModelShape): Face[] {
  const key = `${s.cls}${s.engines}${s.rearEngines}${s.turboprop}${s.upperDeck}${s.winglets}${s.length}${s.span}${s.diameter}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const L = s.length, S = s.span;
  const r = (s.diameter / 2) * 1.15; // etwas dicker als echt, damit der Rumpf klein noch wirkt
  const faces: Face[] = [];
  const add = (p: P3[], tone = 1) => faces.push({ p, tone });

  // ── Rumpf: Ringe mit 12 Seiten; Querschnitt leicht hochoval, Bug rund, Heckkonus nach oben auslaufend
  const SIDES = 12;
  const deck = s.upperDeck === 'full' ? 1.28 : 1;
  /** Ring bei f (m vor der Mitte): Radius k·r, Mittelpunkt um du·r angehoben, hump = Höhe zusätzlich oben */
  const ring = (f: number, k: number, du = 0, hump = 0): P3[] =>
    Array.from({ length: SIDES }, (_, i) => {
      const t = (i / SIDES) * Math.PI * 2;
      const up = Math.cos(t);
      const z = up * r * k * 1.06 * deck + du * r + (up > 0 ? up * hump * r : 0);
      return [f, Math.sin(t) * r * k, z] as P3;
    });
  const hump = (f: number) => {
    if (s.upperDeck !== 'hump') return 0;
    const x = f / L; // Buckel vom Bug bis etwa 40 % der Länge
    return x > 0.1 ? 0.45 * Math.min(1, (x - 0.1) / 0.08) * Math.min(1, Math.max(0, (0.5 - x) / 0.05)) : 0;
  };
  // Bugprofil als Viertelellipse (Abstand von der Spitze ~ 1,6 Rumpfradien), Spitze etwas tiefer
  const noseLen = r * 1.7;
  const ringsF: Array<[number, number, number]> = [];
  for (const q of [0.05, 0.2, 0.4, 0.62, 0.82, 1]) {
    const k = Math.sqrt(1 - (1 - q) ** 2);
    ringsF.push([L / 2 - noseLen * q, k, -0.12 * (1 - q)]);
  }
  const body: P3[][] = ringsF.map(([f, k, du]) => ring(f, k, du, hump(f)));
  for (const fx of [0.3, 0.15, 0, -0.15, -0.26]) body.push(ring(L * fx, 1, 0, hump(L * fx)));
  // Heckkonus: Radius fällt, Mittelpunkt steigt zur Oberkante
  for (const [fx, k] of [[-0.33, 0.8], [-0.4, 0.55], [-0.46, 0.3]]) body.push(ring(L * fx, k, 1 - k));
  // body ist von vorn nach hinten sortiert, Ringe 0..n-1
  const nose: P3 = [L / 2, 0, -0.12 * r];
  const tail: P3 = [-L / 2, 0, 0.88 * r];
  for (let i = 0; i < SIDES; i++) {
    const j = (i + 1) % SIDES;
    add([nose, body[0][i], body[0][j]]);
    for (let k = 0; k + 1 < body.length; k++) add([body[k][i], body[k][j], body[k + 1][j], body[k + 1][i]]);
    add([body[body.length - 1][i], body[body.length - 1][j], tail]);
  }
  // Cockpitfenster: dunkles Band vorn oben (zwischen den Bugringen 2 und 4, obere Seiten)
  const winA = body[2], winB = body[3];
  for (const i of [11, 0, 1]) {
    const j = (i + 1) % SIDES;
    const lift = (p: P3): P3 => [p[0], p[1] * 1.02, p[2] + r * 0.02];
    add([lift(winA[i]), lift(winA[j]), lift(winB[j]), lift(winB[i])], 0.25);
  }

  // ── Flügel: Tiefdecker mit Pfeilung, Knick (Yehudi) und V-Stellung; Turboprop gerader Schulterdecker
  const wu = s.turboprop ? r * 0.85 : -r * 0.45;
  const sweep = s.turboprop ? 0.03 : s.rearEngines ? 0.45 : 0.6; // Vorderkanten-Versatz je Meter Halbspannweite
  const dihedral = s.turboprop ? 0.01 : 0.09;
  const rootChord = s.turboprop ? L * 0.11 : L * (s.cls === 'small' ? 0.19 : 0.21);
  const rootLE = s.turboprop ? L * 0.08 : L * 0.12;
  const half = S / 2;
  const kink = s.turboprop || s.rearEngines ? 0 : 0.35; // Anteil der Halbspannweite bis zum Knick
  const tipChord = rootChord * (s.turboprop ? 0.55 : 0.22);
  const kinkChord = rootChord * 0.55;
  const le = (y: number) => rootLE - sweep * (y - r);
  const z = (y: number) => wu + dihedral * (y - r);
  const chordAt = (y: number) => {
    const ky = r + (half - r) * kink;
    if (kink && y <= ky) return rootChord + (kinkChord - rootChord) * ((y - r) / (ky - r));
    const y0 = kink ? ky : r, c0 = kink ? kinkChord : rootChord;
    return c0 + (tipChord - c0) * ((y - y0) / (half - y0));
  };
  const stations = kink ? [r, r + (half - r) * kink, half] : [r, half];
  for (const side of [1, -1]) {
    for (let k = 0; k + 1 < stations.length; k++) {
      const y0 = stations[k], y1 = stations[k + 1];
      const t = r * 0.18; // Profildicke (Ober- und Unterseite)
      add([[le(y0), side * y0, z(y0) + t], [le(y1), side * y1, z(y1) + t * 0.4], [le(y1) - chordAt(y1), side * y1, z(y1)], [le(y0) - chordAt(y0), side * y0, z(y0)]]);
      add([[le(y0), side * y0, z(y0) - t * 0.3], [le(y1), side * y1, z(y1) - t * 0.15], [le(y1) - chordAt(y1), side * y1, z(y1)], [le(y0) - chordAt(y0), side * y0, z(y0)]], 0.85);
    }
    if (s.winglets) {
      const h = S * 0.035, tl = le(half), tc = chordAt(half);
      add([[tl, side * half, z(half)], [tl - tc * 0.9, side * half, z(half)], [tl - tc * 1.15, side * (half + h * 0.15), z(half) + h], [tl - tc * 0.55, side * (half + h * 0.15), z(half) + h]]);
    }
  }

  // ── Leitwerk: Höhenleitwerk gepfeilt (beim Heckantrieb oben als T-Leitwerk), Seitenleitwerk
  const finH = S * (s.cls === 'small' ? 0.2 : 0.17) + r * 0.3;
  const finRoot = L * 0.17, finTip = finRoot * 0.42, finBase = -L * 0.3;
  const finTop = finBase - finH * 0.9; // Vorderkante oben (Pfeilung)
  const finU0 = r * 0.75;
  add([[finBase, 0, finU0], [finTop, 0, finU0 + finH], [finTop - finTip, 0, finU0 + finH], [finBase - finRoot, 0, r * 0.85]]);
  const htU = s.rearEngines ? finU0 + finH * 0.97 : r * 0.35;
  const htF = s.rearEngines ? finTop - finTip * 0.1 : -L * 0.36;
  const htSpan = S * (s.rearEngines ? 0.17 : 0.2) + r;
  const htRoot = L * 0.11, htTip = htRoot * 0.4;
  for (const side of [1, -1]) {
    const y0 = s.rearEngines ? 0 : r * 0.5;
    const tipLE = htF - (htSpan - y0) * 0.55;
    add([[htF, side * y0, htU], [tipLE, side * htSpan, htU + 0.05 * htSpan], [tipLE - htTip, side * htSpan, htU + 0.05 * htSpan], [htF - htRoot, side * y0, htU]]);
  }

  // ── Triebwerke: runde Gondel (8 Seiten), dunkler Einlauf vorn, Pylon zum Flügel bzw. Rumpf
  const NS = 8;
  const nacR = s.turboprop ? r * 0.38 : r * (s.cls === 'heavy' || s.cls === 'super' ? 0.52 : 0.5);
  const nacL = s.turboprop ? L * 0.15 : nacR * 4.2;
  const nacelle = (f: number, y: number, u: number, pylonTo: P3 | null) => {
    const ringN = (ff: number, k: number) => Array.from({ length: NS }, (_, i) => {
      const t = (i / NS) * Math.PI * 2;
      return [ff, y + Math.sin(t) * nacR * k, u + Math.cos(t) * nacR * k] as P3;
    });
    const a = ringN(f, 0.92), b = ringN(f - nacL * 0.3, 1), c = ringN(f - nacL, s.turboprop ? 0.45 : 0.62);
    for (let i = 0; i < NS; i++) {
      const j = (i + 1) % NS;
      add([a[i], a[j], b[j], b[i]]);
      add([b[i], b[j], c[j], c[i]]);
    }
    add(a.map((p) => [p[0] + 0.01, p[1], p[2]] as P3), 0.2);
    if (pylonTo) add([[f - nacL * 0.2, y, u], [f - nacL * 0.85, y, u], [pylonTo[0] - nacL * 0.6, pylonTo[1], pylonTo[2]], pylonTo], 0.8);
    if (s.turboprop) { // Propeller: zwei gekreuzte Blätter, dunkel
      const pr = S * 0.075, pf = f + 0.4;
      add([[pf, y - pr, u + 0.15], [pf, y + pr, u + 0.15], [pf, y + pr, u - 0.15], [pf, y - pr, u - 0.15]], 0.3);
      add([[pf, y - 0.15, u - pr], [pf, y + 0.15, u - pr], [pf, y + 0.15, u + pr], [pf, y - 0.15, u + pr]], 0.3);
    }
  };
  if (s.rearEngines) {
    for (const side of [1, -1]) {
      const y = side * (r + nacR * 1.35);
      nacelle(-L * 0.2, y, r * 0.35, [-L * 0.22, side * r * 0.8, r * 0.35]);
    }
  } else {
    const spots = s.engines === 4 ? [0.24, 0.4] : [s.turboprop ? 0.27 : 0.33];
    for (const k of spots) {
      for (const side of [1, -1]) {
        const y = k * S;
        const lef = le(y);
        if (s.turboprop) nacelle(lef + nacL * 0.35, side * y, z(y) - nacR * 0.1, null);
        else nacelle(lef + nacL * 0.55, side * y, z(y) - nacR * 1.15, [lef - chordAt(y) * 0.1, side * y, z(y)]);
      }
    }
  }
  cache.set(key, faces);
  return faces;
}
