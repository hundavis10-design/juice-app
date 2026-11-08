// node tools/test-cloud.mjs — the website's iCloud sync rules (same as the app's Juice/CloudDrives.swift).
import { split, applyRemote, outgoing, hash } from "../app/js/cloudkit.js";

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("✗", m); } else console.log("✓", m); };
const D1 = "11111111-1111-4111-8111-111111111111", D2 = "22222222-2222-4222-8222-222222222222";
const T1 = "33333333-3333-4333-8333-333333333333", P1 = "44444444-4444-4444-8444-444444444444";
const drive = (id, extra = {}) => ({ id, carId: "C", start: "2026-11-08T13:00:00Z", end: "2026-11-08T13:30:00Z", startLat: 42, startLon: -71,
  endLat: 42.1, endLon: -71.1, miles: 9, source: "phone", timeApprox: false, pctEstimated: false, path: [], notes: "", dismissedSuggestion: false, ...extra });
const rec = (recordType, recordName, obj) => ({ recordType, recordName, json: JSON.stringify(obj) });
const fresh = () => ({ cars: [], drives: [], deletedDrives: [], rules: [], trips: [], planned: [], meta: { tier: "free" }, prefs: {} });

// 1) First sign-in: what the app put in iCloud shows up, including the plan from juice-cars.
const app = [
  rec("Drive", D1, drive(D1, { updatedAt: "2026-11-08T14:00:00Z" })),
  rec("Drive", D2, drive(D2)),
  rec("PlannedDrive", P1, { id: P1, tripId: T1, name: "Boston → Philadelphia", start: "2026-12-01T13:00:00Z", updatedAt: "2026-11-08T14:00:00Z", eventId: "X" }),
  rec("PlannedDrive", "juice-trips", { kind: "trips", trips: [{ id: T1, name: "Boston → Philadelphia", places: [{ title: "Boston" }], stops: [], saved: { id: T1 } }], deleted: [] }),
  rec("PlannedDrive", "juice-cars", { kind: "cars", cars: [{ id: "C", name: "Model Y" }], tier: "pro", lang: "en" }),
  rec("PlannedDrive", "juice-rules", { kind: "rules", rules: [{ id: "R1", text: "Schools are work", purpose: "business", places: ["school"], days: "any" }], deleted: [] }),
];
const st = fresh(), sync = {};
const n = applyRemote(st, app, sync);
ok(st.drives.length === 2 && st.planned.length === 1 && st.trips.length === 1 && st.rules.length === 1, "app data comes in");
ok(st.meta.tier === "pro" && st.cars[0].name === "Model Y", "plan + cars from juice-cars");
ok(!("eventId" in st.planned[0]), "device-only calendar id stays on the phone");
ok(n >= 5, "counts changes");

// 2) First push: everything is sent once (drives as Pro), then nothing until something changes.
let out = outgoing(st, sync);
ok(out.save.some(r => r.recordName === D1) && out.save.some(r => r.recordName === "juice-trips"), "first push sends records");
ok(!out.save.some(r => r.recordName === "juice-cars"), "the website never writes juice-cars (the app owns the plan)");
ok(out.save.find(r => r.recordName === "juice-trips").json.includes('"saved"'), "the app's full trip copy rides along");
sync.keys = out.keys;
out = outgoing(st, sync);
ok(out.save.length === 0 && out.del.length === 0, "no changes → nothing sent");

// 3) Tag a drive on the web → only that drive goes up.
st.drives.find(d => d.id === D2).purpose = "business";
st.drives.find(d => d.id === D2).updatedAt = new Date().toISOString();
out = outgoing(st, sync);
ok(out.save.length === 1 && out.save[0].recordName === D2 && JSON.parse(out.save[0].json).purpose === "business", "a web tag sends just that drive");
sync.keys = out.keys;

// 4) The phone deletes D1 and a trip; newer phone note on D2 wins over an older one.
const later = [
  rec("Drive", D2, drive(D2, { purpose: "business", notes: "from phone", updatedAt: "2099-01-01T00:00:00Z" })),
  rec("PlannedDrive", P1, { id: P1, tripId: T1, name: "Boston → Philadelphia", start: "2026-12-01T13:00:00Z", updatedAt: "2026-11-08T14:00:00Z" }),
  rec("PlannedDrive", "juice-trips", { kind: "trips", trips: [], deleted: [T1] }),
];
applyRemote(st, later, sync);
ok(!st.drives.some(d => d.id === D1), "deleted on the phone → gone here");
ok(st.deletedDrives.includes(D1), "and remembered as deleted");
ok(st.drives.find(d => d.id === D2).notes === "from phone", "newest edit wins");
ok(st.trips.length === 0, "trip deleted on the phone → gone here");

// 5) Delete a planned drive on the web → a delete goes up. An empty iCloud never wipes the browser.
st.planned = [];
out = outgoing(st, sync);
ok(out.del.includes(P1), "web delete is sent");
const keep = fresh(); keep.drives = [drive(D1)];
applyRemote(keep, [], { keys: { ["Drive/" + D1]: "x" } });
ok(keep.drives.length === 1, "empty iCloud (reset / new account) never deletes local data");

// 6) A browser that isn't Pro never deletes the drives the app put in iCloud.
const free = fresh(); const fs = { keys: { ["Drive/" + D2]: "h1" } };
free.drives = [];
const fo = outgoing(free, fs);
ok(!fo.del.includes(D2), "not Pro here → drives in iCloud are left alone");

ok(split([{ recordType: "Drive", recordName: "bad", json: "{" }]).drives.length === 0, "bad JSON is skipped");
ok(hash("a") !== hash("b") && hash("a") === hash("a"), "change hash");

console.log(fails ? `\n${fails} failed` : "\nAll cloud sync tests passed.");
process.exit(fails ? 1 : 0);
