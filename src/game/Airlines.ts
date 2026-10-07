// filepath: src/game/Airlines.ts
// Name der Airline zum Rufzeichen (CFG1TX → Condor), Liste vom Server (OpenFlights airlines.dat, ODbL)
let table: Record<string, string> = {};
let loading: Promise<void> | null = null;

/** Liste einmalig laden; bis dahin (oder bei Fehler) gibt airlineName nichts zurück */
export function loadAirlines(): Promise<void> {
  loading ??= fetch(`${import.meta.env.BASE_URL}api/opendata/airlines`)
    .then((res) => (res.ok ? res.json() : {}))
    .then((map: Record<string, string>) => { table = map; })
    .catch(() => { /* ohne Namen geht es auch */ });
  return loading;
}

/** Airline zum ICAO-Rufzeichen (drei Buchstaben, dann Ziffer); null bei Kennzeichen oder unbekannt */
export function airlineName(callsign: string): string | null {
  const m = /^([A-Z]{3})\d/.exec(callsign);
  return m ? table[m[1]] ?? null : null;
}
