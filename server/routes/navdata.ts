// Navigraph-AIRAC-Daten aus der Little-NavMap-SQLite-DB.
// Die DB ist lizenziert und liegt NICHT im Repo: Pfad per NAVDATA_DB,
// Standard data/navdata/little_navmap_navigraph.sqlite (siehe scripts/extract-navdata.sh).
import { Router } from 'express';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import NodeCache from 'node-cache';
import type { Airport, ILSData, Runway } from '../../src/types/airport';
import type { STAR, STARLeg, Waypoint } from '../../src/types/navdata';

const router = Router();
const cache = new NodeCache({ stdTTL: 86400 });

const DB_PATH = process.env.NAVDATA_DB ?? 'data/navdata/little_navmap_navigraph.sqlite';
const FT_TO_M = 0.3048;
const NAVAID_RADIUS_NM = 50;
// Anflugsektor: STARs beginnen frühestens so weit vom Platz entfernt
const STAR_MAX_ENTRY_NM = 40;

// Privater Zugang: ohne passenden Schlüssel liefert die Route nichts (Lizenz: nur Eigennutzung)
const NAVDATA_KEY = process.env.NAVDATA_KEY ?? '';

let db: DatabaseSync | null = null;
let cycle: string | null = null;

function openDb(): DatabaseSync | null {
  if (db) return db;
  if (!existsSync(DB_PATH)) return null;
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  const meta = db.prepare('SELECT airac_cycle FROM metadata').get() as { airac_cycle?: string } | undefined;
  cycle = meta?.airac_cycle ?? null;
  console.log(`navdata: ${DB_PATH} geladen (AIRAC ${cycle ?? '?'})`);
  return db;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => (v == null ? '' : String(v));

// ── Airport + Runways + ILS ───────────────────────────────────────────────────
function loadAirport(d: DatabaseSync, icao: string): Airport | null {
  const ap = d.prepare(
    `SELECT airport_id, ident, name, mag_var, transition_altitude, altitude, lonx, laty
       FROM airport WHERE ident = ?`,
  ).get(icao) as Row | undefined;
  if (!ap) return null;

  const ilsRows = d.prepare(
    `SELECT ident, type, frequency, loc_heading, gs_pitch, loc_runway_name, perf_indicator
       FROM ils WHERE loc_airport_ident = ? AND type NOT IN ('G', 'T')`,
  ).all(icao) as Row[];
  const ilsByRunway = new Map<string, ILSData>();
  for (const r of ilsRows) {
    const rwy = str(r.loc_runway_name);
    const gs = num(r.gs_pitch);
    const prev = ilsByRunway.get(rwy);
    // Pro Bahn ein Eintrag; ILS mit Gleitpfad schlägt reinen LOC
    if (prev && (prev.glideslopeAngle > 0 || gs === 0)) continue;
    ilsByRunway.set(rwy, {
      runway: rwy,
      localizerCourse: Math.round(num(r.loc_heading) * 10) / 10,
      glideslopeAngle: gs,
      frequencyMHz: num(r.frequency) / 1000,
      category: ilsCategory(str(r.perf_indicator)),
    });
  }

  const rwyRows = d.prepare(
    `SELECT r.length, r.width,
            p.name AS p_name, p.heading AS p_hdg, p.lonx AS p_lon, p.laty AS p_lat,
            p.altitude AS p_alt, p.offset_threshold AS p_off,
            s.name AS s_name, s.heading AS s_hdg, s.lonx AS s_lon, s.laty AS s_lat,
            s.altitude AS s_alt, s.offset_threshold AS s_off
       FROM runway r
       JOIN runway_end p ON p.runway_end_id = r.primary_end_id
       JOIN runway_end s ON s.runway_end_id = r.secondary_end_id
      WHERE r.airport_id = ?`,
  ).all(num(ap.airport_id)) as Row[];

  const runways: Runway[] = [];
  for (const r of rwyRows) {
    const base = { lengthM: Math.round(num(r.length) * FT_TO_M), widthM: Math.round(num(r.width) * FT_TO_M) };
    for (const [a, b] of [['p', 's'], ['s', 'p']] as const) {
      const id = str(r[`${a}_name`]);
      const off = num(r[`${a}_off`]);
      runways.push({
        ...base,
        id,
        recipId: str(r[`${b}_name`]),
        // Wahre Kurse, wie überall im Spiel (Navigation über bearingBetween)
        heading: Math.round(num(r[`${a}_hdg`]) * 10) / 10,
        recipHeading: Math.round(num(r[`${b}_hdg`]) * 10) / 10,
        thresholdLat: num(r[`${a}_lat`]),
        thresholdLng: num(r[`${a}_lon`]),
        endLat: num(r[`${b}_lat`]),
        endLng: num(r[`${b}_lon`]),
        elevationFt: num(r[`${a}_alt`]),
        ...(off > 0 ? { displacedThresholdM: Math.round(off * FT_TO_M) } : {}),
        ...(ilsByRunway.has(id) ? { ils: ilsByRunway.get(id) } : {}),
      });
    }
  }

  return {
    icao,
    name: str(ap.name),
    lat: num(ap.laty),
    lng: num(ap.lonx),
    elevationFt: num(ap.altitude),
    magneticVariation: Math.round(num(ap.mag_var) * 10) / 10,
    transitionAltitudeFt: num(ap.transition_altitude) || 5000,
    runways,
  };
}

function ilsCategory(perf: string): ILSData['category'] {
  if (perf.includes('3')) return 'III';
  if (perf.includes('2')) return 'II';
  return 'I';
}

// ── STARs ─────────────────────────────────────────────────────────────────────
// In der LNM-DB sind SIDs/STARs Einträge in "approach" mit type='GPS',
// suffix 'D' (SID) bzw. 'A' (STAR); fix_ident ist der Prozedurname.
function loadStars(d: DatabaseSync, airport: Airport, waypoints: Map<string, Waypoint>): STAR[] {
  const icao = airport.icao;
  const procs = d.prepare(
    `SELECT approach_id, fix_ident, runway_name, arinc_name
       FROM approach WHERE airport_ident = ? AND type = 'GPS' AND suffix = 'A'
      ORDER BY fix_ident, runway_name`,
  ).all(icao) as Row[];
  const legStmt = d.prepare(
    `SELECT fix_ident, fix_type, fix_lonx, fix_laty, alt_descriptor, altitude1, altitude2,
            speed_limit_type, speed_limit
       FROM approach_leg WHERE approach_id = ? AND is_missed = 0
      ORDER BY approach_leg_id`,
  );

  const stars: STAR[] = [];
  for (const p of procs) {
    const name = str(p.fix_ident);
    const pts: Waypoint[] = [];
    const legs: STARLeg[] = [];
    for (const l of legStmt.all(num(p.approach_id)) as Row[]) {
      const ident = str(l.fix_ident);
      // Legs ohne Fix (Vektoren, FM/VM) und Bahnschwellen überspringen
      if (!ident || l.fix_lonx == null || l.fix_type === 'R') continue;
      if (pts.length > 0 && pts[pts.length - 1].id === ident) continue;
      const wp = waypoints.get(ident) ?? {
        id: ident, name: ident, lat: num(l.fix_laty), lng: num(l.fix_lonx), type: waypointType(str(l.fix_type)),
      };
      pts.push(wp);
      legs.push({ waypointId: ident, ...altRestriction(l), ...speedRestriction(l) });
    }
    // Weit entfernte Anfangs-Fixes abschneiden, damit der Verkehr im Radarbereich erscheint
    while (pts.length > 2 && distanceNM(airport.lat, airport.lng, pts[0].lat, pts[0].lng) > STAR_MAX_ENTRY_NM) {
      pts.shift();
      const dropped = legs.shift();
      // Höhenvorgabe des abgeschnittenen Legs weitergeben (bestimmt die Einflughöhe)
      if (dropped?.altRestrictionFt !== undefined && legs[0].altRestrictionFt === undefined) {
        legs[0] = { ...legs[0], altRestrictionFt: dropped.altRestrictionFt };
      }
    }
    if (pts.length < 2) continue;
    for (const wp of pts) waypoints.set(wp.id, wp);
    for (const runway of starRunways(p, airport)) {
      stars.push({ id: `${name}/${runway}`, name, icao, runway, waypoints: pts, legs });
    }
  }
  return stars;
}

// Bahnen einer STAR: runway_name, sonst ARINC "RW26B" (= alle Parallelbahnen 26), sonst "ALL"
function starRunways(p: Row, airport: Airport): string[] {
  const rwy = str(p.runway_name);
  if (rwy) return [rwy];
  const both = /^RW(\d{2})B$/.exec(str(p.arinc_name));
  if (both) {
    const ids = airport.runways.map((r) => r.id).filter((id) => /^\d{2}[LRC]?$/.test(id) && id.startsWith(both[1]));
    if (ids.length > 0) return ids;
  }
  return ['ALL'];
}

function distanceNM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}

function waypointType(fixType: string): Waypoint['type'] {
  if (fixType === 'V') return 'vor';
  if (fixType === 'N') return 'ndb';
  return 'fix';
}

// Das Spiel nutzt altRestrictionFt als Obergrenze → bei "zwischen" die obere Grenze
function altRestriction(l: Row): Pick<STARLeg, 'altRestrictionFt'> {
  const alt = num(l.altitude1);
  return alt > 0 ? { altRestrictionFt: alt } : {};
}

// "mindestens" (+) ist keine Obergrenze und wird ignoriert
function speedRestriction(l: Row): Pick<STARLeg, 'speedRestrictionKts'> {
  const spd = num(l.speed_limit);
  return spd > 0 && l.speed_limit_type !== '+' ? { speedRestrictionKts: spd } : {};
}

// ── VOR/NDB im Umkreis ───────────────────────────────────────────────────────
function loadNavaids(d: DatabaseSync, lat: number, lng: number, out: Map<string, Waypoint>): void {
  const dLat = NAVAID_RADIUS_NM / 60;
  const dLng = dLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.1);
  const box = [lat - dLat, lat + dLat, lng - dLng, lng + dLng];
  const q = (table: 'vor' | 'ndb') => d.prepare(
    `SELECT ident, name, lonx, laty FROM ${table}
      WHERE laty BETWEEN ? AND ? AND lonx BETWEEN ? AND ?`,
  ).all(...box) as Row[];
  for (const [table, type] of [['vor', 'vor'], ['ndb', 'ndb']] as const) {
    for (const r of q(table)) {
      const id = str(r.ident);
      if (out.has(id)) continue;
      out.set(id, { id, name: `${id} ${type.toUpperCase()}`, lat: num(r.laty), lng: num(r.lonx), type });
    }
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  if (NAVDATA_KEY && req.get('X-Navdata-Key') !== NAVDATA_KEY) {
    res.status(401).json({ error: 'Kein Zugriff auf Navdata' });
    return;
  }
  next();
});

router.get('/', (_req, res) => {
  const d = openDb();
  res.json({ available: d !== null, cycle });
});

router.get('/:icao', (req, res) => {
  const icao = req.params.icao.toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(icao)) { res.status(400).json({ error: 'Ungültiger ICAO-Code' }); return; }

  const cached = cache.get(icao);
  if (cached) { res.json(cached); return; }

  let d: DatabaseSync | null;
  try {
    d = openDb();
  } catch (err) {
    console.error('navdata: DB konnte nicht geöffnet werden:', err);
    res.status(503).json({ error: 'Navdata nicht verfügbar' });
    return;
  }
  if (!d) { res.status(503).json({ error: 'Navdata nicht installiert' }); return; }

  const airport = loadAirport(d, icao);
  if (!airport) { res.status(404).json({ error: `Flughafen ${icao} nicht gefunden` }); return; }

  const waypoints = new Map<string, Waypoint>();
  const stars = loadStars(d, airport, waypoints);
  loadNavaids(d, airport.lat, airport.lng, waypoints);

  const body = { cycle, airport, waypoints: Array.from(waypoints.values()), stars };
  cache.set(icao, body);
  res.json(body);
});

export default router;
