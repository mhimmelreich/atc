// filepath: src/ui/App.tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { GameEngine, type GameState, type SessionData, type DisplayOptions, type RunwaySource } from '@/game/GameEngine';
import { DEFAULT_DISPLAY } from '@/game/RadarRenderer';
import { fetchAirportData, fetchAirportLayer, AVAILABLE_AIRPORTS, type AirportSource, type SourcePreference } from '@/services/AirportDataService';
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
import { WatchMenu, type WatchMenuState } from './WatchMenu';
import { RadioLog } from './RadioLog';
import { HowTo } from './HowTo';
import { StationPanel } from './StationPanel';
import { WatchPanel } from './WatchPanel';
import { RadioVoice } from '@/services/RadioVoice';
import { loadTelephony } from '@/game/Telephony';
import { fetchLiveTraffic, fetchTrace, fetchDayTracks, LIVE_POLL_MS } from '@/services/LiveTrafficService';
import { fetchWeather, WEATHER_POLL_MS } from '@/services/WeatherService';
import { fetchTowns, type Town } from '@/services/TownService';
import { fetchLandmarks } from '@/services/LandmarkService';
import { fetchRoads } from '@/services/RoadService';
import { airlineName, loadAirlines } from '@/game/Airlines';
import type { TrafficMode, WatchFilter } from '@/types/live';
import { nextLander } from '@/game/NextLander';
import { watchExchange } from '@/game/WatchRadio';

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
// WATCH: Ortschaften ab dieser Einwohnerzahl einblenden (0 = aus)
const TOWNS_STORAGE = 'atc-towns-min';
const DAY_STORAGE = 'atc-day-tracks';
/** Heutiges Datum (Ortszeit) als YYYY-MM-DD */
const today = () => new Date().toLocaleDateString('sv-SE');
const WATCH_FILTER_STORAGE = 'atc-watch-filter';
const TOWN_OPTIONS: Array<{ pop: number; label: string }> = [
  { pop: 0, label: 'AUS' }, { pop: 5000, label: '5k' }, { pop: 10000, label: '10k' },
  { pop: 20000, label: '20k' }, { pop: 50000, label: '50k' }, { pop: 100000, label: '100k' },
];
const RUNWAY_SOURCES: Record<RunwaySource, { label: string; title: string }> = {
  default: { label: 'AUTO', title: 'Automatisch: nach dem Wind (METAR) und bei LIVE nach den echten Landungen' },
  wind:    { label: 'AUTO · WIND', title: 'Automatisch nach dem Wind (METAR)' },
  live:    { label: 'AUTO · LIVE', title: 'Automatisch nach den echten Landungen' },
  manual:  { label: 'MANUELL', title: 'Von Hand gewählt. Klick: wieder automatisch' },
};
const TRAFFIC_OPTIONS: Array<{ id: TrafficMode; label: string; title: string }> = [
  { id: 'sim',  label: 'SIM',  title: 'Erfundener Verkehr zum Lotsen' },
  { id: 'live', label: 'LIVE', title: 'Echte Flieger von adsb.lol, Anflüge zum Lotsen übernehmen' },
  { id: 'watch', label: 'WATCH', title: 'Zuschauen: nur echter Verkehr in Echtzeit, ohne Lotsen und Punkte' },
];

interface RadioPrefs {
  log: boolean;
  voice: boolean;
  /** WATCH: Funkspruch beim Wechsel des gewählten Flugs */
  watch: boolean;
  /** WATCH: Überflüge zeigen */
  transit: boolean;
}

function loadRadioPrefs(): RadioPrefs {
  try {
    return { log: true, voice: true, watch: true, transit: true, ...JSON.parse(localStorage.getItem(RADIO_STORAGE) ?? '{}') };
  } catch {
    return { log: true, voice: true, watch: true, transit: true };
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
    pendingCmdTypes: {}, display: { ...DEFAULT_DISPLAY }, followId: null,
    activeRunwayIds: [], radio: [],
    trafficMode: 'sim', live: { count: 0, inbound: 0, updatedAt: null, error: false }, liveNames: {},
    weather: null, runwaySource: 'default', watch: [], watchRoles: {}, watchLanded: [], spectator: null,
  });
  const watching = gameState.trafficMode === 'watch';
  // WATCH: Standort per GPS (Browser) – der nächste Verkehrsflughafen wird der gewählte Platz
  const [gpsStatus, setGpsStatus] = useState<string | null>(null);
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
  const [view3D, setView3D] = useState(() => { try { return localStorage.getItem('atc-view3d') === '1'; } catch { return false; } });
  const toggleView3D = () => setView3D((v) => {
    try { localStorage.setItem('atc-view3d', v ? '0' : '1'); } catch { /* ohne Speicher eben nicht gemerkt */ }
    return !v;
  });
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
  // Im WATCH schaltet FUNK die Sprachausgabe, sonst VOICE
  const speak = watching ? radioPrefs.watch : radioPrefs.voice;
  useEffect(() => { voice.setEnabled(speak); }, [voice, speak]);
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
    if (speak) fresh.forEach((m) => voice.enqueue(m));
  }, [gameState.radio, speak, voice]);

  const changeSourcePref = useCallback((pref: SourcePreference) => {
    setSourcePref(pref);
    try { localStorage.setItem(SOURCE_STORAGE, pref); } catch { /* nur Komfort */ }
  }, []);
  const [isMobile, setIsMobile] = useState(window.innerWidth < MOBILE_BREAKPOINT);
  const [bottomOpen, setBottomOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [watchMenu, setWatchMenu] = useState<WatchMenuState | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const closeHelp = useCallback(() => setShowHelp(false), []);

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
    // Kamera beim Verlassen/Neuladen sofort sichern
    const onHide = () => engine.saveCamera();
    window.addEventListener('pagehide', onHide);
    return () => { engine.stop(); clearInterval(saveId); window.removeEventListener('pagehide', onHide); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    selectedIcaoRef.current = selectedIcao;
    setLoading(true);
    voice.clear();
    // Antworten zu einem inzwischen abgewählten Platz verwerfen (schnelles Tippen, doppelter Effekt im Dev-Modus)
    let cancelled = false;
    fetchAirportData(selectedIcao, sourcePref).then(({ airport: ap, waypoints: wps, stars: apStars, source }) => {
      if (cancelled) return;
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
      engine.restoreCamera(ap.icao);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedIcao, sourcePref, voice]);

  /** Platz per ICAO wählen; im Zuschauer-Modus ist das dann auch der Standort (GPS aus) */
  const chooseIcao = useCallback((icao: string) => {
    if (icao !== selectedIcaoRef.current) {
      engineRef.current?.setSpectator(null);
      setGpsStatus(null);
    }
    setSelectedIcao(icao);
  }, []);

  const locateByGps = useCallback(() => {
    if (!navigator.geolocation) { setGpsStatus('GPS nicht verfügbar'); return; }
    setGpsStatus('Standort wird gesucht…');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        engineRef.current?.setSpectator({ lat, lng, accuracyM: accuracy });
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}api/opendata/nearest?lat=${lat.toFixed(3)}&lon=${lng.toFixed(3)}`);
          if (!res.ok) throw new Error();
          const near = await res.json() as { icao: string; distNM: number };
          setGpsStatus(`GPS ±${Math.round(accuracy)} m · nächster Platz ${near.icao} ${Math.round(near.distNM)} NM`);
          setIcaoInput(near.icao);
          setIcaoError(null);
          setSelectedIcao(near.icao);
        } catch {
          setGpsStatus(`GPS ±${Math.round(accuracy)} m · kein Flughafen gefunden`);
        }
      },
      (err) => setGpsStatus(err.code === err.PERMISSION_DENIED ? 'GPS nicht erlaubt' : 'Standort nicht gefunden'),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }, []);

  // ── Echter Verkehr: alle 5 s abfragen, solange LIVE/WATCH aktiv und der Tab sichtbar ist ──
  // WATCH mit GPS: Verkehr rund um den Zuschauer
  const spectator = watching ? gameState.spectator : null;
  useEffect(() => {
    if (gameState.trafficMode === 'sim' || !airport) return;
    const center = spectator ?? airport;
    let stopped = false;
    let busy = false;
    const poll = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const list = await fetchLiveTraffic(center.lat, center.lng);
        if (!stopped) engineRef.current?.setLiveTraffic(list);
      } catch {
        if (!stopped) engineRef.current?.setLiveError();
      } finally {
        busy = false;
      }
    };
    void poll();
    const id = setInterval(poll, LIVE_POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [gameState.trafficMode, airport, spectator]);

  // ── WATCH: Filter ALLE / IN / OUT für Liste und Radar ──
  const [watchFilter, setWatchFilter] = useState<WatchFilter>(() => {
    try { const v = localStorage.getItem(WATCH_FILTER_STORAGE); return v === 'in' || v === 'out' ? v : 'all'; } catch { return 'all'; }
  });
  useEffect(() => { engineRef.current?.setWatchFilter(watchFilter); }, [watchFilter]);
  useEffect(() => { engineRef.current?.setWatchTransit(radioPrefs.transit); }, [radioPrefs.transit]);
  const changeWatchFilter = (f: WatchFilter) => {
    setWatchFilter(f);
    try { localStorage.setItem(WATCH_FILTER_STORAGE, f); } catch { /* nur Komfort */ }
  };

  // ── WATCH: Ortschaften rund um den Zuschauer, gefiltert nach Einwohnern ──
  const [townMin, setTownMin] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(TOWNS_STORAGE) ?? '20000'); return TOWN_OPTIONS.some((o) => o.pop === v) ? v : 20000; } catch { return 20000; }
  });
  const changeTownMin = (pop: number) => {
    setTownMin(pop);
    try { localStorage.setItem(TOWNS_STORAGE, String(pop)); } catch { /* nur Komfort */ }
  };
  const [towns, setTowns] = useState<Town[]>([]);
  const [townStatus, setTownStatus] = useState<string | null>(null);
  // Neu laden erst bei deutlich anderem Standort (Server rastert auf 0,5°)
  const townCenter = watching && townMin > 0 && (spectator ?? airport)
    ? `${(Math.round((spectator ?? airport)!.lat * 4) / 4).toFixed(2)},${(Math.round((spectator ?? airport)!.lng * 4) / 4).toFixed(2)}`
    : null;
  useEffect(() => {
    if (!townCenter) return;
    let stopped = false;
    const [lat, lng] = townCenter.split(',').map(Number);
    setTownStatus('Orte werden geladen…');
    fetchTowns(lat, lng, () => stopped)
      .then((list) => { if (!stopped) { setTowns(list); setTownStatus(null); } })
      .catch(() => { if (!stopped) setTownStatus('Orte nicht verfügbar'); });
    return () => { stopped = true; };
  }, [townCenter]);
  useEffect(() => {
    engineRef.current?.setTowns(watching && townMin > 0 ? towns.filter((t) => t.pop >= townMin) : []);
  }, [towns, townMin, watching]);

  // ── WATCH TAG: alle Starts und Landungen eines Tages als Linien (Filter IN/OUT/ALLE wie die Liste) ──
  const [dayOn, setDayOn] = useState(() => { try { return localStorage.getItem(DAY_STORAGE) === '1'; } catch { return false; } });
  const [dayDate, setDayDate] = useState(today);
  const [dayStatus, setDayStatus] = useState<string | null>(null);
  const toggleDay = useCallback(() => {
    setDayOn((v) => { try { localStorage.setItem(DAY_STORAGE, v ? '0' : '1'); } catch { /* nur Komfort */ } return !v; });
  }, []);
  const dayIcao = watching && dayOn && airport ? airport.icao : null;
  useEffect(() => {
    engineRef.current?.setDayTracks(null);
    setDayStatus(null);
    if (!dayIcao) return;
    let stopped = false;
    const load = async () => {
      try {
        const { recorded, flights } = await fetchDayTracks(dayIcao, dayDate);
        if (stopped) return;
        engineRef.current?.setDayTracks(flights);
        const nIn = flights.filter((f) => f.dir === 'in').length;
        setDayStatus(!recorded ? `${dayIcao} wird nicht aufgezeichnet` : `${nIn} Landungen, ${flights.length - nIn} Starts`);
      } catch {
        if (!stopped) setDayStatus('Tagesspuren nicht verfügbar');
      }
    };
    void load();
    // Heute kommen laufend Flüge dazu
    const id = dayDate === today() ? setInterval(load, 60_000) : undefined;
    return () => { stopped = true; if (id) clearInterval(id); };
  }, [dayIcao, dayDate]);
  // ── Flughafengelände aus OSM (Terminals, Vorfeld, Tower …), lädt nach dem Platz ──
  useEffect(() => {
    const layerIcao = airport?.icao;
    if (!layerIcao) return;
    let stopped = false;
    fetchAirportLayer(layerIcao, () => stopped)
      .then((layer) => { if (!stopped && layer) engineRef.current?.setAirportLayer(layerIcao, layer); })
      .catch(() => { /* ohne Gelände geht es auch */ });
    return () => { stopped = true; };
  }, [airport]); // auch nach Quellenwechsel desselben Platzes neu setzen

  // ── Markante Bauwerke rund um den Platz (in allen Modi) ──
  const landmarkCenter = airport ? `${(Math.round(airport.lat * 4) / 4).toFixed(2)},${(Math.round(airport.lng * 4) / 4).toFixed(2)}` : null;
  useEffect(() => {
    engineRef.current?.setLandmarks([]);
    if (!landmarkCenter) return;
    let stopped = false;
    const [lat, lng] = landmarkCenter.split(',').map(Number);
    fetchLandmarks(lat, lng, () => stopped)
      .then((list) => { if (!stopped) engineRef.current?.setLandmarks(list); })
      .catch(() => { /* ohne Bauwerke geht es auch */ });
    return () => { stopped = true; };
  }, [landmarkCenter]);
  // ── Autobahnen als Orientierungslinien (in allen Modi) ──
  useEffect(() => {
    engineRef.current?.setRoads([]);
    if (!landmarkCenter) return;
    let stopped = false;
    const [lat, lng] = landmarkCenter.split(',').map(Number);
    fetchRoads(lat, lng, () => stopped)
      .then((list) => { if (!stopped) engineRef.current?.setRoads(list); })
      .catch(() => { /* ohne Autobahnen geht es auch */ });
    return () => { stopped = true; };
  }, [landmarkCenter]);

  // ── WATCH: vergangene Flugbahn des gewählten Fliegers, jede Minute nachgeladen ──
  const traceHex = watching && gameState.selectedId?.startsWith('live-') ? gameState.selectedId.slice(5) : null;
  const [traceStatus, setTraceStatus] = useState<string | null>(null);
  useEffect(() => {
    engineRef.current?.setTrack(null);
    setTraceStatus(null);
    if (!traceHex) return;
    let stopped = false;
    const load = async () => {
      try {
        const points = await fetchTrace(traceHex);
        if (stopped) return;
        engineRef.current?.setTrack({ hex: traceHex, points });
        setTraceStatus(points.length ? null : 'keine Flugbahn bekannt');
      } catch {
        if (!stopped) setTraceStatus('Flugbahn nicht verfügbar');
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => { stopped = true; clearInterval(id); };
  }, [traceHex]);

  // ── WATCH: ohne gewählten Flug automatisch den voraussichtlich nächsten Lander wählen ──
  // Eine automatische Wahl folgt laufend dem jeweils nächsten Lander. Landet ein gewählter Flug (ALT von
  // über 0 auf 0, auch ein selbst gewählter) oder verschwindet er, kommt der nächste dran. Ein selbst
  // gewählter Flug bleibt bis zur Landung; ein schon gelandeter darf bewusst gewählt bleiben.
  const autoSelRef = useRef<string | null>(null);   // zuletzt automatisch gewählter Flug
  const flyingSelRef = useRef<string | null>(null); // gewählter Flug, der seit der Wahl in der Luft gesehen wurde
  useEffect(() => {
    if (!watching || !airport || watchFilter === 'out') return;
    const sel = gameState.selectedId;
    const selAc = sel ? gameState.watch.find((a) => `live-${a.hex}` === sel) : undefined;
    const landed = new Set(gameState.watchLanded);
    if (selAc && sel !== autoSelRef.current) {
      if (!landed.has(selAc.hex)) { flyingSelRef.current = sel; return; }
      if (flyingSelRef.current !== sel) return;
    }
    const next = nextLander(gameState.watch, gameState.watchRoles, airport, landed, gameState.activeRunwayIds);
    const id = next ? `live-${next.hex}` : null;
    if (!id || id === sel) return;
    autoSelRef.current = id;
    flyingSelRef.current = id;
    engineRef.current?.selectAircraft(id);
  }, [watching, airport, watchFilter, gameState.watch, gameState.watchRoles, gameState.watchLanded, gameState.activeRunwayIds, gameState.selectedId]);

  useEffect(() => { if (watching) void loadAirlines(); }, [watching]);

  // ── WATCH: Funkspruch beim Wechsel des gewählten Flugs (FUNK) ──
  const radioSelRef = useRef<string | null>(null);
  useEffect(() => {
    const sel = watching ? gameState.selectedId : null;
    if (sel === radioSelRef.current) return;
    radioSelRef.current = sel;
    if (!sel || !airport || !radioPrefs.watch) return;
    voice.clear(); // alter Funkverkehr zum vorigen Flug ist nicht mehr gefragt
    const ac = gameState.watch.find((a) => `live-${a.hex}` === sel);
    const calls = ac ? watchExchange(ac, gameState.watchRoles[ac.hex], airport, gameState.activeRunwayIds, gameState.weather) : null;
    if (calls) engineRef.current?.watchRadio(calls);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, gameState.selectedId, airport, radioPrefs.watch]);

  // ── WATCH: Start und Ziel des gewählten Flugs im Klartext oben in der Mitte ──
  const [airportNames, setAirportNames] = useState<Record<string, { name: string; country: string }>>({});
  const selectedLive = watching ? gameState.watch.find((a) => `live-${a.hex}` === gameState.selectedId) : undefined;
  const selectedRoute = selectedLive?.route;
  useEffect(() => {
    const missing = (selectedRoute ?? '').split('-').filter((c) => c && !(c in airportNames));
    if (missing.length === 0) return;
    fetch(`${import.meta.env.BASE_URL}api/opendata/names?icao=${missing.join(',')}`)
      .then((r) => (r.ok ? r.json() : {}))
      // Unbekannte merken (leer), damit nicht ständig nachgefragt wird
      .then((names: Record<string, { name: string; country: string }>) => setAirportNames((prev) => ({ ...prev, ...Object.fromEntries(missing.map((c) => [c, names[c] ?? { name: '', country: '' }])) })))
      .catch(() => { /* dann eben nur die Codes */ });
  }, [selectedRoute, airportNames]);
  const routeBanner = selectedLive
    ? {
        callsign: selectedLive.callsign,
        airline: airlineName(selectedLive.callsign),
        text: selectedRoute
          ? selectedRoute.split('-').map((c) => {
              // Klarname (ICAO, Land)
              const a = airportNames[c];
              return a?.name ? `${a.name} (${c}${a.country ? `, ${a.country}` : ''})` : c;
            }).join('  →  ')
          : 'Start und Ziel unbekannt',
      }
    : null;

  // ── Wetter: METAR beim Laden des Platzes, dann alle 10 Minuten ──
  useEffect(() => {
    if (!airport) return;
    let stopped = false;
    const poll = async () => {
      const weather = await fetchWeather(airport.icao);
      // Fehlschlag: letzten Stand behalten
      if (!stopped && weather) engineRef.current?.setWeather(weather);
    };
    void poll();
    const id = setInterval(poll, WEATHER_POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [airport]);

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

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <a href="https://games.himmelreich.cloud/" style={{ color: '#446644', fontSize: 11, letterSpacing: 1, textDecoration: 'none', whiteSpace: 'nowrap' }}>← ALLE SPIELE</a>
        <button onClick={() => setShowHelp(true)} title="Was macht ein Lotse? Befehle, Funk, Punkte" style={HELP_BUTTON}>? HOWTO</button>
      </div>

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
            if (AVAILABLE_AIRPORTS.includes(v)) chooseIcao(v);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && /^[A-Z0-9]{4}$/.test(icaoInput)) chooseIcao(icaoInput); }}
          onBlur={() => { if (/^[A-Z0-9]{4}$/.test(icaoInput)) chooseIcao(icaoInput); else setIcaoInput(selectedIcao); }}
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

      {/* Verkehr: SIM oder LIVE */}
      <div>
        <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>TRAFFIC</span>
          {gameState.trafficMode !== 'sim' && (
            <span style={{ color: gameState.live.error ? '#ffaa00' : '#00ff88' }}>
              {gameState.live.updatedAt === null
                ? (gameState.live.error ? 'keine Daten' : 'lädt…')
                : `${gameState.live.count} AC · ${gameState.live.inbound} IN · ${Math.round((Date.now() - gameState.live.updatedAt) / 1000)} s`}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 3 }}>
          {TRAFFIC_OPTIONS.map((o) => (
            <button
              key={o.id}
              title={o.title}
              onClick={() => engineRef.current?.setTrafficMode(o.id)}
              style={{
                flex: 1,
                background: gameState.trafficMode === o.id ? '#0a3020' : 'transparent',
                border: `1px solid ${gameState.trafficMode === o.id ? '#00cc66' : '#1a4428'}`,
                color: gameState.trafficMode === o.id ? '#00ff88' : '#446644',
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

      {/* WATCH: Standort des Zuschauers – am Platz (ICAO) oder per GPS */}
      {watching && (
        <div>
          <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>SPECTATOR</div>
          <div style={{ display: 'flex', gap: 3 }}>
            {[
              { label: `ICAO ${selectedIcao}`, title: 'Standort am gewählten Platz (ICAO oben eingeben)', active: !gameState.spectator,
                onClick: () => { engineRef.current?.setSpectator(null); setGpsStatus(null); } },
              { label: 'GPS', title: 'Standort per GPS des Geräts; der nächste Verkehrsflughafen wird gewählt', active: !!gameState.spectator, onClick: locateByGps },
            ].map((o) => (
              <button key={o.label} title={o.title} onClick={o.onClick} style={{
                flex: 1,
                background: o.active ? '#0a3020' : 'transparent',
                border: `1px solid ${o.active ? '#00cc66' : '#1a4428'}`,
                color: o.active ? '#00ff88' : '#446644',
                fontFamily: '"Courier New", monospace', fontSize: 11, padding: '4px 2px', cursor: 'pointer', borderRadius: 2,
              }}>{o.label}</button>
            ))}
          </div>
          {gpsStatus && <div style={{ color: gpsStatus.startsWith('GPS ±') ? '#7fa88c' : '#ffaa00', fontSize: 10, marginTop: 3 }}>{gpsStatus}</div>}
        </div>
      )}

      {/* WATCH TAG: alle Starts und Landungen eines Tages */}
      {watching && (
        <div>
          <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
            <span title="Alle aufgezeichneten Starts und Landungen des Tages als Linien; Filter IN/OUT/ALLE wie bei der Liste">TAG: STARTS / LANDUNGEN</span>
            {dayOn && dayStatus && <span style={{ color: dayStatus.includes('nicht') ? '#ffaa00' : '#7fa88c' }}>{dayStatus}</span>}
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            <button onClick={toggleDay} title="Tageslinien ein- oder ausblenden" style={{
              flex: '0 0 56px',
              background: dayOn ? '#0a3020' : 'transparent',
              border: `1px solid ${dayOn ? '#00cc66' : '#1a4428'}`,
              color: dayOn ? '#00ff88' : '#446644',
              fontFamily: '"Courier New", monospace', fontSize: 11, padding: '4px 2px', cursor: 'pointer', borderRadius: 2,
            }}>{dayOn ? 'AN' : 'AUS'}</button>
            <input type="date" value={dayDate} max={today()} onChange={(e) => e.target.value && setDayDate(e.target.value)} style={{
              flex: 1, minWidth: 0, background: '#0a1a0a', border: '1px solid #1a4428', color: '#00ff88', colorScheme: 'dark',
              fontFamily: '"Courier New", monospace', fontSize: 11, padding: '3px 4px', borderRadius: 2,
            }} />
          </div>
        </div>
      )}

      {/* WATCH: Ortschaften ab Einwohnerzahl */}
      {watching && (
        <div>
          <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
            <span>ORTE AB EINWOHNERN</span>
            {townStatus && <span style={{ color: '#ffaa00' }}>{townStatus}</span>}
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            {TOWN_OPTIONS.map((o) => (
              <button key={o.pop} onClick={() => changeTownMin(o.pop)} title={o.pop ? `Orte ab ${o.pop.toLocaleString('de-DE')} Einwohnern` : 'Keine Orte'} style={{
                flex: 1,
                background: townMin === o.pop ? '#0a3020' : 'transparent',
                border: `1px solid ${townMin === o.pop ? '#00cc66' : '#1a4428'}`,
                color: townMin === o.pop ? '#00ff88' : '#446644',
                fontFamily: '"Courier New", monospace', fontSize: 11, padding: '4px 2px', cursor: 'pointer', borderRadius: 2,
              }}>{o.label}</button>
            ))}
          </div>
        </div>
      )}

      {/* Active landing runway */}
      {airport && (() => {
        const ilsRunways = airport.runways.filter((r) => r.ils && r.role !== 'departure');
        if (ilsRunways.length === 0) return null;
        return (
          <div>
            <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
              <span>ACTIVE RWY</span>
              {/* Herkunft der Landerichtung; nach Handwahl schaltet ein Klick zurück auf automatisch */}
              <span
                title={RUNWAY_SOURCES[gameState.runwaySource].title}
                onClick={() => gameState.runwaySource === 'manual' && engineRef.current?.setRunwayAuto()}
                style={{
                  color: gameState.runwaySource === 'manual' ? '#ffaa00' : '#00ff88',
                  cursor: gameState.runwaySource === 'manual' ? 'pointer' : 'default',
                }}
              >
                {RUNWAY_SOURCES[gameState.runwaySource].label}
              </span>
            </div>
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

      {airport && <StationPanel airport={airport} weather={gameState.weather} />}

      {/* Range selector */}
      <div>
        <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>RANGE</span>
          <span style={{ color: '#00ff88' }}>{gameState.rangeNM < 2 ? gameState.rangeNM.toFixed(1) : Math.round(gameState.rangeNM)} NM</span>
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
          {/* Ein Spurpunkt alle 5 s */}
          <span style={{ color: '#00ff88' }}>{gameState.trailLength === 0 ? 'AUS' : `${Math.floor(gameState.trailLength * 5 / 60)}:${String(gameState.trailLength * 5 % 60).padStart(2, '0')} min`}</span>
        </div>
        <input
          type="range" min={0} max={120} step={1}
          value={gameState.trailLength}
          onChange={(e) => engineRef.current?.setTrailLength(Number(e.target.value))}
          style={{ width: '100%', accentColor: '#00cc66', cursor: 'pointer' }}
        />
      </div>

      {watching ? (
        <WatchPanel
          aircraft={gameState.watch} roles={gameState.watchRoles} airport={airport} spectator={gameState.spectator}
          selectedId={gameState.selectedId} onSelect={handleSelectAircraft} traceStatus={traceStatus}
          filter={watchFilter} onFilter={changeWatchFilter}
          transit={radioPrefs.transit} onTransit={(on) => changeRadioPrefs({ transit: on })}
          radio={radioPrefs.watch} onRadio={(on) => changeRadioPrefs({ watch: on })}
          onFocus={(ac) => { handleSelectAircraft(`live-${ac.hex}`); if (!gameState.followId) engineRef.current?.centerOn(ac.lat, ac.lng); }}
        />
      ) : (<>
      {/* Alerts */}
      <AlertBanner conflicts={gameState.conflicts} aircraft={gameState.aircraft} names={gameState.liveNames} />

      {/* Traffic strips */}
      <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1 }}>
        TRAFFIC ({gameState.aircraft.filter((a) => a.state !== 'landed').length})
      </div>
      <AircraftStrip aircraft={gameState.aircraft} selectedId={gameState.selectedId} onSelect={handleSelectAircraft} />

      {/* Commands */}
      <div style={{ color: '#446644', fontSize: 10, letterSpacing: 1 }}>COMMANDS</div>
      <CommandPanel
        selected={selected} airport={airport} onCommand={handleCommand} activeRunwayIds={gameState.activeRunwayIds}
        pendingCmdTypes={selected ? gameState.pendingCmdTypes[selected.id] : undefined}
      />

      {/* Score / controls */}
      <ScorePanel
        score={gameState.score} landings={gameState.landings} violations={gameState.violations}
        paused={gameState.paused} timeScale={gameState.timeScale} timeLocked={gameState.trafficMode === 'live'} sweepEnabled={gameState.sweepEnabled}
        onPause={() => engineRef.current?.pause()}
        onResume={() => engineRef.current?.resume()}
        onToggleSweep={() => engineRef.current?.setSweep(!gameState.sweepEnabled)}
        onTimeScale={(s) => engineRef.current?.setTimeScale(s)}
      />
      </>)}
    </div>
  );

  // ── Layout ────────────────────────────────────────────────────────────────
  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: isMobile ? 'column' : 'row', overflow: 'hidden', fontFamily: '"Courier New", Courier, monospace' }}>

      {isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', background: '#050e05', borderBottom: '1px solid #0a2010', flexShrink: 0 }}>
          <span style={{ color: '#00cc66', fontSize: 13, fontWeight: 'bold' }}>{watching ? 'ATC WATCH' : 'ATC APPROACH'}</span>
          <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#446644' }}>
            {watching ? <span style={{ color: '#00ff88' }}>{gameState.watch.length} AC</span> : <>
              <span style={{ color: gameState.score >= 0 ? '#00ff88' : '#ff3333' }}>{gameState.score}</span>
              <span>{gameState.landings} LND</span>
            </>}
            <button onClick={() => setShowHelp(true)} title="HowTo" style={HELP_BUTTON}>?</button>
            <button onClick={() => setBottomOpen((o) => !o)} style={{ background: bottomOpen ? '#0a2a18' : 'transparent', border: '1px solid #1a4428', color: '#00cc66', padding: '2px 8px', fontFamily: '"Courier New", monospace', fontSize: 11, cursor: 'pointer', borderRadius: 2 }}>
              {bottomOpen ? '▲ RADAR' : '▼ CTRL'}
            </button>
          </div>
        </div>
      )}

      {(!isMobile || !bottomOpen) && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, position: 'relative' }}>
          {routeBanner && (
            <div style={{
              position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 5, pointerEvents: 'none',
              maxWidth: 'calc(100% - 140px)', textAlign: 'center', padding: '4px 12px', borderRadius: 3,
              background: 'rgba(5,14,5,0.8)', border: '1px solid #1a4428', color: '#cde', fontSize: isMobile ? 11 : 13,
            }}>
              <span style={{ color: '#78d7ff', fontWeight: 'bold' }}>{routeBanner.callsign}</span>{routeBanner.airline && <span style={{ color: '#9fc8e0' }}>{' · '}{routeBanner.airline}</span>}{'  '}{routeBanner.text}
            </div>
          )}
          <RadarCanvas
            engine={engineRef.current}
            aircraft={gameState.aircraft}
            selectedId={gameState.selectedId}
            onSelectAircraft={handleSelectAircraft}
            onContextMenu={handleContextMenu}
            onWatchMenu={(id, x, y) => setWatchMenu({ id, x, y, callsign: gameState.watch.find((a) => `live-${a.hex}` === id)?.callsign ?? id.replace('live-', '') })}
            view3D={view3D}
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
              { label: '3D', title: '3D-Ansicht: Ziehen verschiebt, rechte Maustaste/Shift oder zwei Finger drehen und neigen, Rad/Pinch zoomt', active: view3D, onClick: toggleView3D },
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

      {watchMenu && (
        <WatchMenu menu={watchMenu} following={gameState.followId === watchMenu.id}
          onFollow={(on) => engineRef.current?.follow(on ? watchMenu.id : null)} onClose={() => setWatchMenu(null)} />
      )}
      {gameState.followId && (
        <button onClick={() => engineRef.current?.follow(null)} title="Folgen beenden"
          style={{ position: 'fixed', bottom: 64, left: '50%', transform: 'translateX(-50%)', zIndex: 40, background: '#06140c', border: '1px solid #00cc66', color: '#00ff88', fontFamily: '"Courier New", monospace', fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}>
          KAMERA FOLGT {gameState.watch.find((a) => `live-${a.hex}` === gameState.followId)?.callsign ?? gameState.aircraft.find((a) => a.id === gameState.followId)?.callsign ?? ''} ✕
        </button>
      )}

      {(!isMobile || bottomOpen) && sidebar}

      {showHelp && <HowTo onClose={closeHelp} />}
    </div>
  );
}

const HELP_BUTTON: React.CSSProperties = {
  background: 'transparent', border: '1px solid #1a4428', color: '#00cc66',
  fontFamily: '"Courier New", monospace', fontSize: 11, padding: '2px 8px',
  cursor: 'pointer', borderRadius: 2, letterSpacing: 1,
};

// ── Display toggle bar ────────────────────────────────────────────────────────
const DISPLAY_TOGGLES: { key: keyof DisplayOptions; label: string; title?: string }[] = [
  { key: 'labels',   label: 'LABELS'  },
  { key: 'ilsCones', label: 'ILS'     },
  { key: 'waypoints',label: 'NAVAID'  },
  { key: 'allNavaids', label: 'NAV ALL', title: 'Auch Wegpunkte der STARs inaktiver Bahnen zeigen' },
  { key: 'stars',    label: 'STARs'   },
  { key: 'landmarks', label: 'BLDG', title: 'Markante Bauwerke: Hochhäuser, Türme und große Stadien (OpenStreetMap)' },
  { key: 'roads', label: 'ROADS', title: 'Autobahnen als Orientierung (OpenStreetMap)' },
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
      {DISPLAY_TOGGLES.map(({ key, label, title }) => (
        <button key={key} title={title} onClick={() => onChange({ [key]: !display[key] })} style={toggleStyle(display[key])}>
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
