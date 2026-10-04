// filepath: src/game/Scene3DRenderer.ts
import type { Aircraft } from '@/types/aircraft';
import type { Runway } from '@/types/airport';
import type { STAR, Waypoint } from '@/types/navdata';
import type { RenderOptions } from './RadarRenderer';
import { destinationPoint, toRad } from '@/utils/geo';
import { typeData } from './constants';
import { aircraftSilhouette } from './aircraftSymbol';

/** Höhen werden überhöht, sonst liegt bei 80 NM alles platt am Boden */
export const ALT_EXAGGERATION = 4;
const FT_PER_NM = 6076;
const FOV_DEG = 50;
const GLIDE_NM = 15;
const TRAIL_SAMPLE_MS = 4000;
const TRAIL_MAX = 24;
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
      z: (Math.max(0, altFt) / FT_PER_NM) * ALT_EXAGGERATION,
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
    this.drawRunways(o.airport.runways, o.display.labels);
    if (o.display.ilsCones) {
      for (const r of o.airport.runways) {
        if (r.ils && r.role !== 'departure' && o.activeRunwayIds.includes(r.id)) this.drawGlidePath(r, o.airport.elevationFt);
      }
    }
    if (o.display.stars) this.drawStars(o.stars);
    if (o.display.waypoints) this.drawWaypoints(o.waypoints, o.display.labels);

    this.sampleTrails(o);
    this.drawConflicts(o);
    this.drawTargets(o);
    this.drawHud(o, cam);
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
    ctx.strokeStyle = COL.RWY;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const r of runways) this.line(this.world(r.thresholdLat, r.thresholdLng), this.world(r.endLat, r.endLng));
    ctx.stroke();
    if (!labels) return;
    ctx.fillStyle = COL.RWY_LABEL;
    ctx.font = '9px "Courier New"';
    ctx.textAlign = 'center';
    for (const r of runways) {
      const p = this.proj(this.world(r.thresholdLat, r.thresholdLng));
      if (p && p.depth < Scene3DRenderer.distanceFor(40)) ctx.fillText(r.id, p.x, p.y + 12);
    }
  }

  /** Gleitpfad (3°) vom Aufsetzpunkt hinaus, darunter der verlängerte Anflugkurs am Boden */
  private drawGlidePath(r: Runway, elevFt: number): void {
    const { ctx } = this;
    const thr = this.world(r.thresholdLat, r.thresholdLng);
    const end = this.world(r.endLat, r.endLng);
    const dir = norm({ x: thr.x - end.x, y: thr.y - end.y, z: 0 });
    const angle = toRad(r.ils?.glideslopeAngle ?? 3);
    const far = { x: thr.x + dir.x * GLIDE_NM, y: thr.y + dir.y * GLIDE_NM, z: 0 };
    const top = { ...far, z: (((Math.tan(angle) * GLIDE_NM * FT_PER_NM) + elevFt) / FT_PER_NM) * ALT_EXAGGERATION };
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
    const trailN = Math.max(4, o.trailLength * 2);
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
      items.push({ depth: c.z, draw: () => {
        const color = inbound ? COL.LIVE_INBOUND : COL.LIVE;
        this.drawTrail(`live-${ac.hex}`, inbound ? '120,215,255' : '150,170,160', trailN);
        const p = this.drawStem(v, color, 0.25);
        if (!p) return;
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(p.x - 3, p.y - 3, 6, 6);
        if (inbound?.called && Math.floor(o.now / 500) % 2 === 0) { this.ctx.fillStyle = color; this.ctx.fillRect(p.x - 3, p.y - 3, 6, 6); }
        if (o.display.labels && ac.altFt !== null && (inbound || ac.altFt < LIVE_LABEL_MAX_FT)) {
          const fl = Math.round(ac.altFt / 100).toString().padStart(3, '0');
          const from = inbound ? ` ${inbound.guess ? '?' : inbound.origin ?? ''}` : '';
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

    // Symbol zeigt die Flugrichtung, wie sie aus dieser Perspektive erscheint
    const ahead = destinationPoint(ac.lat, ac.lng, ac.headingDeg, 1);
    const q = this.proj(this.world(ahead.lat, ahead.lng, ac.altitudeFt));
    const rot = q ? Math.atan2(q.x - p.x, -(q.y - p.y)) : 0;
    const size = selected ? 12 : 10;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(rot);
    ctx.fillStyle = color;
    aircraftSilhouette(ctx, size);
    ctx.fill();
    if (selected) { ctx.strokeStyle = COL.WHITE; ctx.lineWidth = 1.5; ctx.stroke(); }
    ctx.restore();

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
    ctx.fillText(`3D  ${o.rangeNM.toFixed(0)} NM  HDG ${hdg}  TILT ${Math.round(cam.pitch)}°  ALT ×${ALT_EXAGGERATION}`, 8, 18);
    if (o.live) {
      ctx.fillStyle = 'rgba(150,170,160,0.6)';
      ctx.fillText('Traffic: adsb.lol (ODbL)', 8, this.cssH - 8);
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
