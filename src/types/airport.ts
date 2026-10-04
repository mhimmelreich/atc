// filepath: src/types/airport.ts

export interface ILSData {
  runway: string;           // e.g. "25L"
  localizerCourse: number;  // magnetic degrees
  glideslopeAngle: number;  // degrees (typically 3.0)
  frequencyMHz: number;
  dmeNM?: number;           // DME co-located at threshold
  category: 'I' | 'II' | 'III';
  decisionHeightFt?: number;
  rvr?: number;             // minimum RVR in meters
}

export interface Runway {
  id: string;               // e.g. "25L"
  recipId: string;          // e.g. "07R"
  heading: number;          // magnetic heading landing direction
  recipHeading: number;
  thresholdLat: number;     // where aircraft touches down
  thresholdLng: number;
  endLat: number;           // opposite end (far end of runway)
  endLng: number;
  lengthM: number;
  widthM: number;
  ils?: ILSData;
  displacedThresholdM?: number;
  elevationFt: number;
  role?: 'both' | 'landing' | 'departure'; // operational role; undefined = both
}

export interface OsmWay {
  id: number;
  geometry: Array<{ lat: number; lng: number }>;
  tags: Record<string, string>;
}

export interface AirportLayer {
  taxiways: OsmWay[];
  aprons: OsmWay[];
  terminals: OsmWay[];
  holdingPoints: Array<{ lat: number; lng: number; name?: string }>;
}

export interface Airport {
  icao: string;
  name: string;
  /** Stadt (OurAirports), für den Rufnamen der Anflugkontrolle */
  city?: string;
  lat: number;
  lng: number;
  elevationFt: number;
  magneticVariation: number;  // degrees east positive
  transitionAltitudeFt: number;
  runways: Runway[];
  layer?: AirportLayer;       // populated from Overpass
}

export type RangeNM = 5 | 10 | 20 | 40 | 80;
