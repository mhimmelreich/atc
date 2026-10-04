// filepath: src/game/RadarRenderer.ts
import type { Aircraft, ConflictPair, TrailPoint } from '@/types/aircraft';
import type { LiveAircraft } from '@/types/live';
import { AIRCRAFT_TYPES } from './constants';
import type { Airport, AirportLayer, OsmWay } from '@/types/airport';
import type { Waypoint, STAR } from '@/types/navdata';
import { destinationPoint, toRad } from '@/utils/geo';
import { SWEEP_PERIOD_MS, ILS_CONE_HALF_DEG } from './constants';

// ── Colour palette ────────────────────────────────────────────────────────────
const C = {
  BG:               '#050e1a',
  RADAR_RING:       'rgba(0,255,136,0.09)',
  RING_LABEL:       'rgba(0,255,136,0.30)',
  COMPASS:          'rgba(0,255,136,0.10)',
  SWEEP:            'rgba(0,255,136,0.85)',
  SWEEP_TRAIL:      'rgba(0,255,136,',

  RWY_FILL:         '#1a2a1a',
  RWY_EDGE:         '#c8c8c8',
  RWY_CTR:          'rgba(255,255,255,0.30)',
  RWY_THR:          '#00ff88',
  RWY_LABEL:        '#aaaaaa',
  RWY_DEP_ARROW:    'rgba(255,170,0,0.7)',

  TAXIWAY:          '#3a4e3a',
  TAXILABEL:        'rgba(90,130,90,0.7)',
  APRON:            '#0c1c0e',
  APRON_BORDER:     'rgba(25,55,20,0.85)',
  TERMINAL:         '#091509',
  TERMINAL_BORDER:  'rgba(35,70,25,0.9)',
  TERMINAL_LABEL:   'rgba(60,110,50,0.8)',

  ILS_CONE:         'rgba(68,136,255,0.40)',
  ILS_CTR:          'rgba(68,136,255,0.20)',
  ILS_CAT3:         'rgba(0,210,255,0.45)',
  ILS_LABEL:        'rgba(90,160,255,0.85)',
  ILS_DME:          'rgba(90,160,255,0.6)',

  WP_FIX:           'rgba(255,221,0,0.75)',
  WP_VOR:           'rgba(255,221,0,0.65)',
  WP_LABEL:         'rgba(255,221,0,0.85)',

  AC_GREEN:         '#00ff88',
  AC_AMBER:         '#ffaa00',
  AC_RED:           '#ff3333',
  AC_BLUE:          '#4488ff',
  AC_YELLOW:        '#ffdd00',
  AC_WHITE:         '#cccccc',
  CONFLICT:         '#ff3333',
  WARNING:          '#ffaa00',

  LIVE:             'rgba(170,190,180,0.85)',
  LIVE_LABEL:       'rgba(150,170,160,0.85)',
  LIVE_TRAIL:       'rgba(150,170,160,',
};

// Echte Flieger: Beschriftung nur unterhalb dieser Höhe (darüber Überflieger ohne Bezug zum Platz)
const LIVE_LABEL_MAX_FT = 20000;

export interface DisplayOptions {
  labels: boolean;
  ilsCones: boolean;
  waypoints: boolean;
  stars: boolean;
}

export const DEFAULT_DISPLAY: DisplayOptions = {
  labels: true,
  ilsCones: true,
  waypoints: true,
  stars: true,
};

export interface RenderOptions {
  now: number;
  airport: Airport | null;
  aircraft: Aircraft[];
  conflicts: ConflictPair[];
  waypoints: Waypoint[];
  selectedId: string | null;
  sweepEnabled: boolean;
  rangeNM: number;
  trailLength: number;
  viewLat: number;
  viewLng: number;
  previewHeading?: { aircraftId: string; targetHdg: number; direction?: 'left' | 'right' } | null;
  previewAltitude?: { aircraftId: string; targetAlt: number } | null;
  stars: STAR[];
  display: DisplayOptions;
  activeRunwayIds: string[];
  /** Echte Flieger (LIVE), nicht gelotst */
  live?: { aircraft: LiveAircraft[]; trails: Map<string, TrailPoint[]> };
}

export class RadarRenderer {
  private canvas: HTMLCanvasElement;
  private ctx:    CanvasRenderingContext2D;
  /** CSS display dimensions */
  private cssW = 0;
  private cssH = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d')!;
  }

  /** Call when the container size changes (CSS pixels). */
  resize(cssW: number, cssH: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    const dpr = window.devicePixelRatio || 1;
    // Physical canvas resolution = display size × DPR
    this.canvas.width  = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    // CSS size stays the same so no layout shift
    this.canvas.style.width  = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
  }

  /** px/NM based on CSS dimensions & current range */
  private pxPerNM(rangeNM: number): number {
    return Math.min(this.cssW, this.cssH) / (rangeNM * 2);
  }

  render(opts: RenderOptions): void {
    const { ctx } = this;
    const { cssW: W, cssH: H } = this;
    if (W === 0 || H === 0) return;

    // ── DPR scaling: every draw uses CSS px, canvas internally renders at device resolution ──
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = C.BG;
    ctx.fillRect(0, 0, W, H);

    if (!opts.airport) {
      ctx.fillStyle = C.AC_GREEN;
      ctx.font = '16px "Courier New"';
      ctx.textAlign = 'center';
      ctx.fillText('LOADING AIRPORT DATA…', W / 2, H / 2);
      ctx.restore();
      return;
    }

    const scale  = this.pxPerNM(opts.rangeNM);
    const cLat   = opts.viewLat;
    const cLng   = opts.viewLng;
    const ll2c   = this.makeLL2C(cLat, cLng, scale, W, H);

    // Airport canvas position (fixed anchor for rings and sweep)
    const apPx = ll2c(opts.airport.lat, opts.airport.lng);

    // ── Back → Front ────────────────────────────────────────────────────────
    this.drawRangeRings(opts.rangeNM, scale, apPx.x, apPx.y);
    if (opts.sweepEnabled) this.drawSweep(opts.now, apPx.x, apPx.y);

    if (opts.airport.layer) {
      if (opts.rangeNM <= 25) this.drawPolygons(opts.airport.layer.aprons,    ll2c, C.APRON,    C.APRON_BORDER,    0.5);
      if (opts.rangeNM <= 18) this.drawPolygons(opts.airport.layer.terminals, ll2c, C.TERMINAL, C.TERMINAL_BORDER, 1);
      if (opts.rangeNM <= 20) this.drawTaxiways(opts.airport.layer, ll2c, scale, opts.rangeNM);
      if (opts.rangeNM <= 18) this.drawTerminalLabels(opts.airport.layer, ll2c);
    }

    this.drawRunways(opts.airport, ll2c, scale, opts.rangeNM);

    if (opts.display.ilsCones) {
      for (const rwy of opts.airport.runways) {
        if (!rwy.ils || rwy.role === 'departure') continue;
        if (!opts.activeRunwayIds.includes(rwy.id)) continue;
        this.drawILSCone(rwy, ll2c, opts.rangeNM);
      }
    }

    if (opts.display.stars && opts.stars.length > 0) {
      this.drawStars(opts.stars, ll2c);
    }
    if (opts.display.waypoints) {
      this.drawWaypoints(opts.waypoints, ll2c, W, H);
    }

    const acMap = new Map(opts.aircraft.map((a) => [a.id, a]));
    this.drawConflicts(opts.conflicts, acMap, ll2c);

    // Predicted track arc (drawn below aircraft symbols)
    if (opts.previewHeading) {
      const previewAc = opts.aircraft.find((a) => a.id === opts.previewHeading!.aircraftId);
      if (previewAc) this.drawPredictedTrack(previewAc, opts.previewHeading.targetHdg, opts.previewHeading.direction, ll2c);
    }

    // Altitude reach circle
    if (opts.previewAltitude) {
      const previewAc = opts.aircraft.find((a) => a.id === opts.previewAltitude!.aircraftId);
      if (previewAc) this.drawAltitudeReachCircle(previewAc, opts.previewAltitude.targetAlt, ll2c);
    }

    if (opts.live) this.drawLive(opts.live, ll2c, W, H, opts.trailLength, opts.display.labels);

    for (const ac of opts.aircraft) this.drawTrail(ac, ll2c, opts.trailLength);
    for (const ac of opts.aircraft) {
      const selected = ac.id === opts.selectedId;
      const route = selected && ac.starId ? opts.stars.find((s) => s.id === ac.starId) : undefined;
      this.drawAircraft(ac, ll2c, selected, W, H, opts.display.labels, route);
    }

    // Compass border
    ctx.strokeStyle = C.COMPASS;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, Math.min(W, H) / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();

    // Range label (top-left)
    ctx.fillStyle = 'rgba(0,255,136,0.35)';
    ctx.font = '11px "Courier New"';
    ctx.textAlign = 'left';
    ctx.fillText(`${opts.rangeNM.toFixed(0)} NM`, 8, 18);

    // Quellenhinweis für die Live-Daten (ODbL)
    if (opts.live) {
      ctx.fillStyle = 'rgba(150,170,160,0.6)';
      ctx.fillText('Traffic: adsb.lol (ODbL)', 8, H - 8);
    }

    ctx.restore();
  }

  // ── Echte Flieger (LIVE) ────────────────────────────────────────────────────
  private drawLive(
    live: NonNullable<RenderOptions['live']>,
    ll2c: (lat: number, lng: number) => { x: number; y: number },
    W: number, H: number,
    trailLength: number,
    showLabels: boolean,
  ): void {
    const { ctx } = this;
    for (const ac of live.aircraft) {
      const p = ll2c(ac.lat, ac.lng);
      if (p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40) continue;

      const trail = (live.trails.get(ac.hex) ?? []).slice(-trailLength);
      trail.forEach((t, i) => {
        const q = ll2c(t.lat, t.lng);
        ctx.fillStyle = `${C.LIVE_TRAIL}${((i + 1) / trail.length) * 0.35})`;
        ctx.fillRect(q.x - 1, q.y - 1, 2, 2);
      });

      // Radarziel als Quadrat mit Vektor für eine Minute Flugweg
      ctx.strokeStyle = C.LIVE;
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x - 3, p.y - 3, 6, 6);
      if (ac.gs !== null && ac.track !== null) {
        const ahead = destinationPoint(ac.lat, ac.lng, ac.track, ac.gs / 60);
        const q = ll2c(ahead.lat, ahead.lng);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }

      if (showLabels && ac.altFt !== null && ac.altFt < LIVE_LABEL_MAX_FT) {
        const fl = Math.round(ac.altFt / 100).toString().padStart(3, '0');
        const vs = (ac.vs ?? 0) > 300 ? '↑' : (ac.vs ?? 0) < -300 ? '↓' : '→';
        ctx.fillStyle = C.LIVE_LABEL;
        ctx.font = '10px "Courier New"';
        ctx.textAlign = 'left';
        ctx.fillText(ac.callsign, p.x + 8, p.y - 3);
        ctx.fillText(`FL${fl} ${vs} ${ac.gs !== null ? Math.round(ac.gs) : ''}`, p.x + 8, p.y + 8);
      }
    }
  }

  // ── Coordinate factory ────────────────────────────────────────────────────
  private makeLL2C(cLat: number, cLng: number, scale: number, W: number, H: number) {
    const cosLat = Math.cos(toRad(cLat));
    return (lat: number, lng: number): { x: number; y: number } => {
      const northNM = (lat - cLat) * 60;
      const eastNM  = (lng - cLng) * 60 * cosLat;
      return { x: W / 2 + eastNM * scale, y: H / 2 - northNM * scale };
    };
  }

  // ── Range rings ───────────────────────────────────────────────────────────
  private drawRangeRings(rangeNM: number, scale: number, cx: number, cy: number): void {
    const { ctx } = this;
    const interval = rangeNM <= 4  ? 0.5
                   : rangeNM <= 8  ? 1
                   : rangeNM <= 15 ? 2
                   : rangeNM <= 30 ? 5
                   : rangeNM <= 60 ? 10
                   : 20;

    ctx.setLineDash([3, 7]);
    ctx.lineWidth = 1;
    for (let r = interval; r <= rangeNM * 1.5; r += interval) {
      const px = r * scale;
      ctx.strokeStyle = C.RADAR_RING;
      ctx.beginPath();
      ctx.arc(cx, cy, px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = C.RING_LABEL;
      ctx.font = '9px "Courier New"';
      ctx.textAlign = 'left';
      ctx.fillText(r % 1 === 0 ? `${r}` : r.toFixed(1), cx + px + 2, cy - 2);
    }
    ctx.setLineDash([]);
  }

  // ── Sweep ─────────────────────────────────────────────────────────────────
  private drawSweep(now: number, cx: number, cy: number): void {
    const { ctx } = this;
    const angle  = ((now % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS) * Math.PI * 2 - Math.PI / 2;
    const radius = Math.hypot(this.cssW, this.cssH);  // cover full canvas from airport
    const trail  = Math.PI * 0.55;
    for (let i = 0; i < 32; i++) {
      const a     = angle - (i / 32) * trail;
      const alpha = (1 - i / 32) * 0.12;
      ctx.strokeStyle = C.SWEEP_TRAIL + alpha + ')';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      ctx.stroke();
    }
    ctx.strokeStyle = C.SWEEP;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    ctx.stroke();
  }

  // ── OSM polygon layers ─────────────────────────────────────────────────────
  private drawPolygons(
    ways: OsmWay[],
    ll2c: (lat: number, lng: number) => { x: number; y: number },
    fillColor: string, strokeColor: string, lineWidth: number
  ): void {
    const { ctx } = this;
    for (const way of ways) {
      if (way.geometry.length < 3) continue;
      ctx.beginPath();
      const f = ll2c(way.geometry[0].lat, way.geometry[0].lng);
      ctx.moveTo(f.x, f.y);
      for (let i = 1; i < way.geometry.length; i++) {
        const p = ll2c(way.geometry[i].lat, way.geometry[i].lng);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  private drawTerminalLabels(
    layer: AirportLayer,
    ll2c: (lat: number, lng: number) => { x: number; y: number }
  ): void {
    const { ctx } = this;
    ctx.fillStyle = C.TERMINAL_LABEL;
    ctx.font = '9px "Courier New"';
    ctx.textAlign = 'center';
    for (const t of layer.terminals) {
      if (!t.tags.name && !t.tags.ref) continue;
      const lats = t.geometry.map((p) => p.lat);
      const lngs = t.geometry.map((p) => p.lng);
      const midLat = (Math.max(...lats) + Math.min(...lats)) / 2;
      const midLng = (Math.max(...lngs) + Math.min(...lngs)) / 2;
      const p = ll2c(midLat, midLng);
      ctx.fillText(t.tags.name ?? t.tags.ref ?? '', p.x, p.y + 3);
    }
  }

  private drawTaxiways(
    layer: AirportLayer,
    ll2c: (lat: number, lng: number) => { x: number; y: number },
    scale: number,
    rangeNM: number
  ): void {
    const { ctx } = this;
    const showLabels = rangeNM <= 7;
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    for (const tw of layer.taxiways) {
      if (tw.geometry.length < 2) continue;
      ctx.strokeStyle = C.TAXIWAY;
      ctx.lineWidth   = Math.max(1, scale * 0.015);
      ctx.beginPath();
      const fp = ll2c(tw.geometry[0].lat, tw.geometry[0].lng);
      ctx.moveTo(fp.x, fp.y);
      for (let i = 1; i < tw.geometry.length; i++) {
        const p = ll2c(tw.geometry[i].lat, tw.geometry[i].lng);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      if (showLabels && tw.tags.ref) {
        const mid = tw.geometry[Math.floor(tw.geometry.length / 2)];
        const mp  = ll2c(mid.lat, mid.lng);
        ctx.fillStyle = C.TAXILABEL;
        ctx.font = '8px "Courier New"';
        ctx.textAlign = 'center';
        ctx.fillText(tw.tags.ref, mp.x, mp.y);
      }
    }
  }

  // ── Runways ───────────────────────────────────────────────────────────────
  private drawRunways(
    airport: Airport,
    ll2c: (lat: number, lng: number) => { x: number; y: number },
    scale: number,
    rangeNM: number
  ): void {
    const { ctx } = this;
    const drawn = new Set<string>();

    for (const rwy of airport.runways) {
      const key = [rwy.id, rwy.recipId].sort().join(':');
      if (drawn.has(key)) continue;
      drawn.add(key);

      const p1 = ll2c(rwy.thresholdLat, rwy.thresholdLng);
      const p2 = ll2c(rwy.endLat, rwy.endLng);

      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.5) continue;

      const widthPx = Math.max(2, (rwy.widthM / 1852) * scale);
      const nx = -dy / len, ny = dx / len;

      // Surface
      ctx.beginPath();
      ctx.moveTo(p1.x + nx * widthPx / 2, p1.y + ny * widthPx / 2);
      ctx.lineTo(p2.x + nx * widthPx / 2, p2.y + ny * widthPx / 2);
      ctx.lineTo(p2.x - nx * widthPx / 2, p2.y - ny * widthPx / 2);
      ctx.lineTo(p1.x - nx * widthPx / 2, p1.y - ny * widthPx / 2);
      ctx.closePath();
      ctx.fillStyle   = rangeNM <= 20 ? '#1c2a1c' : '#111';
      ctx.fill();
      ctx.strokeStyle = C.RWY_EDGE;
      ctx.lineWidth   = 0.8;
      ctx.stroke();

      // Centreline dashes (close range only)
      if (rangeNM <= 12 && len > 30) {
        ctx.save();
        ctx.strokeStyle = C.RWY_CTR;
        ctx.lineWidth   = 0.6;
        ctx.setLineDash([Math.max(5, len * 0.04), Math.max(4, len * 0.03)]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Threshold bars
      if (rangeNM <= 30) {
        this.drawThresholdBar(p1, p2, widthPx);
        this.drawThresholdBar(p2, p1, widthPx);
      }

      // Departure arrow for departure-only runways
      if (rwy.role === 'departure') {
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        ctx.save();
        ctx.translate(midX, midY);
        ctx.rotate(Math.atan2(dy, dx));
        ctx.strokeStyle = C.RWY_DEP_ARROW;
        ctx.lineWidth   = 1.5;
        ctx.beginPath();
        const arrowLen = Math.min(len * 0.2, 20);
        ctx.moveTo(-arrowLen, 0);
        ctx.lineTo(arrowLen, 0);
        ctx.moveTo(arrowLen * 0.5, -arrowLen * 0.3);
        ctx.lineTo(arrowLen, 0);
        ctx.lineTo(arrowLen * 0.5, arrowLen * 0.3);
        ctx.stroke();
        ctx.restore();
      }

      // Labels
      const labelFontSize = rangeNM <= 12 ? 11 : 9;
      ctx.fillStyle = C.RWY_LABEL;
      ctx.font = `bold ${labelFontSize}px "Courier New"`;
      ctx.textAlign = 'center';
      const labelOffset = Math.max(10, len * 0.1);
      const ux = dx / len, uy = dy / len;
      // Kennung steht an ihrer eigenen Schwelle (p1), die Gegenrichtung am anderen Ende (p2)
      ctx.fillText(rwy.id,     p1.x + ux * labelOffset, p1.y + uy * labelOffset + 4);
      if (rwy.id !== rwy.recipId) {
        ctx.fillText(rwy.recipId, p2.x - ux * labelOffset, p2.y - uy * labelOffset + 4);
      }
    }
  }

  private drawThresholdBar(
    near: { x: number; y: number },
    far:  { x: number; y: number },
    widthPx: number
  ): void {
    const { ctx } = this;
    const dx = far.x - near.x, dy = far.y - near.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    const nx = -dy / len, ny = dx / len;
    ctx.strokeStyle = C.RWY_THR;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(near.x + nx * widthPx / 2, near.y + ny * widthPx / 2);
    ctx.lineTo(near.x - nx * widthPx / 2, near.y - ny * widthPx / 2);
    ctx.stroke();
  }

  // ── ILS cones ─────────────────────────────────────────────────────────────
  private drawILSCone(
    rwy: Airport['runways'][0],
    ll2c: (lat: number, lng: number) => { x: number; y: number },
    rangeNM: number
  ): void {
    if (!rwy.ils) return;
    const { ctx } = this;
    const thr      = ll2c(rwy.thresholdLat, rwy.thresholdLng);
    const locHdg   = rwy.ils.localizerCourse;
    const appFrom  = (locHdg + 180) % 360;
    const coneLen  = Math.min(15, rangeNM * 0.75);

    const pLeft  = ll2c(...Object.values(destinationPoint(rwy.thresholdLat, rwy.thresholdLng, (appFrom - ILS_CONE_HALF_DEG + 360) % 360, coneLen)) as [number, number]);
    const pRight = ll2c(...Object.values(destinationPoint(rwy.thresholdLat, rwy.thresholdLng, (appFrom + ILS_CONE_HALF_DEG) % 360, coneLen)) as [number, number]);
    const pFar   = ll2c(...Object.values(destinationPoint(rwy.thresholdLat, rwy.thresholdLng, appFrom, coneLen)) as [number, number]);

    const coneColor = rwy.ils.category === 'III' ? C.ILS_CAT3 : C.ILS_CONE;

    ctx.strokeStyle = coneColor;
    ctx.lineWidth   = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(thr.x, thr.y); ctx.lineTo(pLeft.x, pLeft.y);
    ctx.moveTo(thr.x, thr.y); ctx.lineTo(pRight.x, pRight.y);
    ctx.stroke();

    ctx.strokeStyle = C.ILS_CTR;
    ctx.setLineDash([9, 6]);
    ctx.beginPath();
    ctx.moveTo(thr.x, thr.y); ctx.lineTo(pFar.x, pFar.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // DME tick marks
    if (rangeNM <= 25) {
      for (const dme of [5, 10]) {
        if (dme >= coneLen) continue;
        const pt = destinationPoint(rwy.thresholdLat, rwy.thresholdLng, appFrom, dme);
        const pp = ll2c(pt.lat, pt.lng);
        ctx.fillStyle  = C.ILS_DME;
        ctx.font       = '8px "Courier New"';
        ctx.textAlign  = 'left';
        ctx.fillText(`D${dme}`, pp.x + 4, pp.y - 3);
        const fdx = pFar.x - thr.x, fdy = pFar.y - thr.y;
        const flen = Math.sqrt(fdx * fdx + fdy * fdy);
        if (flen > 0) {
          const tnx = -fdy / flen * 5, tny = fdx / flen * 5;
          ctx.strokeStyle = C.ILS_DME;
          ctx.lineWidth   = 0.8;
          ctx.beginPath();
          ctx.moveTo(pp.x + tnx, pp.y + tny);
          ctx.lineTo(pp.x - tnx, pp.y - tny);
          ctx.stroke();
        }
      }
    }

    // Frequency label
    ctx.fillStyle  = C.ILS_LABEL;
    ctx.font       = 'bold 9px "Courier New"';
    ctx.textAlign  = 'left';
    const lx = thr.x + Math.sin(toRad(appFrom)) * 14;
    const ly = thr.y - Math.cos(toRad(appFrom)) * 14;
    // Frequenz 0 = unbekannt (angenommenes ILS aus freien Daten)
    const freq = rwy.ils.frequencyMHz > 0 ? ` ${rwy.ils.frequencyMHz.toFixed(2)}` : '';
    ctx.fillText(`ILS ${rwy.id}${freq} Cat${rwy.ils.category}`, lx, ly);
  }

  // ── STAR routes ───────────────────────────────────────────────────────────
  private drawStars(
    stars: STAR[],
    ll2c: (lat: number, lng: number) => { x: number; y: number }
  ): void {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(180,120,255,0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    const labelled = new Set<string>();
    for (const star of stars) {
      const pts = star.waypoints;
      if (pts.length < 2) continue;
      ctx.beginPath();
      const first = ll2c(pts[0].lat, pts[0].lng);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < pts.length; i++) {
        const p = ll2c(pts[i].lat, pts[i].lng);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      // STAR name label at first waypoint (once per name, runway variants share it)
      const label = star.name ?? star.id;
      if (labelled.has(label)) continue;
      labelled.add(label);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(180,120,255,0.70)';
      ctx.font = '8px "Courier New"';
      ctx.textAlign = 'left';
      ctx.fillText(label, first.x + 5, first.y - 4);
      ctx.setLineDash([6, 5]);
    }
    ctx.restore();
  }

  // ── Waypoints ─────────────────────────────────────────────────────────────
  private drawWaypoints(
    waypoints: Waypoint[],
    ll2c: (lat: number, lng: number) => { x: number; y: number },
    W: number, H: number
  ): void {
    const { ctx } = this;
    for (const wp of waypoints) {
      const p = ll2c(wp.lat, wp.lng);
      if (p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;

      ctx.lineWidth = 1;
      if (wp.type === 'vor') {
        ctx.strokeStyle = C.WP_VOR;
        ctx.fillStyle   = 'rgba(255,221,0,0.12)';
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 - Math.PI / 6;
          i === 0 ? ctx.moveTo(p.x + Math.cos(a) * 7, p.y + Math.sin(a) * 7)
                  : ctx.lineTo(p.x + Math.cos(a) * 7, p.y + Math.sin(a) * 7);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.strokeStyle = C.WP_FIX;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 6);
        ctx.lineTo(p.x + 5, p.y + 4);
        ctx.lineTo(p.x - 5, p.y + 4);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.fillStyle  = C.WP_LABEL;
      ctx.font       = '9px "Courier New"';
      ctx.textAlign  = 'left';
      ctx.fillText(wp.id, p.x + 8, p.y + 4);
    }
  }

  // ── Conflict lines ─────────────────────────────────────────────────────────
  private drawConflicts(
    conflicts: ConflictPair[],
    acMap: Map<string, Aircraft>,
    ll2c: (lat: number, lng: number) => { x: number; y: number }
  ): void {
    const { ctx } = this;
    for (const c of conflicts) {
      const a = acMap.get(c.a), b = acMap.get(c.b);
      if (!a || !b) continue;
      const pa = ll2c(a.lat, a.lng), pb = ll2c(b.lat, b.lng);
      ctx.strokeStyle = c.type === 'conflict' ? C.CONFLICT : C.WARNING;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ── Trail ─────────────────────────────────────────────────────────────────
  private drawTrail(
    ac: Aircraft,
    ll2c: (lat: number, lng: number) => { x: number; y: number },
    trailLength: number
  ): void {
    const { ctx } = this;
    const pts = ac.trail.slice(-trailLength);
    for (let i = 0; i < pts.length; i++) {
      const p     = ll2c(pts[i].lat, pts[i].lng);
      const alpha = ((i + 1) / pts.length) * 0.55;
      ctx.fillStyle = `rgba(0,255,136,${alpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Predicted turn arc ───────────────────────────────────────────────────
  private drawPredictedTrack(
    ac: Aircraft,
    targetHdg: number,
    direction: 'left' | 'right' | undefined,
    ll2c: (lat: number, lng: number) => { x: number; y: number }
  ): void {
    const { ctx } = this;

    // Compute signed delta from current heading to fixed target, respecting direction
    let delta: number;
    if (direction === 'right') {
      delta = ((targetHdg - ac.headingDeg) % 360 + 360) % 360 || 360;
    } else if (direction === 'left') {
      const cw = ((targetHdg - ac.headingDeg) % 360 + 360) % 360;
      delta = cw === 0 ? 0 : -(360 - cw);
    } else {
      // shortest path
      delta = ((targetHdg - ac.headingDeg + 540) % 360) - 180;
    }
    delta = Math.max(-360, Math.min(360, delta));
    const absAngle = Math.abs(delta);
    const isRight = delta >= 0;

    // Turn radius: r = V/ω, standard rate 3°/s
    const radiusNM = (ac.speedKts / 3600) / (3 * Math.PI / 180);
    const cosLat = Math.cos(ac.lat * Math.PI / 180);
    const h = ac.headingDeg * Math.PI / 180;

    // Arc: closed-form position at fraction t of total turn
    // Right: east=r(cos h−cos(h+α)), north=r(sin(h+α)−sin h)
    // Left:  east=r(cos(h−α)−cos h), north=r(sin h−sin(h−α))
    const arcOffset = (a: number): { lat: number; lng: number } => {
      const eastNM  = isRight
        ? radiusNM * (Math.cos(h) - Math.cos(h + a))
        : radiusNM * (Math.cos(h - a) - Math.cos(h));
      const northNM = isRight
        ? radiusNM * (Math.sin(h + a) - Math.sin(h))
        : radiusNM * (Math.sin(h) - Math.sin(h - a));
      return { lat: ac.lat + northNM / 60, lng: ac.lng + eastNM / (60 * cosLat) };
    };

    const N = Math.max(16, Math.round(absAngle / 3));
    const arcPts = Array.from({ length: N + 1 }, (_, i) =>
      ll2c(...Object.values(arcOffset(absAngle * (i / N) * Math.PI / 180)) as [number, number])
    );

    // Endpoint in geo coords (for continuation)
    const geoEnd = arcOffset(absAngle * Math.PI / 180);
    const contNM = ac.speedKts * 90 / 3600; // 90s on new heading
    const tRad = targetHdg * Math.PI / 180;
    const contEnd = ll2c(
      geoEnd.lat + Math.cos(tRad) * contNM / 60,
      geoEnd.lng + Math.sin(tRad) * contNM / (60 * cosLat)
    );
    const last = arcPts[arcPts.length - 1];

    ctx.save();

    // Arc line
    ctx.strokeStyle = 'rgba(0,220,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(arcPts[0].x, arcPts[0].y);
    for (let i = 1; i < arcPts.length; i++) ctx.lineTo(arcPts[i].x, arcPts[i].y);
    ctx.stroke();

    // Continuation line
    ctx.strokeStyle = 'rgba(0,220,255,0.35)';
    ctx.setLineDash([4, 7]);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(contEnd.x, contEnd.y);
    ctx.stroke();

    // Circle at turn-completion point
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(0,220,255,0.85)';
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ── Altitude reach circle ────────────────────────────────────────────────
  private drawAltitudeReachCircle(
    ac: Aircraft,
    targetAlt: number,
    ll2c: (lat: number, lng: number) => { x: number; y: number }
  ): void {
    const deltaAlt = Math.abs(targetAlt - ac.altitudeFt);
    if (deltaAlt < 50) return;

    // Use standard rates: 1800 fpm climb, 2200 fpm descent
    const vsUsed = targetAlt > ac.altitudeFt ? 1800 : 2200;
    const timeSec = (deltaAlt / vsUsed) * 60;
    const distNM = (ac.speedKts / 3600) * timeSec;
    if (distNM < 0.1) return;

    const { ctx } = this;
    const center = ll2c(ac.lat, ac.lng);
    const cosLat = Math.cos(ac.lat * Math.PI / 180);
    const edgePx = ll2c(ac.lat, ac.lng + distNM / (60 * cosLat));
    const radiusPx = Math.abs(edgePx.x - center.x);
    if (radiusPx < 2) return;

    const isClimb = targetAlt > ac.altitudeFt;
    ctx.save();
    ctx.strokeStyle = isClimb ? 'rgba(0,255,136,0.50)' : 'rgba(255,170,0,0.50)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
    ctx.stroke();

    // Label at top of circle
    ctx.setLineDash([]);
    ctx.fillStyle = isClimb ? 'rgba(0,255,136,0.70)' : 'rgba(255,170,0,0.70)';
    ctx.font = '10px "Courier New", monospace';
    ctx.textAlign = 'center';
    const minSec = Math.round(timeSec / 60);
    const remSec = Math.round(timeSec % 60);
    ctx.fillText(`FL${String(Math.round(targetAlt / 100)).padStart(3,'0')} ~${minSec}:${String(remSec).padStart(2,'0')}`, center.x, center.y - radiusPx - 4);
    ctx.restore();
  }

  // ── Aircraft symbol ────────────────────────────────────────────────────────
  private drawAircraft(
    ac: Aircraft,
    ll2c: (lat: number, lng: number) => { x: number; y: number },
    selected: boolean,
    W: number, H: number,
    showLabel = true,
    route?: STAR,
  ): void {
    const { ctx } = this;
    const p = ll2c(ac.lat, ac.lng);
    if (p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40) return;

    // Restliche STAR-Route des ausgewählten Fliegers hervorheben
    if (route && ac.state === 'enroute' && !ac.directTo && !ac.clearedILS) {
      const rest = route.waypoints.slice(ac.starLegIndex ?? 0);
      if (rest.length > 0) {
        ctx.save();
        ctx.strokeStyle = 'rgba(200,150,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        for (const w of rest) {
          const q = ll2c(w.lat, w.lng);
          ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    // Direct-to-Linie zum Zielpunkt (nur ausgewählter Flieger)
    if (selected && ac.directTo) {
      const t = ll2c(ac.directTo.lat, ac.directTo.lng);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,220,80,0.6)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.restore();
    }

    let color = C.AC_GREEN;
    if (ac.conflict)     color = C.AC_RED;
    else if (ac.warning) color = C.AC_AMBER;
    else if (ac.state === 'established' || ac.state === 'intercepting') color = C.AC_BLUE;
    else if (ac.state === 'vectored')    color = C.AC_YELLOW;

    const size = selected ? 9 : 7;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(toRad(ac.headingDeg));
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.55, size * 0.65);
    ctx.lineTo(0, size * 0.3);
    ctx.lineTo(-size * 0.55, size * 0.65);
    ctx.closePath();
    ctx.fill();
    if (selected) { ctx.strokeStyle = C.AC_WHITE; ctx.lineWidth = 1.5; ctx.stroke(); }
    ctx.restore();

    if (showLabel || selected) {
      const fl  = Math.round(ac.altitudeFt / 100);
      const spd = Math.round(ac.speedKts);
      const vs  = ac.verticalSpeedFpm > 100 ? '↑' : ac.verticalSpeedFpm < -100 ? '↓' : '→';
      const wake = AIRCRAFT_TYPES[ac.type]?.wake;

      ctx.fillStyle  = color;
      ctx.font       = `${selected ? 'bold ' : ''}11px "Courier New"`;
      ctx.textAlign  = 'left';
      ctx.fillText(ac.callsign, p.x + 12, p.y - 4);
      ctx.fillText(`FL${fl.toString().padStart(3, '0')} ${vs}`, p.x + 12, p.y + 8);
      ctx.fillText(`${spd}kt`, p.x + 12, p.y + 20);
      if (ac.clearedILS && ac.assignedRunway) {
        // ILS zugewiesen → "ILS25L"; mit Landefreigabe "LND25L"; etabliert ohne Freigabe orange
        const tag = `${ac.clearedToLand ? 'LND' : 'ILS'}${ac.assignedRunway}`;
        const tagX = p.x + 12 + ctx.measureText(`${spd}kt `).width;
        ctx.fillStyle = ac.clearedToLand ? '#00ff88' : ac.state === 'established' ? '#ffaa00' : '#4488ff';
        ctx.fillText(tag, tagX, p.y + 20);
        ctx.fillStyle = color;
      }

      // Wake turbulence badge for Heavy / Super
      if (wake === 'H' || wake === 'J') {
        const badgeColor = wake === 'J' ? '#ff6666' : '#ffaa00';
        ctx.font = 'bold 9px "Courier New"';
        ctx.fillStyle = badgeColor;
        ctx.fillText(wake, p.x + 12, p.y + 30);
      }
    }

    if (selected) {
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
