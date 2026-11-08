// Browser storage (localStorage, keys start with "juice.") plus import/export in the app's juice-export format.

const KEYS = ["cars", "drives", "deletedDrives", "rules", "trips", "planned", "meta", "prefs"];
const DEFAULTS = () => ({ cars: [], drives: [], deletedDrives: [], rules: [], trips: [], planned: [], meta: { tier: "free" }, prefs: {} });

export function load(storage = globalThis.localStorage) {
  const st = DEFAULTS();
  for (const k of KEYS) {
    try { const v = storage?.getItem("juice." + k); if (v != null) st[k] = JSON.parse(v); } catch { /* keep default */ }
  }
  return st;
}

export function save(st, keys = KEYS, storage = globalThis.localStorage) {
  for (const k of keys) { try { storage?.setItem("juice." + k, JSON.stringify(st[k])); } catch { /* full or blocked */ } }
}

export function clearAll(storage = globalThis.localStorage) {
  for (const k of KEYS) storage?.removeItem("juice." + k);
}

export const TIERS = ["free", "plus", "pro"];
export const tierAtLeast = (st, t) => TIERS.indexOf(st.meta?.tier || "free") >= TIERS.indexOf(t);

function stamp(x) { return new Date(x.updatedAt || x.end || x.start || 0).getTime() || 0; }

function mergeById(local, incoming, newerWins) {
  const map = new Map(local.map(x => [x.id, x]));
  let added = 0, updated = 0;
  for (const x of incoming || []) {
    if (!x || !x.id) continue;
    const have = map.get(x.id);
    if (!have) { map.set(x.id, x); added++; }
    else if (!newerWins || stamp(x) > stamp(have)) { map.set(x.id, x); updated++; }
  }
  return { list: [...map.values()], added, updated };
}

export function isExport(j) { return j && j.format === "juice-export" && Array.isArray(j.drives ?? []); }

/** Merge an export file into the state. Drives/planned: newer updatedAt wins (fallback end). Deleted ids are removed. */
export function mergeImport(st, j) {
  if (!isExport(j)) throw new Error("not-juice");
  const deleted = new Set([...(st.deletedDrives || []), ...(j.deletedDrives || [])]);
  const cars = mergeById(st.cars, j.cars, false);
  const drives = mergeById(st.drives, j.drives, true);
  const rules = mergeById(st.rules, j.rules, false);
  const trips = mergeById(st.trips, j.trips, false);
  const planned = mergeById(st.planned, j.planned, true);
  const before = drives.list.length;
  st.cars = cars.list;
  st.drives = drives.list.filter(d => !deleted.has(d.id));
  st.deletedDrives = [...deleted];
  st.rules = rules.list;
  st.trips = trips.list;
  st.planned = planned.list;
  if (j.tier && ["free", "plus", "pro"].includes(j.tier)) st.meta.tier = j.tier;
  st.meta.importedAt = new Date().toISOString();
  st.meta.fileLang = j.lang;
  return {
    cars: (j.cars || []).length, drives: (j.drives || []).length, rules: (j.rules || []).length,
    trips: (j.trips || []).length, planned: (j.planned || []).length, removed: before - st.drives.length,
  };
}

/** The same format the app writes, so tags and notes made here can go back into JUICE. */
export function buildExport(st, lang, now = new Date()) {
  const trips = st.trips.map(t => ({ id: t.id, name: t.name, places: t.places || [], stops: t.stops || [] }));
  return {
    format: "juice-export", version: 1, exportedAt: now.toISOString(),
    tier: st.meta?.tier || "free", lang: lang === "zh-HK" ? "zh-HK" : "en",
    cars: st.cars, drives: st.drives, deletedDrives: st.deletedDrives, rules: st.rules, trips, planned: st.planned,
  };
}
