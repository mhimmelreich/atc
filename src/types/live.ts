// filepath: src/types/live.ts
/** Verkehrsquelle: erfundener Verkehr (SIM) oder echte Flieger per ADS-B (LIVE) */
export type TrafficMode = 'sim' | 'live';

/** Echter Flieger aus adsb.lol (nicht gelotst) */
export interface LiveAircraft {
  hex: string;
  callsign: string;
  type?: string;
  reg?: string;
  lat: number;
  lng: number;
  altFt: number | null;
  ground: boolean;
  gs: number | null;
  track: number | null;
  vs: number | null;
  squawk?: string;
  /** Im Autopiloten gewählte Höhe (MCP/FCU), also die zuletzt freigegebene Höhe */
  selAltFt?: number;
  /** Flugroute als ICAO-Kette, z. B. "EIDW-EDDF" (falls bekannt) */
  route?: string;
  /** Zeitpunkt der Position (Date.now()) */
  ts: number;
}

/** Echter Anflug zum gewählten Platz, den der Spieler übernehmen kann (fürs Radarbild) */
export interface LiveInbound {
  /** Startplatz laut Flugroute */
  origin?: string;
  /** Ohne Flugroute nur nach Lage geschätzt */
  guess: boolean;
  /** Pilot hat sich schon gemeldet */
  called: boolean;
}

export interface LiveStatus {
  count: number;
  /** davon Anflüge zum gewählten Platz */
  inbound: number;
  updatedAt: number | null;
  error: boolean;
}
