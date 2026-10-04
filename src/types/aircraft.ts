// filepath: src/types/aircraft.ts
export type AircraftState =
  | 'enroute'
  | 'vectored'
  | 'intercepting'
  | 'established'
  | 'landed'
  | 'goaround';

export interface TrailPoint {
  lat: number;
  lng: number;
  ts: number;
}

export interface Aircraft {
  id: string;
  callsign: string;
  type: string;
  lat: number;
  lng: number;
  altitudeFt: number;
  headingDeg: number;
  speedKts: number;
  verticalSpeedFpm: number;
  targetHeading: number;
  targetAltitude: number;
  targetSpeed: number;
  state: AircraftState;
  trail: TrailPoint[];
  clearedILS: boolean;
  assignedRunway?: string;
  /** Landefreigabe erteilt; ohne sie startet der Flieger auf dem kurzen Endanflug durch */
  clearedToLand?: boolean;
  /** Direct-to auf einen Wegpunkt außerhalb der eigenen STAR; nach Erreichen wird der Kurs gehalten */
  directTo?: { id: string; lat: number; lng: number };
  conflict: boolean;
  warning: boolean;
  /** Forced turn direction for the current heading command; undefined = shortest path */
  turnDirection?: 'left' | 'right';
  /** Assigned STAR id (from navdata) */
  starId?: string;
  /** Index into the STAR's waypoints array — current target leg */
  starLegIndex?: number;
  /** Pilot hat sich auf der Frequenz gemeldet (Erstanruf) */
  contacted?: boolean;
  /** Lotse hat den Flieger angesprochen ("radar contact") */
  identified?: boolean;
  /** Übernommener echter Flieger (LIVE): Transponder-Adresse */
  liveHex?: string;
  /** Startplatz (echte Flieger, laut Flugroute) */
  origin?: string;
}

export interface ConflictPair {
  a: string;
  b: string;
  type: 'warning' | 'conflict';
  lateralNM: number;
  verticalFt: number;
}

export type ATCCommand =
  | { type: 'heading'; value: number; turnDirection?: 'left' | 'right' }
  | { type: 'altitude'; value: number }
  | { type: 'speed'; value: number }
  | { type: 'ils'; runwayId: string }
  | { type: 'land' }
  | { type: 'direct'; waypointId: string; lat: number; lng: number }
  /** Anflugpunkt direkt, danach die gewählte STAR ab diesem Punkt */
  | { type: 'star'; starId: string; waypointId: string };
