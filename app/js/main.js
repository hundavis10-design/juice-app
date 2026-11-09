// JUICE for the web: the page. All words come from strings-en.js / strings-zh-hk.js.
import { fmt, esc, uid, makeUnits, monthKey, KM_PER_MI, dayKey } from "./util.js";
import { cumulative, thin, samplePoints, alongRoute, planStops } from "./planner.js";
import { geocode, route, chargersNear, pool, NetError } from "./net.js";
import * as D from "./drives.js";
import { load, save as storeSave, tierAtLeast } from "./store.js";
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
  let contentTarget = null;            // the Drives screen draws its sub-pages under its switch
  const out = () => contentTarget || content;
  let signedIn = false;                // signed in with Apple (iCloud) on this page

  // ---------- skeleton ----------
  // Hunter 11/9 8:07am: "look and feel like the app". Same layout as the iPhone app: the map fills the screen, the
  // JUICE banner sits on top (with the Apple sign-in), "Where to?" floats at the bottom, and the app's tabs (Map,
  // Trip, Drives, Garage) open their screens as a rounded sheet over the map (a side panel on a wide screen).
  if (P.tab === "plan") P.tab = "trip";
  if (P.tab === "trends" || P.tab === "taxes") { P.dsub = P.tab; P.tab = "drives"; }
  if (P.tab === "data") P.tab = "garage";
  if (!["map", "trip", "drives", "garage"].includes(P.tab)) P.tab = "map";
  const root = document.getElementById("app");
  root.innerHTML = `
    <div id="map" aria-label="${esc(S.mapLabel)}"></div>
    <header class="top">
      <div class="banner" id="banner">
        <div class="face" aria-hidden="true"><i></i><i></i><b></b></div>
        <div class="btext"><strong>JUICE</strong><span id="bannerLine">${esc(S.bannerHello)}</span></div>
      </div>
      <div class="topright">${root.dataset.langLink || ""}
        <div class="acct${CK.enabled() ? "" : " hide"}" id="acct"><div id="apple-sign-in-button"></div><div id="apple-sign-out-button"></div></div>
      </div>
    </header>
    <div class="dock" id="dock">
      <button class="where" data-goto="trip" data-focus="to"><span class="flag">⚑</span><span>${esc(S.whereToPill)}</span></button>
    </div>
    <section class="sheet" id="sheet" aria-modal="false">
      <div class="grab" id="grab"></div>
      <div class="sheethead"><h2 id="sheetTitle"></h2><button class="close" id="sheetClose" aria-label="${esc(S.close)}">✕</button></div>
      <div id="content"></div>
      <footer class="foot"><p>${esc(S.privacy)}</p>
        <p><a href="${esc(S._privacyHref)}">${esc(S.privacyLink)}</a> · <a href="${esc(S._supportHref)}">${esc(S.supportLink)}</a></p></footer>
    </section>
    <nav class="tabbar" id="tabs" role="tablist"></nav>
    <div id="print-root"></div>`;
  const $ = id => document.getElementById(id);
  const content = $("content");

  // ---------- map (dark, like the app) ----------
  const map = L.map("map", { zoomControl: false, worldCopyJump: true }).setView(S._mapCenter, S._mapZoom);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ${esc(S.osmContrib)}`,
  }).addTo(map);
  L.control.zoom({ position: "topright" }).addTo(map);
  const layers = { route: L.layerGroup().addTo(map), chargers: L.layerGroup().addTo(map), stops: L.layerGroup().addTo(map), drive: L.layerGroup().addTo(map), places: L.layerGroup().addTo(map) };
  const clearMap = (...ks) => ks.forEach(k => layers[k].clearLayers());
  const fixMap = () => setTimeout(() => map.invalidateSize(), 60);
  window.addEventListener("resize", fixMap);

  /** Saved places and favorite chargers from the iPhone (iCloud), on the map like in the app. */
  function drawPlaces() {
    clearMap("places");
    for (const p of st.places || []) {
      const lat = p.item?.lat ?? p.lat, lon = p.item?.lon ?? p.lon;
      if (lat == null || lon == null) continue;
      L.marker([lat, lon], { icon: L.divIcon({ className: "pin-place", html: `<span>${esc(placeIcon(p.kind))}</span>`, iconSize: [30, 30] }) })
        .bindPopup(`<b>${esc(placeName(p))}</b>${p.item?.subtitle ? "<br>" + esc(p.item.subtitle) : ""}`).addTo(layers.places);
    }
    for (const c of st.favorites || []) {
      L.marker([c.lat, c.lon], { icon: L.divIcon({ className: "pin-fav", html: "<span>★</span>", iconSize: [26, 26] }) })
        .bindPopup(`<b>${esc(c.name)}</b><br>${esc(t("chargerMeta", c.network || S.unknownNetwork, Math.round(c.maxKw || 0)))}`).addTo(layers.places);
    }
  }
  const placeIcon = k => ({ home: "⌂", work: "▣", school: "✎", church: "✝" })[k] || "★";
  const placeName = p => p.name || ({ home: S.placeHome, work: S.placeWork, school: S.placeSchool, church: S.placeChurch })[p.kind] || p.item?.title || "";

  // ---------- tabs (the app's tab bar) ----------
  const TABS = [
    { id: "map", label: S.tabMap, icon: "map" },
    { id: "trip", label: S.tabTrip, icon: "trip" },
    { id: "drives", label: S.tabDrives, icon: "drives", pro: true },
    { id: "garage", label: S.tabGarage, icon: "garage" },
  ];
  const ICONS = {
    map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z M9 4v14 M15 6v14"/>',
    trip: '<path d="M12 2l10 10-10 10L2 12z M9 13v-2h5l-2-2 M14 11l-2 2"/>',
    drives: '<path d="M4 20L9 4 M20 20L15 4 M12 6v2 M12 11v2 M12 16v2"/>',
    garage: '<path d="M3 17h18v-4l-2-5H5l-2 5z M7 17v2 M17 17v2 M6 13h3 M15 13h3"/>',
  };
  function renderTabs() {
    $("tabs").innerHTML = TABS.map(x => `<button role="tab" data-tab="${x.id}" class="${P.tab === x.id ? "on" : ""}" aria-selected="${P.tab === x.id}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[x.icon]}</svg><span>${esc(x.label)}</span></button>`).join("");
  }
  function go(tab, focus) {
    P.tab = tab; savePrefs(); render();
    if (focus) setTimeout(() => content.querySelector(`[data-place="${focus}"]`)?.focus(), 60);
  }
  $("tabs").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) go(b.dataset.tab); });
  $("sheetClose").addEventListener("click", () => go("map"));
  $("dock").addEventListener("click", e => { const b = e.target.closest("[data-goto]"); if (b) go(b.dataset.goto, b.dataset.focus); });
  // Swipe the sheet's handle down (phone) or press Escape to get back to the map.
  let dragY = null;
  $("grab").addEventListener("pointerdown", e => { dragY = e.clientY; });
  window.addEventListener("pointerup", e => { if (dragY != null && e.clientY - dragY > 60) go("map"); dragY = null; });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && P.tab !== "map" && !e.target.closest("input,select,textarea")) go("map"); });

  const SUBS = [{ id: "drives", label: S.subDrives }, { id: "trends", label: S.tabTrends }, { id: "taxes", label: S.tabTaxes }];
  function render() {
    renderTabs();
    const tab = P.tab;
    document.body.dataset.tab = tab;
    $("sheet").classList.toggle("open", tab !== "map");
    $("dock").classList.toggle("hide", tab !== "map");
    $("sheetTitle").textContent = ({ trip: S.tabTrip, drives: S.tabDrives, garage: S.tabGarage })[tab] || "";
    if (tab !== "drives") clearMap("drive");
    drawPlaces();
    if (tab === "map") { fixMap(); return; }
    if (tab === "trip") renderPlan();
    else if (tab === "garage") renderGarage();
    else if (tab === "drives") {
      if (!signedIn && !st.drives.length) { content.innerHTML = signInCard(S.drivesSignIn); fixMap(); return; }
      if (!tierAtLeast(st, "pro")) { content.innerHTML = locked(S.featDrives); fixMap(); return; }
      const sub = SUBS.some(x => x.id === P.dsub) ? P.dsub : "drives";
      content.innerHTML = `<div class="seg wide" id="dsub">${SUBS.map(x => `<button data-sub="${x.id}" class="${sub === x.id ? "on" : ""}">${esc(x.label)}</button>`).join("")}</div><div id="dpane"></div>`;
      const inner = content; const pane = $("dpane");
      // The drive screens write into #content; point them at the pane under the switch.
      contentTarget = pane;
      ({ drives: renderDrives, trends: renderTrends, taxes: renderTaxes })[sub]();
      contentTarget = null;
      void inner;
    }
    fixMap();
  }
  content.addEventListener("click", e => {
    const b = e.target.closest("[data-sub]"); if (b) { P.dsub = b.dataset.sub; savePrefs(); render(); }
  });

  function signInCard(text) {
    return `<div class="card signin"><div class="apple-glyph"></div><h3>${esc(S.signInTitle)}</h3><p>${esc(text)}</p>
      <button class="btn apple" data-act="signin">${esc(S.signInBtn)}</button></div>`;
  }
  function locked(feat) {
    return `<div class="card lock"><span class="badge">Pro</span><p>${esc(t("lockedPro", feat))}</p></div>`;
  }
  content.addEventListener("click", e => {
    const g = e.target.closest("[data-goto]"); if (g) go(g.dataset.goto);
    if (e.target.closest('[data-act="signin"]')) $("apple-sign-in-button").querySelector("a, div, button")?.click();
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
    if (P.tab !== "trip") return;
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
    if (!st.drives.length) { out().innerHTML = `<div class="card"><p>${esc(signedIn ? S.noDrivesYet : S.drivesSignIn)}</p></div>${rulesHTML()}`; return; }
    const list = D.filterDrives(st.drives, F);
    const waiting = list.filter(D.pendingSuggestion);
    const tot = D.totals(list);
    out().innerHTML = `
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
      <div class="drivelist">${list.length ? list.map(driveRow).join("") : `<div class="card"><p class="muted">${esc(S.noMatch)}</p></div>`}</div>
      ${rulesHTML()}`;
  }

  function driveRow(d) {
    const wh = D.whPerMile(d, st.cars), sug = D.pendingSuggestion(d);
    const used = d.pctUsed != null ? (d.pctEstimated ? "≈" : "") + Math.round(d.pctUsed) + "%" : "";
    const sugText = sug ? (d.suggestedRule ? t(d.suggestedBy === "ai" ? "suggestedAi" : "suggested", purposeWord(sug), d.suggestedRule) : t("suggestedPlain", purposeWord(sug))) : "";
    const facts = [U.dist(d.miles || 0), `${Math.round(D.minutes(d))} min`, used, wh != null ? U.eff(wh) + (D.chargedOnTheWay(d, st.cars) ? "*" : "") : "", d.tempF != null ? U.temp(d.tempF) : ""].filter(Boolean);
    return `<div class="card drive" data-id="${esc(d.id)}">
      <div class="dtop"><button class="dwhen" data-act="showdrive" title="${esc(S.showOnMap)}">
          <b>${esc(new Date(d.start).toLocaleDateString(S._locale, { weekday: "short", month: "short", day: "numeric" }))}</b>
          <span class="muted">${esc(U.time(d.start))}${S._carCol && st.cars.length > 1 ? " · " + esc(carName(d.carId)) : ""}</span></button>
        <select class="pill ${d.purpose || "none"}" data-act="purpose" aria-label="${esc(S.colPurpose)}">${opt("", S.untagged, d.purpose)}${opt("business", S.business, d.purpose)}${opt("personal", S.personal, d.purpose)}</select></div>
      <div class="droute">${esc(D.placeLabel(d, "start"))} → <b>${esc(D.placeLabel(d, "end"))}</b></div>
      <div class="dfacts">${facts.map(f => `<span>${esc(f)}</span>`).join("")}</div>
      ${sug ? `<div class="sugg-tag">✨ ${esc(sugText)} <span class="acts"><button class="mini ok" data-act="approve">${esc(S.ok)}</button><button class="mini" data-act="dismiss">${esc(S.dismiss)}</button></span></div>` : ""}
      <input class="note" data-act="note" value="${esc(d.notes || "")}" placeholder="${esc(S.notesPh)}" aria-label="${esc(S.colNotes)}">
    </div>`;
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
  const findDrive = el => st.drives.find(d => d.id === el.closest("[data-id]")?.dataset.id);

  function drawDrive(d) {
    clearMap("drive");
    const path = d.path?.length ? d.path : [[d.startLat, d.startLon], [d.endLat, d.endLon]];
    const line = L.polyline(path, { color: "#FF3D80", weight: 5 }).addTo(layers.drive);
    L.circleMarker([d.startLat, d.startLon], { radius: 7, color: "#0D0A1C", weight: 2, fillColor: "#B8FF3D", fillOpacity: 1 }).bindPopup(esc(D.placeLabel(d, "start"))).addTo(layers.drive);
    L.circleMarker([d.endLat, d.endLon], { radius: 7, color: "#0D0A1C", weight: 2, fillColor: "#FF3D80", fillOpacity: 1 }).bindPopup(esc(D.placeLabel(d, "end"))).addTo(layers.drive);
    map.fitBounds(line.getBounds(), { padding: [40, 40], maxZoom: 15 });
  }

  content.addEventListener("click", e => {
    if (P.tab !== "drives" || (P.dsub && P.dsub !== "drives")) return;
    const b = e.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act;
    if (act === "showdrive") { const d = findDrive(b); if (d) drawDrive(d); }
    else if (act === "approve") { const d = findDrive(b); if (d && D.approve(d)) { save(st, ["drives"]); render(); } }
    else if (act === "dismiss") { const d = findDrive(b); if (d) { D.dismiss(d); save(st, ["drives"]); render(); } }
    else if (act === "approveall") {
      const list = D.filterDrives(st.drives, F).filter(D.pendingSuggestion);
      list.forEach(d => D.approve(d)); save(st, ["drives"]); render();
    } else if (act === "resuggest") {
      const r = D.resuggest(st.drives, st.rules); save(st, ["drives"]); render(); msg("drvMsg", t("resuggested", r.checked, r.changed));
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
      save(st, ["rules", "drives"]); render(); msg("drvMsg", t("resuggested", res.checked, res.changed));
    } else if (act === "delrule") {
      st.rules = st.rules.filter(r => r.id !== b.dataset.id); save(st, ["rules"]); render();
    }
  });
  content.addEventListener("change", e => {
    if (P.tab !== "drives" || (P.dsub && P.dsub !== "drives")) return;
    const f = e.target.closest("[data-f]");
    if (f) { F[f.dataset.f] = f.value || undefined; if (f.dataset.f === "month" && f.value) F.year = undefined; if (f.dataset.f === "year" && f.value) F.month = undefined; savePrefs(); render(); return; }
    const a = e.target.dataset.act, d = a && findDrive(e.target);
    if (!d) return;
    if (a === "purpose") { if (e.target.value) d.purpose = e.target.value; else delete d.purpose; touch(d); save(st, ["drives"]); render(); }
    else if (a === "note") { d.notes = e.target.value; touch(d); save(st, ["drives"]); }
  });

  // =====================================================================
  // TRENDS
  // =====================================================================
  function carIds() { const ids = st.cars.map(c => c.id); for (const d of st.drives) if (!ids.includes(d.carId)) ids.push(d.carId); return ids; }
  function renderTrends() {
    const ids = carIds();
    if (!st.drives.length) { out().innerHTML = `<div class="card"><p>${esc(signedIn ? S.noDrivesYet : S.drivesSignIn)}</p></div>`; return; }
    if (!ids.includes(P.trendCar)) P.trendCar = ids[0];
    const tr = D.trends(st.drives.filter(d => d.carId === P.trendCar), st.cars);
    const months = tr.months.slice(-24);
    const effPts = months.map(m => ({ label: U.monthLabel(m.key), value: m.whPerMile != null ? U.effVal(m.whPerMile) : null }));
    const miPts = months.map(m => ({ label: U.monthLabel(m.key), value: U.distVal(m.miles) }));
    const bandMax = Math.max(1, ...tr.bands.map(b => b.whPerMile || 0));
    out().innerHTML = `
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
    if (P.tab === "drives" && P.dsub === "trends" && e.target.id === "trendCar") { P.trendCar = e.target.value; savePrefs(); render(); }
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
    if (!st.drives.length) { out().innerHTML = `<div class="card"><p>${esc(signedIn ? S.noDrivesYet : S.drivesSignIn)}</p></div>`; return; }
    const x = taxState();
    out().innerHTML = `
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
    if (P.tab !== "drives" || P.dsub !== "taxes") return;
    const b = e.target.closest("[data-act]"); if (!b) return;
    const x = taxState();
    if (b.dataset.act === "taxmode") { P.taxMode = b.dataset.m; P.taxPeriod = undefined; savePrefs(); render(); }
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
    if (P.tab !== "drives" || P.dsub !== "taxes") return;
    if (e.target.id === "taxPeriod") { P.taxPeriod = e.target.value; savePrefs(); render(); }
    else if (e.target.id === "taxCar") { P.taxCar = e.target.value || undefined; savePrefs(); render(); }
  });
  content.addEventListener("input", e => {
    if (P.tab !== "drives" || P.dsub !== "taxes" || e.target.id !== "rate") return;
    const v = parseFloat(e.target.value);
    if (!(v >= 0)) return;
    P.rate = v; savePrefs();
    $("deduct").textContent = t("deduction", U.money(U.distVal(taxState().tot.business) * v));
  });

  // =====================================================================
  // GARAGE (account, cars, saved places, plan) — like the app's Garage tab
  // =====================================================================
  function tierName() { return { free: S.tierFree, plus: S.tierPlus, pro: S.tierPro }[st.meta.tier || "free"]; }
  function renderGarage() {
    const cars = st.cars || [];
    const places = st.places || [], favs = st.favorites || [];
    content.innerHTML = `
      ${signedIn ? `<div class="card account on"><div class="apple-glyph"></div><div><h3>${esc(S.signedInApple)}</h3>
          <p class="muted" id="garageSync">${esc(syncLine())}</p></div></div>`
        : signInCard(S.garageSignIn)}
      <div class="card"><h3>${esc(S.yourCars)}</h3>
        ${cars.length ? cars.map(c => `<div class="carrow"><div class="carico">🚗</div><div><b>${esc(c.name)}</b>
          <span class="muted">${esc(c.title && c.title !== c.name ? c.title + " · " : "")}${esc(t("carSpec", U.dist(c.rangeMi || 0), Math.round(c.batteryKwh || 0)))}</span></div></div>`).join("")
          : `<p class="muted">${esc(signedIn ? S.noCarsYet : S.carsAfterSignIn)}</p>`}
      </div>
      <div class="card"><h3>${esc(S.savedPlacesTitle)}</h3>
        ${places.length || favs.length ? `<ul class="list">${places.map(p => `<li><div><b>${esc(placeIcon(p.kind))} ${esc(placeName(p))}</b>
            <span class="muted">${esc(p.item?.subtitle || p.address || "")}</span></div>
            <div class="acts"><button class="link" data-act="goplace" data-lat="${p.item?.lat ?? ""}" data-lon="${p.item?.lon ?? ""}" data-name="${esc(placeName(p))}">${esc(S.goHere)}</button></div></li>`).join("")}
          ${favs.map(c => `<li><div><b>★ ${esc(c.name)}</b><span class="muted">${esc(t("chargerMeta", c.network || S.unknownNetwork, Math.round(c.maxKw || 0)))}</span></div></li>`).join("")}</ul>`
          : `<p class="muted">${esc(signedIn ? S.noPlacesYet : S.placesAfterSignIn)}</p>`}
      </div>
      <div class="card"><h3>${esc(t("planLine", tierName()))}</h3><p class="muted">${esc(signedIn ? S.tierFromPhone : S.tierHelpSignIn)}</p></div>`;
  }
  let lastInfo = null;
  const syncLine = () => lastInfo ? t("ckSyncedLive", lastInfo.drives, lastInfo.trips, (st.places || []).length) : S.ckSyncing;
  content.addEventListener("click", e => {
    if (P.tab !== "garage") return;
    const b = e.target.closest('[data-act="goplace"]'); if (!b || !b.dataset.lat) return;
    places.to = { text: b.dataset.name, sel: { title: b.dataset.name, short: b.dataset.name, lat: +b.dataset.lat, lon: +b.dataset.lon } };
    persistPlaces(); go("trip");
  });

  render();

  // ---------- Sign in with Apple ID: the same iCloud account as the app, live ----------
  const line = text => { $("bannerLine").textContent = text; };
  cloud = CK.mount({
    getState: () => st,
    persist: () => storeSave(st),
    onStatus: (s, e) => {
      signedIn = s === "signedIn" || s === "syncing";
      document.body.classList.toggle("signedin", signedIn);
      if (s === "signedOut") { line(S.bannerHello); if (P.tab === "garage" || P.tab === "drives") render(); }
      else if (s === "syncing") line(S.ckSyncing);
      else if (s === "error") line(e && (e.ckErrorCode === "QUOTA_EXCEEDED" || e.serverErrorCode === "QUOTA_EXCEEDED") ? S.icloudFull : S.ckError);
    },
    onSynced: (n, info) => {
      lastInfo = info;
      line(t("bannerSynced", info.drives, info.trips));
      if (!ownCars().some(c => c.id === P.car) && st.cars[0]) { P.car = st.cars[0].id; savePrefs(); }
      if (n > 0 || P.tab === "garage" || P.tab === "drives") render(); else drawPlaces();
    },
  });
}
