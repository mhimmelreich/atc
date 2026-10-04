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
  /** Zeitpunkt der Position (Date.now()) */
  ts: number;
}

export interface LiveStatus {
  count: number;
  updatedAt: number | null;
  error: boolean;
}
