

const $ = (id) => document.getElementById(id);
const BASE = location.protocol.startsWith("http") ? location.origin : "http:
const FALLBACK = { lat: 28.2455, lng: 77.0690 };

const HAVEN_ICON = { Police: "🚓", "Campus QRT": "🛡️", Metro: "🚇", Pharmacy: "💊", "Help Desk": "👮", Hospital: "🏥" };

const state = {
  profile: null,
  journey: false,
  risk: 0,
  view: "home",
  map: null, tile: null, trail: null, me: null, havenPins: [], havens: [],
  routeLine: null, originPin: null, destPin: null, picking: false,
  watchId: null, origin: null, here: null, speed: 0, lastMove: Date.now(), trailPts: [],
  busy: false, lastPush: 0,
  trip: null,
  planning: { dest: null, origin: null, results: [] },
  voice: { active: false, rec: null, timer: null, primed: false, fired: false, cooldown: 0 },
  sos: { active: false, acknowledged: false, dispatchDone: false, timer: null },
  checkin: { open: false, timer: null, cooldown: 0 },
  audio: { ctx: null, siren: null },
  strobe: null,
  shake: false, shakeHits: [],
  covert: { armed: false, payload: null, timer: null },
  call: { ring: null, tick: null, connected: false, vibrate: null },
  links: {}, guardianPhone: "", dispatch: [],
};


function toast(msg, tone) {
  const el = document.createElement("div");
  el.className = "toast" + (tone ? " " + tone : "");
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 320);
  }, 3200);
}
function buzz(pattern) {
  try { navigator.vibrate && navigator.vibrate(pattern); } catch (_) {  }
}
async function api(path, body) {
  try {
    const res = await fetch(BASE + path, body === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (_) {
    return null;
  }
}
function haversine(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dPhi = rad(b.lat - a.lat), dLam = rad(b.lng - a.lng);
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLam / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const isNight = () => { const h = new Date().getHours(); return h >= 20 || h < 6; };
const initials = (s) => (s || "?").trim().charAt(0).toUpperCase();

function coords() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const t = setTimeout(() => resolve(null), 2600);
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(t); resolve({ lat: p.coords.latitude, lng: p.coords.longitude }); },
      () => { clearTimeout(t); resolve(null); },
      { timeout: 2200, maximumAge: 30000 }
    );
  });
}


function ctx() {
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  state.audio.ctx = state.audio.ctx || new C();
  if (state.audio.ctx.state === "suspended") state.audio.ctx.resume();
  return state.audio.ctx;
}
function startSiren() {
  const ac = ctx();
  if (!ac || state.audio.siren) return;
  const osc = ac.createOscillator(), gain = ac.createGain();
  const lfo = ac.createOscillator(), lfoGain = ac.createGain();
  osc.type = "sawtooth"; osc.frequency.value = 780;
  gain.gain.value = 0.17;
  lfo.type = "sine"; lfo.frequency.value = 2.4; lfoGain.gain.value = 430;
  lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
  osc.connect(gain); gain.connect(ac.destination);
  osc.start(); lfo.start();
  state.audio.siren = { osc, gain, lfo };
}
function stopSiren() {
  const s = state.audio.siren;
  if (!s) return;
  try {
    s.osc.stop(); s.lfo.stop();
    s.osc.disconnect(); s.lfo.disconnect(); s.gain.disconnect();
  } catch (_) {  }
  state.audio.siren = null;
}
function chime() {
  const ac = ctx();
  if (!ac) return;
  [880, 1180].forEach((f, i) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = "sine"; o.frequency.value = f;
    const at = ac.currentTime + i * 0.18;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.13, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    o.connect(g); g.connect(ac.destination);
    o.start(at); o.stop(at + 0.2);
  });
}


function startStrobe() {
  if (state.strobe) return;
  const el = $("strobe");
  el.hidden = false;
  let white = false;
  state.strobe = setInterval(() => {
    white = !white;
    el.style.background = white ? "rgba(255,255,255,.85)" : "rgba(255,55,95,.4)";
  }, 170);
}
function stopStrobe() {
  if (state.strobe) { clearInterval(state.strobe); state.strobe = null; }
  $("strobe").hidden = true;
}


function go(view) {
  state.view = view;
  document.querySelectorAll(".view").forEach((s) => { s.hidden = s.dataset.view !== view; });
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.goto === view));
  
  
  window.scrollTo(0, 0);
  if (view === "radar") {
    initMap();
    setTimeout(() => state.map && state.map.invalidateSize(), 120);
  }
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  buzz(8);
  go(t.dataset.goto);
}));


$("onboardForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pin = $("fPin").value.trim(), duress = $("fDuress").value.trim();
  const err = $("onboardErr");
  const fail = (m) => { err.textContent = m; err.hidden = false; };

  if (!/^\d{4,8}$/.test(pin)) return fail("Safety PIN must be 4–8 digits.");
  if (!/^\d{4,8}$/.test(duress)) return fail("Duress PIN must be 4–8 digits.");
  if (pin === duress) return fail("Duress PIN must be different from your safety PIN.");
  err.hidden = true;

  const body = {
    name: $("fName").value.trim(), phone: $("fPhone").value.trim(),
    guardian_1_name: $("fG1Name").value.trim(), guardian_1_phone: $("fG1Phone").value.trim(),
    guardian_2_name: $("fG2Name").value.trim(), guardian_2_phone: $("fG2Phone").value.trim(),
    pin, duress_pin: duress,
  };
  const r = await api("/api/register-user", body);
  if (!r || r.error) return fail((r && r.error) || "Could not reach the safety server.");

  state.profile = body;
  state.guardianPhone = body.guardian_1_phone;
  $("onboarding").hidden = true;
  renderProfile();
  buzz(20);
  toast("You're protected. Start a journey when you head out.", "ok");
});

function renderProfile() {
  const p = state.profile;
  if (!p) return;
  const h = new Date().getHours();
  $("greeting").textContent = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  $("userName").textContent = p.name.split(" ")[0];
  $("avatar").textContent = initials(p.name);
  $("profileName").textContent = p.name;
  $("profilePhone").textContent = p.phone;

  const rows = [["Guardian 1", p.guardian_1_name, p.guardian_1_phone], ["Guardian 2", p.guardian_2_name, p.guardian_2_phone]]
    .filter((r) => r[2]);
  $("guardianList").innerHTML = rows.map(([role, name, phone]) => `
    <li><div class="ic">👤</div><div class="grow">
      <p class="li-title">${esc(name)}</p><p class="li-sub">${esc(role)} · ${esc(phone)}</p>
    </div><span class="chip">Alerted first</span></li>`).join("");
  $("profileGuardians").innerHTML = rows.map(([role, name, phone]) => `
    <li><div class="ic blue">👤</div><div class="grow">
      <p class="li-title">${esc(name)}</p><p class="li-sub">${esc(role)} · ${esc(phone)}</p>
    </div></li>`).join("");

  $("fcName").textContent = p.guardian_1_name;
  $("fcAvatar").textContent = initials(p.guardian_1_name);
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }


$("btnJourney").addEventListener("click", async () => {
  if (!state.journey) return openPlanner();
  const r = await api("/api/end-journey", {});
  if (!r) return toast("Couldn't reach the server");
  finishJourney();
  $("purgeSub").textContent = "Trail cleared just now";
  toast("Journey ended — your route has been erased", "ok");
});

function finishJourney() {
  stopTracking();
  stopVoiceWatch();
  resetAlarm();
  endCheckin(true);
  state.journey = false;
  state.trip = null;
  state.risk = 0;
  state.sos.active = false;
  $("tripCard").hidden = true;
  $("sosPanel").hidden = true;
  $("escalationActions").hidden = true;
  clearRoute();
  setRisk(0, "All clear", "Plan a journey to switch on live route watching.");
  renderJourneyState();
}


function openPlanner() {
  state.planning = { dest: null, origin: null, results: [] };
  $("destSearch").value = "";
  $("destResults").hidden = true;
  $("destResults").innerHTML = "";
  $("planPreview").hidden = true;
  $("btnStartPlanned").disabled = true;
  $("planFromLabel").textContent = "Your current location";
  $("planSheet").hidden = false;
}
$("btnClosePlan").addEventListener("click", () => { $("planSheet").hidden = true; state.picking = false; });

let searchTimer = null;
$("destSearch").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 3) { $("destResults").hidden = true; return; }
  searchTimer = setTimeout(() => searchPlaces(q), 450);
});

async function searchPlaces(q) {
  const r = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
  const list = $("destResults");
  if (!r || !r.results || !r.results.length) {
    list.innerHTML = `<li style="padding:10px 0;border:none"><p class="li-sub">${esc((r && r.error) || "No matches — try “Choose on map”.")}</p></li>`;
    list.hidden = false;
    return;
  }
  state.planning.results = r.results;
  list.innerHTML = r.results.map((p, i) => `
    <li style="padding:0;border:none">
      <button class="result" data-i="${i}">
        <span>📍</span>
        <span class="grow">
          <span class="li-title">${esc(p.label)}</span>
          <span class="li-sub">${esc((p.full || "").slice(0, 64))}</span>
        </span>
      </button>
    </li>`).join("");
  list.hidden = false;
  list.querySelectorAll("[data-i]").forEach((b) =>
    b.addEventListener("click", () => chooseDestination(state.planning.results[Number(b.dataset.i)])));
}

async function chooseDestination(place) {
  state.planning.dest = { lat: place.lat, lng: place.lng, label: place.label || "Destination" };
  $("destResults").hidden = true;
  $("destSearch").value = state.planning.dest.label;
  $("planPreview").hidden = false;
  $("planPreview").textContent = "Locking the route…";
  $("btnStartPlanned").disabled = true;

  const origin = await resolveOrigin();
  if (!origin) return ($("planPreview").textContent = "Location is off — turn it on to plan this journey.");
  state.planning.origin = origin;

  const p = await api("/api/journey/plan", { origin, destination: state.planning.dest });
  if (!p || p.error) {
    $("planPreview").textContent = "Route service is busy — we'll still watch your direct corridor.";
  } else {
    $("planPreview").innerHTML = `<b>${(p.distance_m / 1000).toFixed(1)} km</b> · ~${Math.max(1, Math.round(p.duration_s / 60))} min · ${p.source === "osrm" ? "road route locked" : "direct corridor"}`;
  }
  $("btnStartPlanned").disabled = false;
}

async function resolveOrigin() {
  if (state.here) return { lat: state.here.lat, lng: state.here.lng, label: "Your location" };
  const c = await coords();
  if (!c) return null;
  state.here = { ...c, accuracy: 20 };
  return { lat: c.lat, lng: c.lng, label: "Your location" };
}

$("btnPickMap").addEventListener("click", () => {
  $("planSheet").hidden = true;
  go("radar");
  state.picking = true;
  toast("Tap the map to drop your destination");
});

$("btnStartPlanned").addEventListener("click", async () => {
  const origin = state.planning.origin || (await resolveOrigin());
  const dest = state.planning.dest;
  if (!origin || !dest) return toast("Pick a destination first");

  const r = await api("/api/start-journey", { origin, destination: dest });
  if (!r || r.error) return toast((r && r.error) || "Couldn't start the journey");

  state.journey = true;
  state.sos = { active: false, acknowledged: false, dispatchDone: false, timer: null };
  state.trip = {
    dest, origin,
    distance: r.distance_m, duration: r.duration_s,
    route: r.route, source: r.route_source, progress: 0,
  };

  $("planSheet").hidden = true;
  $("tripCard").hidden = false;
  $("tripDest").textContent = dest.label;
  $("tripBar").style.width = "0%";
  $("tripRemaining").textContent = (r.distance_m / 1000).toFixed(1) + " km to go";
  $("tripEta").textContent = "~" + Math.max(1, Math.round(r.duration_s / 60)) + " min";
  $("tripStatus").textContent = "On route";
  $("tripStatus").className = "chip live";
  $("tripNote").hidden = true;
  $("tripCard").classList.remove("trip-off");

  drawRoute(r.route, origin, dest);
  startTracking();
  primeVoicePermission();
  renderJourneyState();
  go("home");
  buzz(15);
  toast("Journey started — route locked, voice watch on standby", "ok");
});

function drawRoute(points, origin, dest) {
  if (!points) return;
  if (!state.map) initMap();
  if (!state.map) return;
  clearRoute();
  state.routeLine = L.polyline(points, { color: "#0a84ff", weight: 5, opacity: .9 }).addTo(state.map);
  state.originPin = L.marker([origin.lat, origin.lng], {
    icon: L.divIcon({ className: "", html: '<div class="haven-pin">🏁</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
  }).addTo(state.map).bindPopup("Start");
  state.destPin = L.marker([dest.lat, dest.lng], {
    icon: L.divIcon({ className: "", html: '<div class="haven-pin">📍</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
  }).addTo(state.map).bindPopup(`<b>${esc(dest.label)}</b>`);
  state.map.fitBounds(L.latLngBounds(points), { padding: [28, 28] });
}
function clearRoute() {
  [state.routeLine, state.originPin, state.destPin].forEach((l) => l && l.remove());
  state.routeLine = state.originPin = state.destPin = null;
}

function renderJourneyState() {
  const dot = $("stateDot");
  dot.className = "state-dot" + (state.journey ? " on" : "");
  $("statusTitle").textContent = state.journey ? "Protected" : "Protection off";
  $("statusSub").textContent = state.journey
    ? "Watching your route, speed and stops in real time"
    : "Plan a journey to switch on route watching";
  $("btnJourney").textContent = state.journey ? "End Journey" : "Start Journey";
  $("btnJourney").className = "btn grow " + (state.journey ? "btn-ghost" : "btn-primary");
}


function startTracking() {
  if (state.watchId !== null || !navigator.geolocation) return;
  state.origin = null; state.trailPts = []; state.lastMove = Date.now();
  if (state.trail) state.trail.setLatLngs([]);
  state.watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
    enableHighAccuracy: true, maximumAge: 2000, timeout: 15000,
  });
}
function stopTracking() {
  if (state.watchId !== null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
}
function onFixError() {
  toast("Location is off — open settings to enable it", "err");
}
function onFix(pos) {
  const here = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy: pos.coords.accuracy || 0,
  };
  if (pos.coords.speed != null && pos.coords.speed >= 0) state.speed = pos.coords.speed * 3.6;

  if (!state.origin) {
    state.origin = here;
    loadHavens(here);
    if (state.map && !state.trip) state.map.setView([here.lat, here.lng], 16);
  }
  state.here = here;

  state.trailPts.push([here.lat, here.lng]);
  if (state.trailPts.length > 400) state.trailPts.shift();
  if (state.me) state.me.setLatLng([here.lat, here.lng]);
  if (state.trail) state.trail.setLatLngs(state.trailPts);

  trackNow();
}

async function trackNow() {
  if (!state.journey || state.busy || !state.here) return;
  
  if (Date.now() - state.lastPush < (state.voice.active ? 3000 : 5000)) return;
  state.lastPush = Date.now();
  state.busy = true;

  const r = await api("/api/journey/track", {
    lat: state.here.lat,
    lng: state.here.lng,
    speed_kmh: Number((state.speed || 0).toFixed(1)),
    accuracy_m: state.here.accuracy || 0,
    ts: Date.now() / 1000,
  });
  state.busy = false;
  if (!r || r.error) return;

  renderTrip(r);
  const high = r.risk_score >= 75;
  setRisk(r.risk_score, high ? "Route anomaly" : "On route", r.factors.join(" · "));

  if (r.arrived) return onArrived();

  if (r.voice_mode_required) {
    startVoiceWatch(r.factors.join(" · "));
  } else if (high && !state.checkin.open && !state.voice.active && Date.now() > state.checkin.cooldown) {
    openCheckin(r.factors.join(" · "));
  }
}

function renderTrip(r) {
  if (!state.trip) return;
  state.trip.progress = r.progress;
  $("tripBar").style.width = Math.round(r.progress * 100) + "%";
  $("tripRemaining").textContent = r.remaining_m > 1000
    ? (r.remaining_m / 1000).toFixed(1) + " km to go"
    : r.remaining_m + " m to go";
  $("tripEta").textContent = r.arrived ? "Arrived" : "~" + r.eta_min + " min";

  const off = !!r.off_route;
  $("tripCard").classList.toggle("trip-off", off);
  $("tripStatus").textContent = off ? "Off route" : (r.stop_seconds > 90 ? "Stopped" : "On route");
  $("tripStatus").className = "chip " + (off ? "t2" : "live");

  const note = $("tripNote");
  if (r.factors && r.factors.length) {
    note.hidden = false;
    note.textContent = r.factors.join(" · ");
  }
}

async function onArrived() {
  if (!state.journey) return;
  await api("/api/end-journey", {});
  finishJourney();
  $("purgeSub").textContent = "Route erased on arrival";
  toast("You've arrived — route data erased", "ok");
}


const VOICE_KEYWORDS = ["bachao", "help", "madad", "save me", "बचाओ", "मदद", "हेल्प"];

function speak(text) {
  try {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "hi-IN";
    u.rate = 0.95;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (_) {  }
}


function primeVoicePermission() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || state.voice.primed) return;
  try {
    const rec = new SR();
    rec.lang = "hi-IN";
    rec.interimResults = false;
    rec.onend = () => { state.voice.primed = true; };
    rec.onerror = () => { state.voice.primed = true; };
    rec.start();
    setTimeout(() => { try { rec.abort(); } catch (_) {} }, 1200);
  } catch (_) {  }
}

function startVoiceWatch(reason) {
  if (state.voice.active || Date.now() < state.voice.cooldown) return;
  state.voice.active = true;
  state.voice.fired = false;
  $("voiceMode").hidden = false;
  $("voiceHint").textContent = reason ? reason.slice(0, 58) : "Say \u201cBachao\u201d or \u201cHelp\u201d";
  buzz([30, 60, 30]);

  speak("Kya aap safe hain? Madad ke liye Bachao bolein.");

  listenLoop();
  clearTimeout(state.voice.timer);
  state.voice.timer = setTimeout(() => {
    if (!state.voice.active) return;
    stopVoiceWatch();
    state.voice.cooldown = Date.now() + 60000;
    openCheckin("We couldn't hear you. Are you safe?");
  }, 18000);
}

function listenLoop() {
  if (!state.voice.active) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $("voiceHint").textContent = "Voice isn't available — tap SOS";
    return;
  }
  const rec = new SR();
  rec.lang = "hi-IN";
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (e) => {
    let said = "";
    for (let i = e.resultIndex; i < e.results.length; i++) said += e.results[i][0].transcript + " ";
    said = said.toLowerCase();
    if (VOICE_KEYWORDS.some((k) => said.includes(k))) {
      state.voice.fired = true;
      stopVoiceWatch();
      fireSos("Voice: " + said.trim().slice(0, 60), "voice");
    }
  };
  rec.onerror = (ev) => {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      $("voiceHint").textContent = "Microphone blocked — tap SOS";
    }
  };
  rec.onend = () => {
    if (state.voice.active && !state.voice.fired) setTimeout(() => { if (state.voice.active) listenLoop(); }, 350);
  };

  state.voice.rec = rec;
  try { rec.start(); } catch (_) {  }
}

function stopVoiceWatch() {
  state.voice.active = false;
  clearTimeout(state.voice.timer);
  state.voice.timer = null;
  if (state.voice.rec) {
    try { state.voice.rec.abort(); } catch (_) {  }
    state.voice.rec = null;
  }
  $("voiceMode").hidden = true;
  try { window.speechSynthesis && speechSynthesis.cancel(); } catch (_) {}
}

function setRisk(score, label, note) {
  state.risk = score;
  const arc = $("riskArc");
  const high = score >= 75, mid = score >= 45 && !high;
  const color = high ? "#ff375f" : mid ? "#ff9f0a" : "#30d158";
  arc.setAttribute("stroke", color);
  arc.setAttribute("stroke-dashoffset", String(289 * (1 - Math.min(score, 100) / 100)));
  $("riskNum").textContent = score;
  $("riskNum").style.color = high ? "#ff8098" : "#f5f5f7";
  $("riskLabel").textContent = label;
  $("riskNote").textContent = note || "Live telemetry starts with your journey.";
  document.querySelector(".risk-ring").style.filter = high
    ? "drop-shadow(0 0 22px rgba(255,55,95,.35))" : "none";
}


function initMap() {
  if (state.map || typeof L === "undefined") return;
  state.map = L.map("map", { zoomControl: false }).setView([FALLBACK.lat, FALLBACK.lng], 15);
  L.control.zoom({ position: "bottomright" }).addTo(state.map);
  state.tile = L.tileLayer("https:
    maxZoom: 19, attribution: "&copy; OpenStreetMap &copy; CARTO",
  }).addTo(state.map);

  state.me = L.marker([FALLBACK.lat, FALLBACK.lng], {
    icon: L.divIcon({ className: "", html: '<div class="you"><i></i></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
  }).addTo(state.map);

  state.trail = L.polyline([], { color: "#ff375f", weight: 4, opacity: .85 }).addTo(state.map);
  state.map.on("click", onMapPick);
  loadHavens(state.here || FALLBACK);
}

async function onMapPick(e) {
  if (!state.picking) return;
  state.picking = false;
  const place = { lat: e.latlng.lat, lng: e.latlng.lng, label: "Dropped pin" };
  $("planSheet").hidden = false;
  await chooseDestination(place);
}

async function loadHavens(at) {
  const data = await api(`/api/safe-havens?lat=${at.lat.toFixed(5)}&lng=${at.lng.toFixed(5)}`);
  if (!data || !data.all) return;
  state.havens = data.all;
  $("havenChip").textContent = `${data.nearest.length} nearby`;
  $("havenChip").className = "chip live";

  if (state.map) {
    state.havenPins.forEach((m) => m.remove());
    state.havenPins = data.all.map((h) => L.marker([h.lat, h.lng], {
      icon: L.divIcon({ className: "", html: `<div class="haven-pin">${HAVEN_ICON[h.type] || "📍"}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
    }).addTo(state.map).bindPopup(
      `<b>${esc(h.name)}</b><br><span style="color:rgba(235,235,245,.6)">${esc(h.type)} · ${(h.distance_m / 1000).toFixed(2)} km · ~${h.eta_min} min walk</span><br><a href="tel:${esc(h.phone)}" style="color:#ff375f">Call ${esc(h.phone)}</a>`
    ));
  }

  $("havenList").innerHTML = data.nearest.map((h) => `
    <li>
      <div class="ic">${HAVEN_ICON[h.type] || "📍"}</div>
      <div class="grow">
        <p class="li-title">${esc(h.name)}</p>
        <p class="li-sub">${esc(h.type)} · ~${h.eta_min} min walk</p>
      </div>
      <a class="chip" href="tel:${esc(h.phone)}" style="text-decoration:none">${(h.distance_m / 1000).toFixed(2)} km</a>
    </li>`).join("");
}


let holdTimer = null, holdStart = 0;

function renderSosRing(progress) {
  $("sosRing").setAttribute("stroke-dashoffset", String(534 * (1 - progress)));
}
$("btnSos").addEventListener("pointerdown", () => {
  holdStart = Date.now();
  buzz(18);
  holdTimer = setInterval(() => {
    const p = Math.min(1, (Date.now() - holdStart) / 3000);
    renderSosRing(p);
    if (p >= 1) { clearInterval(holdTimer); holdTimer = null; fireSos("Long-press trigger", "hold"); }
  }, 40);
});
$("btnSos").addEventListener("pointerup", () => {
  const held = Date.now() - holdStart;
  if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
  renderSosRing(0);
  if (holdStart && held < 3000) fireSos("SOS button", "tap");
  holdStart = 0;
});

["pointercancel", "pointerleave"].forEach((evt) =>
  $("btnSos").addEventListener(evt, () => {
    if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
    renderSosRing(0);
    holdStart = 0;
  })
);

async function fireSos(reason, source) {
  buzz([40, 60, 40, 60, 180]);
  const c = await coords();
  const body = { trigger_type: reason, language: "Hindi", source: source || "manual" };
  if (c) { body.lat = c.lat; body.lng = c.lng; }

  const r = await api("/api/trigger-sos", body);
  if (!r) return toast("Couldn't reach the safety server — call 112 directly", "err");

  state.links = r;
  if (r.coordinates) {
    state.here = r.coordinates;
    if (state.me) state.me.setLatLng([r.coordinates.lat, r.coordinates.lng]);
  }
  $("sosMessage").textContent = r.ai_message || "Emergency alert prepared.";
  $("sosPanelTitle").textContent = "Emergency alert ready to send";
  $("sosPanel").hidden = false;
  $("escalationActions").hidden = false;
  $("sosPanel").scrollIntoView({ behavior: "smooth", block: "center" });
  setTier("Tier 1 · guardians alerted", "t1");
  startSiren(); startStrobe();
  $("alarmLabel").textContent = "Alarm active";
  $("alarmSub").textContent = "Tap to stop";
  $("btnAlarm").classList.add("on");

  state.sos.active = true;
  state.sos.acknowledged = false;
  state.sos.dispatchDone = false;
  scheduleAutoEscalation();
}


function scheduleAutoEscalation() {
  clearTimeout(state.sos.timer);
  state.sos.timer = setTimeout(async () => {
    if (!state.sos.active || state.sos.acknowledged || state.sos.dispatchDone) return;
    const r = await api("/api/escalate-tier2", {});
    if (r && r.status === "ESCALATED_TIER_2") {
      showDispatch(r.dispatched_to, r.reason);
      startSiren(); startStrobe();
      toast("No guardian response — police dispatch triggered", "err");
    }
  }, 45000);
}

$("btnSms").addEventListener("click", () => {
  if (!state.links.sms_link) return toast("No guardian number on file");
  location.href = state.links.sms_link;
});
$("btnWhatsapp").addEventListener("click", () => {
  if (!state.links.whatsapp_link) return toast("No guardian number on file");
  window.open(state.links.whatsapp_link, "_blank", "noopener");
});
$("btnCall112").addEventListener("click", () => { location.href = "tel:112"; });
$("btnCallGuardian").addEventListener("click", () => {
  if (!state.guardianPhone) return toast("No guardian number on file");
  location.href = "tel:" + state.guardianPhone;
});
$("btnStopAlarm").addEventListener("click", () => {
  resetAlarm();
  toast("Alarm stopped");
});

function resetAlarm() {
  stopSiren(); stopStrobe();
  if (state.audio.ctx) {  }
  $("alarmLabel").textContent = "Siren & strobe";
  $("alarmSub").textContent = "Off";
  $("btnAlarm").classList.remove("on");
}

function setTier(text, kind) {
  const chip = $("tierChip");
  chip.textContent = text;
  chip.className = "chip" + (kind ? " " + kind : "");
}


$("btnAck").addEventListener("click", async () => {
  const r = await api("/api/acknowledge-sos", {});
  if (!r || r.status !== "ACKNOWLEDGED") return toast("Nothing to acknowledge");
  state.sos.acknowledged = true;
  clearTimeout(state.sos.timer);
  resetAlarm();
  setTier("Tier 1 · acknowledged", "t1");
  $("escalationActions").hidden = true;
  $("dispatchNote").hidden = false;
  $("dispatchNote").textContent = "Your guardians confirmed the alert. Escalation is on hold.";
  toast("Guardian acknowledged", "ok");
});

$("btnDispatch").addEventListener("click", async () => {
  const r = await api("/api/escalate-tier2", {});
  if (!r) return toast("Couldn't reach the server");
  if (r.status === "ALREADY_ACKNOWLEDGED_BY_FAMILY")
    return toast("Your family already acknowledged this alert");
  if (r.status !== "ESCALATED_TIER_2") return toast("Trigger an SOS first");
  showDispatch(r.dispatched_to, r.reason);
  startSiren(); startStrobe();
});

function showDispatch(units, reason) {
  state.sos.dispatchDone = true;
  setTier("Tier 2 · dispatched", "t2");
  $("escalationActions").hidden = true;
  const note = $("dispatchNote");
  note.hidden = false;
  note.innerHTML = `<b style="color:#ffb3c4">Police and campus security dispatched.</b><br>` +
    (units || []).map((u) => `· ${esc(u)}`).join("<br>") +
    (reason ? `<br><span style="color:var(--label3)">Reason: ${esc(reason)}</span>` : "");
}


const CD_CIRC = 308;
async function openCheckin(reason) {
  const r = await api("/api/checkin/start", { reason, risk_score: state.risk });
  if (!r || r.error) return;
  state.checkin.open = true;

  const windowSec = r.window_seconds || 30;
  const deadline = Date.now() + windowSec * 1000;
  $("cdReason").textContent = reason || "A movement anomaly was detected on your route.";
  $("checkin").hidden = false;
  chime();
  buzz([30, 80, 30]);

  const tick = () => {
    const left = Math.max(0, (deadline - Date.now()) / 1000);
    $("cdNum").textContent = Math.ceil(left);
    $("cdArc").setAttribute("stroke-dashoffset", String(CD_CIRC * (1 - left / windowSec)));
    if (left <= 0) { endCheckin(); checkinTimeout(); }
  };
  tick();
  state.checkin.timer = setInterval(tick, 200);
}
function endCheckin(silent) {
  if (state.checkin.timer) { clearInterval(state.checkin.timer); state.checkin.timer = null; }
  state.checkin.open = false;
  $("checkin").hidden = true;
  $("cdArc").setAttribute("stroke-dashoffset", "0");
  if (!silent) return;
}
async function checkinTimeout() {
  state.checkin.cooldown = Date.now() + 120000;
  const r = await api("/api/checkin/timeout", {});
  buzz([60, 80, 60, 80, 240]);
  if (r && r.status === "ESCALATED_TIER_2") {
    showDispatch(r.dispatched_to, r.reason);
    startSiren(); startStrobe();
    $("btnAlarm").classList.add("on");
    $("alarmLabel").textContent = "Alarm active";
    $("alarmSub").textContent = "Tap to stop";
    toast("No response — police dispatch triggered", "err");
  } else {
    toast("No response to the check-in", "err");
  }
}
$("btnSafe").addEventListener("click", async () => {
  endCheckin();
  const r = await api("/api/checkin/resolve", { safe: true });
  if (r) {
    setRisk(Math.max(0, state.risk - 40), "All clear", "Thanks — escalation was cancelled.");
    setTier("Active monitoring", "live");
    toast("Marked safe", "ok");
  }
});
$("btnUnsafe").addEventListener("click", async () => {
  endCheckin();
  const r = await api("/api/checkin/resolve", { safe: false });
  buzz([60, 80, 60, 80, 240]);
  if (r && r.status === "ESCALATED_TIER_2") {
    showDispatch(r.dispatched_to, r.reason);
    startSiren(); startStrobe();
    toast("Help is being dispatched", "err");
  } else {
    toast("Couldn't reach the server — call 112", "err");
  }
});


$("btnAlarm").addEventListener("click", () => {
  if (state.audio.siren || state.strobe) {
    resetAlarm(); toast("Alarm stopped");
  } else {
    startSiren(); startStrobe();
    $("alarmLabel").textContent = "Alarm active";
    $("alarmSub").textContent = "Tap to stop";
    $("btnAlarm").classList.add("on");
    buzz([40, 60, 40]);
  }
});

$("btnVoice").addEventListener("click", () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("Voice isn't supported in this browser", "err");
  const rec = new SR();
  rec.lang = "hi-IN";
  rec.onstart = () => { toast("Listening… say “help” or “bachao”"); buzz(15); };
  rec.onresult = async (e) => {
    const said = e.results[0][0].transcript.toLowerCase();
    const hit = ["help", "bachao", "madad", "बचाओ", "मदद", "हेल्प"].some((k) => said.includes(k));
    if (hit) { await fireSos("Voice trigger: " + said, "voice"); if (state.guardianPhone) location.href = "tel:" + state.guardianPhone; }
    else toast("Heard: “" + said + "”");
  };
  rec.onerror = () => toast("Couldn't hear that — try again", "err");
  rec.start();
});

$("btnShake").addEventListener("click", async () => {
  if (state.shake) {
    window.removeEventListener("devicemotion", onMotion);
    state.shake = false;
    $("shakeSub").textContent = "Off";
    $("btnShake").classList.remove("on");
    return;
  }
  try {
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      const p = await DeviceMotionEvent.requestPermission();
      if (p !== "granted") return toast("Motion access was denied", "err");
    }
    window.addEventListener("devicemotion", onMotion);
    state.shake = true;
    $("shakeSub").textContent = "Armed";
    $("btnShake").classList.add("on");
    buzz(15);
  } catch (_) {
    toast("Shake detection isn't available here", "err");
  }
});
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  if (Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2) < 26) return;
  const now = Date.now();
  state.shakeHits.push(now);
  state.shakeHits = state.shakeHits.filter((t) => now - t < 1500);
  if (state.shakeHits.length >= 3) {
    state.shakeHits = [];
    fireSos("Shake detected", "shake");
  }
}


function ringtone(on) {
  if (state.call.ring) { clearInterval(state.call.ring); state.call.ring = null; }
  if (state.call.vibrate) { clearInterval(state.call.vibrate); state.call.vibrate = null; }
  if (!on) return;
  const play = () => {
    const ac = ctx();
    if (!ac) return;
    [1046, 784].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sine"; o.frequency.value = f;
      const at = ac.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.12, at + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      o.connect(g); g.connect(ac.destination);
      o.start(at); o.stop(at + 0.24);
    });
  };
  play();
  state.call.ring = setInterval(play, 1900);
  const vib = () => buzz([500, 400, 500]);
  vib();
  state.call.vibrate = setInterval(vib, 2200);
}
$("btnFakeCall").addEventListener("click", () => {
  state.call.connected = false;
  $("fcStatus").textContent = "Incoming call…";
  $("fcAcceptLabel").textContent = "Accept";
  $("fcAccept").classList.remove("alt");
  $("fakeCall").hidden = false;
  ringtone(true);
});
$("fcDecline").addEventListener("click", () => {
  ringtone(false);
  $("fakeCall").hidden = true;
  toast("Call declined");
});
$("fcAccept").addEventListener("click", () => {
  if (state.call.connected) {
    ringtone(false);
    if (state.call.tick) { clearInterval(state.call.tick); state.call.tick = null; }
    $("fakeCall").hidden = true;
    state.call.connected = false;
    toast("Call ended");
    return;
  }
  state.call.connected = true;
  ringtone(false);
  const started = Date.now();
  $("fcStatus").textContent = "00:00";
  $("fcAcceptLabel").textContent = "End";
  $("fcAccept").classList.add("alt");
  state.call.tick = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    $("fcStatus").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 1000);
});


const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];
let pin = "";
function buildKeypad() {
  $("keypad").innerHTML = KEYS.map((k) => k === ""
    ? '<span></span>'
    : `<button class="key${k === "⌫" ? " fn" : ""}" data-key="${k}">${k}</button>`).join("");
  $("keypad").querySelectorAll("[data-key]").forEach((b) =>
    b.addEventListener("click", () => pressKey(b.dataset.key)));
}
function paintDots() {
  $("pinDots").innerHTML = Array.from({ length: Math.max(6, pin.length) })
    .map((_, i) => `<span class="${i < pin.length ? "f" : ""}"></span>`).join("");
  $("btnUnlock").disabled = pin.length < 4;
}
function pressKey(k) {
  buzz(6);
  if (k === "⌫") pin = pin.slice(0, -1);
  else if (pin.length < 8) pin += k;
  paintDots();
}
function openLock() {
  pin = "";
  $("lockErr").hidden = true;
  paintDots();
  $("lockScreen").hidden = false;
}
$("btnLock").addEventListener("click", openLock);
$("btnLock2").addEventListener("click", openLock);
$("btnLockCancel").addEventListener("click", () => { $("lockScreen").hidden = true; pin = ""; });

$("btnUnlock").addEventListener("click", async () => {
  if (pin.length < 4) return;
  const c = await coords();
  const body = { pin };
  if (c) { body.lat = c.lat; body.lng = c.lng; }
  const r = await api("/api/verify-pin", body);

  if (!r || r.error) {
    $("lockErr").textContent = (r && r.error) || "Server unreachable — try again.";
    $("lockErr").hidden = false;
    return;
  }
  if (r.mode === "invalid" || r.mode === "locked") {
    $("lockErr").textContent = r.message + (r.attempts_left != null ? ` (${r.attempts_left} tries left)` : "");
    $("lockErr").hidden = false;
    $("pinDots").classList.add("shake");
    setTimeout(() => $("pinDots").classList.remove("shake"), 460);
    buzz([80, 60, 80]);
    pin = "";
    paintDots();
    return;
  }

  
  $("lockScreen").hidden = true;
  pin = "";
  disarm();
  if (r.duress) startCovert(r.silent);
});

function disarm() {
  stopTracking();
  stopVoiceWatch();
  resetAlarm();
  endCheckin(true);
  state.journey = false;
  state.trip = null;
  state.risk = 0;
  state.sos.active = false;
  $("tripCard").hidden = true;
  clearRoute();
  setRisk(0, "All clear", "Monitoring is off. Start a journey whenever you head out.");
  renderJourneyState();
  setTier("Standby");
  $("escalationActions").hidden = true;
  $("sosPanel").hidden = true;
  state.dispatch = [];
}


function startCovert(payload) {
  state.covert.armed = true;
  state.covert.payload = payload || null;
  $("decoy").hidden = false;
  buzz([20, 120, 20]);

  const delay = ((payload && payload.escalate_after_seconds) || 20) * 1000;
  if (state.covert.timer) clearTimeout(state.covert.timer);
  state.covert.timer = setTimeout(async () => {
    await api("/api/covert/escalate", {});
    state.covert.timer = null;
  }, delay);
}
function leaveDecoy() {
  $("decoy").hidden = true;
  state.covert.armed = false;
  state.covert.payload = null;
}

(function decoyExit() {
  let t = null;
  $("dcTemp").addEventListener("pointerdown", () => { t = setTimeout(leaveDecoy, 2000); });
  ["pointerup", "pointerleave", "pointercancel"].forEach((e) =>
    $("dcTemp").addEventListener(e, () => { if (t) { clearTimeout(t); t = null; } }));
})();


buildKeypad();
paintDots();
renderJourneyState();
setRisk(0, "All clear", "Live telemetry starts with your journey.");

(async function boot() {
  const h = await api("/api/health");
  const pill = $("connPill");
  if (h && h.status === "ok") {
    pill.classList.add("ok");
    $("connText").textContent = "Live";
  } else {
    pill.classList.add("bad");
    $("connText").textContent = "Offline";
  }
})();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
