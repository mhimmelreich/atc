// filepath: src/ui/App.tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { GameEngine, type GameState, type SessionData, type DisplayOptions } from '@/game/GameEngine';
import { DEFAULT_DISPLAY } from '@/game/RadarRenderer';
import { fetchAirportData, AVAILABLE_AIRPORTS, type AirportSource, type SourcePreference } from '@/services/AirportDataService';
import { fetchNavStatus } from '@/services/NavigraphService';
import type { Airport } from '@/types/airport';
import type { STAR, Waypoint } from '@/types/navdata';
import type { ATCCommand, Aircraft } from '@/types/aircraft';
import { RadarCanvas } from './RadarCanvas';
import { AircraftStrip } from './AircraftStrip';
import { CommandPanel } from './CommandPanel';
import { AlertBanner } from './AlertBanner';
import { ScorePanel } from './ScorePanel';
import { ContextMenu, type ContextMenuState } from './ContextMenu';
import { RadioLog } from './RadioLog';
import { RadioVoice } from '@/services/RadioVoice';
import { loadTelephony } from '@/game/Telephony';

const SIDEBAR_W = 288;
const MOBILE_BREAKPOINT = 700;
const RANGE_PRESETS = [10, 20, 40, 80, 120];
const SOURCE_STORAGE = 'atc-data-source';
const SOURCE_OPTIONS: Array<{ id: SourcePreference; label: string; title: string }> = [
  { id: 'auto',    label: 'AUTO',  title: 'Beste verfügbare Quelle' },
  { id: 'navdata', label: 'NAVIG', title: 'Navigraph AIRAC (privat)' },
  { id: 'open',    label: 'OPEN',  title: 'OurAirports (frei)' },
];
const SOURCE_NAMES: Record<AirportSource, string> = {
  navdata: 'Navigraph', open: 'OurAirports', generic: 'generisch',
};
const RADIO_STORAGE = 'atc-radio';

interface RadioPrefs {
  log: boolean;
  voice: boolean;
}

function loadRadioPrefs(): RadioPrefs {
  try {
    return { log: true, voice: true, ...JSON.parse(localStorage.getItem(RADIO_STORAGE) ?? '{}') };
  } catch {
    return { log: true, voice: true };
  }
}

function loadSourcePref(): SourcePreference {
  try {
    const v = localStorage.getItem(SOURCE_STORAGE);
    return SOURCE_OPTIONS.some((o) => o.id === v) ? v as SourcePreference : 'auto';
  } catch {
    return 'auto';
  }
}

export function App() {
  const engineRef = useRef<GameEngine | null>(null);
  const pendingSessionRef = useRef<SessionData | null>(GameEngine.loadSession());
  const selectedIcaoRef = useRef('EDDF');
  const [gameState, setGameState] = useState<GameState>({
    score: 0, landings: 0, violations: 0,
    aircraft: [], conflicts: [], selectedId: null,
    paused: false, timeScale: 1, sweepEnabled: false, rangeNM: 80, trailLength: 6,
    pendingCmdTypes: {}, display: { ...DEFAULT_DISPLAY },
    activeRunwayIds: [], radio: [],
  });
  const [airport, setAirport] = useState<Airport | null>(null);
  const [navPoints, setNavPoints] = useState<Waypoint[]>([]);
  const [stars, setStars] = useState<STAR[]>([]);
  const [selectedIcao, setSelectedIcao] = useState(() => pendingSessionRef.current?.icao ?? 'EDDF');
  const [loading, setLoading] = useState(true);
  const [icaoInput, setIcaoInput] = useState(selectedIcao);
  const [icaoError, setIcaoError] = useState<string | null>(null);
  const lastGoodIcaoRef = useRef<string | null>(null);
  const [sourcePref, setSourcePref] = useState<SourcePreference>(loadSourcePref);
  const [activeSource, setActiveSource] = useState<AirportSource | null>(null);
  const [navAvailable, setNavAvailable] = useState(false);

  useEffect(() => { fetchNavStatus().then(setNavAvailable); }, []);

  // ── Funk: Log und Sprachausgabe ──────────────────────────────────────────
  const [radioPrefs, setRadioPrefs] = useState<RadioPrefs>(loadRadioPrefs);
  const [voice] = useState(() => new RadioVoice());
  const lastRadioIdRef = useRef(0);
  const changeRadioPrefs = useCallback((patch: Partial<RadioPrefs>) => {
    setRadioPrefs((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(RADIO_STORAGE, JSON.stringify(next)); } catch { /* nur Komfort */ }
      return next;
    });
  }, []);
  useEffect(() => { void loadTelephony(); }, []);
  useEffect(() => { voice.setEnabled(radioPrefs.voice); }, [voice, radioPrefs.voice]);
  useEffect(() => {
    // Browser geben Ton erst nach einer Nutzeraktion frei
    const unlock = () => voice.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, [voice]);
  useEffect(() => {
    const fresh = gameState.radio.filter((m) => m.id > lastRadioIdRef.current);
    if (fresh.length === 0) return;
    lastRadioIdRef.current = fresh[fresh.length - 1].id;
    if (radioPrefs.voice) fresh.forEach((m) => voice.enqueue(m));
  }, [gameState.radio, radioPrefs.voice, voice]);

  const changeSourcePref = useCallback((pref: SourcePreference) => {
    setSourcePref(pref);
    try { localStorage.setItem(SOURCE_STORAGE, pref); } catch { /* nur Komfort */ }
  }, []);
  const [isMobile, setIsMobile] = useState(window.innerWidth < MOBILE_BREAKPOINT);
  const [bottomOpen, setBottomOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    const engine = new GameEngine((s) => setGameState({ ...s }));
    engineRef.current = engine;
    engine.start();
    // Auto-save every 10 seconds
    const saveId = setInterval(() => {
      engine.saveSession(selectedIcaoRef.current);
    }, 10_000);
    return () => { engine.stop(); clearInterval(saveId); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    selectedIcaoRef.current = selectedIcao;
    setLoading(true);
    voice.clear();
    fetchAirportData(selectedIcao, sourcePref).then(({ airport: ap, waypoints: wps, stars: apStars, source }) => {
      // Unbekannter Platz (weder Navigraph noch OurAirports) → beim bisherigen bleiben
      if (source === 'generic' && lastGoodIcaoRef.current) {
        setIcaoError(`${selectedIcao} nicht gefunden`);
        setIcaoInput(lastGoodIcaoRef.current);
        setSelectedIcao(lastGoodIcaoRef.current);
        setLoading(false);
        return;
      }
      lastGoodIcaoRef.current = selectedIcao;
      setActiveSource(source);
      setAirport(ap);
      setNavPoints(wps);
      setStars(apStars);
      const engine = engineRef.current;
      if (!engine) return;
      engine.setAirport(ap, wps, apStars);
      // Restore session after airport is set (so aircraft are in known airspace)
      if (pendingSessionRef.current) {
        engine.restoreSession(pendingSessionRef.current);
        pendingSessionRef.current = null;
      }
      setLoading(false);
    });
  }, [selectedIcao, sourcePref, voice]);

  const handleCommand = useCallback((id: string, cmd: ATCCommand) => {
    engineRef.current?.applyCommand(id, cmd);
  }, []);

  const handleSelectAircraft = useCallback((id: string | null) => {
    engineRef.current?.selectAircraft(id);
    if (id && isMobile) setBottomOpen(true);
  }, [isMobile]);

  const handleContextMenu = useCallback((ac: Aircraft, x: number, y: number) => {
    setContextMenu({ x, y, aircraft: ac });
    setGameState((prev) => ({ ...prev, selectedId: ac.id }));
    engineRef.current?.selectAircraft(ac.id);
  }, []);

  const handleHeadingPreview = useCallback((aircraftId: string, targetHdg: number | null, direction?: 'left' | 'right') => {
    engineRef.current?.setPreviewHeading(targetHdg !== null ? aircraftId : null, targetHdg, direction);
  }, []);

  const handleAltitudePreview = useCallback((aircraftId: string, alt: number | null) => {
    engineRef.current?.setPreviewAltitude(alt !== null ? aircraftId : null, alt);
  }, []);

  const selected = gameState.aircraft.find((a) => a.id === gameState.selectedId);

  // ── Sidebar ──────────────────────────────────────────────────────────────
  const sidebar = (
    <div style={{
      width: isMobile ? '100%' : SIDEBAR_W,
      minWidth: isMobile ? undefined : SIDEBAR_W,
      display: 'flex', flexDirection: 'column', gap: 8,
      padding: 10,
      background: '#080f0a',
      borderLeft: isMobile ? 'none' : '1px solid #0a2010',
      borderTop: isMobile ? '1px solid #0a2010' : 'none',
      overflowY: 'auto',
      maxHeight: isMobile ? '60vh' : undefined,
    }}>

      <a href="https://games.himmelreich.cloud/" style={{ color: '#446644', fontSize: 11, letterSpacing: 1, textDecoration: 'none', whiteSpace: 'nowrap' }}>← ALLE SPIELE</a>

      {/* Airport selector */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <label style={{ color: '#446644', fontSize: 10, letterSpacing: 1, whiteSpace: 'nowrap' }}>AIRPORT</label>
        {/* Freie ICAO-Eingabe (Navigraph-Daten), Vorschläge per Datalist */}
        <input
          value={icaoInput}
          list="atc-airports"
          maxLength={4}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value.toUpperCase();
            setIcaoInput(v);
            setIcaoError(null);
            if (AVAILABLE_AIRPORTS.includes(v)) setSelectedIcao(v);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && /^[A-Z0-9]{4}$/.test(icaoInput)) setSelectedIcao(icaoInput); }}
          onBlur={() => { if (/^[A-Z0-9]{4}$/.test(icaoInput)) setSelectedIcao(icaoInput); else setIcaoInput(selectedIcao); }}
          style={{ background: '#0a1a0a', border: '1px solid #1a4428', color: '#00ff88', fontFamily: '"Courier New", monospace', fontSize: 12, padding: '3px 6px', flex: 1, minWidth: 0, outline: 'none', textTransform: 'uppercase' }}
        />
        <datalist id="atc-airports">
          {AVAILABLE_AIRPORTS.map((icao) => <option key={icao} value={icao} />)}
        </datalist>
        {loading && <span style={{ color: '#446644', fontSize: 10 }}>LOAD</span>}
      </div>
      {icaoError && <div style={{ color: '#ff4444', fontSize: 10 }}>{icaoError}</div>}

      {/* Datenquelle */}
      <div>
        <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>DATA</span>
          {activeSource && (
            <span style={{ color: sourcePref !== 'auto' && sourcePref !== activeSource ? '#ffaa00' : '#00ff88' }}>
              {SOURCE_NAMES[activeSource]}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 3 }}>
          {SOURCE_OPTIONS.filter((o) => o.id !== 'navdata' || navAvailable).map((o) => (
            <button
              key={o.id}
              title={o.title}
              onClick={() => changeSourcePref(o.id)}
              style={{
                flex: 1,
                background: sourcePref === o.id ? '#0a3020' : 'transparent',
                border: `1px solid ${sourcePref === o.id ? '#00cc66' : '#1a4428'}`,
                color: sourcePref === o.id ? '#00ff88' : '#446644',
                fontFamily: '"Courier New", monospace',
                fontSize: 11,
                padding: '4px 2px',
                cursor: 'pointer',
                borderRadius: 2,
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Active landing runway */}
      {airport && (() => {
        const ilsRunways = airport.runways.filter((r) => r.ils && r.role !== 'departure');
        if (ilsRunways.length === 0) return null;
        return (
          <div>
            <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>ACTIVE RWY</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {ilsRunways.map((rwy) => {
                const isActive = gameState.activeRunwayIds.includes(rwy.id);
                return (
                  <button
                    key={rwy.id}
                    onClick={() => engineRef.current?.toggleActiveRunway(rwy.id)}
                    style={{
                      flex: '1 0 auto',
                      background: isActive ? '#0a3020' : 'transparent',
                      border: `1px solid ${isActive ? '#00cc66' : '#1a4428'}`,
                      color: isActive ? '#00ff88' : '#446644',
                      fontFamily: '"Courier New", monospace',
                      fontSize: 11,
                      padding: '4px 6px',
                      cursor: 'pointer',
                      borderRadius: 2,
                    }}
                  >
                    {rwy.id}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Range selector */}
      <div>
        <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>RANGE</span>
          <span style={{ color: '#00ff88' }}>{Math.round(gameState.rangeNM)} NM</span>
        </div>
        <div style={{ display: 'flex', gap: 3 }}>
          {RANGE_PRESETS.map((nm) => (
            <button
              key={nm}
              onClick={() => engineRef.current?.setRange(nm)}
              style={{
                flex: 1,
                background: Math.round(gameState.rangeNM) === nm ? '#0a3020' : 'transparent',
                border: `1px solid ${Math.round(gameState.rangeNM) === nm ? '#00cc66' : '#1a4428'}`,
                color: Math.round(gameState.rangeNM) === nm ? '#00ff88' : '#446644',
                fontFamily: '"Courier New", monospace',
                fontSize: 11,
                padding: '4px 2px',
                cursor: 'pointer',
                borderRadius: 2,
              }}
            >
              {nm}
            </button>
          ))}
        </div>
        <button
          onClick={() => engineRef.current?.resetView()}
          style={{
            width: '100%', marginTop: 3,
            background: 'transparent', border: '1px solid #1a4428',
            color: '#446644', fontFamily: '"Courier New", monospace',
            fontSize: 10, padding: '3px 0', cursor: 'pointer', borderRadius: 2,
          }}
        >
          RESET VIEW
        </button>
      </div>

      {/* Trail length slider */}
      <div>
        <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>TRAIL</span>
          <span style={{ color: '#00ff88' }}>{gameState.trailLength}</span>
        </div>
        <input
          type="range" min={0} max={20} step={1}
          value={gameState.trailLength}
          onChange={(e) => engineRef.current?.setTrailLength(Number(e.target.value))}
          style={{ width: '100%', accentColor: '#00cc66', cursor: 'pointer' }}
        />
      </div>

      {/* Alerts */}
      <AlertBanner conflicts={gameState.conflicts} aircraft={gameState.aircraft} />

      {/* Traffic strips */}
      <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1 }}>
        TRAFFIC ({gameState.aircraft.filter((a) => a.state !== 'landed').length})
      </div>
      <AircraftStrip aircraft={gameState.aircraft} selectedId={gameState.selectedId} onSelect={handleSelectAircraft} />

      {/* Commands */}
      <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1 }}>COMMANDS</div>
      <CommandPanel selected={selected} airport={airport} onCommand={handleCommand} activeRunwayIds={gameState.activeRunwayIds} />

      {/* Score / controls */}
      <ScorePanel
        score={gameState.score} landings={gameState.landings} violations={gameState.violations}
        paused={gameState.paused} timeScale={gameState.timeScale} sweepEnabled={gameState.sweepEnabled}
        onPause={() => engineRef.current?.pause()}
        onResume={() => engineRef.current?.resume()}
        onToggleSweep={() => engineRef.current?.setSweep(!gameState.sweepEnabled)}
        onTimeScale={(s) => engineRef.current?.setTimeScale(s)}
      />
    </div>
  );

  // ── Layout ────────────────────────────────────────────────────────────────
  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: isMobile ? 'column' : 'row', overflow: 'hidden', fontFamily: '"Courier New", Courier, monospace' }}>

      {isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', background: '#050e05', borderBottom: '1px solid #0a2010', flexShrink: 0 }}>
          <span style={{ color: '#00cc66', fontSize: 13, fontWeight: 'bold' }}>ATC APPROACH</span>
          <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#446644' }}>
            <span style={{ color: gameState.score >= 0 ? '#00ff88' : '#ff3333' }}>{gameState.score}</span>
            <span>{gameState.landings} LND</span>
            <button onClick={() => setBottomOpen((o) => !o)} style={{ background: bottomOpen ? '#0a2a18' : 'transparent', border: '1px solid #1a4428', color: '#00cc66', padding: '2px 8px', fontFamily: '"Courier New", monospace', fontSize: 11, cursor: 'pointer', borderRadius: 2 }}>
              {bottomOpen ? '▲ RADAR' : '▼ CTRL'}
            </button>
          </div>
        </div>
      )}

      {(!isMobile || !bottomOpen) && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <RadarCanvas
            engine={engineRef.current}
            aircraft={gameState.aircraft}
            selectedId={gameState.selectedId}
            onSelectAircraft={handleSelectAircraft}
            onContextMenu={handleContextMenu}
          />
          {radioPrefs.log && (
            <RadioLog
              messages={gameState.radio}
              selectedId={gameState.selectedId}
              onSelect={handleSelectAircraft}
              height={isMobile ? 64 : 112}
            />
          )}
          <DisplayBar
            display={gameState.display}
            onChange={(patch) => engineRef.current?.setDisplay(patch)}
            extra={[
              { label: 'RADIO', title: 'Funk-Log', active: radioPrefs.log, onClick: () => changeRadioPrefs({ log: !radioPrefs.log }) },
              { label: 'VOICE', title: 'Funk hörbar', active: radioPrefs.voice, onClick: () => changeRadioPrefs({ voice: !radioPrefs.voice }) },
            ]}
          />
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          menu={contextMenu} airport={airport}
          onCommand={handleCommand}
          onClose={() => { setContextMenu(null); engineRef.current?.setPreviewHeading(null, null); engineRef.current?.setPreviewAltitude(null, null); }}
          onHeadingPreview={handleHeadingPreview}
          onAltitudePreview={handleAltitudePreview}
          pendingCmdTypes={gameState.pendingCmdTypes[contextMenu.aircraft.id] ?? []}
          activeRunwayIds={gameState.activeRunwayIds}
          waypoints={navPoints}
          stars={stars}
        />
      )}

      {(!isMobile || bottomOpen) && sidebar}
    </div>
  );
}

// ── Display toggle bar ────────────────────────────────────────────────────────
const DISPLAY_TOGGLES: { key: keyof DisplayOptions; label: string }[] = [
  { key: 'labels',   label: 'LABELS'  },
  { key: 'ilsCones', label: 'ILS'     },
  { key: 'waypoints',label: 'NAVAID'  },
  { key: 'stars',    label: 'STARs'   },
];

interface ExtraToggle {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}

const toggleStyle = (active: boolean): React.CSSProperties => ({
  background: active ? '#0a3020' : 'transparent',
  border: `1px solid ${active ? '#00cc66' : '#1a4428'}`,
  color: active ? '#00ff88' : '#446644',
  fontFamily: '"Courier New", monospace',
  fontSize: 10,
  padding: '2px 8px',
  cursor: 'pointer',
  borderRadius: 2,
  letterSpacing: 1,
});

function DisplayBar({ display, onChange, extra = [] }: { display: DisplayOptions; onChange: (patch: Partial<DisplayOptions>) => void; extra?: ExtraToggle[] }) {
  return (
    <div style={{
      display: 'flex', gap: 4, padding: '4px 8px',
      background: '#050e05', borderTop: '1px solid #0a2010',
      flexShrink: 0, flexWrap: 'wrap',
    }}>
      {DISPLAY_TOGGLES.map(({ key, label }) => (
        <button key={key} onClick={() => onChange({ [key]: !display[key] })} style={toggleStyle(display[key])}>
          {label}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      {extra.map((t) => (
        <button key={t.label} title={t.title} onClick={t.onClick} style={toggleStyle(t.active)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
