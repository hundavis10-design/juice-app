// Network calls: Nominatim (places), OSRM (route), Open Charge Map (chargers).
import { OCM_KEY, OCM_URL, OSRM_URL, NOMINATIM_URL } from "./config.js";
import { parseOCM } from "./planner.js";

export class NetError extends Error {
  constructor(service, msg) { super(msg || service); this.service = service; }
}

// Nominatim asks for at most 1 request a second. Every geocode goes through this queue.
let lastNominatim = 0;
let chain = Promise.resolve();
const geoCache = new Map();

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

/** bias = [minLon, minLat, maxLon, maxLat]: a soft preference (places inside come first), never a filter. */
export function geocode(q, lang = "en", limit = 5, bias = null) {
  q = q.trim();
  const key = `${lang}|${limit}|${bias}|${q.toLowerCase()}`;
  if (geoCache.has(key)) return Promise.resolve(geoCache.get(key));
  const run = async () => {
    const gap = Date.now() - lastNominatim;
    if (gap < 1100) await wait(1100 - gap);
    lastNominatim = Date.now();
    const vb = bias ? `&viewbox=${bias.join(",")}` : "";
    const u = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=jsonv2&limit=${limit}&accept-language=${encodeURIComponent(lang)}${vb}`;
    let r;
    try { r = await fetch(u, { headers: { Accept: "application/json" } }); } catch { throw new NetError("Nominatim"); }
    if (!r.ok) throw new NetError("Nominatim", String(r.status));
    let list = (await r.json()).map(x => ({ title: x.display_name, short: shortName(x), lat: +x.lat, lon: +x.lon }));
    if (bias) {
      const inside = p => p.lon >= bias[0] && p.lon <= bias[2] && p.lat >= bias[1] && p.lat <= bias[3];
      list = [...list.filter(inside), ...list.filter(p => !inside(p))];
    }
    geoCache.set(key, list);
    return list;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

function shortName(x) {
  const parts = String(x.display_name || "").split(",").map(s => s.trim());
  return (x.name && x.name !== parts[0] ? x.name + ", " : "") + parts.slice(0, 3).join(", ");
}

/** coords: [{lat,lon}, …] in order. Returns { coords:[[lon,lat]…], km, min, legs:[{km,min}] }. */
export async function route(points) {
  const path = points.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  let r;
  try { r = await fetch(`${OSRM_URL}${path}?overview=full&geometries=geojson`); } catch { throw new NetError("OSRM"); }
  if (!r.ok && r.status !== 400) throw new NetError("OSRM", String(r.status));
  const j = await r.json();
  if (j.code !== "Ok" || !j.routes?.length) return null;
  const rt = j.routes[0];
  return {
    coords: rt.geometry.coordinates,
    km: rt.distance / 1000,
    min: rt.duration / 60,
    legs: rt.legs.map(l => ({ km: l.distance / 1000, min: l.duration / 60 })),
  };
}

/** Fast chargers (50 kW+) within radiusKm of a point. */
export async function chargersNear(lat, lon, radiusKm, { allowTeslaOnly = false, maxResults = 200 } = {}) {
  const u = `${OCM_URL}?key=${OCM_KEY}&output=json&latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}` +
    `&distance=${Math.round(radiusKm)}&distanceunit=km&minpowerkw=50&maxresults=${maxResults}&verbose=false`;
  let r;
  try { r = await fetch(u); } catch { throw new NetError("Open Charge Map"); }
  if (!r.ok) throw new NetError("Open Charge Map", String(r.status));
  return parseOCM(await r.json(), { allowTeslaOnly });
}

/** Run tasks with a small concurrency limit, reporting progress. */
export async function pool(items, limit, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      onProgress?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
