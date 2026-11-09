// iCloud sync (CloudKit JS), kept apart from everything else.
// Hunter 11/8 4:45pm: one sign-in for the app and the website. Both sign in with the same Apple ID and read and write the
// same private iCloud database (container iCloud.com.hunterdavis.juice). Only the signed-in person can read it.
// Records (production schema: types Drive and PlannedDrive, each a recordName + String field "json"):
//   Drive/<id>          one drive, full JSON (tags and notes included)
//   PlannedDrive/<id>   one drive saved to a day
//   PlannedDrive/juice-trips, juice-rules, juice-cars, juice-places   "bundles": every item plus ids deleted anywhere, so two sides
//                       adding at once both keep theirs. juice-cars also carries the plan (tier) from the app.
// Same rules as the app (Juice/CloudDrives.swift): pull, merge (newest edit wins, deletes stick), push what changed.
// The web API token is public by design; Apple only accepts it from the allowed origin (hundavis10-design.github.io).

export const CONFIG = {
  containerIdentifier: "iCloud.com.hunterdavis.juice",
  apiToken: "f0dfc5444a56f64f3db9347b297cdf73722a60de2f392a5e598da7e69aac7dca",   // CloudKit Console → Production → Tokens & Keys "JUICE website"
  environment: "production",
};

export const enabled = () => !!CONFIG.apiToken;
const PREFIX = "juice-";
const SENT_KEY = "juice.cksync";

let loading = null;
function loadScript() {
  if (globalThis.CloudKit) return Promise.resolve(globalThis.CloudKit);
  loading ??= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.apple-cloudkit.com/ck/2/cloudkit.js";
    s.async = true;
    s.onload = () => res(globalThis.CloudKit);
    s.onerror = () => rej(new Error("cloudkit.js"));
    document.head.appendChild(s);
  });
  return loading;
}

// ---------- pure helpers (tested in tools/test.mjs) ----------

/** FNV-1a over the JSON text, as a string (same idea as the app's change check). */
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + ":" + text.length;
}
const stamp = x => new Date(x?.updatedAt || x?.end || x?.start || 0).getTime() || 0;

export function loadSync(storage = globalThis.localStorage) {
  try { return JSON.parse(storage?.getItem(SENT_KEY) || "") || {}; } catch { return {}; }
}
export function saveSync(sync, storage = globalThis.localStorage) {
  try { storage?.setItem(SENT_KEY, JSON.stringify(sync)); } catch { /* ignore */ }
}

/** Splits records ({recordType, recordName, json}) into drives, planned and bundles. */
export function split(records) {
  const out = { drives: [], planned: [], bundles: {}, names: new Set() };
  for (const r of records) {
    let j; try { j = JSON.parse(r.json); } catch { continue; }
    if (!j) continue;
    if (r.recordType === "Drive" && j.id) { out.drives.push(j); out.names.add("Drive/" + j.id); }
    else if (r.recordType === "PlannedDrive" && r.recordName.startsWith(PREFIX)) { out.bundles[r.recordName] = j; out.names.add("Bundle/" + r.recordName); }
    else if (r.recordType === "PlannedDrive" && j.id) { out.planned.push(j); out.names.add("PlannedDrive/" + j.id); }
  }
  return out;
}

/** Records we sent that the query didn't return. */
export function missing(records, sync) {
  const names = split(records).names;
  return Object.keys(sync.keys || {}).filter(k => !k.startsWith("Bundle/") && !names.has(k));
}

function mergeNewest(local, incoming, gone) {
  const map = new Map(local.filter(x => !gone.has(x.id)).map(x => [x.id, x]));
  let n = 0;
  for (const x of incoming) {
    const have = map.get(x.id);
    if (!have || stamp(x) > stamp(have)) { map.set(x.id, x); n++; }
  }
  return { list: [...map.values()], n };
}

function mergeBundle(local, bundle, key, sync) {
  const dead = new Set([...(bundle?.deleted || []), ...((sync.tombs || {})[key] || [])]);
  sync.tombs = { ...(sync.tombs || {}), [key]: [...dead].slice(-500) };
  const list = local.filter(x => !dead.has(x.id));
  let n = 0;
  for (const x of bundle?.[key] || []) {
    if (!x?.id || dead.has(x.id)) continue;
    const i = list.findIndex(y => y.id === x.id);
    if (i < 0) { list.push(x); n++; }
    else if (key === "rules" && JSON.stringify(list[i]) !== JSON.stringify(x)) { list[i] = x; n++; }
  }
  return { list, n };
}

/** Merges iCloud into the browser state. Returns how many items came in or changed. */
export function applyRemote(st, records, sync, confirmed) {
  const r = split(records);
  sync.keys ||= {};
  // Sent before, gone now = deleted elsewhere. (An empty iCloud is a reset, never "delete everything".)
  // `confirmed`: the ones checked by name (queries lag a few seconds behind saves); undefined = trust the query (tests).
  const gone = !records.length ? [] : confirmed ?? missing(records, sync);
  const goneIds = type => new Set(gone.filter(k => k.startsWith(type + "/")).map(k => k.slice(type.length + 1)));
  let n = 0;
  const dGone = goneIds("Drive");
  const d = mergeNewest(st.drives, r.drives, dGone); st.drives = d.list; n += d.n;
  st.deletedDrives = [...new Set([...(st.deletedDrives || []), ...dGone])];
  const p = mergeNewest(st.planned, r.planned.map(x => { const y = { ...x }; delete y.eventId; delete y.openedOn; return y; }), goneIds("PlannedDrive"));
  st.planned = p.list; n += p.n;
  const tr = r.bundles["juice-trips"]; if (tr) { const m = mergeBundle(st.trips, tr, "trips", sync); st.trips = m.list; n += m.n; }
  const ru = r.bundles["juice-rules"]; if (ru) { const m = mergeBundle(st.rules, ru, "rules", sync); st.rules = m.list; n += m.n; }
  const cars = r.bundles["juice-cars"];
  if (cars) {
    if (Array.isArray(cars.cars) && cars.cars.length) st.cars = cars.cars;
    if (["free", "plus", "pro"].includes(cars.tier)) st.meta.tier = cars.tier;
    if (cars.units === "km" || cars.units === "mi") st.meta.units = cars.units;
    st.meta.fromICloud = true;
  }
  // Saved places (Home, Work…) and favorite chargers: the app owns them; the site shows them on the map and Garage.
  const pl = r.bundles["juice-places"];
  if (pl) {
    if (Array.isArray(pl.places)) st.places = pl.places;
    if (Array.isArray(pl.favorites)) st.favorites = pl.favorites;
  }
  for (const g of gone) delete sync.keys[g];
  return n;
}

function noteDeletes(sync, kind, ids) {
  const last = new Set((sync.lastIds || {})[kind] || []);
  const now = new Set(ids);
  const removed = [...last].filter(x => !now.has(x));
  const tombs = [...new Set([...((sync.tombs || {})[kind] || []), ...removed])].filter(x => !now.has(x)).slice(-500);
  sync.tombs = { ...(sync.tombs || {}), [kind]: tombs };
  sync.lastIds = { ...(sync.lastIds || {}), [kind]: ids };
  return tombs.sort();
}

/** What to send: records that changed since the last sync, and records deleted here. */
export function outgoing(st, sync) {
  sync.keys ||= {};
  const keys = {}, save = [];
  const add = (recordType, recordName, key, obj) => {
    const json = JSON.stringify(obj), h = hash(json);
    keys[key] = h;
    if (sync.keys[key] !== h) save.push({ recordType, recordName, json });
  };
  const pro = ["pro"].includes(st.meta?.tier);
  if (pro) for (const d of st.drives) add("Drive", d.id, "Drive/" + d.id, d);
  for (const p of st.planned) add("PlannedDrive", p.id, "PlannedDrive/" + p.id, p);
  const trips = st.trips.slice(0, 60);
  add("PlannedDrive", "juice-trips", "Bundle/juice-trips",
    { kind: "trips", trips: trips.map(t => ({ id: t.id, name: t.name, places: t.places || [], stops: t.stops || [], ...(t.saved ? { saved: t.saved } : {}) })),
      deleted: noteDeletes(sync, "trips", trips.map(t => t.id)) });
  if (pro) add("PlannedDrive", "juice-rules", "Bundle/juice-rules", { kind: "rules", rules: st.rules, deleted: noteDeletes(sync, "rules", st.rules.map(r => r.id)) });
  // juice-cars is written by the app only (it knows the plan); the website just reads it.
  if (sync.keys["Bundle/juice-cars"]) keys["Bundle/juice-cars"] = sync.keys["Bundle/juice-cars"];
  // Not Pro here: drives aren't ours to send or delete this time, so they keep their old state.
  if (!pro) for (const [k, v] of Object.entries(sync.keys)) if (k.startsWith("Drive/")) keys[k] = v;
  const del = Object.keys(sync.keys).filter(k => !keys[k] && !k.startsWith("Bundle/")).map(k => k.split("/").pop());
  for (const [k, v] of Object.entries(sync.keys)) if (k.startsWith("Bundle/") && !keys[k]) keys[k] = v;
  return { save, del, keys };
}

// ---------- CloudKit ----------

const toPlain = r => ({ recordType: r.recordType, recordName: r.recordName, json: r.fields?.json?.value });

async function queryAll(db, recordType) {
  const out = [];
  let resp = await db.performQuery({ recordType });
  for (;;) {
    if (resp.hasErrors) { const e = resp.errors[0]; if (e?.ckErrorCode === "NOT_FOUND") break; throw e; }
    out.push(...resp.records.map(toPlain));
    if (!resp.moreComing) break;
    resp = await db.performQuery(resp);
  }
  return out;
}

/** Only "no such record" by name counts as deleted elsewhere (a fresh save can be missing from queries for a bit). */
async function confirmGone(db, keys) {
  const gone = [];
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    const resp = await db.fetchRecords(chunk.map(k => k.split("/").pop()));
    const missingNames = new Set((resp.errors || []).filter(e => (e.ckErrorCode === "NOT_FOUND" || e.serverErrorCode === "NOT_FOUND")).map(e => e.recordName));
    chunk.forEach(k => { if (missingNames.has(k.split("/").pop())) gone.push(k); });
  }
  return gone;
}

async function push(db, out) {
  const recs = out.save.map(r => ({ recordType: r.recordType, recordName: r.recordName, fields: { json: { value: r.json } } }));
  for (let i = 0; i < Math.max(recs.length, out.del.length); i += 200) {
    const b = db.newRecordsBatch();
    recs.slice(i, i + 200).forEach(r => b.forceReplace(r));
    out.del.slice(i, i + 200).forEach(n => b.forceDelete({ recordName: n }));
    const resp = await b.commit();
    if (resp.hasErrors) throw resp.errors[0];
  }
}

/**
 * Puts the Apple sign-in button in the page and keeps the browser in sync while signed in.
 *   getState() → the browser state; onSynced(n, info) after each sync; onStatus("signedOut"|"syncing"|"signedIn"|"error").
 * Returns { schedule() } to call after every local change.
 */
export function mount({ getState, persist, onSynced, onStatus }) {
  const api = { schedule() {}, syncNow() {} };
  if (!enabled()) return api;
  let db = null, me = null, timer = null, busy = false, again = false;

  async function syncNow() {
    if (!db) return;
    if (busy) { again = true; return; }
    busy = true; onStatus?.("syncing");
    try {
      const st = getState();
      let sync = loadSync();
      if (sync.account !== me) sync = { account: me, keys: {} };   // another Apple ID: start fresh
      const records = [...await queryAll(db, "Drive"), ...await queryAll(db, "PlannedDrive")];
      const n = applyRemote(st, records, sync, records.length ? await confirmGone(db, missing(records, sync)) : []);
      persist();
      const out = outgoing(st, sync);
      await push(db, out);
      sync.keys = out.keys;
      saveSync(sync);
      onStatus?.("signedIn");
      onSynced?.(n, { drives: st.drives.length, trips: st.trips.length, planned: st.planned.length, at: new Date() });
    } catch (e) {
      console.warn("[JUICE iCloud]", e);
      onStatus?.("error", e);
    } finally {
      busy = false;
      if (again) { again = false; syncNow(); }
    }
  }
  api.syncNow = syncNow;
  api.schedule = () => { if (!db) return; clearTimeout(timer); timer = setTimeout(syncNow, 3000); };

  (async () => {
    try {
      const CK = await loadScript();
      CK.configure({
        containers: [{
          containerIdentifier: CONFIG.containerIdentifier,
          apiTokenAuth: { apiToken: CONFIG.apiToken, persist: true,
            signInButton: { id: "apple-sign-in-button", theme: "black" },
            signOutButton: { id: "apple-sign-out-button", theme: "black" } },
          environment: CONFIG.environment,
        }],
      });
      const container = CK.getDefaultContainer();
      const signedIn = async user => {
        me = user.userRecordName; db = container.privateCloudDatabase;
        onStatus?.("signedIn"); await syncNow();
        container.whenUserSignsOut().then(() => { db = null; me = null; onStatus?.("signedOut"); waitIn(); });
      };
      const waitIn = () => container.whenUserSignsIn().then(signedIn).catch(e => { onStatus?.("error", e); });
      const user = await container.setUpAuth();
      if (user) await signedIn(user); else { onStatus?.("signedOut"); waitIn(); }
      // Pick up phone changes when the tab comes back.
      document.addEventListener("visibilitychange", () => { if (!document.hidden) api.schedule(); });
    } catch (e) { console.warn("[JUICE iCloud]", e); onStatus?.("error", e); }
  })();
  return api;
}
