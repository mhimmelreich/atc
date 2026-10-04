// filepath: src/types/radio.ts
/** Stimmen des Sprachdienstes: Lotse (atc) und Piloten (us/gb, viele Sprecher) */
export type RadioVoiceKey = 'atc' | 'us' | 'gb';

export interface RadioMessage {
  id: number;
  /** Zeitpunkt der Meldung (Date.now()) */
  ts: number;
  from: 'atc' | 'pilot';
  aircraftId?: string;
  /** ICAO-Rufzeichen wie auf dem Streifen, z. B. DLH427 */
  callsign: string;
  /** Text fürs Funk-Log */
  text: string;
  /** Sprechtext: Ziffern einzeln ausgeschrieben, Buchstaben im Buchstabieralphabet */
  spoken: string;
  voice: RadioVoiceKey;
  speaker: number;
}
