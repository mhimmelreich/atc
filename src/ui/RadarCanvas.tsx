// filepath: src/ui/RadarCanvas.tsx
import { useEffect, useRef, useCallback } from 'react';
import type { GameEngine } from '@/game/GameEngine';
import type { Aircraft } from '@/types/aircraft';

interface Props {
  engine: GameEngine | null;
  aircraft: Aircraft[];
  selectedId: string | null;
  onSelectAircraft: (id: string | null) => void;
  onContextMenu: (aircraft: Aircraft, x: number, y: number) => void;
  /** 3D-Ansicht statt Radar */
  view3D: boolean;
}

type Target = { id: string; lat: number; lng: number; altitudeFt: number };
type ToScreen = (t: Target) => { x: number; y: number } | null;

/** Bildposition eines Ziels: Radar (2D) oder perspektivisch (3D), in CSS px relativ zum Canvas */
function projector(engine: GameEngine, canvas: HTMLCanvasElement): ToScreen {
  if (engine.view3D) return (t) => engine.project3D(t.lat, t.lng, t.altitudeFt);
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width, rect.height) / (engine.rangeNM * 2); // px per NM
  const cosLat = Math.cos((engine.viewLat * Math.PI) / 180);
  return (t) => ({
    x: rect.width / 2 + (t.lng - engine.viewLng) * 60 * cosLat * scale,
    y: rect.height / 2 - (t.lat - engine.viewLat) * 60 * scale,
  });
}

/** Nächstes Ziel unter dem Mauszeiger */
function hitTestAircraft<T extends Target>(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement,
  toScreen: ToScreen,
  aircraft: T[],
  threshold = 22
): T | null {
  const rect = canvas.getBoundingClientRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  let best: T | null = null;
  let bestDist = threshold;
  for (const ac of aircraft) {
    const p = toScreen(ac);
    if (!p) continue;
    const dist = Math.hypot(p.x - cx, p.y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = ac;
    }
  }
  return best;
}

export function RadarCanvas({ engine, aircraft, selectedId, onSelectAircraft, onContextMenu, view3D }: Props) {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Gesten (kein React-State, kein Re-Render nötig): alle aktiven Zeiger, Art des Ziehens, Strecke
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{ mode: 'none' | 'pan' | 'orbit'; moved: number }>({ mode: 'none', moved: 0 });

  useEffect(() => {
    if (!engine || !canvasRef.current) return;
    engine.attachCanvas(canvasRef.current);
  }, [engine]);

  useEffect(() => { engine?.setView3D(view3D); }, [engine, view3D]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || !engine) return;
    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      engine.resizeCanvas(width, height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [engine]);

  // ── Wheel zoom ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !engine) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.15 : 0.87;
      engine.adjustRange(factor);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [engine]);

  /** Flieger oder übernehmbaren echten Anflug unter dem Zeiger */
  const hitAt = useCallback(
    (clientX: number, clientY: number, threshold = 22): { own: Aircraft | null; live: Target | null } => {
      const canvas = canvasRef.current;
      if (!canvas || !engine) return { own: null, live: null };
      const toScreen = projector(engine, canvas);
      const own = hitTestAircraft(clientX, clientY, canvas, toScreen, aircraft, threshold);
      const live = own ? null : hitTestAircraft(clientX, clientY, canvas, toScreen, engine.liveTargets(), threshold);
      return { own, live };
    },
    [engine, aircraft]
  );

  // ── Pointer: Klick wählt aus, Ziehen verschiebt; in 3D rechte Taste / Shift / zwei Finger drehen und neigen ──
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !engine) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);

      if (pointersRef.current.size >= 2) {
        // Zweiter Finger: Geste statt Verschieben
        dragRef.current = { mode: 'orbit', moved: 0 };
        return;
      }
      if (e.button === 2) {
        // Rechte Taste: in 3D drehen, sonst öffnet onContextMenu das Menü
        dragRef.current = { mode: engine.view3D ? 'orbit' : 'none', moved: 0 };
        return;
      }
      if (e.button === 0 && !e.shiftKey) {
        const { own, live } = hitAt(e.clientX, e.clientY);
        // Sonst ein echter Anflug (LIVE): der Klick übernimmt ihn
        const target = own ?? live;
        if (target) {
          onSelectAircraft(target.id);
          engine.selectAircraft(target.id);
          dragRef.current = { mode: 'none', moved: 0 };
          return; // don't start drag on aircraft click
        }
      }
      dragRef.current = { mode: engine.view3D && e.shiftKey ? 'orbit' : 'pan', moved: 0 };
    },
    [engine, hitAt, onSelectAircraft]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const pointers = pointersRef.current;
      const prev = pointers.get(e.pointerId);
      if (!prev || !engine || !canvasRef.current) return;
      const drag = dragRef.current;

      if (pointers.size >= 2) {
        // Zwei Finger: Abstand = Zoom, Drehung = Spin, gemeinsames Hoch/Runter = Neigen
        const [a, b] = [...pointers.entries()].slice(0, 2);
        const other = a[0] === e.pointerId ? b[1] : a[1];
        const before = { dx: prev.x - other.x, dy: prev.y - other.y };
        const after = { dx: e.clientX - other.x, dy: e.clientY - other.y };
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const d0 = Math.hypot(before.dx, before.dy), d1 = Math.hypot(after.dx, after.dy);
        if (d0 > 0 && d1 > 0) engine.adjustRange(d0 / d1);
        if (engine.view3D) {
          const ang = Math.atan2(after.dy, after.dx) - Math.atan2(before.dy, before.dx);
          const wrapped = Math.atan2(Math.sin(ang), Math.cos(ang));
          engine.orbit3D((-wrapped * 180) / Math.PI, (e.clientY - prev.y) * 0.25);
        }
        return;
      }

      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      drag.moved += Math.abs(dx) + Math.abs(dy);

      if (drag.mode === 'orbit') {
        engine.orbit3D(dx * 0.3, dy * 0.3);
      } else if (drag.mode === 'pan') {
        if (engine.view3D) { engine.pan3D(dx, dy); return; }
        const rect = canvasRef.current.getBoundingClientRect();
        const pxPerNM = Math.min(rect.width, rect.height) / (engine.rangeNM * 2);
        // dx>0 = drag right = content moves right = view moves east → viewLng decreases
        // dy>0 = drag down  = content moves down  = view moves north → viewLat increases
        engine.pan(dx / pxPerNM, dy / pxPerNM);
      }
    },
    [engine]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId);
    canvasRef.current?.releasePointerCapture(e.pointerId);
    // Ein Finger bleibt liegen: nicht plötzlich verschieben
    if (pointersRef.current.size === 0) dragRef.current.mode = 'none';
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas || !engine) return;
      // Nach dem Drehen mit der rechten Taste kein Menü
      if (engine.view3D && dragRef.current.moved > 6) return;
      const { own, live } = hitAt(e.clientX, e.clientY, 28);
      let hit = own;
      if (!hit && live) {
        // Echter Anflug (LIVE): übernehmen und gleich das Menü öffnen
        engine.selectAircraft(live.id);
        hit = engine.getSelectedAircraft() ?? null;
      }
      if (!hit) return;

      // Compute aircraft's screen position and open menu in the farthest viewport corner
      const rect = canvas.getBoundingClientRect();
      const p = projector(engine, canvas)(hit) ?? { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const acX = rect.left + p.x;
      const acY = rect.top + p.y;

      // Default: bottom-right of aircraft; fall back to top-left if no space
      const MENU_W = 240, MENU_H = 420, OFFSET = 28;
      let mx = acX + OFFSET;
      let my = acY + OFFSET;
      if (mx + MENU_W > window.innerWidth || my + MENU_H > window.innerHeight) {
        mx = acX - MENU_W - OFFSET;
        my = acY - MENU_H - OFFSET;
      }

      onContextMenu(hit, mx, my);
    },
    [engine, hitAt, onContextMenu]
  );

  void selectedId;

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, position: 'relative', minHeight: 0, background: '#050e1a' }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={handleContextMenu}
        style={{ display: 'block', width: '100%', height: '100%', cursor: view3D ? 'grab' : 'crosshair', touchAction: 'none' }}
      />
      {view3D && engine && <ViewControls engine={engine} />}
    </div>
  );
}

/** Knöpfe für Drehen, Neigen und Zoomen (vor allem für Touch ohne zweite Hand) */
function ViewControls({ engine }: { engine: GameEngine }) {
  const btn = (label: string, title: string, act: () => void) => (
    <button
      key={label}
      title={title}
      onPointerDown={(e) => {
        e.preventDefault();
        act();
        // Gedrückt halten wiederholt
        const t = window.setInterval(act, 60);
        const stop = () => { window.clearInterval(t); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
      }}
      style={{
        width: 30, height: 30, background: 'rgba(5,20,12,0.85)', border: '1px solid #1a4428', color: '#00cc66',
        fontFamily: '"Courier New", monospace', fontSize: 14, cursor: 'pointer', borderRadius: 2, padding: 0, touchAction: 'none',
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ position: 'absolute', right: 8, bottom: 8, display: 'grid', gridTemplateColumns: 'repeat(3, 30px)', gap: 3 }}>
      {btn('⟲', 'Nach links drehen', () => engine.orbit3D(-3, 0))}
      {btn('▲', 'Steiler von oben', () => engine.orbit3D(0, 2))}
      {btn('⟳', 'Nach rechts drehen', () => engine.orbit3D(3, 0))}
      {btn('+', 'Heranzoomen', () => engine.adjustRange(0.95))}
      {btn('▼', 'Flacher', () => engine.orbit3D(0, -2))}
      {btn('−', 'Wegzoomen', () => engine.adjustRange(1.05))}
      <div />
      {btn('⌂', 'Ansicht zurücksetzen', () => { engine.resetCamera(); engine.resetView(); })}
      <div />
    </div>
  );
}
