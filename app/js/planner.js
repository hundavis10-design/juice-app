// Trip planning: route geometry helpers, chargers along the route, and the greedy charging-stop picker.
// Pure functions only (network calls live in net.js) so node tests can run them.
import { haversineKm, KM_PER_MI } from "./util.js";

/** OSRM GeoJSON coords [[lon,lat],…] → points with cumulative km. */
export function cumulative(coords) {
  const out = [];
  let d = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    if (i > 0) { const p = out[out.length - 1]; d += haversineKm(p.lat, p.lon, lat, lon); }
    out.push({ lat, lon, d });
  }
  return out;
}

/** Keep one point every ~stepKm (always the last), for fast nearest-point lookups. */
export function thin(points, stepKm = 0.25) {
  if (points.length < 3) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) if (points[i].d - out[out.length - 1].d >= stepKm) out.push(points[i]);
  out.push(points[points.length - 1]);
  return out;
}

/** The point at a given km along the route (linear between vertices). */
export function pointAt(points, km) {
  if (km <= 0) return points[0];
  for (let i = 1; i < points.length; i++) {
    if (points[i].d >= km) {
      const a = points[i - 1], b = points[i], f = b.d > a.d ? (km - a.d) / (b.d - a.d) : 0;
      return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, d: km };
    }
  }
  return points[points.length - 1];
}

/** Where to ask for chargers: evenly spaced points, with a search radius that covers the whole route. */
export function samplePoints(points, { maxSamples = 40 } = {}) {
  const total = points[points.length - 1].d;
  let spacing = Math.max(40, Math.min(120, total / 12));
  if (total / spacing + 1 > maxSamples) spacing = total / (maxSamples - 1);
  const n = Math.max(1, Math.ceil(total / spacing));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(pointAt(points, Math.min(total, i * total / n)));
  const step = total / n;
  return { samples: out, radiusKm: Math.min(150, Math.ceil(step / 2 + 6)) };
}

/** Nearest route point to a lat/lon: how far along (km) and how far off (km). */
export function project(lat, lon, thinPts) {
  let best = Infinity, along = 0;
  // Cheap equirectangular distance for the search, real distance for the answer.
  const kx = Math.cos(lat * Math.PI / 180);
  for (const p of thinPts) {
    const dx = (p.lon - lon) * kx, dy = p.lat - lat, q = dx * dx + dy * dy;
    if (q < best) { best = q; along = p.d; }
  }
  const p = pointAt(thinPts, along);
  return { along, off: haversineKm(lat, lon, p.lat, p.lon) };
}

/** Open Charge Map POIs → plain chargers. Tesla-only sites are kept only for Tesla cars. */
export function parseOCM(pois, { allowTeslaOnly = false } = {}) {
  const out = [];
  for (const p of pois || []) {
    const a = p.AddressInfo || {};
    if (a.Latitude == null || a.Longitude == null) continue;
    const kws = (p.Connections || []).map(c => Number(c.PowerKW) || 0);
    const maxKw = Math.max(0, ...kws);
    const op = p.OperatorInfo?.Title || "";
    // OCM operator 23 = "Tesla (Tesla-only charging)"; open Superchargers are listed under a different operator.
    const teslaOnly = p.OperatorID === 23 || /tesla-only/i.test(op);
    if (teslaOnly && !allowTeslaOnly) continue;
    if (p.StatusType && p.StatusType.IsOperational === false) continue;
    out.push({
      id: String(p.ID),
      name: a.Title || "",
      lat: a.Latitude, lon: a.Longitude,
      network: op.replace(/\s*\(.*\)\s*$/, ""),
      maxKw: maxKw || 50,
      address: [a.AddressLine1, a.Town, a.StateOrProvince].filter(Boolean).join(", "),
      stalls: p.NumberOfPoints || null,
    });
  }
  return out;
}

/** Chargers within maxOffKm of the route, each with along/off, deduped by id and by spot. */
export function alongRoute(chargers, thinPts, maxOffKm = 3) {
  const byId = new Map();
  for (const c of chargers) {
    if (byId.has(c.id)) continue;
    const { along, off } = project(c.lat, c.lon, thinPts);
    if (off > maxOffKm) continue;
    byId.set(c.id, { ...c, along, off });
  }
  // Same spot listed twice (different ids, < 60 m apart): keep the faster one.
  const list = [...byId.values()].sort((a, b) => a.along - b.along);
  const out = [];
  for (const c of list) {
    const dup = out.find(o => Math.abs(o.along - c.along) < 1 && haversineKm(o.lat, o.lon, c.lat, c.lon) < 0.06);
    if (dup) { if (c.maxKw > dup.maxKw) Object.assign(dup, c); continue; }
    out.push(c);
  }
  return out;
}

/** Charge time estimate: kWh / min(charger kW, 150), slowed by a taper factor, at least 5 min. */
export const TAPER = 1.25;
/** Look back this far from the farthest reachable charger for a faster one. */
export const PREFER_KM = 25;
export function chargeMinutes(kwh, maxKw) {
  if (kwh <= 0) return 0;
  return Math.max(5, kwh / Math.min(maxKw || 50, 150) * 60 * TAPER);
}

/**
 * Greedy charging plan. At each step, drive to the farthest fast charger you can reach without dropping under
 * the reserve, charge to chargeToPct (or only what the rest needs), repeat until the destination is in reach.
 * Distances in km. Returns { ok, stops, timeline, arrivePct, driveMin, chargeMin, totalKm } or { ok:false, error, atKm }.
 */
export function planStops({ totalKm, durationMin, chargers, rangeMi, batteryKwh, startPct, reservePct = 15, chargeToPct = 80, waypoints = [] }) {
  const rangeKm = rangeMi * KM_PER_MI;
  const pctPerKm = 100 / rangeKm;
  const minPerKm = totalKm > 0 ? durationMin / totalKm : 1;
  if (chargeToPct <= reservePct) return { ok: false, error: "chargeTo" };
  const sorted = chargers.filter(c => c.maxKw >= 50).sort((a, b) => a.along - b.along);
  let pos = 0, off = 0, pct = startPct;
  const stops = [];
  for (let guard = 0; guard < 60; guard++) {
    const remain = totalKm - pos + off;
    if (pct - remain * pctPerKm >= reservePct - 1e-9) break;
    const reach = sorted.filter(c => c.along > pos + 0.5 && pct - (c.along - pos + off + c.off) * pctPerKm >= reservePct - 1e-9);
    if (!reach.length) return { ok: false, error: "reach", atKm: pos, stops };
    // The farthest reachable one, but a much faster charger up to PREFER_KM before it wins (less time plugged in).
    const far = Math.max(...reach.map(c => c.along));
    let best = null;
    for (const c of reach) {
      if (c.along < far - PREFER_KM) continue;
      const kw = Math.min(c.maxKw, 250), bk = best && Math.min(best.maxKw, 250);
      if (!best || kw > bk || (kw === bk && c.along > best.along)) best = c;
    }
    const legKm = best.along - pos + off + best.off;
    const arrive = pct - legKm * pctPerKm;
    const restNeed = (totalKm - best.along + best.off) * pctPerKm + reservePct;
    let leave = chargeToPct;
    if (restNeed <= chargeToPct) leave = Math.min(chargeToPct, Math.max(arrive, Math.ceil(restNeed / 5) * 5));
    if (leave <= arrive + 0.5 && restNeed > arrive) return { ok: false, error: "reach", atKm: best.along, stops };
    const kwh = Math.max(0, (leave - arrive) / 100 * batteryKwh);
    stops.push({ ...best, arrivePct: arrive, leavePct: leave, kwh, chargeMin: chargeMinutes(kwh, best.maxKw) });
    pos = best.along; off = best.off; pct = leave;
  }

  // Timeline: start, charging stops and the user's own stops in route order, then the destination.
  const pts = [
    ...stops.map(s => ({ kind: "charge", along: s.along, off: s.off, stop: s })),
    ...waypoints.map(w => ({ kind: "waypoint", along: w.alongKm, off: 0, name: w.name, lat: w.lat, lon: w.lon })),
  ].sort((a, b) => a.along - b.along);
  const timeline = [];
  let p = startPct, at = 0, atOff = 0, driveMin = 0, chargeMin = 0;
  for (const x of pts) {
    const km = Math.max(0, x.along - at) + atOff + x.off;
    const arrive = p - km * pctPerKm;
    const min = km * minPerKm;
    driveMin += min;
    const row = { kind: x.kind, legKm: km, legMin: min, arrivePct: arrive };
    if (x.kind === "charge") {
      Object.assign(row, { stop: x.stop, leavePct: x.stop.leavePct, chargeMin: x.stop.chargeMin, name: x.stop.name, lat: x.stop.lat, lon: x.stop.lon });
      chargeMin += x.stop.chargeMin; p = x.stop.leavePct;
    } else { Object.assign(row, { name: x.name, lat: x.lat, lon: x.lon }); p = arrive; }
    timeline.push(row);
    at = x.along; atOff = x.off;
  }
  const lastKm = Math.max(0, totalKm - at) + atOff;
  const arrivePct = p - lastKm * pctPerKm;
  driveMin += lastKm * minPerKm;
  timeline.push({ kind: "destination", legKm: lastKm, legMin: lastKm * minPerKm, arrivePct });
  return { ok: true, stops, timeline, arrivePct, driveMin, chargeMin, totalKm };
}
