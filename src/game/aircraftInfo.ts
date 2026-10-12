// filepath: src/game/aircraftInfo.ts
// Steckbriefe fürs Favoriten-Radar: Klartextname des ICAO-Typs und Land zum Kennzeichen (Nationalitätszeichen).

const TYPE_NAMES: Record<string, string> = {
  A318: 'Airbus A318', A319: 'Airbus A319', A320: 'Airbus A320', A321: 'Airbus A321',
  A19N: 'Airbus A319neo', A20N: 'Airbus A320neo', A21N: 'Airbus A321neo',
  A306: 'Airbus A300-600', A310: 'Airbus A310', A332: 'Airbus A330-200', A333: 'Airbus A330-300', A338: 'Airbus A330-800neo', A339: 'Airbus A330-900neo',
  A342: 'Airbus A340-200', A343: 'Airbus A340-300', A345: 'Airbus A340-500', A346: 'Airbus A340-600',
  A359: 'Airbus A350-900', A35K: 'Airbus A350-1000', A388: 'Airbus A380-800', BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300',
  A400: 'Airbus A400M Atlas', A124: 'Antonow An-124',
  B736: 'Boeing 737-600', B737: 'Boeing 737-700', B738: 'Boeing 737-800', B739: 'Boeing 737-900',
  B37M: 'Boeing 737 MAX 7', B38M: 'Boeing 737 MAX 8', B39M: 'Boeing 737 MAX 9', B3XM: 'Boeing 737 MAX 10',
  B752: 'Boeing 757-200', B753: 'Boeing 757-300', B762: 'Boeing 767-200', B763: 'Boeing 767-300', B764: 'Boeing 767-400',
  B772: 'Boeing 777-200', B77L: 'Boeing 777-200LR/F', B773: 'Boeing 777-300', B77W: 'Boeing 777-300ER', B778: 'Boeing 777-8', B779: 'Boeing 777-9',
  B788: 'Boeing 787-8', B789: 'Boeing 787-9', B78X: 'Boeing 787-10', B744: 'Boeing 747-400', B748: 'Boeing 747-8', B74F: 'Boeing 747 Frachter',
  MD11: 'McDonnell Douglas MD-11', DC10: 'McDonnell Douglas DC-10', B712: 'Boeing 717', MD82: 'McDonnell Douglas MD-82', MD83: 'McDonnell Douglas MD-83',
  E170: 'Embraer 170', E175: 'Embraer 175', E75L: 'Embraer 175', E75S: 'Embraer 175', E190: 'Embraer 190', E195: 'Embraer 195',
  E290: 'Embraer 190-E2', E295: 'Embraer 195-E2', E135: 'Embraer ERJ-135', E145: 'Embraer ERJ-145', E55P: 'Embraer Phenom 300',
  CRJ2: 'Bombardier CRJ200', CRJ7: 'Bombardier CRJ700', CRJ9: 'Bombardier CRJ900', CRJX: 'Bombardier CRJ1000',
  AT43: 'ATR 42-300', AT45: 'ATR 42-500', AT72: 'ATR 72', AT75: 'ATR 72-500', AT76: 'ATR 72-600',
  DH8A: 'De Havilland Dash 8-100', DH8C: 'De Havilland Dash 8-300', DH8D: 'De Havilland Dash 8-400',
  F70: 'Fokker 70', F100: 'Fokker 100', SF34: 'Saab 340', SB20: 'Saab 2000', D328: 'Dornier 328', J328: 'Dornier 328JET', B190: 'Beechcraft 1900', JS41: 'BAe Jetstream 41',
  B463: 'BAe 146-300', RJ85: 'Avro RJ85', RJ1H: 'Avro RJ100', C17: 'Boeing C-17 Globemaster III', C130: 'Lockheed C-130 Hercules', K35R: 'Boeing KC-135',
  IL76: 'Iljuschin Il-76', GLF5: 'Gulfstream G550', GLF6: 'Gulfstream G650', GLEX: 'Bombardier Global Express', GL7T: 'Bombardier Global 7500',
  CL35: 'Bombardier Challenger 350', CL60: 'Bombardier Challenger 600', C56X: 'Cessna Citation Excel', C68A: 'Cessna Citation Latitude', C700: 'Cessna Citation Longitude',
  F2TH: 'Dassault Falcon 2000', FA7X: 'Dassault Falcon 7X', FA8X: 'Dassault Falcon 8X', LJ45: 'Learjet 45', PC24: 'Pilatus PC-24', PC12: 'Pilatus PC-12', PC6T: 'Pilatus PC-6 Porter',
  C150: 'Cessna 150', C152: 'Cessna 152', C172: 'Cessna 172 Skyhawk', C182: 'Cessna 182 Skylane', C206: 'Cessna 206', C208: 'Cessna 208 Caravan', C210: 'Cessna 210',
  C310: 'Cessna 310', C340: 'Cessna 340', P28A: 'Piper PA-28 Cherokee', P28R: 'Piper PA-28R Arrow', PA34: 'Piper PA-34 Seneca', PA44: 'Piper PA-44 Seminole', PA46: 'Piper PA-46 Malibu',
  SR20: 'Cirrus SR20', SR22: 'Cirrus SR22', DA40: 'Diamond DA40', DA42: 'Diamond DA42', DA62: 'Diamond DA62', DV20: 'Diamond DV20 Katana', DR40: 'Robin DR400',
  BE20: 'Beechcraft King Air 200', BE35: 'Beechcraft Bonanza', BE36: 'Beechcraft Bonanza A36', BE58: 'Beechcraft Baron', TBM7: 'Daher TBM 700', TBM8: 'Daher TBM 850', TBM9: 'Daher TBM 900',
  P68: 'Vulcanair P.68', BN2P: 'Britten-Norman Islander', DHC6: 'De Havilland Twin Otter', L410: 'Let L-410',
  EC35: 'Airbus H135', EC45: 'Airbus H145', EC30: 'Airbus H130', EC55: 'Airbus H155', H160: 'Airbus H160', AS50: 'Airbus H125 (AS350)', R44: 'Robinson R44', R22: 'Robinson R22',
  A109: 'Leonardo AW109', A139: 'Leonardo AW139', B06: 'Bell 206', NH90: 'NHIndustries NH90', CH47: 'Boeing CH-47 Chinook',
};

export function typeName(type?: string): string | null {
  return type ? TYPE_NAMES[type.toUpperCase()] ?? null : null;
}

// Nationalitätszeichen (längste Übereinstimmung zuerst)
const REG_PREFIX: Array<[string, string]> = [
  ['D-', 'Deutschland'], ['OE-', 'Österreich'], ['HB-', 'Schweiz'], ['F-', 'Frankreich'], ['G-', 'Vereinigtes Königreich'],
  ['EI-', 'Irland'], ['PH-', 'Niederlande'], ['OO-', 'Belgien'], ['LX-', 'Luxemburg'], ['EC-', 'Spanien'], ['CS-', 'Portugal'],
  ['I-', 'Italien'], ['9H-', 'Malta'], ['SX-', 'Griechenland'], ['TC-', 'Türkei'], ['OY-', 'Dänemark'], ['SE-', 'Schweden'],
  ['LN-', 'Norwegen'], ['OH-', 'Finnland'], ['TF-', 'Island'], ['SP-', 'Polen'], ['OK-', 'Tschechien'], ['OM-', 'Slowakei'],
  ['HA-', 'Ungarn'], ['YR-', 'Rumänien'], ['LZ-', 'Bulgarien'], ['9A-', 'Kroatien'], ['S5-', 'Slowenien'], ['YU-', 'Serbien'],
  ['ES-', 'Estland'], ['YL-', 'Lettland'], ['LY-', 'Litauen'], ['UR-', 'Ukraine'], ['4X-', 'Israel'], ['A6-', 'Vereinigte Arabische Emirate'],
  ['A7-', 'Katar'], ['HZ-', 'Saudi-Arabien'], ['9V-', 'Singapur'], ['B-', 'China/Taiwan/Hongkong'], ['JA', 'Japan'], ['HL', 'Südkorea'],
  ['VT-', 'Indien'], ['VH-', 'Australien'], ['ZK-', 'Neuseeland'], ['C-', 'Kanada'], ['N', 'USA'], ['XA-', 'Mexiko'], ['PR-', 'Brasilien'],
  ['PP-', 'Brasilien'], ['PT-', 'Brasilien'], ['LV-', 'Argentinien'], ['ZS-', 'Südafrika'], ['ET-', 'Äthiopien'], ['SU-', 'Ägypten'],
  ['CN-', 'Marokko'], ['TS-', 'Tunesien'], ['7T-', 'Algerien'], ['EP-', 'Iran'], ['AP-', 'Pakistan'], ['HS-', 'Thailand'], ['9M-', 'Malaysia'],
  ['PK-', 'Indonesien'], ['RP-', 'Philippinen'], ['VN-', 'Vietnam'], ['RA-', 'Russland'], ['4K-', 'Aserbaidschan'], ['4L-', 'Georgien'],
  ['EK-', 'Armenien'], ['UK', 'Usbekistan'], ['UP-', 'Kasachstan'], ['9K-', 'Kuwait'], ['A9C-', 'Bahrain'], ['A4O-', 'Oman'], ['JY-', 'Jordanien'],
  ['OD-', 'Libanon'], ['5B-', 'Zypern'], ['ER-', 'Moldau'], ['Z3-', 'Nordmazedonien'], ['ZA-', 'Albanien'], ['T7-', 'San Marino'], ['M-', 'Isle of Man'],
  ['2-', 'Guernsey'], ['VP-B', 'Bermuda'], ['VQ-B', 'Bermuda'], ['P4-', 'Aruba'],
].sort((x, y) => y[0].length - x[0].length) as Array<[string, string]>;

export function regCountry(reg?: string): string | null {
  if (!reg) return null;
  const r = reg.toUpperCase();
  return REG_PREFIX.find(([p]) => r.startsWith(p))?.[1] ?? null;
}
