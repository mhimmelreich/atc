// filepath: src/ui/ContextMenu.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Aircraft, ATCCommand } from '@/types/aircraft';
import type { Airport } from '@/types/airport';
import type { STAR, Waypoint } from '@/types/navdata';
import { distanceNM } from '@/utils/geo';
import { getILSStatusForRunway } from '@/game/ILS';
import { normaliseHdg, headingDiff } from '@/utils/aviation';
import { AIRCRAFT_TYPES } from '@/game/constants';

export interface ContextMenuState {
  x: number;
  y: number;
  aircraft: Aircraft;
}

interface Props {
  menu: ContextMenuState;
  airport: Airport | null;
  onCommand: (id: string, cmd: ATCCommand) => void;
  onClose: () => void;
  onHeadingPreview?: (aircraftId: string, hdg: number | null, direction?: 'left' | 'right') => void;
  onAltitudePreview?: (aircraftId: string, alt: number | null) => void;
  pendingCmdTypes?: string[];   // command types queued but not yet executed
  activeRunwayIds?: string[];
  waypoints?: Waypoint[];
  stars?: STAR[];
}

const MENU_STYLE: React.CSSProperties = {
  position: 'fixed',
  background: '#070f0a',
  border: '1px solid #1a5530',
  borderRadius: 4,
  width: 248,
  zIndex: 1000,
  fontFamily: '"Courier New", monospace',
  fontSize: 12,
  boxShadow: '0 4px 20px rgba(0,0,0,0.8)',
  overflowX: 'hidden',
  overflowY: 'auto',
};

const SECTION_STYLE: React.CSSProperties = {
  color: '#2a5535',
  fontSize: 10,
  letterSpacing: 1.5,
  padding: '6px 10px 3px',
  borderTop: '1px solid #0a2a15',
  userSelect: 'none',
};

const ITEM_STYLE: React.CSSProperties = {
  padding: '6px 12px',
  cursor: 'pointer',
  color: '#00cc66',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 16,
};

const ITEM_HOVER = '#0d2a18';

export function ContextMenu({ menu, airport, onCommand, onClose, onHeadingPreview, onAltitudePreview, pendingCmdTypes = [], activeRunwayIds = [], waypoints = [], stars = [] }: Props) {
  const { aircraft: ac } = menu;
  const ref = useRef<HTMLDivElement>(null);
  const [entryId, setEntryId] = useState<string | null>(null);
  const starListRef = useRef<HTMLDivElement>(null);
  // STAR-Auswahl nach Wahl des Anflugpunkts sichtbar machen (Menü scrollt)
  useEffect(() => { if (entryId) starListRef.current?.scrollIntoView({ block: 'nearest' }); }, [entryId]);

  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Show heading arc and altitude circle for active (not yet reached) targets on open
  useEffect(() => {
    const hdgDiff = Math.abs(headingDiff(ac.headingDeg, ac.targetHeading));
    if (hdgDiff > 2) {
      onHeadingPreview?.(ac.id, ac.targetHeading, ac.turnDirection);
    }
    if (Math.abs(ac.altitudeFt - ac.targetAltitude) > 100) {
      onAltitudePreview?.(ac.id, ac.targetAltitude);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Position computed in RadarCanvas — clamp to viewport as safety net
  const x = Math.max(4, Math.min(menu.x, window.innerWidth  - 234));
  const y = Math.max(4, Math.min(menu.y, window.innerHeight - 424));

  const cmd = (c: ATCCommand) => { onCommand(ac.id, c); onClose(); };
  const typeData = AIRCRAFT_TYPES[ac.type];
  const approachSpd = typeData?.approachKts ?? 140;

  // Alle ILS-Bahnen der aktiven Richtung (ohne aktive Auswahl: alle ILS-Bahnen)
  const ilsRunways = airport?.runways.filter((rwy) =>
    rwy.ils && (activeRunwayIds.length === 0 || activeRunwayIds.includes(rwy.id)),
  ) ?? [];
  const landPending = pendingCmdTypes.includes('land');

  // Direct-to: restliche Punkte der eigenen STAR, dann die nächstgelegenen übrigen Wegpunkte
  const star = ac.starId ? stars.find((st) => st.id === ac.starId) : undefined;
  const starRest = star ? star.waypoints.slice(ac.starLegIndex ?? 0).slice(0, 6) : [];
  const nearest = waypoints
    .filter((w) => !starRest.some((sw) => sw.id === w.id))
    .map((w) => ({ w, dist: distanceNM(ac.lat, ac.lng, w.lat, w.lng) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 6);
  const sendDirect = (w: Waypoint) => cmd({ type: 'direct', waypointId: w.id, lat: w.lat, lng: w.lng });

  // Anflugpunkt → STAR: Startpunkte der STARs der aktiven Bahnen, danach die STARs über den gewählten Punkt
  const activeStars = (() => {
    const m = stars.filter((st) => st.runway === 'ALL' || activeRunwayIds.includes(st.runway));
    return m.length > 0 ? m : stars;
  })();
  const starPoints = [...new Map(activeStars.flatMap((st) => st.waypoints).map((w) => [w.id, w])).values()];
  const entryPoints = [...new Map(activeStars.map((st) => [st.waypoints[0].id, st.waypoints[0]])).values()]
    .map((w) => ({ w, dist: distanceNM(ac.lat, ac.lng, w.lat, w.lng) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 9);
  const entryGroups = [...activeStars
    .filter((st) => entryId && st.waypoints.some((w) => w.id === entryId))
    .reduce((m, st) => m.set(st.name ?? st.id, [...(m.get(st.name ?? st.id) ?? []), st]), new Map<string, STAR[]>())];
  const starPending = pendingCmdTypes.includes('star');

  return (
    <div ref={ref} style={{ ...MENU_STYLE, left: x, top: y, maxHeight: `calc(100vh - ${y + 4}px)` }}>
      {/* Header */}
      <div style={{
        padding: '7px 12px', background: '#0a1f12', color: '#00ff88',
        fontWeight: 'bold', fontSize: 13,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span>{ac.callsign}</span>
        <span style={{ color: '#446644', fontSize: 11, fontWeight: 'normal' }}>
          {ac.type} · FL{Math.round(ac.altitudeFt / 100).toString().padStart(3, '0')} · {Math.round(ac.speedKts)}kt
        </span>
      </div>

      {/* ── HEADING ── */}
      <div style={SECTION_STYLE}>
        HEADING
        <CmdStatus
          current={`${String(Math.round(ac.headingDeg)).padStart(3,'0')}°`}
          target={`${String(Math.round(ac.targetHeading)).padStart(3,'0')}°`}
          active={Math.abs(ac.headingDeg - ac.targetHeading) > 2 &&
                  Math.abs(((ac.headingDeg - ac.targetHeading + 540) % 360) - 180) > 2}
          pending={pendingCmdTypes.includes('heading')}
          tendency={(() => {
            const d = ((ac.targetHeading - ac.headingDeg + 540) % 360) - 180;
            return d > 0 ? '↻' : '↺';
          })()}
        />
      </div>
      <ScrollableValue
        initial={Math.round(ac.headingDeg)}
        step={1} stepShift={10}
        min={1} max={360} wrap
        format={(v) => `${String(v).padStart(3, '0')}°`}
        unit="HDG"
        onSend={(v, dir) => cmd({ type: 'heading', value: v, turnDirection: dir })}
        onPreviewDelta={(d) => {
          if (d === null) { onHeadingPreview?.(ac.id, null); return; }
          const absHdg = normaliseHdg(Math.round(ac.headingDeg) + d);
          const dir = d > 0 ? 'right' : d < 0 ? 'left' : undefined;
          onHeadingPreview?.(ac.id, absHdg, dir);
        }}
      />
      <div style={{ display: 'flex' }}>
        {([-30, -90, 90, 30] as const).map((delta) => (
          <HoverItem
            key={delta}
            style={{ ...ITEM_STYLE, flex: 1, justifyContent: 'center', fontSize: 11, padding: '5px 4px' }}
            hoverBg={ITEM_HOVER}
            onClick={() => cmd({ type: 'heading', value: normaliseHdg(ac.headingDeg + delta), turnDirection: delta > 0 ? 'right' : 'left' })}
          >
            {delta > 0 ? `R${delta}°` : `L${Math.abs(delta)}°`}
          </HoverItem>
        ))}
      </div>

      {/* ── ALTITUDE ── */}
      <div style={SECTION_STYLE}>
        ALTITUDE
        <CmdStatus
          current={`FL${String(Math.round(ac.altitudeFt / 100)).padStart(3, '0')}`}
          target={`FL${String(Math.round(ac.targetAltitude / 100)).padStart(3, '0')}`}
          active={Math.abs(ac.altitudeFt - ac.targetAltitude) > 100}
          pending={pendingCmdTypes.includes('altitude')}
          tendency={ac.targetAltitude > ac.altitudeFt ? '▲' : '▼'}
        />
      </div>
      <ScrollableValue
        initial={Math.round(ac.altitudeFt / 1000) * 1000}
        step={1000} stepShift={100}
        min={1000} max={41000}
        format={(v) => `FL${String(v / 100).padStart(3, '0')}`}
        unit="ALT"
        onSend={(v) => cmd({ type: 'altitude', value: v })}
        onPreview={(v) => onAltitudePreview?.(ac.id, v)}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {[12000, 10000, 8000, 6000, 5000, 4000].map((alt) => (
          <HoverItem
            key={alt}
            style={{ ...ITEM_STYLE, flex: '0 0 33%', justifyContent: 'center', fontSize: 11, padding: '5px 4px' }}
            hoverBg={ITEM_HOVER}
            onClick={() => cmd({ type: 'altitude', value: alt })}
          >
            FL{String(alt / 100).padStart(3, '0')}
          </HoverItem>
        ))}
      </div>

      {/* ── SPEED ── */}
      <div style={SECTION_STYLE}>
        SPEED
        <CmdStatus
          current={`${Math.round(ac.speedKts)}kt`}
          target={`${Math.round(ac.targetSpeed)}kt`}
          active={Math.abs(ac.speedKts - ac.targetSpeed) > 5}
          pending={pendingCmdTypes.includes('speed')}
          tendency={ac.targetSpeed > ac.speedKts ? '▲' : '▼'}
        />
      </div>
      <ScrollableValue
        initial={Math.round(ac.speedKts)}
        step={5} stepShift={10}
        min={80} max={350}
        format={(v) => `${v} kt`}
        unit="SPD"
        onSend={(v) => cmd({ type: 'speed', value: v })}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {[280, 250, 220, 180, approachSpd].map((spd) => (
          <HoverItem
            key={spd}
            style={{ ...ITEM_STYLE, flex: '0 0 33%', justifyContent: 'center', fontSize: 11, padding: '5px 4px' }}
            hoverBg={ITEM_HOVER}
            onClick={() => cmd({ type: 'speed', value: spd })}
          >
            {spd}kt
          </HoverItem>
        ))}
      </div>

      {/* ── DIRECT TO ── */}
      {(starRest.length > 0 || nearest.length > 0) && (
        <>
          <div style={SECTION_STYLE}>
            DIRECT TO
            <span style={{ float: 'right', fontSize: 10, fontWeight: 'normal', letterSpacing: 0,
              color: pendingCmdTypes.includes('direct') ? '#ffaa00' : '#00cc66' }}>
              {pendingCmdTypes.includes('direct') ? '⧖ ' : ''}
              {ac.directTo ? `DCT ${ac.directTo.id}` : star && ac.state === 'enroute' ? (star.name ?? star.id) : ''}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {starRest.map((w) => (
              <HoverItem key={`s-${w.id}`} hoverBg={ITEM_HOVER} onClick={() => sendDirect(w)}
                style={{ ...ITEM_STYLE, flex: '0 0 33%', justifyContent: 'center', fontSize: 11, padding: '5px 4px', color: '#b478ff', boxSizing: 'border-box' }}>
                {w.id}
              </HoverItem>
            ))}
            {nearest.map(({ w, dist }) => (
              <HoverItem key={`n-${w.id}`} hoverBg={ITEM_HOVER} onClick={() => sendDirect(w)}
                style={{ ...ITEM_STYLE, flex: '0 0 33%', justifyContent: 'center', gap: 4, fontSize: 11, padding: '5px 4px', boxSizing: 'border-box' }}>
                <span>{w.id}</span>
                <span style={{ color: '#2a7745', fontSize: 9 }}>{Math.round(dist)}</span>
              </HoverItem>
            ))}
          </div>
          <FixInput waypoints={waypoints} onSend={sendDirect} />
        </>
      )}

      {/* ── ANFLUGPUNKT → STAR ── */}
      {entryPoints.length > 0 && (
        <>
          <div style={SECTION_STYLE}>
            ENTRY → STAR
            <span style={{ float: 'right', fontSize: 10, fontWeight: 'normal', letterSpacing: 0,
              color: starPending ? '#ffaa00' : '#b478ff' }}>
              {starPending ? '⧖ ' : ''}
              {star && ac.state === 'enroute' && !ac.directTo ? (star.name ?? star.id) : ''}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {entryPoints.map(({ w, dist }) => (
              <HoverItem key={`e-${w.id}`} hoverBg={ITEM_HOVER} onClick={() => setEntryId(entryId === w.id ? null : w.id)}
                style={{ ...ITEM_STYLE, flex: '0 0 33%', justifyContent: 'center', gap: 4, fontSize: 11, padding: '5px 4px',
                  color: '#b478ff', boxSizing: 'border-box', background: entryId === w.id ? '#24153a' : 'transparent' }}>
                <span>{w.id}</span>
                <span style={{ color: '#6a4a90', fontSize: 9 }}>{Math.round(dist)}</span>
              </HoverItem>
            ))}
          </div>
          <FixInput waypoints={starPoints} placeholder="Anflugpunkt eingeben + Enter" onSend={(w) => setEntryId(w.id)} />
          {/* STARs über den gewählten Punkt; Bahnvarianten derselben STAR als Buttons */}
          <div ref={starListRef}>
            {entryGroups.map(([name, variants]) => {
              const legsLeft = variants[0].waypoints.length - variants[0].waypoints.findIndex((w) => w.id === entryId);
              return (
                <div key={name} style={{ ...ITEM_STYLE, cursor: 'default', color: '#c89aff', gap: 6, padding: '4px 12px' }}>
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {name} <span style={{ color: '#6a4a90', fontSize: 9 }}>{legsLeft} WPT</span>
                  </span>
                  <span style={{ display: 'flex', gap: 3 }}>
                    {variants.map((st) => {
                      const assigned = ac.starId === st.id && ac.state === 'enroute' && !ac.directTo;
                      return (
                        <HoverItem key={st.id} hoverBg="#24153a"
                          onClick={() => cmd({ type: 'star', starId: st.id, waypointId: entryId! })}
                          style={{ padding: '2px 5px', border: `1px solid ${assigned ? '#00cc66' : '#3a2a55'}`, borderRadius: 2,
                            fontSize: 10, cursor: 'pointer', color: assigned ? '#00cc66' : '#c89aff' }}>
                          {st.runway}
                        </HoverItem>
                      );
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── RUNWAY / ILS + LANDEFREIGABE ── */}
      {(ilsRunways.length > 0 || ac.clearedILS) && (
        <>
          <div style={SECTION_STYLE}>
            RUNWAY / ILS
            {(ac.clearedILS || pendingCmdTypes.includes('ils')) && (
              <span style={{ float: 'right', fontSize: 10, fontWeight: 'normal', letterSpacing: 0,
                color: pendingCmdTypes.includes('ils') ? '#ffaa00' : '#00cc66' }}>
                {pendingCmdTypes.includes('ils') ? '⧖ ' : ''}
                {ac.assignedRunway ? `RWY ${ac.assignedRunway}` : ''}
                {!pendingCmdTypes.includes('ils') && ac.clearedILS ? ' ✓' : ''}
              </span>
            )}
          </div>
          {ilsRunways.map((rwy) => {
            const status = getILSStatusForRunway(ac, rwy);
            const assigned = ac.clearedILS && ac.assignedRunway === rwy.id;
            return (
              <HoverItem key={rwy.id} style={ITEM_STYLE} hoverBg={ITEM_HOVER}
                onClick={() => cmd({ type: 'ils', runwayId: rwy.id })}>
                <span>Cleared ILS RWY {rwy.id}</span>
                {assigned ? (
                  <span style={{ color: '#00cc66', fontSize: 10 }}>ACTIVE</span>
                ) : (
                  // Abstand zur Schwelle; gedimmt, wenn der Localizer gerade nicht erfliegbar ist
                  <span style={{ color: status.canIntercept ? '#00cc66' : '#2a5535', fontSize: 10 }}>
                    {Math.round(status.distanceToThresholdNM)} NM
                  </span>
                )}
              </HoverItem>
            );
          })}
          {ac.clearedILS && ac.assignedRunway && (
            ac.clearedToLand ? (
              <div style={{ ...ITEM_STYLE, cursor: 'default', color: '#00ff88' }}>
                <span>Cleared to land RWY {ac.assignedRunway}</span>
                <span style={{ fontSize: 10 }}>✓</span>
              </div>
            ) : (
              <HoverItem style={{ ...ITEM_STYLE, color: landPending ? '#ffaa00' : '#ffcc44' }} hoverBg={ITEM_HOVER}
                onClick={() => cmd({ type: 'land' })}>
                <span>Cleared to land RWY {ac.assignedRunway}</span>
                <span style={{ fontSize: 10 }}>{landPending ? '⧖' : 'LAND'}</span>
              </HoverItem>
            )
          )}
        </>
      )}
    </div>
  );
}

// ── Command status indicator ─────────────────────────────────────────────────
function CmdStatus({ current, target, active, pending, tendency }: {
  current: string; target: string; active: boolean; pending: boolean; tendency: string;
}) {
  if (!active && !pending) return null;
  return (
    <span style={{ float: 'right', fontSize: 10, color: pending ? '#ffaa00' : '#00cc66', fontWeight: 'normal', letterSpacing: 0 }}>
      {pending ? '⧖ ' : ''}{current}→{target} {tendency}
    </span>
  );
}

// ── Generic scrollable value spinbox ─────────────────────────────────────────
// Interaction: 1st click → activate (scroll to adjust) · 2nd click → send
interface ScrollableValueProps {
  initial: number;
  step: number;
  stepShift: number;
  min: number;
  max: number;
  wrap?: boolean;
  format: (v: number) => string;
  unit: string;
  onSend: (v: number, dir?: 'left' | 'right') => void;
  onPreview?: (v: number | null) => void;
  /** Heading-specific: passes raw accumulated delta (maintains scroll direction, ignores shortest-path) */
  onPreviewDelta?: (delta: number | null) => void;
}

function ScrollableValue({ initial, step, stepShift, min, max, wrap, format, unit, onSend, onPreview, onPreviewDelta }: ScrollableValueProps) {
  const [value, setValue] = useState(initial);
  const [active, setActive] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const onPreviewDeltaRef = useRef(onPreviewDelta);
  onPreviewDeltaRef.current = onPreviewDelta;
  // Accumulated raw scroll delta (signed, not wrapped) — used for heading arc direction
  const rawDeltaRef = useRef(0);

  const handleClick = () => {
    if (!active) {
      rawDeltaRef.current = 0;
      setActive(true);
      onPreviewRef.current?.(value);
      onPreviewDeltaRef.current?.(0);
    } else {
      onPreviewRef.current?.(null);
      onPreviewDeltaRef.current?.(null);
      const dir = rawDeltaRef.current > 0 ? 'right' : rawDeltaRef.current < 0 ? 'left' : undefined;
      onSend(value, dir);
    }
  };

  // Notify preview on value change while active
  useEffect(() => {
    if (active) onPreviewRef.current?.(value);
    // onPreviewDelta is fired in the wheel handler directly (has rawDelta)
  }, [value, active]);

  // Clear preview when deactivated externally
  useEffect(() => {
    if (!active) {
      onPreviewRef.current?.(null);
      onPreviewDeltaRef.current?.(null);
    }
  }, [active]);

  /** Wert um d ändern; aktiviert das Feld beim ersten Mal (Mausrad, ▲/▼-Tasten, −/+-Buttons) */
  const adjust = useCallback((d: number) => {
    if (!active) {
      // Auto-activate from current initial value (reset state to initial first)
      rawDeltaRef.current = 0;
      setValue(initial);
      setActive(true);
      onPreviewRef.current?.(initial);
      onPreviewDeltaRef.current?.(0);
    }
    rawDeltaRef.current += d;
    setValue((prev) => {
      const next = (active ? prev : initial) + d;
      if (wrap) return ((next - 1 + 360) % 360) + 1;
      return Math.max(min, Math.min(max, next));
    });
    onPreviewDeltaRef.current?.(rawDeltaRef.current);
  }, [active, initial, min, max, wrap]);

  // Scroll wheel: activate on first scroll, then adjust
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const s = e.shiftKey ? stepShift : step;
      adjust(e.deltaY > 0 ? -s : s);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [adjust, step, stepShift]);

  // Pfeiltasten ↑/↓ ändern den aktiven Wert (Shift = feine Schritte)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      e.stopPropagation();
      const s = e.shiftKey ? stepShift : step;
      adjust(e.key === 'ArrowUp' ? s : -s);
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [active, adjust, step, stepShift]);

  // ENTER key sends the value when active
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      onPreviewRef.current?.(null);
      onPreviewDeltaRef.current?.(null);
      const dir = rawDeltaRef.current > 0 ? 'right' : rawDeltaRef.current < 0 ? 'left' : undefined;
      onSend(value, dir);
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [active, value, onSend]);

  return (
    <div
      ref={ref}
      onClick={handleClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        padding: '8px 12px', cursor: 'pointer',
        background: active ? '#0a3020' : 'transparent',
        border: active ? '1px solid #00cc66' : '1px solid transparent',
        margin: '0 4px 2px',
        borderRadius: 3,
        userSelect: 'none',
        transition: 'background 0.1s',
      }}
      title={active ? 'Mausrad, ↑/↓ oder −/+ zum Ändern · Klick oder Enter zum Senden' : 'Klick zum Aktivieren · Mausrad oder −/+ zum Ändern'}
    >
      <StepButton label="−" onClick={(e) => adjust(-(e.shiftKey ? stepShift : step))} />
      <span style={{ color: active ? '#00ff88' : '#446655', fontSize: 20, fontWeight: 'bold', letterSpacing: 2 }}>
        {format(value)}
      </span>
      <StepButton label="+" onClick={(e) => adjust(e.shiftKey ? stepShift : step)} />
      <span style={{ color: active ? '#00cc66' : '#2a5535', fontSize: 10 }}>
        {active ? 'SEND' : unit}
      </span>
    </div>
  );
}

// Freie Eingabe eines Wegpunkts (Kennung + Enter)
function FixInput({ waypoints, onSend, placeholder = 'Fix eingeben + Enter' }: {
  waypoints: Waypoint[]; onSend: (w: Waypoint) => void; placeholder?: string;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const submit = () => {
    const w = waypoints.find((wp) => wp.id === value.trim().toUpperCase());
    if (w) onSend(w);
    else setError(true);
  };
  return (
    <div style={{ padding: '2px 8px 6px' }}>
      <input
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => { setValue(e.target.value.toUpperCase()); setError(false); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); submit(); } }}
        style={{
          width: '100%', boxSizing: 'border-box', background: '#0a1a10',
          border: `1px solid ${error ? '#ff4444' : '#1a4428'}`, color: '#00ff88',
          fontFamily: '"Courier New", monospace', fontSize: 11, padding: '4px 6px', outline: 'none', borderRadius: 2,
        }}
      />
    </div>
  );
}

// −/+ Button im Spinbox-Feld (Klick löst kein Senden aus)
function StepButton({ label, onClick }: { label: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <span
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      style={{
        color: '#00cc66', border: '1px solid #1a4428', borderRadius: 2,
        width: 22, height: 22, lineHeight: '20px', textAlign: 'center',
        fontSize: 14, fontWeight: 'bold', cursor: 'pointer', flex: '0 0 auto',
      }}
    >
      {label}
    </span>
  );
}

// ── Generic hover item ────────────────────────────────────────────────────────
function HoverItem({
  children, style, hoverBg, onClick,
}: {
  children: React.ReactNode;
  style: React.CSSProperties;
  hoverBg: string;
  onClick: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const baseBg = style.background;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const enter = () => (el.style.background = hoverBg);
    // Zurück auf den eigenen Hintergrund (z. B. markierte Auswahl), nicht pauschal transparent
    const leave = () => (el.style.background = String(baseBg ?? 'transparent'));
    el.addEventListener('mouseenter', enter);
    el.addEventListener('mouseleave', leave);
    return () => {
      el.removeEventListener('mouseenter', enter);
      el.removeEventListener('mouseleave', leave);
    };
  }, [hoverBg, baseBg]);

  return (
    <div ref={ref} style={style} onClick={onClick}>
      {children}
    </div>
  );
}
