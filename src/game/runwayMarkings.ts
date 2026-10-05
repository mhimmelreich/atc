// filepath: src/game/runwayMarkings.ts
// Bahnmarkierungen nach ICAO Annex 14 (vereinfacht) in Bahnkoordinaten: a = Meter entlang der Bahn
// ab der Schwelle der ersten Richtung, c = Meter quer (rechts positiv, in Richtung der ersten Bahn
// gesehen). 2D- und 3D-Ansicht bilden diese Punkte nur noch auf den Bildschirm ab.

export type LocalPt = [number, number]; // [a, c]
export interface RunwayText { a: number; c: number; h: number; text: string; /** 180° gedreht (Gegenrichtung) */ flip: boolean }

export interface RunwayMarkings {
  /** Seitenlinien und Mittellinie (schon ab wenigen Pixeln Breite sinnvoll) */
  lines: LocalPt[][];
  /** Schwellenbalken, Zielpunkt, Aufsetzzone (erst bei mehr Platz) */
  detail: LocalPt[][];
  /** Bahnbezeichnung an beiden Enden */
  texts: RunwayText[];
}

const rect = (a0: number, a1: number, c0: number, c1: number): LocalPt[] => [[a0, c0], [a1, c0], [a1, c1], [a0, c1]];

/** Markierungen einer Bahn (beide Richtungen); idA gilt ab a = 0, idB ab a = lengthM */
export function runwayMarkings(lengthM: number, widthM: number, idA: string, idB: string): RunwayMarkings {
  const L = lengthM, W = widthM, half = W / 2;
  const lines: LocalPt[][] = [];
  const detail: LocalPt[][] = [];
  const texts: RunwayText[] = [];

  // Seitenlinien über die ganze Länge, Mittellinie 30 m Strich, 20 m Lücke zwischen den Bezeichnungen
  lines.push(rect(0, L, half - 1.4, half - 0.5), rect(0, L, -half + 0.5, -half + 1.4));
  for (let a = 90; a + 30 <= L - 90; a += 50) lines.push(rect(a, a + 30, -0.45, 0.45));

  // Je Richtung: a von der eigenen Schwelle, c nach rechts; die Gegenrichtung wird gespiegelt
  for (const [id, fwd] of [[idA, true], [idB, false]] as const) {
    const at = (a: number, c: number): LocalPt => (fwd ? [a, c] : [L - a, -c]);
    const quad = (a0: number, a1: number, c0: number, c1: number) => detail.push(rect(a0, a1, c0, c1).map(([a, c]) => at(a, c)));

    // Schwellenbalken („Klaviertasten“): 30 m lang ab 6 m hinter der Schwelle, Anzahl nach Bahnbreite
    const perSide = W >= 60 ? 8 : W >= 45 ? 6 : W >= 30 ? 4 : W >= 23 ? 3 : 2;
    const step = (half - 3) / perSide;
    for (let i = 0; i < perSide; i++) {
      const outer = half - 3 - i * step, inner = outer - step * 0.55;
      quad(6, 36, inner, outer);
      quad(6, 36, -outer, -inner);
    }

    // Bezeichnung: Buchstabe (L/C/R) näher an der Schwelle, darüber die Zahl, je 9 m hoch
    const m = /^(\d{1,2})([LCR]?)$/.exec(id);
    const num = m ? m[1].padStart(2, '0') : id;
    const letter = m?.[2] ?? '';
    let a = 48;
    if (letter) { texts.push({ ...pos(at(a + 4.5, 0)), h: 9, text: letter, flip: !fwd }); a += 15; }
    texts.push({ ...pos(at(a + 4.5, 0)), h: 9, text: num, flip: !fwd });

    // Zielpunkt und Aufsetzzone, nach Bahnlänge
    const gap = W >= 45 ? 9 : W * 0.2;
    if (L >= 2400) {
      quad(400, 460, gap, gap + 10); quad(400, 460, -gap - 10, -gap);
      tdz(quad, gap, [[150, 3], [300, 3], [600, 2], [750, 2], [900, 1], [1050, 1]]);
    } else if (L >= 1500) {
      quad(300, 345, gap, gap + 6); quad(300, 345, -gap - 6, -gap);
      tdz(quad, gap, [[150, 3], [450, 2], [600, 1]]);
    } else if (L >= 900) {
      quad(250, 280, gap, gap + 4); quad(250, 280, -gap - 4, -gap);
      tdz(quad, gap, [[150, 2]]);
    }
  }
  return { lines, detail, texts };
}

const pos = ([a, c]: LocalPt) => ({ a, c });

/** Aufsetzzonen-Paare: je Abstand n Streifen 22,5 m × 1,8 m mit 1,5 m Lücke, außen an den Zielpunkt anschließend */
function tdz(quad: (a0: number, a1: number, c0: number, c1: number) => void, gap: number, rows: Array<[number, number]>): void {
  for (const [a, n] of rows) {
    for (let i = 0; i < n; i++) {
      const c0 = gap + i * 3.3, c1 = c0 + 1.8;
      quad(a, a + 22.5, c0, c1);
      quad(a, a + 22.5, -c1, -c0);
    }
  }
}

type Proj = (a: number, c: number) => { x: number; y: number } | null;

/**
 * Bahn samt Markierungen zeichnen. P bildet Bahnkoordinaten auf den Bildschirm ab (2D linear,
 * 3D perspektivisch, null hinter der Kamera), pxPerM ist der Maßstab an der Bahn. Markierungen
 * erscheinen erst, wenn sie im Bild groß genug sind.
 */
export function drawRunwayMarkings(
  ctx: CanvasRenderingContext2D, P: Proj, lengthM: number, widthM: number, idA: string, idB: string,
  pxPerM: number, surface: string, paint: string,
): void {
  const poly = (pts: LocalPt[]) => {
    const s = pts.map(([a, c]) => P(a, c));
    if (s.some((p) => !p)) return false;
    s.forEach((p, i) => (i === 0 ? ctx.moveTo(p!.x, p!.y) : ctx.lineTo(p!.x, p!.y)));
    ctx.closePath();
    return true;
  };
  const half = widthM / 2;
  ctx.fillStyle = surface;
  ctx.beginPath();
  poly(rect(0, lengthM, -half, half));
  ctx.fill();
  const widthPx = widthM * pxPerM;
  if (widthPx < 4) return;
  const m = runwayMarkings(lengthM, widthM, idA, idB);
  ctx.fillStyle = paint;
  ctx.beginPath();
  for (const q of m.lines) poly(q);
  if (widthPx >= 10) for (const q of m.detail) poly(q);
  ctx.fill();
  if (9 * pxPerM < 5) return;
  // Bezeichnung: lokale Abbildung um den Textmittelpunkt (für die Perspektive genau genug)
  for (const t of m.texts) {
    const p0 = P(t.a, t.c), pa = P(t.a + 1, t.c), pc = P(t.a, t.c + 1);
    if (!p0 || !pa || !pc) continue;
    const s = t.flip ? -1 : 1;
    const ax = (pa.x - p0.x) * s, ay = (pa.y - p0.y) * s, cx = (pc.x - p0.x) * s, cy = (pc.y - p0.y) * s;
    ctx.save();
    // Textachse x = quer nach rechts (aus Sicht des Anflugs), y nach unten = zur Schwelle hin
    ctx.transform(cx, cy, -ax, -ay, p0.x, p0.y);
    ctx.font = `bold ${t.h / 0.72}px "Arial Narrow", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = paint;
    ctx.fillText(t.text, 0, 0);
    ctx.restore();
  }
}
