// Small helpers shared by every module. No DOM here, so node tests can import it.

export const KM_PER_MI = 1.609344;

export function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371.0088, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().toUpperCase();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16);
  }).toUpperCase();
}

/** "{0} of {1}" style formatting. */
export function fmt(s, ...args) {
  return String(s).replace(/\{(\d+)\}/g, (_, i) => args[+i] ?? "");
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Local calendar keys, e.g. "2026-11" and "2026-11-08". */
export function monthKey(d) { d = new Date(d); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
export function dayKey(d) { d = new Date(d); return `${monthKey(d)}-${String(d.getDate()).padStart(2, "0")}`; }
export function hhmm(d) { d = new Date(d); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }

/** Units and number formats for one language. English = miles/°F/USD, Cantonese = km/°C/HK$. */
export function makeUnits(S) {
  const metric = !!S._metric;
  return {
    metric,
    distVal(mi) { return metric ? mi * KM_PER_MI : mi; },
    fromDistVal(v) { return metric ? v / KM_PER_MI : v; },
    dist(mi) {
      const v = metric ? mi * KM_PER_MI : mi;
      return fmt(S.distFmt, v < 10 ? (Math.round(v * 10) / 10).toString() : Math.round(v).toLocaleString(S._locale));
    },
    eff(whPerMile) { return fmt(S.effFmt, Math.round(metric ? whPerMile / KM_PER_MI : whPerMile)); },
    effVal(whPerMile) { return metric ? whPerMile / KM_PER_MI : whPerMile; },
    temp(f) { return f == null ? "" : fmt(S.tempFmt, Math.round(metric ? (f - 32) * 5 / 9 : f)); },
    dur(min) {
      min = Math.max(0, Math.round(min));
      const h = Math.floor(min / 60), m = min % 60;
      return h > 0 ? fmt(S.hMinFmt, h, m) : fmt(S.minFmt, m);
    },
    money(v) { return fmt(S.moneyFmt, (Math.round(v * 100) / 100).toLocaleString(S._locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })); },
    andList(items) {
      if (items.length <= 1) return items.join("");
      return items.slice(0, -1).join(S.listSep) + S.listAnd + items[items.length - 1];
    },
    monthLabel(key) {
      const [y, m] = key.split("-").map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString(S._locale, { year: "numeric", month: "short" });
    },
    date(d) { return new Date(d).toLocaleDateString(S._locale, { year: "numeric", month: "short", day: "numeric", weekday: "short" }); },
    dateTime(d) { return new Date(d).toLocaleString(S._locale, { month: "short", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" }); },
    time(d) { return new Date(d).toLocaleTimeString(S._locale, { hour: "numeric", minute: "2-digit" }); },
  };
}
