// filepath: src/game/aircraftPlanform.ts
// Draufsicht eines Fliegers fürs Favoriten-Radar: Größe nach echtem Typ (Länge, Spannweite),
// Triebwerke in echter Zahl und Lage (unter den Flügeln, hinten am Rumpf, Propeller an Nase oder Flügel),
// Hubschrauber mit Rotorkreis. Maße aus aircraftModel3D (Jets, Turboprops) bzw. hier (Leichtflugzeuge).
import { modelShape } from './aircraftModel3D';

type Kind = 'jet' | 'turboprop' | 'piston1' | 'piston2' | 'heli' | 'glider';
export interface Planform {
  kind: Kind;
  length: number;
  span: number;
  diameter: number;
  engines: number;
  rearEngines: boolean;
}

// Leichtflugzeuge: [Länge, Spannweite, Triebwerke]
const LIGHT: Record<string, [number, number, number]> = {
  C150: [7.3, 10.2, 1], C152: [7.3, 10.2, 1], C172: [8.3, 11.0, 1], C182: [8.8, 11.0, 1], C206: [8.6, 11.0, 1], C208: [11.5, 15.9, 1],
  P28A: [7.3, 10.7, 1], P28B: [7.3, 10.7, 1], P28R: [7.6, 10.8, 1], PA46: [8.8, 13.1, 1], P46T: [9.0, 13.1, 1], SR20: [7.9, 11.7, 1], SR22: [7.9, 11.7, 1],
  DA40: [8.1, 11.9, 1], DV20: [7.2, 10.8, 1], DR40: [7.0, 8.7, 1], M20P: [7.5, 11.0, 1], BE35: [8.4, 10.2, 1], BE36: [8.4, 10.2, 1],
  TBM7: [10.6, 12.8, 1], TBM8: [10.7, 12.8, 1], TBM9: [10.7, 12.8, 1], PC12: [14.4, 16.3, 1], PC6T: [10.9, 15.9, 1], C210: [8.6, 11.2, 1],
  DA42: [8.6, 13.4, 2], DA62: [9.2, 14.6, 2], PA34: [8.7, 11.9, 2], PA44: [8.4, 11.8, 2], BE58: [9.1, 11.5, 2], BE20: [13.4, 16.6, 2],
  C310: [9.7, 11.3, 2], C340: [10.5, 11.6, 2], P68: [9.4, 12.0, 2], BN2P: [10.9, 14.9, 2], DHC6: [15.8, 19.8, 2], L410: [14.4, 19.5, 2],
};
const HELI: Record<string, [number, number]> = { // [Länge, Rotordurchmesser]
  EC35: [10.2, 10.2], EC45: [13.0, 11.0], EC30: [10.7, 10.7], EC55: [14.3, 12.5], H160: [13.5, 13.4], AS50: [10.9, 10.7],
  R44: [8.9, 10.1], R22: [8.8, 7.7], A109: [13.0, 11.0], A139: [16.7, 13.8], B06: [9.5, 10.2], NH90: [19.6, 16.3], CH47: [30.1, 18.3],
};

export function planform(type: string | undefined, category: string | undefined): Planform {
  const t = (type ?? '').toUpperCase();
  if (HELI[t] || category === 'A7') {
    const [length, span] = HELI[t] ?? [11, 10.5];
    return { kind: 'heli', length, span, diameter: 1.6, engines: 0, rearEngines: false };
  }
  if (category === 'B1' || /^(GLID|DG\d|ASK\d|LS\d)/.test(t)) return { kind: 'glider', length: 7, span: 17, diameter: 0.8, engines: 0, rearEngines: false };
  if (LIGHT[t]) {
    const [length, span, engines] = LIGHT[t];
    return { kind: engines === 1 ? 'piston1' : 'piston2', length, span, diameter: 1.3, engines, rearEngines: false };
  }
  if (category === 'A1' || category === 'B4') return { kind: 'piston1', length: 8, span: 11, diameter: 1.2, engines: 1, rearEngines: false };
  const s = modelShape(type);
  return { kind: s.turboprop ? 'turboprop' : 'jet', length: s.length, span: s.span, diameter: s.diameter, engines: s.engines, rearEngines: s.rearEngines };
}

/**
 * Zeichnet die Draufsicht um (0,0), Nase nach oben, pxPerM Bildpunkte je Meter, mindestens minSpanPx breit.
 * Füllt mit der aktuellen fillStyle; Triebwerke stehen als Gondeln vor der Flügelvorderkante heraus,
 * mit dunklem Spalt (gapColor) zum Flügel, damit ihre Zahl auch klein erkennbar ist. Gibt die halbe Länge in px zurück.
 */
export function drawPlanform(ctx: CanvasRenderingContext2D, pf: Planform, pxPerM: number, minSpanPx: number, gapColor: string): number {
  const k = Math.max(pxPerM, minSpanPx / pf.span);
  const L = pf.length * k, S = pf.span * k, D = Math.max(1.5, pf.diameter * k);
  const top = -L / 2;

  if (pf.kind === 'heli') {
    ctx.beginPath(); ctx.ellipse(0, -L * 0.1, D * 1.1, L * 0.28, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(-Math.max(1, D * 0.25), -L * 0.1, Math.max(2, D * 0.5), L * 0.6);
    ctx.save();
    ctx.globalAlpha *= 0.55; ctx.lineWidth = 1; ctx.strokeStyle = ctx.fillStyle;
    ctx.beginPath(); ctx.arc(0, -L * 0.1, S / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    return Math.max(L / 2, S / 2);
  }

  const swept = pf.kind === 'jet';
  const rootChord = L * (pf.kind === 'glider' ? 0.14 : swept ? 0.2 : 0.17);
  const rootLe = top + L * (swept ? 0.36 : pf.kind === 'piston1' || pf.kind === 'glider' ? 0.24 : 0.33);
  const sweep = swept ? (S / 2) * Math.tan((27 * Math.PI) / 180) : 0;
  const tipChord = rootChord * (pf.kind === 'glider' ? 0.4 : swept ? 0.28 : 0.7);

  // Flügel
  ctx.beginPath();
  ctx.moveTo(0, rootLe);
  ctx.lineTo(S / 2, rootLe + sweep);
  ctx.lineTo(S / 2, rootLe + sweep + tipChord);
  ctx.lineTo(0, rootLe + rootChord);
  ctx.lineTo(-S / 2, rootLe + sweep + tipChord);
  ctx.lineTo(-S / 2, rootLe + sweep);
  ctx.closePath(); ctx.fill();
  // Höhenleitwerk
  const hs = S * (pf.kind === 'glider' ? 0.17 : swept ? 0.34 : 0.36), hsLe = top + L * 0.84, hsC = L * 0.1;
  const hsSweep = swept ? (hs / 2) * 0.6 : 0;
  ctx.beginPath();
  ctx.moveTo(0, hsLe); ctx.lineTo(hs / 2, hsLe + hsSweep); ctx.lineTo(hs / 2, hsLe + hsSweep + hsC * 0.5);
  ctx.lineTo(0, hsLe + hsC); ctx.lineTo(-hs / 2, hsLe + hsSweep + hsC * 0.5); ctx.lineTo(-hs / 2, hsLe + hsSweep);
  ctx.closePath(); ctx.fill();
  // Rumpf mit runder Nase
  ctx.beginPath();
  ctx.moveTo(-D / 2, top + D); ctx.quadraticCurveTo(-D / 2, top, 0, top); ctx.quadraticCurveTo(D / 2, top, D / 2, top + D);
  ctx.lineTo(D / 2 * 0.8, top + L * 0.92); ctx.lineTo(0, top + L); ctx.lineTo(-D / 2 * 0.8, top + L * 0.92);
  ctx.closePath(); ctx.fill();

  // Triebwerke: auch bei kleinem Maßstab sichtbar (mindestens 2 px breit, ragen vor den Flügel)
  const ew = Math.max(2, pf.diameter * k * 0.55), el = Math.max(3.5, pf.diameter * k * 1.1);
  const pod = (x: number, y: number, w: number, h: number) => {
    ctx.save(); ctx.fillStyle = gapColor; ctx.fillRect(x - 0.6, y - 0.6, w + 1.2, h + 1.2); ctx.restore();
    ctx.fillRect(x, y, w, h);
  };
  if (pf.kind === 'piston1') {
    ctx.fillRect(-Math.max(4, S * 0.25) / 2, top - 2, Math.max(4, S * 0.25), 1.2); // Propeller an der Nase
  } else if (pf.rearEngines) {
    for (const side of [-1, 1]) pod(side * (D / 2 + 0.8) - (side < 0 ? ew : 0), top + L * 0.66, ew, el);
  } else if (pf.engines > 0) {
    const spots = pf.engines === 4 ? [0.24, 0.42] : [pf.kind === 'jet' ? 0.34 : 0.3];
    for (const f of spots) {
      for (const side of [-1, 1]) {
        const x = side * f * (S / 2);
        const le = rootLe + sweep * f;
        if (pf.kind === 'jet') pod(x - ew / 2, le - el * 0.9, ew, el);
        else { pod(x - ew / 2, le - el * 0.6, ew, el); ctx.fillRect(x - Math.max(4, S * 0.12) / 2, le - el * 0.6 - 1.8, Math.max(4, S * 0.12), 1.2); } // Gondel mit Propeller
      }
    }
  }
  return Math.max(L / 2, S / 2);
}
