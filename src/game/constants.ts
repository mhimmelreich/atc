// filepath: src/game/constants.ts
export const SEP_LATERAL_NM = 3;
export const SEP_VERTICAL_FT = 1000;
export const WARN_LATERAL_NM = 5;
export const WARN_VERTICAL_FT = 2000;

export const RADAR_RANGE_NM = 80;
export const SWEEP_PERIOD_MS = 4000;
export const TRAIL_LENGTH = 120;
export const TRAIL_INTERVAL_MS = 5000;

export const ILS_CONE_HALF_DEG = 3;
export const ILS_CONE_LENGTH_NM = 15;
export const LOCALIZER_WIDTH_DEG = 30;  // max intercept angle
export const GLIDESLOPE_DEG = 3;

// Aircraft turn/climb performance
export const TURN_RATE_DEG_S = 3;
export const MAX_VS_FPM = 2000;
export const ACCEL_KTS_S = 5;

// Spawn config
export const SPAWN_INTERVAL_MIN_S = 45;
export const SPAWN_INTERVAL_MAX_S = 90;
export const SPAWN_DISTANCE_NM = 70;
export const MAX_AIRCRAFT = 12;

// Score
export const SCORE_LANDING = 100;
export const SCORE_SEPARATION_VIOLATION = -50;
export const SCORE_COLLISION = -200;
export const SCORE_GOAROUND = -30;

// Aircraft types and their approach speeds (kts)
// wake: M=Medium, H=Heavy, J=Super (ICAO wake turbulence category)
export const AIRCRAFT_TYPES: Record<string, { approachKts: number; cruiseKts: number; wake: 'M' | 'H' | 'J' }> = {
  B738: { approachKts: 140, cruiseKts: 280, wake: 'M' },
  A320: { approachKts: 137, cruiseKts: 280, wake: 'M' },
  A321: { approachKts: 145, cruiseKts: 280, wake: 'M' },
  B77W: { approachKts: 155, cruiseKts: 290, wake: 'H' },
  A388: { approachKts: 160, cruiseKts: 290, wake: 'J' },
  E190: { approachKts: 130, cruiseKts: 260, wake: 'M' },
  DH8D: { approachKts: 120, cruiseKts: 200, wake: 'M' },
  CRJ9: { approachKts: 125, cruiseKts: 250, wake: 'M' },
};

export type TypeData = (typeof AIRCRAFT_TYPES)[string];

/**
 * Leistungsdaten zu einem ICAO-Mustercode. Echte Flieger (LIVE) bringen beliebige Codes mit:
 * bekannte direkt, sonst nach Familie (A20N wie A320, B789 wie B77W), im Zweifel wie ein A320.
 */
export function typeData(type: string): TypeData {
  return AIRCRAFT_TYPES[type] ?? AIRCRAFT_TYPES[typeFamily(type)];
}

function typeFamily(type: string): string {
  if (/^A38\w$/.test(type)) return 'A388';
  if (/^(A30\w|A310|A3[345]\w|B7[4678]\w|MD11|IL96|A124|A400|C17)$/.test(type)) return 'B77W';
  if (type === 'A21N') return 'A321';
  if (/^(B73\w|B3\dM|B3XM|B75\w)$/.test(type)) return 'B738';
  if (/^(E1[79]\d|E2[89]\d|E75\w|E1[34]5|BCS\d|F100|RJ\w\w|B46\d)$/.test(type)) return 'E190';
  if (/^CRJ\w$/.test(type)) return 'CRJ9';
  if (/^(AT[4-7]\w|DH8\w|SF34|D328|ATP|F50|JS41|B190|C130)$/.test(type)) return 'DH8D';
  return 'A320';
}

export const CALLSIGN_PREFIXES = [
  'DLH', 'EZY', 'RYR', 'BAW', 'AFL', 'UAE', 'THY', 'SWR',
  'KLM', 'IBE', 'AUA', 'SAS', 'TAP', 'VKG', 'CFG', 'TUI',
];
