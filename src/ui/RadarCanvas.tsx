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
}

/** Convert CSS-pixel canvas position to hit-test aircraft, using engine view state. */
function hitTestAircraft<T extends { lat: number; lng: number }>(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement,
  viewLat: number,
  viewLng: number,
  rangeNM: number,
  aircraft: T[],
  threshold = 22
): T | null {
  const rect = canvas.getBoundingClientRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  const W = rect.width;   // CSS pixels
  const H = rect.height;
  const scale = Math.min(W, H) / (rangeNM * 2); // px per NM
  const cosLat = Math.cos((viewLat * Math.PI) / 180);

  let best: T | null = null;
  let bestDist = threshold;

  for (const ac of aircraft) {
    const northNM = (ac.lat - viewLat) * 60;
    const eastNM  = (ac.lng - viewLng) * 60 * cosLat;
    const x = W / 2 + eastNM * scale;
    const y = H / 2 - northNM * scale;
    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      best = ac;
    }
  }
  return best;
}

export function RadarCanvas({ engine, aircraft, selectedId, onSelectAircraft, onContextMenu }: Props) {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Drag state (not React state — no re-render needed)
  const dragRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false, lastX: 0, lastY: 0,
  });

  useEffect(() => {
    if (!engine || !canvasRef.current) return;
    engine.attachCanvas(canvasRef.current);
  }, [engine]);

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

  // ── Pointer drag pan ────────────────────────────────────────────────────────
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.button === 2) return; // right-click handled via onContextMenu

      const canvas = canvasRef.current;
      if (!canvas || !engine) return;

      if (e.button === 0) {
        // Check if clicking an aircraft first
        const hit = hitTestAircraft(
          e.clientX, e.clientY, canvas,
          engine.viewLat, engine.viewLng, engine.rangeNM, aircraft
        );
        // Sonst ein echter Anflug (LIVE): der Klick übernimmt ihn
        const target = hit ?? hitTestAircraft(
          e.clientX, e.clientY, canvas,
          engine.viewLat, engine.viewLng, engine.rangeNM, engine.liveTargets()
        );
        if (target) {
          onSelectAircraft(target.id);
          engine.selectAircraft(target.id);
          return; // don't start drag on aircraft click
        }
      }

      // Start drag pan
      dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    },
    [engine, aircraft, onSelectAircraft]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag.active || !engine || !canvasRef.current) return;

      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;

      const rect = canvasRef.current.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      const pxPerNM = Math.min(W, H) / (engine.rangeNM * 2);
      // dx>0 = drag right = content moves right = view moves east → viewLng decreases
      // dy>0 = drag down  = content moves down  = view moves north → viewLat increases
      engine.pan(dx / pxPerNM, dy / pxPerNM);
    },
    [engine]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current.active = false;
    canvasRef.current?.releasePointerCapture(e.pointerId);
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas || !engine) return;
      let hit = hitTestAircraft(
        e.clientX, e.clientY, canvas,
        engine.viewLat, engine.viewLng, engine.rangeNM, aircraft, 28
      );
      if (!hit) {
        // Echter Anflug (LIVE): übernehmen und gleich das Menü öffnen
        const target = hitTestAircraft(
          e.clientX, e.clientY, canvas,
          engine.viewLat, engine.viewLng, engine.rangeNM, engine.liveTargets(), 28
        );
        if (target) {
          engine.selectAircraft(target.id);
          hit = engine.getSelectedAircraft() ?? null;
        }
      }
      if (!hit) return;

      // Compute aircraft's screen position and open menu in the farthest viewport corner
      const rect = canvas.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      const scale = Math.min(W, H) / (engine.rangeNM * 2);
      const cosLat = Math.cos(engine.viewLat * Math.PI / 180);
      const northNM = (hit.lat - engine.viewLat) * 60;
      const eastNM  = (hit.lng - engine.viewLng) * 60 * cosLat;
      const acX = rect.left + W / 2 + eastNM * scale;
      const acY = rect.top  + H / 2 - northNM * scale;

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
    [engine, aircraft, onContextMenu]
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
        style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair', touchAction: 'none' }}
      />
    </div>
  );
}
