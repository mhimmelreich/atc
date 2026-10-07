// filepath: src/game/Airlines.ts
// Name der Airline zum Rufzeichen (CFG1TX → Condor), Liste vom Server (OpenFlights airlines.dat, ODbL)
// OpenFlights ist teils veraltet oder umständlich (CFG „Condor Flugdienst“, TUI „Tuninter“): heutige Namen vorziehen
const OVERRIDES: Record<string, string> = {
  CFG: 'Condor', TUI: 'TUIfly', TFL: 'TUI fly Netherlands', JAF: 'TUI fly Belgium', TOM: 'TUI Airways',
  SXS: 'SunExpress', BCS: 'DHL (European Air Transport)', DHK: 'DHL Air', GEC: 'Lufthansa Cargo',
  CLH: 'Lufthansa CityLine', LHX: 'Lufthansa City Airlines', DLA: 'Air Dolomiti', ITY: 'ITA Airways',
  EJU: 'easyJet Europe', EZS: 'easyJet Switzerland', EDW: 'Edelweiss', WMT: 'Wizz Air Malta', WUK: 'Wizz Air UK',
  DLH: 'Lufthansa', EWG: 'Eurowings', DJT: 'Discover Airlines', OCN: 'Discover Airlines',
};

let table: Record<string, string> = { ...OVERRIDES };
let loading: Promise<void> | null = null;

/** Liste einmalig laden; bis dahin (oder bei Fehler) gibt airlineName nichts zurück */
export function loadAirlines(): Promise<void> {
  loading ??= fetch(`${import.meta.env.BASE_URL}api/opendata/airlines`)
    .then((res) => (res.ok ? res.json() : {}))
    .then((map: Record<string, string>) => { table = { ...map, ...OVERRIDES }; })
    .catch(() => { /* ohne Namen geht es auch */ });
  return loading;
}

/** Airline zum ICAO-Rufzeichen (drei Buchstaben, dann Ziffer); null bei Kennzeichen oder unbekannt */
export function airlineName(callsign: string): string | null {
  const m = /^([A-Z]{3})\d/.exec(callsign);
  return m ? table[m[1]] ?? null : null;
}
