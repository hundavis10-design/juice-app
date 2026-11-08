// TZ=America/New_York node tools/test.mjs [sample-export.json]
// Headless checks of the planner, import merge, rules, trends, CSV and calendar file.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { cumulative, thin, alongRoute, planStops, chargeMinutes, parseOCM, samplePoints, PREFER_KM } from "../app/js/planner.js";
import * as D from "../app/js/drives.js";
import { mergeImport, buildExport, isExport, load, save, tierAtLeast } from "../app/js/store.js";
import { buildICS } from "../app/js/ics.js";
import { lineChart, barChart } from "../app/js/charts.js";
import { makeUnits, KM_PER_MI } from "../app/js/util.js";
import en from "../app/js/strings-en.js";
import zh from "../app/js/strings-zh-hk.js";

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("✓", name); };
const samplePath = process.argv[2] || "/tmp/juice-56/sample-export.json";
const sample = () => JSON.parse(readFileSync(samplePath, "utf8"));
const memStore = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };

// ---------- planner ----------
// A straight east-west road along 40°N, about 850 km, with a charger every ~60 km and two far off the road.
const coords = []; for (let lon = -80; lon <= -70; lon += 0.01) coords.push([lon, 40]);
const cum = cumulative(coords), th = thin(cum);
const total = cum[cum.length - 1].d;
const raw = [];
for (let i = 1; i < 14; i++) raw.push({ id: "c" + i, name: "Charger " + i, lat: 40.005, lon: -80 + i * 0.7, network: "Net", maxKw: i % 3 ? 150 : 350 });
raw.push({ id: "far1", name: "Far", lat: 40.3, lon: -76, network: "Net", maxKw: 350 });
raw.push({ id: "c3", name: "Charger 3 dup id", lat: 40.005, lon: -77.9, network: "Net", maxKw: 50 });
raw.push({ id: "c3b", name: "Charger 3 same spot", lat: 40.0052, lon: -80 + 3 * 0.7, network: "Net", maxKw: 50 });

test("route geometry: ~850 km and thinning keeps the ends", () => {
  assert.ok(total > 840 && total < 860, total);
  assert.equal(th[0], cum[0]); assert.equal(th[th.length - 1], cum[cum.length - 1]);
  const { samples, radiusKm } = samplePoints(cum);
  assert.ok(samples.length >= 8 && samples.length <= 40);
  assert.ok(radiusKm * 2 >= total / (samples.length - 1));
});

const along = alongRoute(raw, th, 3);
test("chargers along route: off-road ones dropped, duplicates merged", () => {
  assert.ok(!along.some(c => c.id === "far1"));
  assert.equal(along.filter(c => Math.abs(c.lon - (-80 + 3 * 0.7)) < 0.01).length, 1);
  assert.ok(along.every(c => c.off < 3));
  for (let i = 1; i < along.length; i++) assert.ok(along[i].along >= along[i - 1].along);
});

test("greedy plan: farthest reachable charger (fastest within 25 km of it), never under the reserve", () => {
  const r = planStops({ totalKm: total, durationMin: 480, chargers: along, rangeMi: 250, batteryKwh: 75, startPct: 90, reservePct: 15, chargeToPct: 80 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.stops.length >= 2 && r.stops.length <= 4, r.stops.length);
  const pctPerKm = 100 / (250 * KM_PER_MI);
  let pos = 0, off = 0, pct = 90;
  for (const s of r.stops) {
    assert.ok(s.arrivePct >= 15 - 1e-6, `arrive ${s.arrivePct}`);
    // Nothing reachable more than PREFER_KM past it, and nothing faster in that window.
    const reach = along.filter(c => c.along > pos + 0.5 && pct - (c.along - pos + off + c.off) * pctPerKm >= 15);
    const far = Math.max(...reach.map(c => c.along));
    assert.ok(s.along >= far - PREFER_KM, `stopped short at ${s.along} (farthest ${far})`);
    for (const c of reach) if (c.along >= far - PREFER_KM) assert.ok(Math.min(c.maxKw, 250) <= Math.min(s.maxKw, 250), `slower pick than ${c.id}`);
    assert.ok(s.leavePct <= 80 && s.leavePct > s.arrivePct);
    assert.equal(Math.round(s.chargeMin), Math.round(chargeMinutes(s.kwh, s.maxKw)));
    pos = s.along; off = s.off; pct = s.leavePct;
  }
  assert.ok(r.arrivePct >= 15 - 1e-6, r.arrivePct);
  const tl = r.timeline;
  assert.equal(tl[tl.length - 1].kind, "destination");
  assert.ok(Math.abs(tl.reduce((s, x) => s + x.legKm, 0) - total) < 2 * r.stops.length * 3 + 0.5);
  assert.ok(Math.abs(r.driveMin - 480) < 10);
});

test("plan: no stops when the battery covers it; waypoints show in order", () => {
  const r = planStops({ totalKm: 200, durationMin: 120, chargers: along, rangeMi: 300, batteryKwh: 80, startPct: 90, waypoints: [{ name: "Lunch", alongKm: 100, lat: 40, lon: -78.8 }] });
  assert.ok(r.ok); assert.equal(r.stops.length, 0);
  assert.deepEqual(r.timeline.map(x => x.kind), ["waypoint", "destination"]);
  assert.ok(r.arrivePct > 15);
});

test("plan: gap too big → can't reach; charge-to below reserve → error", () => {
  const sparse = along.filter(c => c.along < 100 || c.along > 700);
  const r = planStops({ totalKm: total, durationMin: 480, chargers: sparse, rangeMi: 200, batteryKwh: 60, startPct: 90 });
  assert.equal(r.ok, false); assert.equal(r.error, "reach");
  assert.equal(planStops({ totalKm: 100, durationMin: 60, chargers: [], rangeMi: 200, batteryKwh: 60, startPct: 90, reservePct: 20, chargeToPct: 20 }).error, "chargeTo");
});

test("charge minutes: kWh / min(kW,150) × taper, at least 5", () => {
  assert.equal(chargeMinutes(40, 250), 40 / 150 * 60 * 1.25);
  assert.equal(chargeMinutes(40, 50), 40 / 50 * 60 * 1.25);
  assert.equal(chargeMinutes(1, 350), 5);
  assert.equal(chargeMinutes(0, 350), 0);
});

if (existsSync("/tmp/juice-56/priv/ocm.json")) test("Open Charge Map parse: real response, Tesla-only kept only for Teslas", () => {
  const pois = JSON.parse(readFileSync("/tmp/juice-56/priv/ocm.json", "utf8"));
  const all = parseOCM(pois, { allowTeslaOnly: true }), open = parseOCM(pois);
  assert.ok(all.length >= 1 && all.every(c => c.lat && c.lon && c.maxKw > 0 && c.name));
  assert.ok(open.length <= all.length);
});

// ---------- import / merge ----------
let st;
test("import: sample merges, deleted drives removed, tier from file", () => {
  st = load(memStore());
  assert.equal(st.meta.tier, "free");
  const r = mergeImport(st, sample());
  assert.equal(st.cars.length, 2); assert.equal(st.rules.length, 2); assert.equal(st.trips.length, 1); assert.equal(st.planned.length, 1);
  assert.equal(st.drives.length, 8);
  assert.ok(!st.drives.some(d => d.id.endsWith("9")));
  assert.equal(r.removed, 1);
  assert.equal(st.meta.tier, "pro"); assert.ok(tierAtLeast(st, "plus"));
  assert.throws(() => mergeImport(st, { hello: 1 }));
});

test("merge: newer updatedAt wins (fallback end), older loses", () => {
  const j = sample();
  const d3 = j.drives.find(d => d.id.endsWith("3")); d3.purpose = "personal"; d3.updatedAt = "2026-11-01T00:00:00Z";
  const d1 = j.drives.find(d => d.id.endsWith("1")); d1.notes = "OLD"; d1.updatedAt = "2026-10-01T00:00:00Z";
  const d2 = j.drives.find(d => d.id.endsWith("2")); d2.notes = "no updatedAt, same end"; // same end → not newer
  const local = st.drives.find(d => d.id.endsWith("4")); local.notes = "web edit"; local.updatedAt = "2026-11-08T20:00:00Z";
  const s2 = structuredClone(st);
  mergeImport(s2, j);
  assert.equal(s2.drives.find(d => d.id.endsWith("3")).purpose, "personal");
  assert.equal(s2.drives.find(d => d.id.endsWith("1")).notes, "Board meeting, room 4");
  assert.equal(s2.drives.find(d => d.id.endsWith("2")).notes, "");
  assert.equal(s2.drives.find(d => d.id.endsWith("4")).notes, "web edit");
  local.notes = ""; delete local.updatedAt;
});

test("storage: saves under juice.* keys and loads back", () => {
  const m = memStore(); save(st, undefined, m);
  assert.ok([...m.m.keys()].every(k => k.startsWith("juice.")));
  assert.equal(load(m).drives.length, 8);
});

// ---------- rules ----------
test("rule matching: place words vs end fields, weekdays / weekends, otherwise", () => {
  const by = id => st.drives.find(d => d.id.endsWith(id));
  assert.equal(D.match(by("3"), st.rules).purpose, "business");   // NYC on a Wednesday
  assert.equal(D.match(by("4"), st.rules).purpose, "personal");   // NYC on a Saturday → otherwise
  assert.equal(D.match(by("2"), st.rules), null);                 // groceries
  assert.equal(D.match(by("7"), st.rules).rule.text, "Trips to schools are work"); // "High School"
  assert.equal(D.match({ start: "2026-11-04T15:00:00Z", endCategory: "SCHOOL" }, [{ text: "x", purpose: "business", places: ["Schools"], days: "any" }]).purpose, "business");
  assert.equal(D.match({ start: "2026-11-07T15:00:00Z", endName: "school" }, [{ text: "x", purpose: "business", places: ["school"], days: "weekdays" }]), null);
});

test("re-suggest + approve: nothing tagged without OK; approve all; dismiss", () => {
  const r = D.resuggest(st.drives, st.rules);
  const by = id => st.drives.find(d => d.id.endsWith(id));
  assert.equal(r.checked, 6);
  assert.equal(by("3").suggestion, "business"); assert.equal(by("3").suggestedRule, st.rules[1].text); assert.equal(by("3").purpose, undefined);
  assert.equal(by("4").suggestion, "personal");
  assert.equal(by("1").suggestion, undefined); // already tagged: untouched
  assert.equal(D.pendingSuggestion(by("6")), null);
  const waiting = st.drives.filter(D.pendingSuggestion);
  assert.equal(waiting.length, 3);
  D.dismiss(by("4"));
  assert.equal(D.pendingSuggestion(by("4")), null);
  st.drives.filter(D.pendingSuggestion).forEach(d => D.approve(d));
  assert.equal(by("3").purpose, "business"); assert.equal(by("7").purpose, "business"); assert.equal(by("4").purpose, undefined);
  assert.ok(by("3").updatedAt > "2026-11-08");
});

test("rule reader: plain words → rule", () => {
  const r = D.parseRule("Trips to New York City are work unless on weekends");
  assert.deepEqual(r.places, ["new york city"]); assert.equal(r.days, "weekdays"); assert.equal(r.otherwise, "personal"); assert.equal(r.purpose, "business");
  assert.deepEqual(D.parseRule("Drives to the gym are personal").places, ["gym"]);
  assert.equal(D.parseRule("hello"), null);
});

// ---------- drive log numbers ----------
test("Wh/mi, charged-on-the-way, filters, totals", () => {
  const by = id => st.drives.find(d => d.id.endsWith(id));
  assert.ok(Math.abs(D.whPerMile(by("3"), st.cars) - 0.18 * 75000 / 48.7) < 1e-9);
  assert.ok(D.chargedOnTheWay(by("5"), st.cars));
  assert.ok(!D.chargedOnTheWay(by("7"), st.cars)); // phone estimate is never "measured"
  assert.equal(D.filterDrives(st.drives, { month: "2026-10" }).length, 4);
  assert.equal(D.filterDrives(st.drives, { year: "2026", carId: st.cars[1].id }).length, 2);
  assert.equal(D.filterDrives(st.drives, { purpose: "untagged" }).length, 4);
  const t = D.totals(D.filterDrives(st.drives, { month: "2026-10" }));
  assert.equal(t.count, 4); assert.ok(Math.abs(t.miles - 117.3) < 1e-9); assert.ok(Math.abs(t.business - 61.1) < 1e-9);
});

test("battery trends: monthly Wh/mi skips charged-on-the-way, bands by temperature", () => {
  const car = st.cars[0].id;
  const tr = D.trends(st.drives.filter(d => d.carId === car), st.cars);
  assert.deepEqual(tr.months.map(m => m.key), ["2026-10", "2026-11"]);
  assert.equal(tr.skipped, 1);
  const nov = tr.months[1];
  assert.ok(Math.abs(nov.whPerMile - 0.04 * 75000 / 9) < 1e-6); // only the dentist drive
  assert.ok(Math.abs(nov.miles - 89) < 1e-9);                    // miles still counted
  assert.equal(tr.bands.find(b => b.key === "b0").drives, 1);    // 30°F
  assert.equal(tr.bands.find(b => b.key === "b1").drives, 2);    // 45, 40
  assert.ok(lineChart(tr.months.map(m => ({ label: m.key, value: m.whPerMile }))).startsWith("<svg"));
  assert.ok(barChart(tr.months.map(m => ({ label: m.key, value: m.miles }))).includes("<rect"));
});

test("CSV: header, rows in date order, quoting, km in Cantonese", () => {
  const U = makeUnits(en);
  const csv = D.toCSV(st.drives, st.cars, "2026-10", { headers: en.csvHeaders, purposeWord: p => p === "business" ? "Business" : "Personal", distVal: U.distVal });
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[0], "Date,Start,End,From,To,Purpose,Miles,Notes,Car");
  assert.equal(lines.length, 5);
  assert.ok(lines[1].startsWith("2026-10-06,08:30,08:58,Home,Lincoln Elementary School,Business,12.4,\"Board meeting, room 4\",My EV"), lines[1]);
  const year = D.toCSV(st.drives, st.cars, "2026", { headers: en.csvHeaders, purposeWord: p => p, distVal: U.distVal });
  assert.equal(year.trim().split("\r\n").length, 9);
  const Z = makeUnits(zh);
  const zcsv = D.toCSV(st.drives, st.cars, "2026-10", { headers: zh.csvHeaders, purposeWord: p => p, distVal: Z.distVal });
  assert.ok(zcsv.includes(",20.0,")); // 12.4 mi = 20.0 km
});

test("calendar file: VEVENT, link, stops, optional alarm, folded lines", () => {
  const p = st.planned[0], tr = st.trips[0];
  const ics = buildICS({ id: p.id, summary: `⚡️ Drive: ${p.name}`, start: p.start, minutes: p.minutes, location: tr.places[1].title,
    url: `juice://trip/open?id=${p.id}`, description: `Open in JUICE: juice://trip/open?id=${p.id}\nCharging stops: Milford Supercharger`, alarmLead: 30,
    now: new Date("2026-11-08T20:00:00Z") });
  assert.ok(ics.includes("BEGIN:VEVENT") && ics.includes("END:VCALENDAR\r\n"));
  assert.ok(ics.includes("DTSTART:20261120T130000Z")); assert.ok(ics.includes("DTEND:20261120T190000Z"));
  assert.ok(ics.includes("SUMMARY:⚡️ Drive: Boston → Philadelphia"));
  assert.ok(ics.includes("LOCATION:Philadelphia\\, PA"));
  assert.ok(ics.includes(`URL:juice://trip/open?id=${p.id}`));
  assert.ok(ics.includes("BEGIN:VALARM") && ics.includes("TRIGGER:-PT30M") && ics.includes("ACTION:DISPLAY"));
  const enc = new TextEncoder();
  for (const line of ics.split("\r\n")) assert.ok(enc.encode(line).length <= 75, line);
  const unfolded = ics.replace(/\r\n /g, "");
  assert.ok(unfolded.includes("Charging stops: Milford Supercharger"));
  const noAlarm = buildICS({ id: "x", summary: "s", start: p.start, minutes: null });
  assert.ok(!noAlarm.includes("VALARM")); assert.ok(noAlarm.includes("DTEND:20261120T140000Z"));
});

test("export for JUICE: same format, round-trips", () => {
  const j = buildExport(st, "zh-HK");
  assert.ok(isExport(j)); assert.equal(j.version, 1); assert.equal(j.lang, "zh-HK"); assert.equal(j.tier, "pro");
  for (const k of ["cars", "drives", "deletedDrives", "rules", "trips", "planned"]) assert.ok(Array.isArray(j[k]), k);
  const fresh = load(memStore());
  mergeImport(fresh, JSON.parse(JSON.stringify(j)));
  assert.equal(fresh.drives.length, st.drives.length);
  assert.equal(fresh.drives.find(d => d.id.endsWith("3")).purpose, "business");
});

test("units: miles in English, km / °C / HK$ in Cantonese", () => {
  const E = makeUnits(en), Z = makeUnits(zh);
  assert.equal(E.dist(100), "100 mi"); assert.equal(Z.dist(100), "161 km");
  assert.equal(E.temp(32), "32°F"); assert.equal(Z.temp(32), "0°C");
  assert.equal(E.dur(130), "2 h 10 min"); assert.equal(Z.dur(130), "2小時10分鐘");
  assert.equal(E.money(3.5), "$3.50"); assert.equal(Z.money(3.5), "HK$3.50");
  assert.equal(E.andList(["A", "B", "C"]), "A, B and C"); assert.equal(Z.andList(["甲", "乙", "丙"]), "甲、乙同丙");
});

console.log(`\nAll ${n} tests passed.`);
