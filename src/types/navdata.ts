// filepath: src/types/navdata.ts
export interface Waypoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  type: 'fix' | 'vor' | 'ndb' | 'apt';
}

export interface STARLeg {
  waypointId: string;
  altRestrictionFt?: number;
  speedRestrictionKts?: number;
}

export interface STAR {
  id: string;
  name?: string;    // Prozedurname für die Anzeige, falls id die Bahn enthält (z. B. "KERA6A/25L")
  fullName?: string; // ausgeschriebener Name für Funk und Anzeige, z. B. "KERAX 6A"
  icao: string;
  runway: string;   // e.g. "25L" or "ALL"
  waypoints: Waypoint[];
  legs: STARLeg[];
}
