// filepath: src/game/aircraftSymbol.ts

// Rechte Hälfte der Silhouette, Nase oben (y = -1), Heck unten (y = 1), Spannweite ±1
const RIGHT_HALF: Array<[number, number]> = [
  [0.09, -0.86], [0.11, -0.3],  // Rumpf vorn
  [1.0, 0.12], [1.0, 0.26],     // Flügel
  [0.11, 0.1], [0.08, 0.62],    // Rumpf hinten
  [0.42, 0.86], [0.42, 0.97],   // Höhenleitwerk
  [0.05, 0.9], [0, 1],
];

/** Pfad einer Flugzeugsilhouette um (0,0), Nase nach oben; halbe Länge = size */
export function aircraftSilhouette(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.beginPath();
  ctx.moveTo(0, -size);
  for (const [x, y] of RIGHT_HALF) ctx.lineTo(x * size, y * size);
  for (let i = RIGHT_HALF.length - 2; i >= 0; i--) ctx.lineTo(-RIGHT_HALF[i][0] * size, RIGHT_HALF[i][1] * size);
  ctx.closePath();
}
