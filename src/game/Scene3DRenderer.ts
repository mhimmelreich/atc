// filepath: src/game/Scene3DRenderer.ts
import type { Aircraft } from '@/types/aircraft';
import type { AirportLayer, OsmWay, Runway } from '@/types/airport';
import { buildingHeightM } from '@/types/airport';
import type { STAR, Waypoint } from '@/types/navdata';
import { drawSpectator, drawTowns, LANDMARK_RGB, sourceCredit, type RenderOptions } from './RadarRenderer';
import { toRad } from '@/utils/geo';
import { typeData } from './constants';
import { drawRunwayMarkings } from './runwayMarkings';
import { modelFaces, modelShape, MODEL_PX_PER_M, MODEL_MIN_SPAN_PX } from './aircraftModel3D';

/** Höhen werden standardmäßig überhöht, sonst liegt bei 80 NM alles platt am Boden; ×1 = maßstabsgetreu */
export const ALT_SCALES = [4, 2, 1] as const;
export const DEFAULT_ALT_SCALE = 4;
const FT_PER_NM = 6076;
const FOV_DEG = 50;
const GLIDE_NM = 15;
const TRAIL_SAMPLE_MS = 5000;
// Orte verblassen mit der Entfernung zur Kamera (Vielfache des Abstands Kamera–Blickpunkt)
const TOWN_FADE_START = 0.4;
const TOWN_FADE_END = 1.3;
const TRAIL_MAX = 120;
const LIVE_LABEL_MAX_FT = 20000;

/** Kamera: Blickrichtung (Grad, 0 = nach Norden), Neigung über dem Boden (Grad) */
export interface Camera3D {
  yaw: number;
  pitch: number;
}

export const DEFAULT_CAMERA: Camera3D = { yaw: 0, pitch: 35 };
export const PITCH_MIN = 3;
export const PITCH_MAX = 89;

interface Vec { x: number; y: number; z: number }
interface Pt { x: number; y: number; depth: number }

const COL = {
  BG_TOP: '#02070e',
  BG_BOTTOM: '#071a2a',
  RING: 'rgba(0,255,136,0.13)',
  RING_LABEL: 'rgba(0,255,136,0.35)',
  RWY: '#c8c8c8',
  RWY_SURFACE: '#596066',
  AD_BOUNDARY: 'rgba(90,150,90,0.4)',
  APRON: 'rgba(70,82,80,0.55)',
  TAXIWAY: 'rgba(78,90,88,0.9)',
  TAXI_CL: 'rgba(230,200,60,0.85)',
  TERMINAL: '150,175,190',
  HANGAR: '135,150,140',
  TOWER: '190,220,200',
  RWY_LABEL: '#aaaaaa',
  GLIDE: 'rgba(68,136,255,0.75)',
  GLIDE_GROUND: 'rgba(68,136,255,0.25)',
  STAR: 'rgba(180,120,255,0.55)',
  STAR_DROP: 'rgba(180,120,255,0.12)',
  STAR_LABEL: 'rgba(180,120,255,0.75)',
  WP: 'rgba(255,221,0,0.75)',
  WP_LABEL: 'rgba(255,221,0,0.8)',
  GREEN: '#00ff88', AMBER: '#ffaa00', RED: '#ff3333', BLUE: '#4488ff', YELLOW: '#ffdd00', WHITE: '#cccccc',
  LIVE: 'rgba(170,190,180,0.85)',
  LIVE_INBOUND: 'rgba(120,215,255,0.95)',
  LIVE_OUTBOUND: 'rgba(255,190,90,0.95)',
};

/** Perspektivische Ansicht der Szene: Boden in NM, Höhe überhöht, Kamera kreist um den Blickpunkt */
export class Scene3DRenderer {
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  // Bezug für Weltkoordinaten (Platz) und aktuelle Kamera, für Projektion und Klicks
  private lat0 = 0;
  private lng0 = 0;
  private cosLat0 = 1;
  /** Höhe des Platzes: der Boden der Szene liegt auf Platzhöhe, Höhen darüber also über Grund */
  private elev0 = 0;
  /** Überhöhung der Höhen (×1 maßstabsgetreu) */
  altScale: number = DEFAULT_ALT_SCALE;
  private cam: Vec = { x: 0, y: 0, z: 0 };
  private right: Vec = { x: 1, y: 0, z: 0 };
  private up: Vec = { x: 0, y: 0, z: 1 };
  private fwd: Vec = { x: 0, y: 1, z: 0 };
  private focal = 1;
  private near = 0.1;
  /** Eigene Spuren mit Höhe (die 2D-Spur kennt keine Höhe) */
  private trails = new Map<string, Vec[]>();
  private lastSample = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(cssW: number, cssH: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
  }

  /** Abstand der Kamera zum Blickpunkt, so dass etwa ±rangeNM ins Bild passen */
  static distanceFor(rangeNM: number): number {
    return rangeNM / Math.tan(toRad(FOV_DEG / 2));
  }

  /** NM am Boden pro Bildschirmpixel am Blickpunkt (fürs Verschieben) */
  nmPerPx(rangeNM: number): number {
    return Scene3DRenderer.distanceFor(rangeNM) / this.focal;
  }

  world(lat: number, lng: number, altFt = 0): Vec {
    return {
      x: (lng - this.lng0) * 60 * this.cosLat0,
      y: (lat - this.lat0) * 60,
      z: (Math.max(0, altFt - this.elev0) / FT_PER_NM) * this.altScale,
    };
  }

  /** Bildschirmpunkt (CSS px) eines Weltpunkts; null hinter der Kamera */
  project(lat: number, lng: number, altFt = 0): { x: number; y: number } | null {
    const p = this.proj(this.world(lat, lng, altFt));
    return p ? { x: p.x, y: p.y } : null;
  }

  private setupCamera(o: RenderOptions, cam: Camera3D): void {
    const ap = o.airport!;
    this.lat0 = ap.lat;
    this.lng0 = ap.lng;
    this.cosLat0 = Math.cos(toRad(ap.lat));
    this.elev0 = ap.elevationFt ?? 0;
    const target = this.world(o.viewLat, o.viewLng, 0);
    const d = Scene3DRenderer.distanceFor(o.rangeNM);
    const yaw = toRad(cam.yaw);
    const pitch = toRad(cam.pitch);
    // Kamera steht hinter dem Blickpunkt (entgegen der Blickrichtung) und oben
    this.cam = {
      x: target.x - Math.sin(yaw) * Math.cos(pitch) * d,
      y: target.y - Math.cos(yaw) * Math.cos(pitch) * d,
      z: Math.sin(pitch) * d,
    };
    this.fwd = norm(sub(target, this.cam));
    this.right = norm(cross(this.fwd, { x: 0, y: 0, z: 1 }));
    this.up = cross(this.right, this.fwd);
    this.focal = Math.min(this.cssW, this.cssH) / 2 / Math.tan(toRad(FOV_DEG / 2));
    this.near = d * 0.02;
  }

  private camSpace(v: Vec): Vec {
    const d = sub(v, this.cam);
    return { x: dot(d, this.right), y: dot(d, this.up), z: dot(d, this.fwd) };
  }

  private toScreen(c: Vec): Pt {
    return { x: this.cssW / 2 + (c.x / c.z) * this.focal, y: this.cssH / 2 - (c.y / c.z) * this.focal, depth: c.z };
  }

  private proj(v: Vec): Pt | null {
    const c = this.camSpace(v);
    if (c.z < this.near) return null;
    return this.toScreen(c);
  }

  /** Linienzug in den aktuellen Pfad, an der Nahebene abgeschnitten */
  private polyline(points: Vec[], closed = false): void {
    const { ctx } = this;
    const pts = closed && points.length > 2 ? [...points, points[0]] : points;
    let pen = false;
    for (let i = 1; i < pts.length; i++) {
      let a = this.camSpace(pts[i - 1]);
      let b = this.camSpace(pts[i]);
      if (a.z < this.near && b.z < this.near) { pen = false; continue; }
      if (a.z < this.near) { a = lerpToNear(a, b, this.near); pen = false; }
      const bClipped = b.z < this.near;
      if (bClipped) b = lerpToNear(b, a, this.near);
      const sa = this.toScreen(a);
      const sb = this.toScreen(b);
      if (!pen) ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      pen = !bClipped;
    }
  }

  private line(a: Vec, b: Vec): void {
    this.polyline([a, b]);
  }

  render(o: RenderOptions, cam: Camera3D): void {
    const { ctx } = this;
    const W = this.cssW, H = this.cssH;
    if (W === 0 || H === 0 || !o.airport) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.scale(dpr, dpr);

    this.setupCamera(o, cam);

    // Himmel: oben dunkel, zum Horizont heller
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, COL.BG_TOP);
    sky.addColorStop(1, COL.BG_BOTTOM);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    this.drawGround(o);
    const layer = o.rangeNM <= 20 ? o.airport.layer : undefined;
    if (layer) this.drawAirportGround(layer);
    this.drawRunways(o.airport.runways, o.display.labels);
    if (layer) this.drawAirportBuildings(layer, o.airport.elevationFt ?? 0, o.display.labels);
    if (o.display.ilsCones) {
      for (const r of o.airport.runways) {
        if (r.ils && r.role !== 'departure' && o.activeRunwayIds.includes(r.id)) this.drawGlidePath(r);
      }
    }
    if (o.display.stars) this.drawStars(o.stars);
    if (o.display.waypoints) this.drawWaypoints(o.waypoints, o.display.labels);

    this.sampleTrails(o);
    this.drawConflicts(o);
    if (o.towns?.length) {
      // Nahe Orte voll (im Rahmen der Grundblässe), ab dem Blickpunkt verblassend, weit hinten unsichtbar
      const d = Scene3DRenderer.distanceFor(o.rangeNM);
      const fade = (depth: number) => Math.max(0, Math.min(1, 1 - (depth - d * TOWN_FADE_START) / (d * (TOWN_FADE_END - TOWN_FADE_START))));
      drawTowns(this.ctx, o.towns, (lat, lng) => this.proj(this.world(lat, lng, 0)), this.cssW, this.cssH, fade);
    }
    if (o.dayTracks?.length) {
      // Tageslinien in ihrer Höhe, dünn und durchscheinend: Anflüge hellblau, Abflüge gelborange
      this.ctx.lineWidth = 1;
      for (const dir of ['in', 'out'] as const) {
        this.ctx.strokeStyle = dir === 'in' ? 'rgba(120,215,255,0.28)' : 'rgba(255,190,90,0.28)';
        this.ctx.beginPath();
        for (const f of o.dayTracks) if (f.dir === dir) this.polyline(f.p.map(([lat, lng, alt]) => this.world(lat, lng, alt ?? 0)));
        this.ctx.stroke();
      }
    }
    if (o.landmarks?.length) this.drawLandmarks(o);
    if (o.track && o.live) {
      // Bisherige Flugbahn in ihrer Höhe, mit Loten alle paar Punkte
      const now = o.live.aircraft.find((a) => a.hex === o.track!.hex);
      const pts = [...o.track.points, ...(now ? [now] : [])];
      const vs = pts.map((p) => this.world(p.lat, p.lng, p.altFt ?? 0));
      // Kräftiges Orange mit dunklem Rand; gemessen durchgezogen, geschätzt (Ozean ohne Empfang) gestrichelt
      const tp = o.track.points;
      const isEst = (i: number) => i < tp.length && tp[i].est === true;
      this.ctx.lineCap = 'round';
      for (const [color, width] of [['rgba(0,0,0,0.7)', 5], ['rgba(255,110,0,0.95)', 2.5]] as const) {
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = width;
        for (const est of [false, true]) {
          this.ctx.setLineDash(est ? [7, 6] : []);
          this.ctx.beginPath();
          for (let i = 1; i < vs.length; i++) {
            if ((isEst(i - 1) || isEst(i)) !== est) continue;
            this.line(vs[i - 1], vs[i]);
          }
          this.ctx.stroke();
        }
      }
      this.ctx.setLineDash([]);
      this.ctx.lineCap = 'butt';
      this.ctx.strokeStyle = 'rgba(255,110,0,0.2)';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      const every = Math.max(1, Math.round(pts.length / 40));
      pts.forEach((p, i) => { if (i % every === 0) this.line(vs[i], this.world(p.lat, p.lng, 0)); });
      this.ctx.stroke();
    }
    if (o.spectator) {
      const p = this.proj(this.world(o.spectator.lat, o.spectator.lng, 0));
      if (p) drawSpectator(this.ctx, p);
    }
    this.drawTargets(o);
    this.drawHud(o, cam);
    ctx.restore();
  }

  // ── Flughafengelände (OSM): Platzgrenze, Vorfeld, Rollwege am Boden ──
  private drawAirportGround(layer: AirportLayer): void {
    const { ctx } = this;
    const ring = (w: OsmWay) => {
      const pts = w.geometry.map((g) => this.proj(this.world(g.lat, g.lng)));
      if (pts.some((p) => !p)) return false;
      pts.forEach((p, i) => (i ? ctx.lineTo(p!.x, p!.y) : ctx.moveTo(p!.x, p!.y)));
      return true;
    };
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = COL.AD_BOUNDARY;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const w of layer.boundary ?? []) ring(w);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COL.APRON;
    ctx.beginPath();
    for (const w of layer.aprons) if (ring(w)) ctx.closePath();
    ctx.fill();
    // Rollwege in echter Breite (OSM width, sonst 23 m), ab genug Platz mit gelber Mittellinie
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const w of layer.taxiways) {
      const mid = w.geometry[Math.floor(w.geometry.length / 2)];
      const z = this.camSpace(this.world(mid.lat, mid.lng)).z;
      if (z < this.near) continue;
      const pxPerM = this.focal / z / 1852;
      const widthM = parseFloat(w.tags.width ?? '') || (w.tags.aeroway === 'taxilane' ? 15 : 23);
      ctx.strokeStyle = COL.TAXIWAY;
      ctx.lineWidth = Math.max(1, widthM * pxPerM);
      ctx.beginPath();
      ring(w);
      ctx.stroke();
      if (widthM * pxPerM >= 6) {
        ctx.strokeStyle = COL.TAXI_CL;
        ctx.lineWidth = Math.max(0.8, 0.3 * pxPerM);
        ctx.beginPath();
        ring(w);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Terminals, Hangars und Tower als Körper in echter Höhe (wie die Bauwerke überhöht) */
  private drawAirportBuildings(layer: AirportLayer, elevFt: number, labels: boolean): void {
    const { ctx } = this;
    type Item = { z: number; ring: Array<{ lat: number; lng: number }>; topFt: number; rgb: string; label?: string; lat: number; lng: number };
    const items: Item[] = [];
    const add = (w: OsmWay, fallbackM: number, rgb: string, label?: string) => {
      const g = w.geometry;
      const lat = g.reduce((s, p) => s + p.lat, 0) / g.length, lng = g.reduce((s, p) => s + p.lng, 0) / g.length;
      const z = this.camSpace(this.world(lat, lng)).z;
      if (z > this.near) items.push({ z, ring: g, topFt: elevFt + buildingHeightM(w.tags, fallbackM) * 3.281, rgb, label, lat, lng });
    };
    for (const w of layer.terminals) add(w, 20, COL.TERMINAL, w.tags.name ?? w.tags.ref);
    for (const w of layer.hangars ?? []) add(w, 18, COL.HANGAR);
    for (const t of layer.towers ?? []) {
      // Ohne kartierten Grundriss ein Schaft von etwa 12 m Durchmesser
      const r = 6 / 111_320, k = Math.cos(toRad(t.lat));
      const ring = t.footprint?.geometry ?? Array.from({ length: 9 }, (_, i) => ({ lat: t.lat + r * Math.cos((i / 8) * Math.PI * 2), lng: t.lng + (r / k) * Math.sin((i / 8) * Math.PI * 2) }));
      const z = this.camSpace(this.world(t.lat, t.lng)).z;
      if (z > this.near) items.push({ z, ring, topFt: elevFt + t.heightM * 3.281, rgb: COL.TOWER, label: t.label, lat: t.lat, lng: t.lng });
    }
    items.sort((a, b) => b.z - a.z);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = '9px "Courier New"';
    ctx.textAlign = 'center';
    for (const it of items) {
      const B = it.ring.map((g) => this.proj(this.world(g.lat, g.lng)));
      const T = it.ring.map((g) => this.proj(this.world(g.lat, g.lng, it.topFt)));
      if (B.some((p) => !p) || T.some((p) => !p)) continue;
      const b = B as Pt[], t = T as Pt[];
      ctx.fillStyle = `rgba(${it.rgb},0.28)`;
      ctx.strokeStyle = `rgba(${it.rgb},0.8)`;
      for (let i = 1; i < b.length; i++) {
        ctx.beginPath();
        ctx.moveTo(b[i - 1].x, b[i - 1].y); ctx.lineTo(b[i].x, b[i].y); ctx.lineTo(t[i].x, t[i].y); ctx.lineTo(t[i - 1].x, t[i - 1].y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = `rgba(${it.rgb},0.45)`;
      ctx.beginPath();
      t.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (labels && it.label) {
        const p = this.proj(this.world(it.lat, it.lng, it.topFt));
        if (p) { ctx.fillStyle = `rgba(${it.rgb},0.9)`; ctx.fillText(it.label, p.x, p.y - 4); }
      }
    }
    ctx.restore();
  }

  // ── Markante Bauwerke als Körper in echter Höhe (Fuß MSL wie die Flieger, also ebenso überhöht) ──
  private drawLandmarks(o: RenderOptions): void {
    const { ctx } = this;
    const d = Scene3DRenderer.distanceFor(o.rangeNM);
    // Gelände etwa auf Platzhöhe: Dach = Platzhöhe + Bauwerkshöhe (MSL), damit Flieger daneben richtig hoch oder tief wirken
    const elevFt = o.airport?.elevationFt ?? 0;
    const items = o.landmarks!
      .map((l) => ({ l, c: this.camSpace(this.world(l.lat, l.lng, 0)) }))
      .filter(({ c }) => c.z > this.near && c.z < d * 4)
      .sort((a, b) => b.c.z - a.c.z); // von hinten nach vorn
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = '9px "Courier New"';
    ctx.textAlign = 'center';
    for (const { l, c } of items) {
      const vis = Math.max(0.25, Math.min(1, 1 - (c.z - d) / (d * 2)));
      const topFt = elevFt + l.heightM * 3.281;
      ctx.strokeStyle = `rgba(${LANDMARK_RGB},${0.75 * vis})`;
      ctx.fillStyle = `rgba(${LANDMARK_RGB},${0.16 * vis})`;
      if (l.rings.length === 0) {
        // Turm als Punkt: senkrechter Strich mit Spitze
        const a = this.proj(this.world(l.lat, l.lng, 0));
        const b = this.proj(this.world(l.lat, l.lng, topFt));
        if (!a || !b) continue;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.lineWidth = 1;
      } else {
        for (const ring of l.rings) {
          const base = ring.map(([lat, lng]) => this.proj(this.world(lat, lng, 0)));
          const top = ring.map(([lat, lng]) => this.proj(this.world(lat, lng, topFt)));
          if (base.some((p) => !p) || top.some((p) => !p)) continue;
          const B = base as Pt[], T = top as Pt[];
          // Wände halbdurchsichtig füllen, dann Dachkante und senkrechte Kanten
          for (let i = 1; i < ring.length; i++) {
            ctx.beginPath();
            ctx.moveTo(B[i - 1].x, B[i - 1].y); ctx.lineTo(B[i].x, B[i].y); ctx.lineTo(T[i].x, T[i].y); ctx.lineTo(T[i - 1].x, T[i - 1].y);
            ctx.closePath();
            ctx.fill();
          }
          ctx.beginPath();
          T.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.stroke();
          ctx.beginPath();
          B.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          // Senkrechte Kanten nur an Ecken (bei runden Grundrissen sonst ein Strichgewirr)
          const every = Math.max(1, Math.round(ring.length / 8));
          for (let i = 0; i < ring.length - 1; i += every) { ctx.moveTo(B[i].x, B[i].y); ctx.lineTo(T[i].x, T[i].y); }
          ctx.stroke();
        }
      }
      if (o.display.labels && l.name && c.z < d * 1.5 && (l.heightM >= 150 || l.kind === 'stadium' || c.z < d * 0.6)) {
        const p = this.proj(this.world(l.lat, l.lng, topFt));
        if (p) {
          ctx.fillStyle = `rgba(${LANDMARK_RGB},${0.85 * vis})`;
          ctx.fillText(l.name.toUpperCase(), p.x, p.y - 5);
        }
      }
    }
    ctx.restore();
  }

  // ── Boden: Entfernungsringe um den Platz und Himmelsrichtungen ─────────────
  private drawGround(o: RenderOptions): void {
    const { ctx } = this;
    const step = o.rangeNM <= 15 ? 2 : o.rangeNM <= 30 ? 5 : o.rangeNM <= 100 ? 10 : 20;
    const maxR = Math.max(step * 3, Math.ceil((o.rangeNM * 1.5) / step) * step);
    ctx.strokeStyle = COL.RING;
    ctx.lineWidth = 1;
    ctx.font = '10px "Courier New"';
    ctx.textAlign = 'center';
    for (let r = step; r <= maxR; r += step) {
      const ring: Vec[] = [];
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        ring.push({ x: Math.sin(a) * r, y: Math.cos(a) * r, z: 0 });
      }
      ctx.beginPath();
      this.polyline(ring, true);
      ctx.stroke();
      const lbl = this.proj({ x: 0, y: -r, z: 0 });
      if (lbl) { ctx.fillStyle = COL.RING_LABEL; ctx.fillText(`${r}`, lbl.x, lbl.y - 3); }
    }
    // Achsen N-S und O-W
    ctx.beginPath();
    this.line({ x: 0, y: -maxR, z: 0 }, { x: 0, y: maxR, z: 0 });
    this.line({ x: -maxR, y: 0, z: 0 }, { x: maxR, y: 0, z: 0 });
    ctx.stroke();
    ctx.font = 'bold 12px "Courier New"';
    for (const [t, x, y] of [['N', 0, 1], ['E', 1, 0], ['S', 0, -1], ['W', -1, 0]] as const) {
      const p = this.proj({ x: x * maxR, y: y * maxR, z: 0 });
      if (p) { ctx.fillStyle = 'rgba(0,255,136,0.5)'; ctx.fillText(t, p.x, p.y); }
    }
  }

  private drawRunways(runways: Runway[], labels: boolean): void {
    const { ctx } = this;
    const drawn = new Set<string>();
    for (const r of runways) {
      const key = [r.id, r.recipId].sort().join(':');
      if (drawn.has(key)) continue;
      drawn.add(key);
      const t = this.world(r.thresholdLat, r.thresholdLng), e = this.world(r.endLat, r.endLng);
      const lenNM = Math.hypot(e.x - t.x, e.y - t.y);
      if (lenNM < 1e-4) continue;
      const ux = (e.x - t.x) / lenNM, uy = (e.y - t.y) / lenNM;
      // Bahnkoordinaten (Meter längs/quer, rechts positiv) → Welt → Bild
      const P = (a: number, c: number) => {
        const p = this.proj({ x: t.x + (ux * a + uy * c) / 1852, y: t.y + (uy * a - ux * c) / 1852, z: t.z });
        return p ? { x: p.x, y: p.y } : null;
      };
      // Teil der Bahn vor der Kamera (Tiefe ist längs der Bahn linear); dahinter wird abgeschnitten
      const L = lenNM * 1852;
      const z0 = this.camSpace(t).z, z1 = this.camSpace(e).z, zMin = this.near * 1.5;
      if (z0 < zMin && z1 < zMin) continue;
      const aCut = z0 === z1 ? 0 : ((zMin - z0) / (z1 - z0)) * L;
      const clip: [number, number] = z0 >= zMin && z1 >= zMin ? [0, L] : z0 < zMin ? [aCut, L] : [0, aCut];
      // Maßstab am nächsten sichtbaren Punkt bestimmt, wie viel Markierung gezeichnet wird
      const pxPerM = this.focal / Math.max(zMin, Math.min(z0, z1)) / 1852;
      const widthM = Math.max(r.widthM, 3 / pxPerM);
      drawRunwayMarkings(ctx, P, L, widthM, r.id, r.recipId, pxPerM, COL.RWY_SURFACE, 'rgba(235,235,235,0.85)', clip);
    }
    if (!labels) return;
    ctx.fillStyle = COL.RWY_LABEL;
    ctx.font = '9px "Courier New"';
    ctx.textAlign = 'center';
    for (const r of runways) {
      const p = this.proj(this.world(r.thresholdLat, r.thresholdLng));
      // entfällt, sobald die aufgemalte Bezeichnung lesbar ist
      if (p && p.depth < Scene3DRenderer.distanceFor(40) && (9 * this.focal) / p.depth / 1852 < 10) ctx.fillText(r.id, p.x, p.y + 12);
    }
  }

  /** Gleitpfad (3°) vom Aufsetzpunkt hinaus, darunter der verlängerte Anflugkurs am Boden */
  private drawGlidePath(r: Runway): void {
    const { ctx } = this;
    const thr = this.world(r.thresholdLat, r.thresholdLng);
    const end = this.world(r.endLat, r.endLng);
    const dir = norm({ x: thr.x - end.x, y: thr.y - end.y, z: 0 });
    const angle = toRad(r.ils?.glideslopeAngle ?? 3);
    const far = { x: thr.x + dir.x * GLIDE_NM, y: thr.y + dir.y * GLIDE_NM, z: 0 };
    const top = { ...far, z: Math.tan(angle) * GLIDE_NM * this.altScale };
    ctx.lineWidth = 1;
    ctx.strokeStyle = COL.GLIDE_GROUND;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    this.line(thr, far);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = COL.GLIDE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this.line(thr, top);
    // Senkrechte alle 5 NM als Höhenmarke
    for (let d = 5; d <= GLIDE_NM; d += 5) {
      const g = { x: thr.x + dir.x * d, y: thr.y + dir.y * d, z: 0 };
      this.line(g, { ...g, z: (top.z * d) / GLIDE_NM });
    }
    ctx.stroke();
  }

  /** STAR-Wegpunkte auf Höhe ihrer Beschränkung; fehlende Höhen dazwischen interpoliert */
  private starPath(star: STAR): Vec[] {
    const alts = star.waypoints.map((_, i) => star.legs[i]?.altRestrictionFt);
    const known = alts.map((a, i) => (a !== undefined ? i : -1)).filter((i) => i >= 0);
    return star.waypoints.map((w, i) => {
      let alt = 0;
      if (known.length > 0) {
        const prev = [...known].reverse().find((k) => k <= i);
        const next = known.find((k) => k >= i);
        if (prev === undefined) alt = alts[next!]!;
        else if (next === undefined || next === prev) alt = alts[prev]!;
        else alt = alts[prev]! + ((alts[next]! - alts[prev]!) * (i - prev)) / (next - prev);
      }
      return this.world(w.lat, w.lng, alt);
    });
  }

  private drawStars(stars: STAR[]): void {
    const { ctx } = this;
    const labelled = new Set<string>();
    ctx.lineWidth = 1;
    for (const star of stars) {
      if (star.waypoints.length < 2) continue;
      const path = this.starPath(star);
      ctx.strokeStyle = COL.STAR_DROP;
      ctx.beginPath();
      for (const v of path) if (v.z > 0) this.line(v, { ...v, z: 0 });
      ctx.stroke();
      ctx.strokeStyle = COL.STAR;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      this.polyline(path);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = star.name ?? star.id;
      if (labelled.has(label)) continue;
      labelled.add(label);
      const p = this.proj(path[0]);
      if (p) {
        ctx.fillStyle = COL.STAR_LABEL;
        ctx.font = '8px "Courier New"';
        ctx.textAlign = 'left';
        ctx.fillText(label, p.x + 5, p.y - 4);
      }
    }
  }

  private drawWaypoints(waypoints: Waypoint[], labels: boolean): void {
    const { ctx } = this;
    ctx.lineWidth = 1;
    ctx.font = '9px "Courier New"';
    ctx.textAlign = 'left';
    for (const wp of waypoints) {
      const p = this.proj(this.world(wp.lat, wp.lng));
      if (!p || p.x < -20 || p.x > this.cssW + 20 || p.y < -20 || p.y > this.cssH + 20) continue;
      ctx.strokeStyle = COL.WP;
      ctx.beginPath();
      if (wp.type === 'vor' || wp.type === 'ndb') ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      else { ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x + 3.5, p.y + 2.5); ctx.lineTo(p.x - 3.5, p.y + 2.5); ctx.closePath(); }
      ctx.stroke();
      if (labels) { ctx.fillStyle = COL.WP_LABEL; ctx.fillText(wp.id, p.x + 6, p.y + 3); }
    }
  }

  // ── Flieger ────────────────────────────────────────────────────────────────
  private sampleTrails(o: RenderOptions): void {
    if (o.now - this.lastSample < TRAIL_SAMPLE_MS) return;
    this.lastSample = o.now;
    const seen = new Set<string>();
    const add = (id: string, v: Vec) => {
      seen.add(id);
      const t = this.trails.get(id) ?? [];
      t.push(v);
      if (t.length > TRAIL_MAX) t.shift();
      this.trails.set(id, t);
    };
    for (const ac of o.aircraft) add(ac.id, this.world(ac.lat, ac.lng, ac.altitudeFt));
    for (const ac of o.live?.aircraft ?? []) add(`live-${ac.hex}`, this.world(ac.lat, ac.lng, ac.altFt ?? 0));
    for (const id of this.trails.keys()) if (!seen.has(id)) this.trails.delete(id);
  }

  private drawTrail(id: string, rgb: string, n: number): void {
    const t = (this.trails.get(id) ?? []).slice(-n);
    t.forEach((v, i) => {
      const p = this.proj(v);
      if (!p) return;
      this.ctx.fillStyle = `rgba(${rgb},${((i + 1) / t.length) * 0.5})`;
      this.ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    });
  }

  private drawConflicts(o: RenderOptions): void {
    const pos = new Map<string, Vec>(o.aircraft.map((a) => [a.id, this.world(a.lat, a.lng, a.altitudeFt)]));
    for (const ac of o.live?.aircraft ?? []) pos.set(`live-${ac.hex}`, this.world(ac.lat, ac.lng, ac.altFt ?? 0));
    const { ctx } = this;
    for (const c of o.conflicts) {
      const a = pos.get(c.a), b = pos.get(c.b);
      if (!a || !b) continue;
      ctx.strokeStyle = c.type === 'conflict' ? COL.RED : COL.AMBER;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      this.line(a, b);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Alle Ziele von hinten nach vorn, damit nahe Flieger die fernen überdecken */
  private drawTargets(o: RenderOptions): void {
    type Item = { depth: number; draw: () => void };
    const items: Item[] = [];
    const trailN = Math.max(4, o.trailLength);
    for (const ac of o.aircraft) {
      const v = this.world(ac.lat, ac.lng, ac.altitudeFt);
      const c = this.camSpace(v);
      if (c.z < this.near) continue;
      const selected = ac.id === o.selectedId;
      const route = selected && ac.starId ? o.stars.find((s) => s.id === ac.starId) : undefined;
      items.push({ depth: c.z, draw: () => this.drawAircraft(ac, v, selected, o.display.labels, trailN, route) });
    }
    for (const ac of o.live?.aircraft ?? []) {
      const v = this.world(ac.lat, ac.lng, ac.altFt ?? 0);
      const c = this.camSpace(v);
      if (c.z < this.near) continue;
      const inbound = o.live!.inbound.get(ac.hex);
      const selected = o.selectedId === `live-${ac.hex}`;
      items.push({ depth: c.z, draw: () => {
        const color = inbound?.out ? COL.LIVE_OUTBOUND : inbound ? COL.LIVE_INBOUND : COL.LIVE;
        this.drawTrail(`live-${ac.hex}`, inbound?.out ? '255,190,90' : inbound ? '120,215,255' : '150,170,160', trailN);
        const p = this.drawStem(v, color, 0.25);
        if (!p) return;
        this.drawModel(v, ac.type, ac.track ?? 0, ac.vs ?? 0, ac.gs ?? 250, color, selected);
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 1;
        if (selected) { this.ctx.beginPath(); this.ctx.arc(p.x, p.y, 16, 0, Math.PI * 2); this.ctx.stroke(); }
        // Hat sich gemeldet: blinkender Ring
        if (inbound?.called && Math.floor(o.now / 500) % 2 === 0) { this.ctx.beginPath(); this.ctx.arc(p.x, p.y, 12, 0, Math.PI * 2); this.ctx.stroke(); }
        if (ac.altFt !== null && (selected || (o.display.labels && (inbound || ac.altFt < LIVE_LABEL_MAX_FT)))) {
          const fl = Math.round(ac.altFt / 100).toString().padStart(3, '0');
          const from = inbound?.out ? ` →${inbound.dest ?? ''}` : inbound ? ` ${inbound.guess ? '?' : inbound.origin ?? ''}` : '';
          this.ctx.fillStyle = color;
          this.ctx.font = '10px "Courier New"';
          this.ctx.textAlign = 'left';
          this.ctx.fillText(`${ac.callsign}${from}`, p.x + 8, p.y - 3);
          this.ctx.fillText(`FL${fl} ${ac.gs !== null ? Math.round(ac.gs) : ''}`, p.x + 8, p.y + 8);
        }
      } });
    }
    items.sort((a, b) => b.depth - a.depth).forEach((i) => i.draw());
  }

  /**
   * 3D-Flugzeugmodell an v: Kurs (rechtweisend), Längsneigung aus Steig-/Sinkrate (mit der Überhöhung),
   * in fester Bildgröße je Größenklasse, Flächen nach Tiefe sortiert und nach Lichteinfall schattiert
   */
  private drawModel(v: Vec, type: string | undefined, headingDeg: number, vsFpm: number, gsKts: number, color: string, selected: boolean): void {
    const c = this.camSpace(v);
    if (c.z < this.near) return;
    const shape = modelShape(type);
    // Fester Bildmaßstab je Meter, damit die Typen zueinander in echter Größe stehen
    const spanPx = Math.max(MODEL_MIN_SPAN_PX, shape.span * MODEL_PX_PER_M) * (selected ? 1.15 : 1);
    const scale = (spanPx * (c.z / this.focal)) / shape.span; // NM je Modellmeter
    const h = toRad(headingDeg);
    // Fluglage wie echt, nicht der Bahnwinkel: im Sinkflug/Anflug Nase leicht hoch (~2,5°), im Steigflug
    // je nach Steigrate bis ~15°, im Reiseflug fast waagerecht, am Boden (langsam) waagerecht
    const pitch = gsKts < 80 ? 0 : toRad(vsFpm < -300 ? 2.5 : vsFpm > 300 ? Math.min(15, 4 + (vsFpm / 3000) * 11) : 1.5);
    const f0 = { x: Math.sin(h), y: Math.cos(h), z: 0 };
    const fwd = { x: f0.x * Math.cos(pitch), y: f0.y * Math.cos(pitch), z: Math.sin(pitch) };
    const up = { x: -f0.x * Math.sin(pitch), y: -f0.y * Math.sin(pitch), z: Math.cos(pitch) };
    const right = { x: Math.cos(h), y: -Math.sin(h), z: 0 };
    const [cr, cg, cb] = toRgb(color);
    const light = norm({ x: -0.35, y: 0.45, z: 0.82 });
    const faces: Array<{ depth: number; pts: Pt[]; shade: number }> = [];
    for (const face of modelFaces(shape)) {
      const w = face.p.map(([f, r, u]) => ({
        x: v.x + (f * fwd.x + r * right.x + u * up.x) * scale,
        y: v.y + (f * fwd.y + r * right.y + u * up.y) * scale,
        z: v.z + (f * fwd.z + r * right.z + u * up.z) * scale,
      }));
      const pts = w.map((p) => this.proj(p));
      if (pts.some((p) => !p)) continue;
      const n = norm(cross(sub(w[1], w[0]), sub(w[2], w[0])));
      const shade = (0.5 + 0.5 * Math.abs(dot(n, light))) * face.tone;
      faces.push({ depth: pts.reduce((s, p) => s + p!.depth, 0) / pts.length, pts: pts as Pt[], shade });
    }
    const { ctx } = this;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.5;
    for (const fc of faces.sort((a, b) => b.depth - a.depth)) {
      const k = fc.shade;
      ctx.fillStyle = `rgb(${Math.round(cr * k)},${Math.round(cg * k)},${Math.round(cb * k)})`;
      ctx.strokeStyle = ctx.fillStyle; // schließt die Fugen zwischen den Flächen
      ctx.beginPath();
      fc.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Lot vom Flieger zum Boden mit Schattenpunkt; gibt die Bildposition des Fliegers zurück */
  private drawStem(v: Vec, color: string, alpha: number): Pt | null {
    const { ctx } = this;
    const p = this.proj(v);
    const g = this.proj({ ...v, z: 0 });
    if (!p) return null;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    this.line(v, { ...v, z: 0 });
    ctx.stroke();
    if (g) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(g.x, g.y, 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    return p;
  }

  private drawAircraft(ac: Aircraft, v: Vec, selected: boolean, labels: boolean, trailN: number, route?: STAR): void {
    const { ctx } = this;
    let color = COL.GREEN;
    if (ac.conflict) color = COL.RED;
    else if (ac.warning) color = COL.AMBER;
    else if (ac.state === 'established' || ac.state === 'intercepting') color = COL.BLUE;
    else if (ac.state === 'vectored') color = COL.YELLOW;

    // Restliche STAR-Route des ausgewählten Fliegers
    if (route && ac.state === 'enroute' && !ac.directTo && !ac.clearedILS) {
      const rest = this.starPath(route).slice(ac.starLegIndex ?? 0);
      if (rest.length > 0) {
        ctx.strokeStyle = 'rgba(200,150,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        this.polyline([v, ...rest]);
        ctx.stroke();
      }
    }
    if (selected && ac.directTo) {
      ctx.strokeStyle = 'rgba(255,220,80,0.6)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      this.line(v, this.world(ac.directTo.lat, ac.directTo.lng, ac.altitudeFt));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this.drawTrail(ac.id, '0,255,136', trailN);
    const p = this.drawStem(v, color, 0.45);
    if (!p) return;

    // Kleines 3D-Modell in Flugrichtung, nach Typ (Größe, 2 oder 4 Triebwerke)
    this.drawModel(v, ac.type, ac.headingDeg, ac.verticalSpeedFpm, ac.speedKts, color, selected);

    if (labels || selected) {
      const fl = Math.round(ac.altitudeFt / 100).toString().padStart(3, '0');
      const vs = ac.verticalSpeedFpm > 100 ? '↑' : ac.verticalSpeedFpm < -100 ? '↓' : '→';
      const wake = typeData(ac.type).wake;
      ctx.fillStyle = color;
      ctx.font = `${selected ? 'bold ' : ''}11px "Courier New"`;
      ctx.textAlign = 'left';
      ctx.fillText(ac.callsign + (wake === 'H' || wake === 'J' ? ` ${wake}` : ''), p.x + 15, p.y - 4);
      ctx.fillText(`FL${fl} ${vs} ${Math.round(ac.speedKts)}kt`, p.x + 15, p.y + 8);
      if (ac.clearedILS && ac.assignedRunway) {
        ctx.fillStyle = ac.clearedToLand ? '#00ff88' : ac.state === 'established' ? '#ffaa00' : '#4488ff';
        ctx.fillText(`${ac.clearedToLand ? 'LND' : 'ILS'}${ac.assignedRunway}`, p.x + 15, p.y + 20);
      }
    }
    if (selected) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ── Anzeige: Maßstab, Blickrichtung, Kompass ─────────────────────────────
  private drawHud(o: RenderOptions, cam: Camera3D): void {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0,255,136,0.45)';
    ctx.font = '11px "Courier New"';
    ctx.textAlign = 'left';
    const hdg = Math.round(((cam.yaw % 360) + 360) % 360).toString().padStart(3, '0');
    ctx.fillText(`3D  ${o.rangeNM.toFixed(o.rangeNM < 2 ? 1 : 0)} NM  HDG ${hdg}  TILT ${Math.round(cam.pitch)}°  ALT ×${this.altScale}`, 8, 18);
    const credit = sourceCredit(o);
    if (credit) {
      ctx.fillStyle = 'rgba(150,170,160,0.6)';
      ctx.fillText(credit, 8, this.cssH - 8);
    }
    // Kompassrose oben rechts: Pfeil zeigt nach Norden
    const cx = this.cssW - 28, cy = 28;
    ctx.strokeStyle = 'rgba(0,255,136,0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, 16, 0, Math.PI * 2);
    ctx.stroke();
    const a = -toRad(cam.yaw);
    ctx.fillStyle = 'rgba(0,255,136,0.8)';
    ctx.beginPath();
    ctx.moveTo(cx + Math.sin(a) * 13, cy - Math.cos(a) * 13);
    ctx.lineTo(cx + Math.sin(a + 2.6) * 7, cy - Math.cos(a + 2.6) * 7);
    ctx.lineTo(cx + Math.sin(a - 2.6) * 7, cy - Math.cos(a - 2.6) * 7);
    ctx.closePath();
    ctx.fill();
    ctx.font = 'bold 9px "Courier New"';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx + Math.sin(a) * 23, cy - Math.cos(a) * 23 + 3);
  }
}

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec, b: Vec): Vec => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: Vec): Vec => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
/** Punkt auf der Strecke a→b (Kameraraum), an dem z die Nahebene erreicht */
function lerpToNear(a: Vec, b: Vec, near: number): Vec {
  const t = (near - a.z) / (b.z - a.z);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: near };
}

/** "#rrggbb" oder "rgb(a)(r,g,b[,a])" → [r, g, b] */
function toRgb(color: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  const n = color.match(/[\d.]+/g)?.map(Number) ?? [200, 200, 200];
  return [n[0], n[1], n[2]];
}
