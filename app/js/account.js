// JUICE account on the website. Hunter 11/9 8:30am: "It shouldn't need to be tied to iCloud. I want the same Apple
// login that I can use on any other app/website ... my lack of Storage never stops me from being able to sign in and
// see my data". Sign in with Apple JS (Services ID com.hunterdavis.juice.web) → JUICE's own server api.juiceev.app
// (Cloudflare Worker + D1). The iPhone/Mac app signs in with the same Apple ID and reads/writes the same records.
//
// Records: {kind, id, json, updated (ms), deleted}. kinds: drive, planned, trip, rule, place, favorite, car, meta
// (the app also keeps "charge" records, which the website does not show).
// Same rules as the app (Juice/CloudDrives.swift): pull what changed since last time (newer edit wins, deletes stick),
// then push what changed here. The session lives in localStorage; nothing here touches iCloud.

export const API = "https://api.juiceev.app";
export const CLIENT_ID = "com.hunterdavis.juice.web";
const SESSION = "juice.session", SYNC = "juice.acct";

// ---------- pure helpers (tested in tools/test-account.mjs) ----------
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + ":" + text.length;
}
const stampOf = x => new Date(x?.updatedAt || x?.end || x?.start || 0).getTime() || 0;

/** Every syncable item in the browser state: "kind/id" → {kind, id, obj, updated?}. */
export function localItems(st) {
  const out = {};
  const put = (kind, id, obj, updated) => { if (id != null && id !== "") out[`${kind}/${id}`] = { kind, id: String(id), obj, updated }; };
  for (const d of st.drives || []) put("drive", d.id, d, stampOf(d) || undefined);
  for (const r of st.rules || []) put("rule", r.id, r);
  for (const p of st.planned || []) { const x = { ...p }; delete x.eventId; delete x.openedOn; put("planned", p.id, x, stampOf(p) || undefined); }
  for (const t of st.trips || []) put("trip", t.id, t);
  for (const p of st.places || []) put("place", p.id, p);
  for (const f of st.favorites || []) put("favorite", f.id, f);
  for (const c of st.cars || []) put("car", c.id, c, c.updatedAt ? new Date(c.updatedAt).getTime() : undefined);
  return out;
}

const LISTS = { drive: "drives", rule: "rules", planned: "planned", trip: "trips", place: "places", favorite: "favorites", car: "cars" };

/** Applies server records to the browser state. Returns how many items changed here. */
export function applyRecords(st, records, sync) {
  sync.sent ||= {}; sync.stamp ||= {};
  let n = 0;
  for (const r of records) {
    const key = `${r.kind}/${r.id}`;
    if ((sync.stamp[key] || 0) >= r.updated) continue;   // our own edit is newer (or this is our echo)
    if (r.kind === "meta") {
      try {
        const m = JSON.parse(r.json || "null");
        if (m && ["free", "plus", "pro"].includes(m.tier)) st.meta.tier = m.tier;
        if (m && (m.units === "km" || m.units === "mi")) st.meta.units = m.units;
      } catch { /* ignore */ }
      sync.stamp[key] = r.updated; n++; continue;
    }
    const list = LISTS[r.kind]; if (!list) continue;
    const arr = (st[list] ||= []);
    const i = arr.findIndex(x => String(x.id) === r.id);
    if (r.deleted) {
      if (i >= 0) { arr.splice(i, 1); n++; }
      if (r.kind === "drive") st.deletedDrives = [...new Set([...(st.deletedDrives || []), r.id])];
      delete sync.sent[key];
    } else {
      let obj; try { obj = JSON.parse(r.json); } catch { continue; }
      if (r.kind === "planned" && i >= 0) { obj.eventId = arr[i].eventId; obj.openedOn = arr[i].openedOn; }
      if (i >= 0) arr[i] = obj; else arr.push(obj);
      n++;
    }
    sync.stamp[key] = r.updated;
  }
  // What we hold now matches the server: don't send it straight back.
  const now = localItems(st);
  for (const r of records) { const key = `${r.kind}/${r.id}`; if (now[key]) sync.sent[key] = hash(JSON.stringify(now[key].obj)); }
  return n;
}

/** What to send: items that changed here since the last sync, and deletes. Drives/rules only on a Pro account. */
export function outgoingRecords(st, sync, now = Date.now()) {
  sync.sent ||= {}; sync.stamp ||= {};
  const pro = st.meta?.tier === "pro";
  const items = localItems(st), out = [], next = { ...sync.sent };
  for (const [key, it] of Object.entries(items)) {
    if (!pro && (it.kind === "drive" || it.kind === "rule")) continue;
    const json = JSON.stringify(it.obj), h = hash(json);
    if (sync.sent[key] === h) continue;
    const updated = Math.max(it.updated || now, sync.stamp[key] || 0);
    out.push({ kind: it.kind, id: it.id, json, updated });
    next[key] = h;
  }
  for (const key of Object.keys(sync.sent)) {
    if (items[key]) continue;
    if (!pro && (key.startsWith("drive/") || key.startsWith("rule/"))) continue;
    const [kind, ...rest] = key.split("/");
    out.push({ kind, id: rest.join("/"), deleted: true, updated: now });
    delete next[key];
  }
  return { out, next };
}

// ---------- server ----------
const loadSync = () => { try { return JSON.parse(localStorage.getItem(SYNC) || "{}") || {}; } catch { return {}; } };
const saveSync = s => { try { localStorage.setItem(SYNC, JSON.stringify(s)); } catch { /* full */ } };

async function api(method, path, body) {
  const session = localStorage.getItem(SESSION);
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json", ...(session ? { Authorization: "Bearer " + session } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { const e = new Error("signed_out"); e.signedOut = true; throw e; }
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}

let appleLoading = null;
function loadApple(lang) {
  if (globalThis.AppleID) return Promise.resolve(globalThis.AppleID);
  appleLoading ??= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = `https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/${lang === "zh-HK" ? "zh_HK" : "en_US"}/appleid.auth.js`;
    s.onload = () => res(globalThis.AppleID); s.onerror = () => rej(new Error("appleid.auth.js"));
    document.head.appendChild(s);
  });
  return appleLoading;
}

/**
 * Sign in with Apple + live sync. getState() → browser state; persist() saves it; onStatus("signedOut"|"syncing"|
 * "signedIn"|"error"); onSynced(n, info). Returns { schedule(), signIn(), signOut(), deleteAccount(), signedIn() }.
 */
export function mount({ lang, getState, persist, reload, onStatus, onSynced }) {
  let timer = null, busy = false, again = false;
  const signedIn = () => !!localStorage.getItem(SESSION);
  // One tab syncs at a time. Another tab (the other language's page, say) may have synced since this one last looked,
  // so each run starts from what is saved in the browser, never from this tab's older copy: an item the other tab
  // pulled must not look "deleted here".
  const oneTabAtATime = work => (globalThis.navigator?.locks ? navigator.locks.request("juice.sync", work) : work());

  async function syncNow() {
    if (!signedIn()) return;
    if (busy) { again = true; return; }
    busy = true; onStatus?.("syncing");
    try { await oneTabAtATime(syncOnce); } finally {
      busy = false;
      if (again) { again = false; syncNow(); }
    }
  }

  async function syncOnce() {
    try {
      reload?.();
      const st = getState(), sync = loadSync();
      let n = 0;
      for (;;) {
        const page = await api("GET", `/v1/sync?since=${sync.cursor || 0}`);
        n += applyRecords(st, page.records, sync);
        sync.cursor = Math.max(sync.cursor || 0, page.now);
        if (!page.more) break;
      }
      persist();
      const { out, next } = outgoingRecords(st, sync);
      for (let i = 0; i < out.length; i += 400) await api("POST", "/v1/sync", { records: out.slice(i, i + 400) });
      sync.sent = next;
      for (const r of out) sync.stamp[`${r.kind}/${r.id}`] = r.updated;
      saveSync(sync);
      onStatus?.("signedIn");
      onSynced?.(n, { drives: (st.drives || []).length, trips: (st.trips || []).length, places: (st.places || []).length });
    } catch (e) {
      if (e.signedOut) { localStorage.removeItem(SESSION); onStatus?.("signedOut"); }
      else onStatus?.("error", e);
    }
  }

  async function signIn() {
    try {
      const AppleID = await loadApple(lang);
      AppleID.auth.init({ clientId: CLIENT_ID, scope: "name", redirectURI: location.origin + location.pathname, usePopup: true });
      const res = await AppleID.auth.signIn();
      const token = res?.authorization?.id_token;
      if (!token) throw new Error("no token");
      const name = res?.user?.name?.firstName || null;
      const j = await api("POST", "/v1/auth/apple", { identityToken: token, name });
      const prev = loadSync();
      if (prev.user && prev.user !== j.user) {
        // Another Apple ID: start fresh. The last person's data must not be uploaded into this account.
        const st = getState();
        for (const list of Object.values(LISTS)) st[list] = [];
        st.deletedDrives = []; st.meta = { tier: "free" };
        persist();
        saveSync({});
      }
      const s = loadSync(); s.user = j.user; s.name = j.name || name; saveSync(s);
      localStorage.setItem(SESSION, j.session);
      onStatus?.("signedIn");
      await syncNow();
      return true;
    } catch (e) {
      if (e?.error === "popup_closed_by_user" || e?.error === "user_cancelled_authorize") { onStatus?.("signedOut"); return false; }
      onStatus?.("error", e); return false;
    }
  }

  function signOut() { localStorage.removeItem(SESSION); onStatus?.("signedOut"); }

  async function deleteAccount() {
    await api("DELETE", "/v1/me");
    localStorage.removeItem(SESSION); saveSync({ user: loadSync().user }); onStatus?.("signedOut");   // still know whose data is here
  }

  const schedule = () => { if (!signedIn()) return; clearTimeout(timer); timer = setTimeout(syncNow, 2500); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
  setInterval(() => { if (!document.hidden) syncNow(); }, 60_000);   // pick up phone changes while the page is open
  if (signedIn()) { onStatus?.("signedIn"); syncNow(); } else onStatus?.("signedOut");
  return { schedule, syncNow, signIn, signOut, deleteAccount, signedIn, name: () => loadSync().name || null };
}
