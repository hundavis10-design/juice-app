// node tools/test-account.mjs — the website's JUICE-account sync rules (same as the app's Juice/CloudDrives.swift).
import { localItems, applyRecords, outgoingRecords } from "../app/js/account.js";

let fails = 0;
const ok = (c, m) => { console.log(c ? "✓" : "✗", m); if (!c) fails++; };
const fresh = () => ({ cars: [], drives: [], deletedDrives: [], rules: [], trips: [], planned: [], places: [], favorites: [], meta: { tier: "free" }, prefs: {} });
const rec = (kind, id, obj, updated, deleted = 0) => ({ kind, id, json: obj ? JSON.stringify(obj) : null, updated, deleted });

// 1) First sign-in: the phone's data comes in (plan from meta first, so Pro drives are allowed).
const st = fresh(), sync = {};
const n = applyRecords(st, [
  rec("meta", "account", { tier: "pro", units: "mi" }, 1000),
  rec("drive", "d1", { id: "d1", notes: "phone" }, 1000),
  rec("trip", "t1", { id: "t1", name: "Boston → Philly" }, 1000),
  rec("place", "p1", { id: "p1", name: "Home" }, 1000),
  rec("planned", "pl1", { id: "pl1", tripId: "t1" }, 1000),
], sync);
ok(st.meta.tier === "pro" && st.drives.length === 1 && st.trips.length === 1 && st.places.length === 1 && st.planned.length === 1, "phone data and plan come in");
ok(n === 5, "counts what changed");
ok(outgoingRecords(st, sync).out.length === 0, "what just came down isn't sent straight back");

// 2) Tag a drive on the web → only that drive goes up.
st.drives[0].purpose = "business";
let o = outgoingRecords(st, sync, 5000);
ok(o.out.length === 1 && o.out[0].kind === "drive" && JSON.parse(o.out[0].json).purpose === "business", "a web edit sends just that item");
sync.sent = o.next; for (const r of o.out) sync.stamp[`${r.kind}/${r.id}`] = r.updated;

// 3) An older edit from elsewhere never overwrites the newer one here.
applyRecords(st, [rec("drive", "d1", { id: "d1", notes: "stale" }, 3000)], sync);
ok(st.drives[0].purpose === "business", "older remote edit loses");
applyRecords(st, [rec("drive", "d1", { id: "d1", notes: "newer from phone" }, 9000)], sync);
ok(st.drives[0].notes === "newer from phone", "newer remote edit wins");

// 4) Deletes travel both ways.
applyRecords(st, [rec("trip", "t1", null, 9500, 1)], sync);
ok(st.trips.length === 0, "trip deleted on the phone → gone here");
st.places = [];
o = outgoingRecords(st, sync, 10000);
ok(o.out.some(r => r.kind === "place" && r.id === "p1" && r.deleted), "place deleted here → delete goes up");

// 5) Not Pro here: drives/rules are never sent or deleted from the account.
const free = fresh(); const fs = { sent: { "drive/d9": "h" }, stamp: {} };
free.drives = [{ id: "d8" }];
const fo = outgoingRecords(free, fs);
ok(!fo.out.some(r => r.kind === "drive"), "free browser leaves drives in the account alone");

// 6) Calendar ids stay on the device.
ok(!("eventId" in localItems({ ...fresh(), planned: [{ id: "x", eventId: "E" }] })["planned/x"].obj), "calendar event id never uploads");

console.log(fails ? `\n${fails} failed` : "\nAll account sync tests passed.");
process.exit(fails ? 1 : 0);
