// Drive log logic: efficiency, filters, totals, trends, rules and CSV. Pure, for node tests.
import { monthKey, dayKey, hhmm } from "./util.js";

export function batteryKwhFor(d, cars) {
  return d.batteryKwh ?? cars?.find(c => c.id === d.carId)?.batteryKwh ?? null;
}
export function kwhUsed(d, cars) {
  const b = batteryKwhFor(d, cars);
  return d.pctUsed != null && b != null ? d.pctUsed / 100 * b : null;
}
/** Wh/mi = pctUsed/100 * batteryKwh * 1000 / miles, when miles > 0.5. */
export function whPerMile(d, cars) {
  const k = kwhUsed(d, cars);
  return k != null && d.miles > 0.5 ? k * 1000 / d.miles : null;
}
export function measured(d) { return d.source === "tesla" && d.pctUsed != null && !d.pctEstimated; }
/** Used under 120 Wh/mi over 5+ miles: it most likely charged on the way, so it's left out of trends. */
export function chargedOnTheWay(d, cars) { return measured(d) && d.miles >= 5 && (whPerMile(d, cars) ?? 999) < 120; }
export function minutes(d) { return (new Date(d.end) - new Date(d.start)) / 60000; }
export function pendingSuggestion(d) { return d.purpose == null && !d.dismissedSuggestion ? d.suggestion ?? null : null; }

export function placeLabel(d, which) {
  if (which === "start") return d.startName || `${(+d.startLat).toFixed(3)}, ${(+d.startLon).toFixed(3)}`;
  return d.endName || d.endPlace || [d.endCity, d.endArea].filter(Boolean).join(", ") || `${(+d.endLat).toFixed(3)}, ${(+d.endLon).toFixed(3)}`;
}

/** Filters: { carId, month:"2026-11", year:"2026", purpose:"business"|"personal"|"untagged" }. Newest first. */
export function filterDrives(drives, f = {}) {
  return drives.filter(d => {
    if (f.carId && d.carId !== f.carId) return false;
    if (f.month && monthKey(d.start) !== f.month) return false;
    if (f.year && String(new Date(d.start).getFullYear()) !== String(f.year)) return false;
    if (f.purpose === "untagged") { if (d.purpose) return false; }
    else if (f.purpose && d.purpose !== f.purpose) return false;
    return true;
  }).sort((a, b) => new Date(b.start) - new Date(a.start));
}

export function totals(list) {
  const t = { count: list.length, miles: 0, minutes: 0, business: 0, personal: 0, untagged: 0, untaggedCount: 0 };
  for (const d of list) {
    t.miles += d.miles || 0; t.minutes += minutes(d);
    if (d.purpose === "business") t.business += d.miles || 0;
    else if (d.purpose === "personal") t.personal += d.miles || 0;
    else { t.untagged += d.miles || 0; t.untaggedCount++; }
  }
  return t;
}

/** Temperature bands in °F. */
export const BANDS = [
  { key: "b0", test: f => f < 32 },
  { key: "b1", test: f => f >= 32 && f < 50 },
  { key: "b2", test: f => f >= 50 && f < 70 },
  { key: "b3", test: f => f >= 70 },
];

/** Battery trend for one car's drives: monthly Wh/mi + miles, lifetime, temperature bands. */
export function trends(drives, cars) {
  const months = new Map();
  const ensure = k => months.get(k) || (months.set(k, { key: k, miles: 0, effMiles: 0, kwh: 0 }), months.get(k));
  const anyMeasured = drives.some(d => measured(d) && !chargedOnTheWay(d, cars));
  const usable = d => kwhUsed(d, cars) != null && d.miles > 0.5 && !chargedOnTheWay(d, cars) && (!anyMeasured || measured(d));
  let effMi = 0, kwh = 0, skipped = 0;
  const bands = BANDS.map(b => ({ key: b.key, miles: 0, kwh: 0, drives: 0 }));
  for (const d of drives) {
    const m = ensure(monthKey(d.start));
    m.miles += d.miles || 0;
    if (chargedOnTheWay(d, cars)) { skipped++; continue; }
    if (!usable(d)) continue;
    const k = kwhUsed(d, cars);
    m.effMiles += d.miles; m.kwh += k; effMi += d.miles; kwh += k;
    if (d.tempF != null) {
      const i = BANDS.findIndex(b => b.test(d.tempF));
      bands[i].miles += d.miles; bands[i].kwh += k; bands[i].drives++;
    }
  }
  const list = [...months.values()].sort((a, b) => a.key.localeCompare(b.key))
    .map(m => ({ key: m.key, miles: m.miles, whPerMile: m.effMiles > 1 ? m.kwh * 1000 / m.effMiles : null }));
  return {
    months: list,
    lifetimeMiles: drives.reduce((s, d) => s + (d.miles || 0), 0),
    lifetimeWhPerMile: effMi > 1 ? kwh * 1000 / effMi : null,
    bands: bands.map(b => ({ key: b.key, drives: b.drives, whPerMile: b.miles > 1 ? b.kwh * 1000 / b.miles : null })),
    measuredOnly: anyMeasured,
    skipped,
  };
}

// MARK: Rules (same matching as the app's DriveClassifier)

const SYNONYMS = {
  "school": ["school", "elementary", "middle school", "high school", "academy", "college", "university", "preschool",
    "montessori", "campus", "kindergarten", "learning center", "mkpoicategoryschool"],
  "new york city": ["new york city", "nyc", "manhattan", "brooklyn", "queens", "bronx", "staten island", "new york county", "kings county"],
  "practice": ["practice", "dental", "dentist", "dds", "orthodont", "chiropract", "optometr", "clinic", "medical", "physician",
    "pediatric", "dermatolog", "therapy", "veterinar", "animal hospital", "law office", "attorney", "law firm",
    "cpa", "accounting", "insurance agency", "family medicine", "associates"],
  "office": ["office", "headquarters", "corporate"],
  "client": ["client", "customer"],
};

export function expand(place) {
  let p = String(place).toLowerCase().trim();
  for (const drop of ["small business ", "small-business ", "business ", "local "]) p = p.split(drop).join("");
  const singular = p.endsWith("ies") ? p.slice(0, -3) + "y" : p.endsWith("ches") ? p.slice(0, -2) : p.endsWith("s") ? p.slice(0, -1) : p;
  let out = [p, singular];
  for (const [k, v] of Object.entries(SYNONYMS)) {
    if (p.includes(k) || singular.includes(k) || (singular.length >= 4 && k.includes(singular))) out = out.concat(v);
  }
  if (p === "new york" || p === "ny city") out = out.concat(SYNONYMS["new york city"]);
  return [...new Set(out.filter(Boolean))];
}

/** endPlace / endCategory / endCity / endArea / endName, lowercased. */
export function haystack(d) {
  const bits = [d.endName, d.endPlace, d.endCategory, d.endCity, d.endArea].filter(Boolean);
  if (d.endCity === "New York") bits.push("new york city");
  return bits.join(" | ").toLowerCase();
}

export function isWeekend(date) { const g = new Date(date).getDay(); return g === 0 || g === 6; }

export function verdict(r, weekend) {
  switch (r.days) {
    case "weekdays": return weekend ? r.otherwise ?? null : r.purpose;
    case "weekends": return weekend ? r.purpose : r.otherwise ?? null;
    default: return r.purpose;
  }
}

/** The first rule that fits a drive and what it says for that day, or null. */
export function match(d, rules) {
  const hay = haystack(d);
  if (!hay) return null;
  const weekend = isWeekend(d.start);
  for (const r of rules) {
    if (!(r.places || []).some(p => expand(p).some(w => hay.includes(w)))) continue;
    const v = verdict(r, weekend);
    if (v) return { rule: r, purpose: v };
  }
  return null;
}

/** Re-suggest: puts rule suggestions on untagged drives (never the tag). Returns how many changed. */
export function resuggest(drives, rules, now = new Date()) {
  let checked = 0, changed = 0;
  for (const d of drives) {
    if (d.purpose) continue;
    checked++;
    const m = match(d, rules);
    if (m) {
      if (d.suggestion !== m.purpose || d.suggestedRule !== m.rule.text || d.suggestedBy !== "rule") {
        d.suggestion = m.purpose; d.suggestedBy = "rule"; d.suggestedRule = m.rule.text; d.dismissedSuggestion = false;
        d.updatedAt = now.toISOString(); changed++;
      }
    } else if (d.suggestedBy === "rule" && d.suggestion) {
      // The rule that made it is gone or no longer fits.
      delete d.suggestion; delete d.suggestedBy; delete d.suggestedRule;
      d.updatedAt = now.toISOString(); changed++;
    }
  }
  return { checked, changed };
}

export function approve(d, now = new Date()) {
  if (!pendingSuggestion(d)) return false;
  d.purpose = d.suggestion; d.updatedAt = now.toISOString();
  return true;
}
export function dismiss(d, now = new Date()) { d.dismissedSuggestion = true; d.updatedAt = now.toISOString(); }

/** The app's simple rule reader: "Trips to schools are work", "… unless on weekends". */
export function parseRule(text) {
  const low = String(text).toLowerCase();
  const business = ["work", "business", "job", "client"].some(w => low.includes(w));
  const personal = ["personal", "private", "not work", "not business"].some(w => low.includes(w));
  if (!business && !personal) return null;
  const purpose = personal && !low.includes("unless") ? "personal" : "business";
  let days = "any", otherwise = null;
  if (low.includes("unless") && low.includes("weekend")) { days = "weekdays"; otherwise = purpose === "business" ? "personal" : "business"; }
  else if (low.includes("weekday")) days = "weekdays";
  else if (low.includes("weekend")) days = "weekends";
  let place = low;
  const i = place.indexOf(" to ");
  if (i >= 0) place = place.slice(i + 4); else if (place.startsWith("to ")) place = place.slice(3);
  for (const stop of [" are ", " is ", " = ", " count", " should", " unless", " on week", " except", ","]) {
    const j = place.indexOf(stop); if (j >= 0) place = place.slice(0, j);
  }
  place = place.replace(/^(trips|drives|driving|all|any|the)\s+/, "").replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
  if (!place) return null;
  return { text, purpose, places: [place], days, otherwise };
}

// MARK: CSV

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Drives in a period ("2026-11" or "2026") → CSV text. S gives headers/purpose words; U gives units. */
export function toCSV(drives, cars, period, { headers, purposeWord, distVal }) {
  const inPeriod = drives.filter(d => period.length === 4 ? String(new Date(d.start).getFullYear()) === period : monthKey(d.start) === period)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const rows = [headers];
  for (const d of inPeriod) {
    rows.push([
      dayKey(d.start), hhmm(d.start), hhmm(d.end), placeLabel(d, "start"), placeLabel(d, "end"),
      d.purpose ? purposeWord(d.purpose) : "", (Math.round(distVal(d.miles || 0) * 10) / 10).toFixed(1), d.notes || "",
      cars.find(c => c.id === d.carId)?.name || "",
    ]);
  }
  return "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function inPeriod(drives, period) {
  return drives.filter(d => period.length === 4 ? String(new Date(d.start).getFullYear()) === period : monthKey(d.start) === period);
}
