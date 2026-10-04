// filepath: src/game/Aircraft.ts
import type { Aircraft, TrailPoint } from '@/types/aircraft';
import type { AircraftState } from '@/types/aircraft';
import type { Runway } from '@/types/airport';
import type { STAR } from '@/types/navdata';
import { turnToHeading, adjustAltitude, adjustSpeed, ktsToNMps, headingDiff, glideslopeAltitude, normaliseHdg } from '@/utils/aviation';
import { destinationPoint, distanceNM, bearingBetween } from '@/utils/geo';
import { TRAIL_LENGTH, TRAIL_INTERVAL_MS, typeData } from './constants';

export function createAircraft(partial: Omit<Aircraft, 'trail' | 'conflict' | 'warning'>): Aircraft {
  return { ...partial, trail: [], conflict: false, warning: false };
}

export function updateAircraft(
  ac: Aircraft,
  dt: number,
  now: number,
  runway?: Runway,
  star?: STAR,
): { updated: Aircraft; remove: boolean } {
  if (ac.state === 'landed') {
    return { updated: ac, remove: true };
  }

  let state: AircraftState = ac.state;
  let headingDeg = ac.headingDeg;
  let altitudeFt = ac.altitudeFt;
  let speedKts = ac.speedKts;
  let verticalSpeedFpm = ac.verticalSpeedFpm;
  const clearedILS = ac.clearedILS;

  let targetHdg = ac.targetHeading;
  let targetAlt = ac.targetAltitude;
  let targetSpd = ac.targetSpeed;
  let turnDirection = ac.turnDirection;
  let starLegIndex = ac.starLegIndex ?? 0;
  let directTo = ac.directTo;

  // ── Direct-to (Wegpunkt außerhalb der STAR) ───────────────────────────────
  if (!clearedILS && directTo) {
    targetHdg = Math.round(bearingBetween(ac.lat, ac.lng, directTo.lat, directTo.lng));
    // Am Punkt angekommen: aktuellen Kurs halten, Lotse übernimmt wieder
    if (distanceNM(ac.lat, ac.lng, directTo.lat, directTo.lng) < 1.5) directTo = undefined;
  }

  // ── STAR navigation (enroute, not ILS-cleared) ────────────────────────────
  if (!clearedILS && state === 'enroute' && star && starLegIndex < star.waypoints.length) {
    const wp = star.waypoints[starLegIndex];
    const leg = star.legs[starLegIndex];
    const distToWp = distanceNM(ac.lat, ac.lng, wp.lat, wp.lng);

    targetHdg = Math.round(bearingBetween(ac.lat, ac.lng, wp.lat, wp.lng));
    if (leg?.altRestrictionFt !== undefined && targetAlt > leg.altRestrictionFt) {
      targetAlt = leg.altRestrictionFt;
    }
    if (leg?.speedRestrictionKts !== undefined && targetSpd > leg.speedRestrictionKts) {
      targetSpd = leg.speedRestrictionKts;
    }

    if (distToWp < 1.5) {
      starLegIndex++;
    }
  }

  // ── ILS auto-guidance (when cleared ILS) ──────────────────────────────────
  if (clearedILS && runway) {
    const distToThr = distanceNM(ac.lat, ac.lng, runway.thresholdLat, runway.thresholdLng);
    const bearingToThr = bearingBetween(ac.lat, ac.lng, runway.thresholdLat, runway.thresholdLng);
    // Signed deviation: how far the aircraft is from the extended centreline
    // positive = aircraft LEFT of centreline, negative = RIGHT of centreline
    const locDeviation = headingDiff(runway.heading, bearingToThr);

    if (state === 'established') {
      // Follow localizer and glideslope precisely
      targetHdg = normaliseHdg(runway.heading + locDeviation * 1.5); // slight correction
      targetAlt = glideslopeAltitude(distToThr, 0);
    } else {
      // Not yet established — steer toward localizer intercept
      const approachSpd = typeData(ac.type).approachKts;

      if (Math.abs(locDeviation) < 1.5 && distToThr < 14) {
        // On centreline close enough: establish
        state = 'established';
        targetHdg = runway.heading;
        targetAlt = glideslopeAltitude(distToThr, 0);
      } else if (distToThr < 25) {
        // Within capture range: steer toward centreline
        state = 'intercepting';
        // Intercept angle: proportional to deviation, capped at 30°
        const interceptAngle = Math.min(Math.abs(locDeviation) * 1.2, 30);
        targetHdg = normaliseHdg(runway.heading + Math.sign(locDeviation) * interceptAngle);
        // Start glideslope descent from 8 NM out
        if (distToThr < 8) targetAlt = glideslopeAltitude(distToThr, 0);
      } else {
        // Far out: fly toward extended centreline approach point
        // Aim for a point on the localizer inbound at 20 NM
        const cosLat = Math.cos(ac.lat * Math.PI / 180);
        const rwyHdRad = runway.heading * Math.PI / 180;
        // Point 20 NM from threshold on the extended centreline
        const captureDistNM = 20;
        const captureLat = runway.thresholdLat - Math.cos(rwyHdRad) * captureDistNM / 60;
        const captureLng = runway.thresholdLng - Math.sin(rwyHdRad) * captureDistNM / (60 * cosLat);
        const hdgToCapture = bearingBetween(ac.lat, ac.lng, captureLat, captureLng);
        targetHdg = hdgToCapture;
        if (state === 'enroute') state = 'vectored';
      }

      // Auto-reduce to approach speed once within 15 NM
      if (distToThr < 15 && targetSpd > approachSpd) {
        targetSpd = approachSpd;
      }
    }
  }

  // ILS auto-guidance overrides any manual turnDirection
  if (clearedILS && runway) turnDirection = undefined;

  headingDeg = turnToHeading(headingDeg, targetHdg, dt, 3, turnDirection);
  // Clear forced direction only when the heading has arrived via the forced arc,
  // not by shortest-path distance (which would prematurely clear a long forced turn).
  if (turnDirection === 'right') {
    const remaining = normaliseHdg(targetHdg - headingDeg); // 0..360 clockwise remaining
    if (remaining < 1 || remaining > 359) turnDirection = undefined;
  } else if (turnDirection === 'left') {
    const remaining = normaliseHdg(headingDeg - targetHdg); // 0..360 counter-clockwise remaining
    if (remaining < 1 || remaining > 359) turnDirection = undefined;
  } else {
    if (Math.abs(headingDiff(headingDeg, targetHdg)) < 1) turnDirection = undefined;
  }

  const altResult = adjustAltitude(altitudeFt, targetAlt, dt);
  altitudeFt = altResult.alt;
  verticalSpeedFpm = altResult.vs;

  speedKts = adjustSpeed(speedKts, targetSpd, dt);

  const distNMTravelled = ktsToNMps(speedKts) * dt;
  const newPos = destinationPoint(ac.lat, ac.lng, headingDeg, distNMTravelled);

  // Trail
  const trail: TrailPoint[] = [...ac.trail];
  const lastTrail = trail[trail.length - 1];
  if (!lastTrail || now - lastTrail.ts >= TRAIL_INTERVAL_MS) {
    trail.push({ lat: ac.lat, lng: ac.lng, ts: now });
    if (trail.length > TRAIL_LENGTH) trail.shift();
  }

  // Landing / go-around
  if (state === 'established' && runway) {
    const distToThreshold = distanceNM(newPos.lat, newPos.lng, runway.thresholdLat, runway.thresholdLng);
    if (distToThreshold < 1.0 && !ac.clearedToLand) {
      // Keine Landefreigabe auf dem kurzen Endanflug → Durchstarten
      state = 'goaround';
    } else if (distToThreshold < 0.3 && altitudeFt < 500) {
      state = 'landed';
    } else if (distToThreshold < 1.0 && (altitudeFt > 1500 || speedKts > 180)) {
      state = 'goaround';
    }
  }

  const updated: Aircraft = {
    ...ac,
    lat: newPos.lat,
    lng: newPos.lng,
    headingDeg,
    altitudeFt,
    speedKts,
    verticalSpeedFpm,
    targetHeading: targetHdg,
    targetAltitude: targetAlt,
    targetSpeed: targetSpd,
    state,
    trail,
    turnDirection,
    starLegIndex,
    directTo,
  };

  return { updated, remove: state === 'landed' };
}
