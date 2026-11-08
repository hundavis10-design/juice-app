// JUICE for the web: the page. All words come from strings-en.js / strings-zh-hk.js.
import { fmt, esc, uid, makeUnits, monthKey, KM_PER_MI, dayKey } from "./util.js";
import { cumulative, thin, samplePoints, alongRoute, planStops } from "./planner.js";
import { geocode, route, chargersNear, pool, NetError } from "./net.js";
import * as D from "./drives.js";
import { load, save as storeSave, clearAll, mergeImport, buildExport, tierAtLeast } from "./store.js";
import { buildICS } from "./ics.js";
import { lineChart, barChart } from "./charts.js";
import * as CK from "./cloudkit.js";
import { PRESETS } from "./presets.js";

export function start(S, lang) {
  const U = makeUnits(S);
  const st = load();
  // Every change saves to this browser and (signed in with Apple ID) syncs to iCloud a few seconds later.
  let cloud = { schedule() {}, syncNow() {} };
  const save = (s, keys) => { storeSave(s, keys); if (!(keys && keys.length === 1 && keys[0] === "prefs")) cloud.schedule(); };
  const P = st.prefs;
  Object.assign(P, { startPct: P.startPct ?? 90, reserve: P.reserve ?? 15, chargeTo: P.chargeTo ?? 80, tab: P.tab || "plan" });
  if (!P.car) P.car = st.cars[0]?.id || "p-myl";
  const savePrefs = () => save(st, ["prefs"]);
  const t = (k, ...a) => fmt(S[k] ?? k, ...a);
  const purposeWord = p => p === "business" ? S.business : p === "personal" ? S.personal : S.untagged;
  const pct = v => `${Math.round(v)}%`;

  // ---------- skeleton ----------
  const root = document.getElementById("app");
  root.innerHTML = `
    <header class="bar">
      <a class="brand" href="${esc(S._homeHref)}">JUICE<span>.</span></a>
      <h1>${esc(S.appTitle)}</h1>
      <div class="bar-right">${root.dataset.langLink || ""}</div>
    </header>
    <div class="layout" id="layout">
      <div class="mapwrap"><div id="map" aria-label="${esc(S.mapLabel)}"></div></div>
      <section class="panel">
        <div class="ckbar${CK.enabled() ? "" : " hide"}" id="ckBar">
          <div class="ck-text"><strong id="ckTitle">${esc(S.ckTitle)}</strong><span id="ckLine">${esc(S.ckHelp)}</span></div>
          <div class="ck-btns"><div id="apple-sign-in-button"></div><div id="apple-sign-out-button"></div></div>
        </div>
        <nav class="tabs" id="tabs" role="tablist"></nav>
        <div id="content"></div>
        <footer class="foot"><p>${esc(S.privacy)}</p>
          <p><a href="${esc(S._privacyHref)}">${esc(S.privacyLink)}</a> · <a href="${esc(S._supportHref)}">${esc(S.supportLink)}</a></p></footer>
      </section>
    </div>
    <div id="print-root"></div>`;
  const $ = id => document.getElementById(id);
  const content = $("content");

  // ---------- map ----------
  const map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView(S._mapCenter, S._mapZoom);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ${esc(S.osmContrib)}`,
  }).addTo(map);
  const layers = { route: L.layerGroup().addTo(map), chargers: L.layerGroup().addTo(map), stops: L.layerGroup().addTo(map), drive: L.layerGroup().addTo(map) };
  const clearMap = (...ks) => ks.forEach(k => layers[k].clearLayers());
  const fixMap = () => setTimeout(() => map.invalidateSize(), 50);
  window.addEventListener("resize", fixMap);

  // ---------- tabs ----------
  const TABS = [
    { id: "plan", label: S.tabPlan },
    { id: "drives", label: S.tabDrives, pro: true, feat: S.featDrives },
    { id: "trends", label: S.tabTrends, pro: true, feat: S.featTrends },
    { id: "taxes", label: S.tabTaxes, pro: true, feat: S.featTaxes },
    { id: "data", label: S.tabData },
  ];
  function renderTabs() {
    const pro = tierAtLeast(st, "pro");
    $("tabs").innerHTML = TABS.map(x => `<button role="tab" data-tab="${x.id}" class="${P.tab === x.id ? "on" : ""}" aria-selected="${P.tab === x.id}">${esc(x.label)}${x.pro && !pro ? ` <span class="badge">Pro</span>` : ""}</button>`).join("");
  }
  $("tabs").addEventListener("click", e => {
    const b = e.target.closest("[data-tab]"); if (!b) return;
    P.tab = b.dataset.tab; savePrefs(); render();
  });

  function render() {
    renderTabs();
    const tab = TABS.find(x => x.id === P.tab) || TABS[0];
    $("layout").classList.toggle("wide", ["drives", "trends", "taxes"].includes(tab.id));
    if (tab.id !== "drives") clearMap("drive");
    if (tab.pro && !tierAtLeast(st, "pro")) { content.innerHTML = locked(tab.feat); fixMap(); return; }
    ({ plan: renderPlan, drives: renderDrives, trends: renderTrends, taxes: renderTaxes, data: renderData })[tab.id]();
    fixMap();
  }

  function locked(feat) {
    return `<div class="card lock"><p>${esc(t("locked", feat))}</p><button class="btn" data-goto="data">${esc(S.importNow)}</button></div>`;
  }
  content.addEventListener("click", e => {
    const g = e.target.closest("[data-goto]"); if (g) { P.tab = g.dataset.goto; savePrefs(); render(); }
  });

  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const msg = (id, text, bad) => { const el = $(id); if (el) { el.textContent = text; el.className = "msg" + (bad ? " bad" : ""); } };

  // =====================================================================
  // PLAN
  // =====================================================================
  const places = P.places && P.places.from ? P.places : { from: { text: "" }, to: { text: "" }, via: [] };
  let plan = null;          // last planned trip
  let showCal = false, showSave = false;

  function ownCars() { return tierAtLeast(st, "plus") ? st.cars : st.cars.slice(0, 1); }
  function currentCar() {
    const own = ownCars().find(c => c.id === P.car);
    if (own) return { id: own.id, title: own.title || own.name, name: own.name, rangeMi: own.rangeMi || 250, batteryKwh: own.batteryKwh || 75, tesla: /tesla/i.test(own.title || own.name || "") };
    const pre = PRESETS.find(p => p.id === P.car);
    if (pre) return { ...pre, name: pre.title };
    if (P.car === "custom") return { id: "custom", title: S.customCar, name: S.customCar, rangeMi: P.customRange || 250, batteryKwh: P.customKwh || 75, tesla: false };
    return { ...PRESETS[1], name: PRESETS[1].title };
  }

  function placeRow(key, label, ph, removable) {
    const v = key === "from" ? places.from : key === "to" ? places.to : places.via[+key.split(":")[1]];
    return `<div class="place"><label>${esc(label)}</label>
      <div class="pin"><input data-place="${key}" value="${esc(v.sel?.short || v.text)}" placeholder="${esc(ph)}" autocomplete="off">
      ${removable ? `<button class="x" data-act="rmvia" data-i="${key.split(":")[1]}" title="${esc(S.remove)}" aria-label="${esc(S.remove)}">×</button>` : ""}</div>
      <div class="sugg" data-sugg="${key}"></div></div>`;
  }

  function renderPlan() {
    const car = currentCar();
    const own = ownCars();
    const extra = st.cars.length - own.length;
    content.innerHTML = `
      <div class="card">
        <h2>${esc(S.whereTo)}</h2>
        ${placeRow("from", S.from, S.fromPh)}
        ${places.via.map((_, i) => placeRow("via:" + i, S.waypoint, S.waypointPh, true)).join("")}
        ${placeRow("to", S.to, S.toPh)}
        <div class="row"><button class="link" data-act="addvia">${esc(S.addWaypoint)}</button>
        <button class="link" data-act="swap">${esc(S.swap)}</button></div>
      </div>
      <div class="card">
        <h2>${esc(S.carBattery)}</h2>
        <label>${esc(S.car)}<select id="car">
          ${own.length ? `<optgroup label="${esc(S.yourCars)}">${own.map(c => `<option value="${esc(c.id)}" ${c.id === car.id ? "selected" : ""}>${esc(c.name)}${c.title && c.title !== c.name ? " · " + esc(c.title) : ""}</option>`).join("")}</optgroup>` : ""}
          <optgroup label="${esc(S.presetsGroup)}">${PRESETS.map(p => `<option value="${p.id}" ${p.id === car.id ? "selected" : ""}>${esc(p.title)}</option>`).join("")}
          <option value="custom" ${car.id === "custom" ? "selected" : ""}>${esc(S.customCar)}</option></optgroup>
        </select></label>
        ${extra > 0 ? `<p class="muted">${esc(t("moreCarsPlus", own[0]?.name || ""))}</p>` : ""}
        <div class="grid2 ${car.id === "custom" ? "" : "hide"}" id="customBox">
          <label>${esc(S.rangeFull)}<input id="cRange" type="number" min="50" max="1000" value="${Math.round(U.distVal(P.customRange || 250))}"></label>
          <label>${esc(S.batteryKwh)}<input id="cKwh" type="number" min="10" max="250" value="${P.customKwh || 75}"></label>
        </div>
        <p class="muted" id="carSpec">${esc(t("carSpec", U.dist(car.rangeMi), Math.round(car.batteryKwh)))}</p>
        <div class="grid3">
          <label>${esc(S.startPct)}<input id="startPct" type="number" min="5" max="100" value="${P.startPct}"></label>
          <label>${esc(S.reservePct)}<input id="reserve" type="number" min="0" max="50" value="${P.reserve}"></label>
          <label>${esc(S.chargeToPct)}<input id="chargeTo" type="number" min="20" max="100" value="${P.chargeTo}"></label>
        </div>
        <button class="btn big" data-act="plan" id="planBtn">${esc(S.planTrip)}</button>
        <div id="planMsg" class="msg"></div>
      </div>
      <div id="result">${plan ? resultHTML() : ""}</div>
      ${savedTripsHTML()}
      ${plannedHTML()}`;
  }

  function resultHTML() {
    const r = plan.result, car = plan.car;
    const n = r.stops.length;
    const head = n === 0 ? S.stops0 : n === 1 ? S.stops1 : t("stopsN", n);
    let rows = `<li class="node start"><b>${esc(plan.places[0].short)}</b><span class="muted">${esc(t("leaveWith", Math.round(plan.startPct)))}</span></li>`;
    let num = 0;
    for (const x of r.timeline) {
      rows += `<li class="leg">${esc(t("legDrive", U.dur(x.legMin), U.dist(x.legKm / KM_PER_MI), Math.round(x.arrivePct)))}</li>`;
      if (x.kind === "charge") {
        num++;
        const s = x.stop;
        rows += `<li class="node charge"><span class="num">${num}</span><b>${esc(s.name)}</b>
          <span class="muted">${esc(t("chargerMeta", s.network || S.unknownNetwork, Math.round(s.maxKw)))}</span>
          <span>${esc(t("chargeLine", Math.round(x.arrivePct), Math.round(x.leavePct), U.dur(x.chargeMin)))}</span></li>`;
      } else if (x.kind === "waypoint") {
        rows += `<li class="node via"><b>${esc(x.name)}</b><span class="muted">${esc(S.waypoint)}</span></li>`;
      } else {
        rows += `<li class="node end"><b>${esc(plan.places[plan.places.length - 1].short)}</b><span>${esc(t("arriveWith", Math.round(x.arrivePct)))}</span></li>`;
      }
    }
    const tomorrow = new Date(Date.now() + 86400000);
    return `<div class="card">
      <h2>${esc(head)}</h2>
      <p class="big-line">${esc(t("tripLine", U.dur(r.driveMin + r.chargeMin), U.dist(r.totalKm / KM_PER_MI), Math.round(r.arrivePct)))}</p>
      <p class="muted">${esc(t("drivingTotal", U.dur(r.driveMin), U.dur(r.chargeMin)))} · ${esc(car.name)}</p>
      <ol class="timeline">${rows}</ol>
      <p class="muted">${esc(t("chargersShown", plan.chargers.length))}${plan.failed ? " · " + esc(t("someMissing", plan.failed)) : ""}</p>
      <p class="muted">${esc(S.estNote)}</p>
      <div class="row">
        <button class="btn" data-act="showsave">${esc(plan.tripId ? S.savedCheck : S.saveTrip)}</button>
        <button class="btn alt" data-act="showcal">${esc(S.addToCal)}</button>
      </div>
      <div class="sub ${showSave ? "" : "hide"}" id="saveBox">
        <label>${esc(S.tripName)}<input id="tripName" value="${esc(plan.name)}"></label>
        <button class="btn" data-act="savetrip">${esc(S.save)}</button>
      </div>
      <div class="sub ${showCal ? "" : "hide"}" id="calBox">
        <div class="grid2">
          <label>${esc(S.calDate)}<input id="calDate" type="date" value="${dayKey(tomorrow)}"></label>
          <label>${esc(S.calTime)}<input id="calTime" type="time" value="09:00"></label>
        </div>
        <label class="check"><input id="calAlarm" type="checkbox"> ${esc(S.alarmBefore)}</label>
        <label class="hide" id="leadBox">${esc(S.alarmWhen)}<select id="calLead">${[15, 30, 45, 60].map(m => `<option value="${m}" ${m === 30 ? "selected" : ""}>${esc(t("alarmLead", m))}</option>`).join("")}</select></label>
        <button class="btn" data-act="calgo">${esc(S.downloadCal)}</button>
        <p class="muted">${esc(S.calNote)}</p>
      </div>
      <div id="resMsg" class="msg"></div>
    </div>`;
  }

  function savedTripsHTML() {
    const list = st.trips.slice().reverse();
    return `<div class="card"><h2>${esc(S.savedTrips)}</h2>${list.length ? `<ul class="list">${list.map(tr => `
      <li><div><b>${esc(tr.name)}</b><span class="muted">${esc((tr.stops?.length ?? 0) === 1 ? S.stops1 : (tr.stops?.length ?? 0) === 0 ? S.stops0 : t("stopsN", tr.stops.length))}</span></div>
      <div class="acts"><button class="link" data-act="opentrip" data-id="${esc(tr.id)}">${esc(S.open)}</button>
      <button class="link danger" data-act="deltrip" data-id="${esc(tr.id)}">${esc(S.del)}</button></div></li>`).join("")}</ul>` : `<p class="muted">${esc(S.noSavedTrips)}</p>`}</div>`;
  }

  function plannedHTML() {
    const now = Date.now();
    const list = st.planned.slice().sort((a, b) => new Date(a.start) - new Date(b.start));
    return `<div class="card"><h2>${esc(S.plannedDrives)}</h2>${list.length ? `<ul class="list">${list.map(p => `
      <li class="${new Date(p.start) < now - 86400000 ? "past" : ""}"><div><b>${esc(p.name)}</b>
      <span class="muted">${esc(U.dateTime(p.start))}${p.alarm ? " · " + esc(t("alarmOn", p.alarmLead || 30)) : ""}</span></div>
      <div class="acts"><button class="link" data-act="icsagain" data-id="${esc(p.id)}">${esc(S.calFile)}</button>
      <button class="link danger" data-act="delplanned" data-id="${esc(p.id)}">${esc(S.del)}</button></div></li>`).join("")}</ul>` : `<p class="muted">${esc(S.noPlanned)}</p>`}</div>`;
  }

  // --- place inputs with polite suggestions (debounced; the geocoder queue keeps it to 1 request a second)
  const timers = {};
  function placeObj(key) { return key === "from" ? places.from : key === "to" ? places.to : places.via[+key.split(":")[1]]; }
  const persistPlaces = () => { P.places = places; savePrefs(); };
  content.addEventListener("input", e => {
    const inp = e.target.closest("[data-place]"); if (!inp) return;
    const key = inp.dataset.place, o = placeObj(key);
    o.text = inp.value; o.sel = null; persistPlaces();
    clearTimeout(timers[key]);
    const box = content.querySelector(`[data-sugg="${CSS.escape(key)}"]`);
    const q0 = inp.value.trim();
    if (q0.length < (/[\u3400-\u9fff]/.test(q0) ? 2 : 3)) { box.innerHTML = ""; return; }
    timers[key] = setTimeout(async () => {
      const q = inp.value;
      try {
        const list = await geocode(q, S._nominatimLang, 5, S._bias);
        if (inp.value !== q || !document.body.contains(inp)) return;
        box.innerHTML = list.map((p, i) => `<button data-pick="${esc(key)}" data-i="${i}">${esc(p.title)}</button>`).join("");
        box._list = list;
      } catch { /* quiet: Plan will try again */ }
    }, 800);
  });
  content.addEventListener("click", e => {
    const b = e.target.closest("[data-pick]"); if (!b) return;
    const key = b.dataset.pick, box = b.parentElement, p = box._list[+b.dataset.i];
    const o = placeObj(key); o.sel = p; o.text = p.short; persistPlaces();
    content.querySelector(`[data-place="${CSS.escape(key)}"]`).value = p.short;
    box.innerHTML = "";
  });

  content.addEventListener("change", e => {
    const id = e.target.id;
    if (id === "car") {
      P.car = e.target.value; savePrefs();
      $("customBox").classList.toggle("hide", P.car !== "custom");
      const c = currentCar(); $("carSpec").textContent = t("carSpec", U.dist(c.rangeMi), Math.round(c.batteryKwh));
    } else if (id === "cRange" || id === "cKwh") {
      P.customRange = U.fromDistVal(+$("cRange").value || 250); P.customKwh = +$("cKwh").value || 75; savePrefs();
      const c = currentCar(); $("carSpec").textContent = t("carSpec", U.dist(c.rangeMi), Math.round(c.batteryKwh));
    } else if (["startPct", "reserve", "chargeTo"].includes(id)) {
      P[id] = Math.max(0, Math.min(100, +e.target.value || 0)); savePrefs();
    } else if (id === "calAlarm") {
      $("leadBox").classList.toggle("hide", !e.target.checked);
    }
  });

  async function resolvePlace(o) {
    if (o.sel) return o.sel;
    const list = await geocode(o.text, S._nominatimLang, 5, S._bias);
    if (!list.length) throw Object.assign(new Error("place"), { place: o.text });
    o.sel = list[0]; o.text = list[0].short; persistPlaces();
    return list[0];
  }

  const closeSuggestions = () => content.querySelectorAll(".sugg").forEach(b => { b.innerHTML = ""; });
  document.addEventListener("click", e => { if (!e.target.closest(".place")) closeSuggestions(); });

  async function doPlan() {
    closeSuggestions();
    Object.values(timers).forEach(clearTimeout);
    const btn = $("planBtn");
    const all = [places.from, ...places.via.filter(v => v.text.trim() || v.sel), places.to];
    if (!places.from.text.trim() || !places.to.text.trim()) return msg("planMsg", S.errNeedBoth, true);
    if (P.chargeTo <= P.reserve) return msg("planMsg", S.errChargeTo, true);
    btn.disabled = true; btn.textContent = S.planning;
    try {
      msg("planMsg", S.findingPlaces);
      const pts = [];
      for (const o of all) pts.push(await resolvePlace(o));
      msg("planMsg", S.findingRoute);
      const rt = await route(pts);
      if (!rt) { msg("planMsg", S.errRoute, true); return; }
      const cum = cumulative(rt.coords), th = thin(cum);
      const { samples, radiusKm } = samplePoints(cum);
      const car = currentCar();
      let failed = 0;
      const found = await pool(samples, 3, s => chargersNear(s.lat, s.lon, radiusKm, { allowTeslaOnly: car.tesla }).catch(() => { failed++; return []; }),
        (d, n) => msg("planMsg", t("scanning", d, n)));
      if (failed === samples.length) throw new NetError("Open Charge Map");
      const chargers = alongRoute(found.flat(), th, 3);
      let acc = 0;
      const waypoints = pts.slice(1, -1).map((p, i) => { acc += rt.legs[i].km; return { name: p.short, lat: p.lat, lon: p.lon, alongKm: acc }; });
      const result = planStops({ totalKm: rt.km, durationMin: rt.min, chargers, rangeMi: car.rangeMi, batteryKwh: car.batteryKwh,
        startPct: P.startPct, reservePct: P.reserve, chargeToPct: P.chargeTo, waypoints });
      drawPlan(rt, chargers, result, pts);
      if (!result.ok) {
        plan = null;
        msg("planMsg", result.error === "chargeTo" ? S.errChargeTo : t("errReach", U.dist(result.atKm / KM_PER_MI)), true);
        $("result").innerHTML = "";
        return;
      }
      plan = { rt, chargers, result, car, places: pts, startPct: P.startPct, failed,
        name: `${pts[0].short.split(",")[0]} → ${pts[pts.length - 1].short.split(",")[0]}`, tripId: null };
      showCal = false; showSave = false;
      msg("planMsg", "");
      $("result").innerHTML = resultHTML();
      $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      if (err.place) msg("planMsg", t("errPlace", err.place), true);
      else msg("planMsg", t("errNet", err.service || "JUICE"), true);
    } finally {
      btn.disabled = false; btn.textContent = S.planTrip;
    }
  }

  function drawPlan(rt, chargers, result, pts) {
    clearMap("route", "chargers", "stops");
    const line = L.polyline(rt.coords.map(([lon, lat]) => [lat, lon]), { color: "#B8FF3D", weight: 5, opacity: 0.9 }).addTo(layers.route);
    const chosen = new Set((result.stops || []).map(s => s.id));
    for (const c of chargers) {
      if (chosen.has(c.id)) continue;
      L.circleMarker([c.lat, c.lon], { radius: 4, color: "#3DE0FF", weight: 1, fillOpacity: 0.7 })
        .bindPopup(`<b>${esc(c.name)}</b><br>${esc(t("chargerMeta", c.network || S.unknownNetwork, Math.round(c.maxKw)))}`).addTo(layers.chargers);
    }
    (result.stops || []).forEach((s, i) => {
      L.circleMarker([s.lat, s.lon], { radius: 10, color: "#fff", weight: 2, fillColor: "#FF3D80", fillOpacity: 1 })
        .bindTooltip(String(i + 1), { permanent: true, direction: "center", className: "numtip" })
        .bindPopup(`<b>${esc(s.name)}</b><br>${esc(t("chargerMeta", s.network || S.unknownNetwork, Math.round(s.maxKw)))}<br>${esc(t("chargeLine", Math.round(s.arrivePct), Math.round(s.leavePct), U.dur(s.chargeMin)))}`)
        .addTo(layers.stops);
    });
    pts.forEach((p, i) => {
      const end = i === pts.length - 1, first = i === 0;
      L.circleMarker([p.lat, p.lon], { radius: first || end ? 8 : 6, color: "#0D0A1C", weight: 2, fillColor: end ? "#FF3D80" : first ? "#B8FF3D" : "#F5F2FF", fillOpacity: 1 })
        .bindPopup(esc(p.title)).addTo(layers.stops);
    });
    map.fitBounds(line.getBounds(), { padding: [30, 30] });
  }

  function tripFromPlan(name) {
    return {
      id: plan.tripId || uid(), name: name || plan.name,
      places: plan.places.map(p => ({ title: p.short, lat: p.lat, lon: p.lon })),
      stops: plan.result.stops.map(s => ({ name: s.name, lat: s.lat, lon: s.lon, network: s.network || "", maxKw: Math.round(s.maxKw) })),
    };
  }
  function saveTrip(name) {
    const tr = tripFromPlan(name);
    const i = st.trips.findIndex(x => x.id === tr.id);
    if (i >= 0) st.trips[i] = tr; else st.trips.push(tr);
    plan.tripId = tr.id; plan.name = tr.name;
    save(st, ["trips"]);
    return tr;
  }

  function plannedICS(p) {
    const tr = st.trips.find(x => x.id === p.tripId);
    const link = `juice://trip/open?id=${p.id}`;
    const stops = (tr?.stops || []).map(s => s.name);
    const desc = [t("calOpen", link)];
    if (stops.length) desc.push(t("calStops", U.andList(stops)));
    return buildICS({ id: p.id, summary: t("calSummary", p.name), start: new Date(p.start), minutes: p.minutes,
      location: tr?.places?.[tr.places.length - 1]?.title, url: link, description: desc.join("\n"),
      alarmLead: p.alarm ? (p.alarmLead || 30) : null });
  }
  const icsName = p => `JUICE-${dayKey(p.start)}.ics`;

  async function openTrip(id) {
    const tr = st.trips.find(x => x.id === id); if (!tr || !tr.places?.length) return;
    const mk = p => ({ text: p.title, sel: p.lat != null && p.lon != null ? { title: p.title, short: p.title, lat: p.lat, lon: p.lon } : null });
    places.from = mk(tr.places[0]);
    places.to = mk(tr.places[tr.places.length - 1]);
    places.via = tr.places.slice(1, -1).map(mk);
    persistPlaces();
    plan = null; renderPlan();
    await doPlan();
    if (plan) { plan.tripId = tr.id; plan.name = tr.name; $("result").innerHTML = resultHTML(); }
  }

  content.addEventListener("click", async e => {
    if (P.tab !== "plan") return;
    const b = e.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act;
    if (act === "plan") doPlan();
    else if (act === "addvia") { places.via.push({ text: "" }); persistPlaces(); renderPlan(); }
    else if (act === "rmvia") { places.via.splice(+b.dataset.i, 1); persistPlaces(); renderPlan(); }
    else if (act === "swap") { [places.from, places.to] = [places.to, places.from]; places.via.reverse(); persistPlaces(); renderPlan(); }
    else if (act === "showsave") { showSave = !showSave; $("saveBox").classList.toggle("hide", !showSave); }
    else if (act === "showcal") { showCal = !showCal; $("calBox").classList.toggle("hide", !showCal); }
    else if (act === "savetrip") { saveTrip($("tripName").value.trim()); renderPlan(); msg("resMsg", S.saved); }
    else if (act === "calgo") {
      const day = $("calDate").value, time = $("calTime").value;
      if (!day || !time) return;
      const tr = plan.tripId ? st.trips.find(x => x.id === plan.tripId) : saveTrip($("tripName")?.value.trim());
      const alarm = $("calAlarm").checked;
      const p = { id: uid(), tripId: tr.id, name: tr.name, start: new Date(`${day}T${time}`).toISOString(),
        minutes: Math.round(plan.result.driveMin + plan.result.chargeMin), alarm, updatedAt: new Date().toISOString() };
      if (alarm) p.alarmLead = +$("calLead").value;
      st.planned.push(p); save(st, ["planned"]);
      download(icsName(p), plannedICS(p), "text/calendar;charset=utf-8");
      showCal = false; renderPlan(); msg("resMsg", S.calAdded);
    }
    else if (act === "opentrip") openTrip(b.dataset.id);
    else if (act === "deltrip") { st.trips = st.trips.filter(x => x.id !== b.dataset.id); save(st, ["trips"]); renderPlan(); }
    else if (act === "icsagain") { const p = st.planned.find(x => x.id === b.dataset.id); if (p) download(icsName(p), plannedICS(p), "text/calendar;charset=utf-8"); }
    else if (act === "delplanned") { st.planned = st.planned.filter(x => x.id !== b.dataset.id); save(st, ["planned"]); renderPlan(); }
  });
  content.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.matches("[data-place]")) { e.preventDefault(); doPlan(); }
    if (e.key === "Escape") closeSuggestions();
  });

  // =====================================================================
  // DRIVES
  // =====================================================================
  const F = P.driveFilter || (P.driveFilter = {});
  const carName = id => st.cars.find(c => c.id === id)?.name || "";
  const monthsOf = list => [...new Set(list.map(d => monthKey(d.start)))].sort().reverse();
  const yearsOf = list => [...new Set(list.map(d => String(new Date(d.start).getFullYear())))].sort().reverse();
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur ?? "") === String(v) ? "selected" : ""}>${esc(label)}</option>`;

  function ruleSummary(r) {
    const days = r.days === "weekdays" ? S.daysWeekdays : r.days === "weekends" ? S.daysWeekends : S.daysAny;
    let s = `${purposeWord(r.purpose)} · ${(r.places || []).map(p => `“${p}”`).join(S.listSep)} · ${days}`;
    if (r.otherwise && r.days !== "any") s += " · " + t("ruleOther", purposeWord(r.otherwise));
    return s;
  }

  function renderDrives() {
    if (!st.drives.length) { content.innerHTML = `<div class="card"><p>${esc(S.noDrives)}</p><button class="btn" data-goto="data">${esc(S.importNow)}</button></div>${rulesHTML()}`; return; }
    const list = D.filterDrives(st.drives, F);
    const waiting = list.filter(D.pendingSuggestion);
    const tot = D.totals(list);
    content.innerHTML = `
      <div class="card filters">
        <label>${esc(S.car)}<select data-f="carId">${opt("", S.allCars, F.carId)}${st.cars.map(c => opt(c.id, c.name, F.carId)).join("")}</select></label>
        <label>${esc(S.month)}<select data-f="month">${opt("", S.allMonths, F.month)}${monthsOf(st.drives).map(m => opt(m, U.monthLabel(m), F.month)).join("")}</select></label>
        <label>${esc(S.year)}<select data-f="year">${opt("", S.allYears, F.year)}${yearsOf(st.drives).map(y => opt(y, y, F.year)).join("")}</select></label>
        <label>${esc(S.colPurpose)}<select data-f="purpose">${opt("", S.allPurposes, F.purpose)}${opt("business", S.business, F.purpose)}${opt("personal", S.personal, F.purpose)}${opt("untagged", S.untagged, F.purpose)}</select></label>
      </div>
      <div class="card">
        <p class="totals">${esc(tot.count === 1 ? S.totDrive1 : t("totDrives", tot.count))} · ${esc(U.dist(tot.miles))} · ${esc(U.dur(tot.minutes))}</p>
        <p class="muted">${esc(S.business)} ${esc(U.dist(tot.business))} · ${esc(S.personal)} ${esc(U.dist(tot.personal))} · ${esc(S.untagged)} ${esc(U.dist(tot.untagged))}</p>
        ${waiting.length ? `<div class="suggest-bar"><b>${esc(waiting.length === 1 ? S.waiting1 : t("waitingN", waiting.length))}</b>
          <button class="btn" data-act="approveall">${esc(t("approveAll", waiting.length))}</button></div>` : ""}
        <div class="row"><button class="btn alt" data-act="resuggest">${esc(S.resuggest)}</button><span class="muted">${esc(S.suggestNote)}</span></div>
        <div id="drvMsg" class="msg"></div>
      </div>
      <div class="card tablecard">${list.length ? `<div class="scroll"><table class="drives">
        <thead><tr><th>${esc(S.colDate)}</th><th>${esc(S.colRoute)}</th><th class="n">${esc(S.colDist)}</th><th class="n">${esc(S.colMin)}</th>
        <th class="n">${esc(S.colUsed)}</th><th class="n">${esc(S.colEff)}</th><th class="n">${esc(S.colTemp)}</th><th>${esc(S.colPurpose)}</th><th>${esc(S.colNotes)}</th></tr></thead>
        <tbody>${list.map(driveRow).join("")}</tbody></table></div>` : `<p class="muted">${esc(S.noMatch)}</p>`}</div>
      ${rulesHTML()}`;
  }

  function driveRow(d) {
    const wh = D.whPerMile(d, st.cars), sug = D.pendingSuggestion(d);
    const used = d.pctUsed != null ? (d.pctEstimated ? "≈" : "") + Math.round(d.pctUsed) + "%" : "";
    const sugText = sug ? (d.suggestedRule ? t(d.suggestedBy === "ai" ? "suggestedAi" : "suggested", purposeWord(sug), d.suggestedRule) : t("suggestedPlain", purposeWord(sug))) : "";
    return `<tr data-id="${esc(d.id)}">
      <td><button class="link" data-act="showdrive" title="${esc(S.showOnMap)}">${esc(new Date(d.start).toLocaleDateString(S._locale, { month: "short", day: "numeric" }))}<br><span class="muted">${esc(U.time(d.start))}</span></button>
        ${S._carCol && st.cars.length > 1 ? `<div class="muted small">${esc(carName(d.carId))}</div>` : ""}</td>
      <td class="route">${esc(D.placeLabel(d, "start"))} → ${esc(D.placeLabel(d, "end"))}</td>
      <td class="n">${esc(U.dist(d.miles || 0).replace(/\s*\D+$/, ""))}</td>
      <td class="n">${Math.round(D.minutes(d))}</td>
      <td class="n">${esc(used)}</td>
      <td class="n">${wh != null ? Math.round(U.effVal(wh)) + (D.chargedOnTheWay(d, st.cars) ? "*" : "") : ""}</td>
      <td class="n">${esc(U.temp(d.tempF))}</td>
      <td><select data-act="purpose" aria-label="${esc(S.colPurpose)}">${opt("", "—", d.purpose)}${opt("business", S.business, d.purpose)}${opt("personal", S.personal, d.purpose)}</select>
        ${sug ? `<div class="sugg-tag">${esc(sugText)} <span class="acts"><button class="mini ok" data-act="approve">${esc(S.ok)}</button><button class="mini" data-act="dismiss">${esc(S.dismiss)}</button></span></div>` : ""}</td>
      <td><input class="note" data-act="note" value="${esc(d.notes || "")}" placeholder="${esc(S.notesPh)}" aria-label="${esc(S.colNotes)}"></td>
    </tr>`;
  }

  function rulesHTML() {
    return `<div class="card"><h2>${esc(S.rules)}</h2>
      ${st.rules.length ? `<ul class="list">${st.rules.map(r => `<li><div><b>${esc(r.text)}</b><span class="muted">${esc(ruleSummary(r))}</span></div>
        <div class="acts"><button class="link danger" data-act="delrule" data-id="${esc(r.id)}">${esc(S.del)}</button></div></li>`).join("")}</ul>` : `<p class="muted">${esc(S.noRules)}</p>`}
      <h3>${esc(S.addRule)}</h3>
      <label>${esc(S.ruleText)}<input id="rText" placeholder="${esc(S.ruleTextPh)}"></label>
      ${S._canParse ? `<button class="link" data-act="readrule">${esc(S.readRule)}</button>` : ""}
      <div class="grid2">
        <label>${esc(S.colPurpose)}<select id="rPurpose">${opt("business", S.business)}${opt("personal", S.personal)}</select></label>
        <label>${esc(S.rulePlaces)}<input id="rPlaces" placeholder="${esc(S.rulePlacesPh)}"></label>
        <label>${esc(S.ruleDays)}<select id="rDays">${opt("any", S.daysAny)}${opt("weekdays", S.daysWeekdays)}${opt("weekends", S.daysWeekends)}</select></label>
        <label>${esc(S.ruleOtherwise)}<select id="rOther">${opt("", S.otherwiseNone)}${opt("business", S.business)}${opt("personal", S.personal)}</select></label>
      </div>
      <p class="muted">${esc(S.rulePlacesHelp)}</p>
      <button class="btn" data-act="saverule">${esc(S.saveRule)}</button>
      <div id="ruleMsg" class="msg"></div></div>`;
  }

  const touch = d => { d.updatedAt = new Date().toISOString(); };
  const findDrive = el => st.drives.find(d => d.id === el.closest("tr")?.dataset.id);

  function drawDrive(d) {
    clearMap("drive");
    const path = d.path?.length ? d.path : [[d.startLat, d.startLon], [d.endLat, d.endLon]];
    const line = L.polyline(path, { color: "#FF3D80", weight: 5 }).addTo(layers.drive);
    L.circleMarker([d.startLat, d.startLon], { radius: 7, color: "#0D0A1C", weight: 2, fillColor: "#B8FF3D", fillOpacity: 1 }).bindPopup(esc(D.placeLabel(d, "start"))).addTo(layers.drive);
    L.circleMarker([d.endLat, d.endLon], { radius: 7, color: "#0D0A1C", weight: 2, fillColor: "#FF3D80", fillOpacity: 1 }).bindPopup(esc(D.placeLabel(d, "end"))).addTo(layers.drive);
    map.fitBounds(line.getBounds(), { padding: [40, 40], maxZoom: 15 });
  }

  content.addEventListener("click", e => {
    if (P.tab !== "drives") return;
    const b = e.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act;
    if (act === "showdrive") { const d = findDrive(b); if (d) drawDrive(d); }
    else if (act === "approve") { const d = findDrive(b); if (d && D.approve(d)) { save(st, ["drives"]); renderDrives(); } }
    else if (act === "dismiss") { const d = findDrive(b); if (d) { D.dismiss(d); save(st, ["drives"]); renderDrives(); } }
    else if (act === "approveall") {
      const list = D.filterDrives(st.drives, F).filter(D.pendingSuggestion);
      list.forEach(d => D.approve(d)); save(st, ["drives"]); renderDrives();
    } else if (act === "resuggest") {
      const r = D.resuggest(st.drives, st.rules); save(st, ["drives"]); renderDrives(); msg("drvMsg", t("resuggested", r.checked, r.changed));
    } else if (act === "readrule") {
      const r = D.parseRule($("rText").value);
      if (!r) return msg("ruleMsg", S.ruleCantRead, true);
      $("rPurpose").value = r.purpose; $("rPlaces").value = r.places.join(", "); $("rDays").value = r.days; $("rOther").value = r.otherwise || "";
      msg("ruleMsg", "");
    } else if (act === "saverule") {
      const placesW = $("rPlaces").value.split(/[,，、]/).map(s => s.trim().toLowerCase()).filter(Boolean);
      if (!placesW.length) return msg("ruleMsg", S.ruleNeedPlace, true);
      const r = { id: uid(), text: $("rText").value.trim(), purpose: $("rPurpose").value, places: placesW, days: $("rDays").value };
      if (!r.text) r.text = t("ruleAuto", placesW.join(S.listSep), purposeWord(r.purpose));
      if ($("rOther").value && r.days !== "any") r.otherwise = $("rOther").value;
      st.rules.push(r);
      const res = D.resuggest(st.drives, st.rules);
      save(st, ["rules", "drives"]); renderDrives(); msg("drvMsg", t("resuggested", res.checked, res.changed));
    } else if (act === "delrule") {
      st.rules = st.rules.filter(r => r.id !== b.dataset.id); save(st, ["rules"]); renderDrives();
    }
  });
  content.addEventListener("change", e => {
    if (P.tab !== "drives") return;
    const f = e.target.closest("[data-f]");
    if (f) { F[f.dataset.f] = f.value || undefined; if (f.dataset.f === "month" && f.value) F.year = undefined; if (f.dataset.f === "year" && f.value) F.month = undefined; savePrefs(); renderDrives(); return; }
    const a = e.target.dataset.act, d = a && findDrive(e.target);
    if (!d) return;
    if (a === "purpose") { if (e.target.value) d.purpose = e.target.value; else delete d.purpose; touch(d); save(st, ["drives"]); renderDrives(); }
    else if (a === "note") { d.notes = e.target.value; touch(d); save(st, ["drives"]); }
  });

  // =====================================================================
  // TRENDS
  // =====================================================================
  function carIds() { const ids = st.cars.map(c => c.id); for (const d of st.drives) if (!ids.includes(d.carId)) ids.push(d.carId); return ids; }
  function renderTrends() {
    const ids = carIds();
    if (!st.drives.length) { content.innerHTML = `<div class="card"><p>${esc(S.noDrives)}</p><button class="btn" data-goto="data">${esc(S.importNow)}</button></div>`; return; }
    if (!ids.includes(P.trendCar)) P.trendCar = ids[0];
    const tr = D.trends(st.drives.filter(d => d.carId === P.trendCar), st.cars);
    const months = tr.months.slice(-24);
    const effPts = months.map(m => ({ label: U.monthLabel(m.key), value: m.whPerMile != null ? U.effVal(m.whPerMile) : null }));
    const miPts = months.map(m => ({ label: U.monthLabel(m.key), value: U.distVal(m.miles) }));
    const bandMax = Math.max(1, ...tr.bands.map(b => b.whPerMile || 0));
    content.innerHTML = `
      <div class="card filters"><label>${esc(S.car)}<select id="trendCar">${ids.map(id => opt(id, carName(id) || S.unknownCar, P.trendCar)).join("")}</select></label></div>
      <div class="card"><h2>${esc(S.lifetime)}</h2>
        <p class="big-line">${esc(U.dist(tr.lifetimeMiles))}${tr.lifetimeWhPerMile ? " · " + esc(U.eff(tr.lifetimeWhPerMile)) : ""}</p>
        ${!tr.measuredOnly ? `<p class="muted">${esc(S.estOnly)}</p>` : ""}
        ${tr.skipped ? `<p class="muted">${esc(t("skipNote", tr.skipped))}</p>` : ""}</div>
      <div class="card"><h2>${esc(S.effByMonth)} <span class="muted">(${esc(S.effUnitShort)})</span></h2>
        ${effPts.some(p => p.value != null) ? lineChart(effPts, { title: S.effByMonth }) : `<p class="muted">${esc(S.fewDrives)}</p>`}</div>
      <div class="card"><h2>${esc(S.milesByMonth)} <span class="muted">(${esc(S.distUnitShort)})</span></h2>${barChart(miPts, { title: S.milesByMonth })}</div>
      <div class="card"><h2>${esc(S.byTemp)}</h2>${tr.bands.some(b => b.whPerMile) ? `<ul class="bands">${tr.bands.map(b => `
        <li><span class="bl">${esc(S["band_" + b.key])}</span>
        <span class="bar"><i style="width:${b.whPerMile ? Math.round(b.whPerMile / bandMax * 100) : 0}%"></i></span>
        <span class="bv">${b.whPerMile ? esc(U.eff(b.whPerMile)) : "—"}<span class="muted"> · ${esc(b.drives === 1 ? S.totDrive1 : t("totDrives", b.drives))}</span></span></li>`).join("")}</ul>`
        : `<p class="muted">${esc(S.fewDrives)}</p>`}</div>`;
  }
  content.addEventListener("change", e => {
    if (P.tab === "trends" && e.target.id === "trendCar") { P.trendCar = e.target.value; savePrefs(); renderTrends(); }
  });

  // =====================================================================
  // TAXES
  // =====================================================================
  function taxState() {
    const mode = P.taxMode || "month";
    const pool_ = P.taxCar ? st.drives.filter(d => d.carId === P.taxCar) : st.drives;
    const periods = mode === "year" ? yearsOf(st.drives) : monthsOf(st.drives);
    let period = P.taxPeriod;
    if (!periods.includes(period)) period = periods[0];
    const rate = P.rate ?? S._defaultRate;
    const list = period ? D.inPeriod(pool_, period).sort((a, b) => new Date(a.start) - new Date(b.start)) : [];
    return { mode, periods, period, rate, list, tot: D.totals(list) };
  }
  const periodLabel = p => p.length === 4 ? p : new Date(+p.slice(0, 4), +p.slice(5) - 1, 1).toLocaleDateString(S._locale, { year: "numeric", month: "long" });

  function renderTaxes() {
    if (!st.drives.length) { content.innerHTML = `<div class="card"><p>${esc(S.noDrives)}</p><button class="btn" data-goto="data">${esc(S.importNow)}</button></div>`; return; }
    const x = taxState();
    content.innerHTML = `
      <div class="card filters">
        <div class="seg">${["month", "year"].map(m => `<button data-act="taxmode" data-m="${m}" class="${x.mode === m ? "on" : ""}">${esc(m === "month" ? S.monthly : S.yearly)}</button>`).join("")}</div>
        <label>${esc(S.period)}<select id="taxPeriod">${x.periods.map(p => opt(p, periodLabel(p), x.period)).join("")}</select></label>
        <label>${esc(S.car)}<select id="taxCar">${opt("", S.allCars, P.taxCar)}${st.cars.map(c => opt(c.id, c.name, P.taxCar)).join("")}</select></label>
      </div>
      <div class="card">
        <h2>${esc(periodLabel(x.period))}</h2>
        <dl class="kv">
          <dt>${esc(S.businessTotal)}</dt><dd><b>${esc(U.dist(x.tot.business))}</b></dd>
          <dt>${esc(S.personalTotal)}</dt><dd>${esc(U.dist(x.tot.personal))}</dd>
          <dt>${esc(S.untagged)}</dt><dd>${esc(U.dist(x.tot.untagged))}</dd>
          <dt>${esc(S.allDrives)}</dt><dd>${esc(U.dist(x.tot.miles))} · ${esc(x.tot.count === 1 ? S.totDrive1 : t("totDrives", x.tot.count))}</dd>
        </dl>
        <label>${esc(S.rateLabel)}<input id="rate" type="number" step="0.01" min="0" value="${x.rate}"></label>
        <p class="muted">${esc(S.rateNote)}</p>
        <p class="big-line" id="deduct">${esc(t("deduction", U.money(U.distVal(x.tot.business) * x.rate)))}</p>
        ${x.tot.untaggedCount ? `<p class="warn">${esc(x.tot.untaggedCount === 1 ? S.untaggedWarn1 : t("untaggedWarnN", x.tot.untaggedCount))}</p>` : ""}
        <p class="muted">${esc(S.taxNote)}</p>
        <div class="row"><button class="btn" data-act="csv">${esc(S.downloadCsv)}</button><button class="btn alt" data-act="print">${esc(S.printReport)}</button></div>
      </div>`;
  }

  function reportHTML(x) {
    const carLine = P.taxCar ? carName(P.taxCar) : S.allCars;
    return `<div class="report"><h1>${esc(t("reportTitle", periodLabel(x.period)))}</h1>
      <p>${esc(carLine)}</p>
      <table><thead><tr>${S.csvHeaders.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>
      ${x.list.map(d => `<tr><td>${esc(dayKey(d.start))}</td><td>${esc(U.time(d.start))}</td><td>${esc(U.time(d.end))}</td>
        <td>${esc(D.placeLabel(d, "start"))}</td><td>${esc(D.placeLabel(d, "end"))}</td><td>${esc(d.purpose ? purposeWord(d.purpose) : S.untagged)}</td>
        <td class="n">${(Math.round(U.distVal(d.miles || 0) * 10) / 10).toFixed(1)}</td><td>${esc(d.notes || "")}</td><td>${esc(carName(d.carId))}</td></tr>`).join("")}
      </tbody></table>
      <table class="sum">
        <tr><th>${esc(S.businessTotal)}</th><td>${esc(U.dist(x.tot.business))}</td></tr>
        <tr><th>${esc(S.personalTotal)}</th><td>${esc(U.dist(x.tot.personal))}</td></tr>
        <tr><th>${esc(S.untagged)}</th><td>${esc(U.dist(x.tot.untagged))}</td></tr>
        <tr><th>${esc(S.allDrives)}</th><td>${esc(U.dist(x.tot.miles))}</td></tr>
        <tr><th>${esc(S.rateShort)}</th><td>${esc(t("ratePer", U.money(x.rate)))}</td></tr>
        <tr><th>${esc(S.deductionShort)}</th><td><b>${esc(U.money(U.distVal(x.tot.business) * x.rate))}</b></td></tr>
      </table>
      <p class="muted">${esc(S.taxNote)}</p>
      <p class="muted">${esc(t("reportMade", U.date(new Date())))}</p></div>`;
  }

  content.addEventListener("click", e => {
    if (P.tab !== "taxes") return;
    const b = e.target.closest("[data-act]"); if (!b) return;
    const x = taxState();
    if (b.dataset.act === "taxmode") { P.taxMode = b.dataset.m; P.taxPeriod = undefined; savePrefs(); renderTaxes(); }
    else if (b.dataset.act === "csv" && x.period) {
      const pool_ = P.taxCar ? st.drives.filter(d => d.carId === P.taxCar) : st.drives;
      download(`JUICE-drives-${x.period}.csv`, D.toCSV(pool_, st.cars, x.period, { headers: S.csvHeaders, purposeWord: p => purposeWord(p), distVal: U.distVal }), "text/csv;charset=utf-8");
    } else if (b.dataset.act === "print" && x.period) {
      $("print-root").innerHTML = reportHTML(x);
      document.body.classList.add("printing");
      setTimeout(() => { window.print(); }, 50);
    }
  });
  window.addEventListener("afterprint", () => document.body.classList.remove("printing"));
  content.addEventListener("change", e => {
    if (P.tab !== "taxes") return;
    if (e.target.id === "taxPeriod") { P.taxPeriod = e.target.value; savePrefs(); renderTaxes(); }
    else if (e.target.id === "taxCar") { P.taxCar = e.target.value || undefined; savePrefs(); renderTaxes(); }
  });
  content.addEventListener("input", e => {
    if (P.tab !== "taxes" || e.target.id !== "rate") return;
    const v = parseFloat(e.target.value);
    if (!(v >= 0)) return;
    P.rate = v; savePrefs();
    $("deduct").textContent = t("deduction", U.money(U.distVal(taxState().tot.business) * v));
  });

  // =====================================================================
  // DATA
  // =====================================================================
  function tierName() { return { free: S.tierFree, plus: S.tierPlus, pro: S.tierPro }[st.meta.tier || "free"]; }
  function renderData() {
    content.innerHTML = `
      <div class="card"><h2>${esc(t("planLine", tierName()))}</h2>
        <p class="muted">${esc(st.meta.importedAt ? t("planFromFile", U.dateTime(st.meta.importedAt)) : S.planNoFile)}</p>
        <p class="muted">${esc(S.tierHelp)}</p></div>
      <div class="card"><h2>${esc(S.importTitle)}</h2>
        <p>${esc(S.importHelp)}</p>
        <label class="btn file">${esc(S.pickFile)}<input type="file" id="importFile" accept=".json,application/json" hidden></label>
        <div id="impMsg" class="msg"></div>
        <p class="muted small">${esc(CK.enabled() ? S.ckDataHint : S.icloudSoon)}</p></div>
      <div class="card"><h2>${esc(S.exportTitle)}</h2>
        <p>${esc(S.exportHelp)}</p>
        <button class="btn alt" data-act="export">${esc(S.exportBtn)}</button></div>
      <div class="card"><h2>${esc(S.inBrowser)}</h2>
        <p class="muted">${esc(t("counts", st.cars.length, st.drives.length, st.rules.length, st.trips.length, st.planned.length))}</p>
        <button class="btn danger" data-act="clear">${esc(S.clearData)}</button></div>`;
  }
  content.addEventListener("change", async e => {
    if (e.target.id !== "importFile") return;
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const r = mergeImport(st, j);
      if (!ownCars().some(c => c.id === P.car) && !PRESETS.some(p => p.id === P.car) && st.cars[0]) P.car = st.cars[0].id;
      if (P.car && PRESETS.some(p => p.id === P.car) && st.cars[0]) P.car = st.cars[0].id;
      save(st);
      renderData();
      renderTabs();
      msg("impMsg", t("imported", r.cars, r.drives, r.rules, r.trips, r.planned));
    } catch { msg("impMsg", S.importBad, true); }
  });
  content.addEventListener("click", e => {
    if (P.tab !== "data") return;
    const b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "export") {
      download(`JUICE-web-${dayKey(new Date())}.json`, JSON.stringify(buildExport(st, lang), null, 2), "application/json");
    } else if (b.dataset.act === "clear") {
      if (!confirm(S.clearConfirm)) return;
      clearAll(); location.reload();
    }
  });

  render();

  // ---------- Sign in with Apple ID (iCloud sync with the app) ----------
  const ckLine = (k, ...a) => { const el = $("ckLine"); if (el) el.textContent = t(k, ...a); };
  cloud = CK.mount({
    getState: () => st,
    persist: () => storeSave(st),
    onStatus: (s, e) => {
      $("ckBar").classList.toggle("on", s === "signedIn" || s === "syncing");
      if (s === "signedOut") { $("ckTitle").textContent = S.ckTitle; ckLine("ckHelp"); }
      else if (s === "syncing") { $("ckTitle").textContent = S.ckSignedIn; ckLine("ckSyncing"); }
      else if (s === "error") ckLine("ckError");
    },
    onSynced: (n, info) => {
      $("ckTitle").textContent = S.ckSignedIn;
      ckLine("ckSynced", info.drives, info.trips, info.planned);
      if (n > 0) { renderTabs(); render(); }
    },
  });
}
