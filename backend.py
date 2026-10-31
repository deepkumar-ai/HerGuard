from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import numpy as np
from sklearn.ensemble import IsolationForest
import urllib.parse
import urllib.request
import json
import hashlib
import hmac
import secrets
import math
import time
import os

try:
    from groq import Groq
    GROQ_AVAILABLE = True
except ImportError:
    GROQ_AVAILABLE = False

app = FastAPI(title="HER GUARD - Smart Safety Net Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PBKDF2_ITERATIONS = 120_000
CHECKIN_WINDOW_SECONDS = 30
COVERT_ESCALATION_SECONDS = 20
MAX_LOG_LINES = 200
MAX_TRAIL_POINTS = 120
SAFE_HAVEN_LIMIT = 6

# Journey intelligence tuning
OFF_ROUTE_M = 200          # beyond this the user is considered off the planned route
OFF_ROUTE_GRACE_S = 45     # sustained off-route time before it counts as an emergency
STOP_ALERT_S = 150         # unplanned stop that starts looking wrong
ARRIVAL_M = 120            # distance at which the destination counts as reached
VOICE_RISK_THRESHOLD = 70  # risk at which the app opens voice mode on its own
ROUTING_USER_AGENT = "HERGUARD-SafetyApp/2.0 (local prototype)"

SESSION = {
    "user_registered": False,
    "user_profile": {},
    "pin_hash": "",
    "duress_pin_hash": "",
    "pin_failed_attempts": 0,
    "journey_active": False,
    "status": "Awaiting User Registration",
    "risk_score": 0,
    "sos_active": False,
    "tier1_acknowledged": False,
    "current_tier": "Standby",
    "last_coords": {"lat": 28.2455, "lng": 77.0690},
    "trail": [],
    "covert": False,
    "covert_deadline": 0.0,
    "checkin": {
        "active": False,
        "prompt_id": 0,
        "deadline": 0.0,
        "reason": "",
        "resolved": True,
    },
    "dispatch": [],
    "journey": {
        "origin": None,
        "destination": None,
        "route": None,          # {points, distance_m, duration_s, source, cumulative}
        "started_at": 0.0,
        "last_pos": None,
        "last_moved_at": 0.0,
        "progress": 0.0,
        "max_deviation_m": 0.0,
        "off_route_since": None,
        "voice_armed": False,
        "arrived": False,
    },
    "logs": [],
    "covert_log": [],
}


# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #
def datetime_now() -> str:
    return time.strftime("%H:%M:%S")


def log_event(msg: str, covert: bool = False):
    """Append an audit line.

    Covert lines go to a private buffer that never reaches the client session
    payload, so someone holding the phone cannot read that a duress code was
    used or that a silent dispatch left the device.
    """
    line = f"[{datetime_now()}] {msg}"
    if covert:
        SESSION["covert_log"].insert(0, line)
        del SESSION["covert_log"][50:]
        return
    SESSION["logs"].insert(0, line)
    del SESSION["logs"][MAX_LOG_LINES:]


# --------------------------------------------------------------------------- #
# PIN handling
# --------------------------------------------------------------------------- #
def hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_pin(pin: str, stored: str) -> bool:
    if not stored or not pin:
        return False
    try:
        algorithm, iterations, salt_hex, digest_hex = stored.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac(
            "sha256", pin.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
        return hmac.compare_digest(expected, actual)
    except (ValueError, TypeError):
        return False


def valid_pin(pin: str) -> bool:
    return pin.isdigit() and 4 <= len(pin) <= 8


# --------------------------------------------------------------------------- #
# Geo helpers
# --------------------------------------------------------------------------- #
def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lng2 - lng1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


# Demo dataset: verified safe zones seeded around the default (Delhi NCR) origin.
SAFE_HAVENS = [
    {"id": "campus-qrt", "name": "Campus Security Control Room", "type": "Campus QRT",
     "lat": 28.2468, "lng": 77.0712, "phone": "01126961000", "note": "24x7 armed quick reaction team"},
    {"id": "pcr-helpdesk", "name": "Police PCR Helpdesk", "type": "Police",
     "lat": 28.2412, "lng": 77.0648, "phone": "112", "note": "Nearest PCR van · 800m patrol radius"},
    {"id": "metro-gate2", "name": "Metro Station — Gate 2", "type": "Metro",
     "lat": 28.2501, "lng": 77.0735, "phone": "155370", "note": "CCTV covered · staffed till last train"},
    {"id": "pharmacy-24x7", "name": "24x7 Pharmacy — Main Market", "type": "Pharmacy",
     "lat": 28.2398, "lng": 77.0751, "phone": "01145678890", "note": "Open 24x7 · well-lit frontage"},
    {"id": "women-helpdesk", "name": "Women's Help Desk — Sector 12", "type": "Help Desk",
     "lat": 28.2479, "lng": 77.0602, "phone": "181", "note": "Trained counsellor on duty"},
    {"id": "hospital-er", "name": "City Hospital — Emergency Gate", "type": "Hospital",
     "lat": 28.2522, "lng": 77.0661, "phone": "108", "note": "ER + ambulance bay"},
]

# --------------------------------------------------------------------------- #
# ML risk engine
# --------------------------------------------------------------------------- #
# Normal commute envelope: deviation (m), stop duration (s), transit speed (km/h)
normal_commute_data = np.array([
    [10, 0, 18], [25, 15, 15], [5, 0, 20], [40, 30, 12],
    [15, 5, 16], [30, 20, 14], [20, 10, 19], [35, 25, 15]
])
ml_model = IsolationForest(contamination=0.1, random_state=42)
ml_model.fit(normal_commute_data)


def compute_risk(deviation_m: float, stop_s: float, speed_kmh: float, late_night: bool):
    deviation_score = min(45.0, (deviation_m / 500.0) * 45.0)
    stop_score = min(35.0, (stop_s / 180.0) * 35.0)
    night_score = 20.0 if late_night else 5.0
    loiter_score = 8.0 if (speed_kmh < 3 and stop_s > 60) else 0.0

    total = int(min(98, deviation_score + stop_score + night_score + loiter_score))

    features = np.array([[deviation_m, stop_s, speed_kmh]])
    anomaly = int(ml_model.predict(features)[0]) == -1
    # The model is trained on moving commutes, so a red light also looks anomalous.
    # Only let it force a critical score when something concrete corroborates it.
    corroborated = deviation_m >= 50 or stop_s >= 90
    if anomaly and corroborated and total < 75:
        total = 79

    factors = []
    if deviation_score > 0:
        factors.append(f"Route deviation {deviation_m:.0f}m")
    if stop_score > 0:
        factors.append(f"Stationary {stop_s:.0f}s")
    factors.append("Late-night window" if late_night else "Daylight window")
    if loiter_score:
        factors.append("Loitering at near-zero speed")

    return total, anomaly, " · ".join(factors)


# --------------------------------------------------------------------------- #
# Journey planning & route intelligence
# --------------------------------------------------------------------------- #
def _xy(lat: float, lng: float, lat0: float, lng0: float):
    m_per_deg_lat = 111_320.0
    m_per_deg_lng = 111_320.0 * math.cos(math.radians(lat0))
    return ((lng - lng0) * m_per_deg_lng, (lat - lat0) * m_per_deg_lat)


def segment_metrics(lat: float, lng: float, a, b, lat0: float, lng0: float):
    """Perpendicular distance to segment a-b (metres) and the fraction along it."""
    px, py = _xy(lat, lng, lat0, lng0)
    ax, ay = _xy(a[0], a[1], lat0, lng0)
    bx, by = _xy(b[0], b[1], lat0, lng0)
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - ax, py - ay), 0.0
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy), t


def cumulative_distances(points):
    cum = [0.0]
    for i in range(1, len(points)):
        cum.append(cum[-1] + haversine_m(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]))
    return cum


def fetch_osrm_route(origin: dict, destination: dict):
    coords = f"{origin['lng']},{origin['lat']};{destination['lng']},{destination['lat']}"
    url = (f"https://router.project-osrm.org/route/v1/driving/{coords}"
           "?overview=simplified&geometries=geojson")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": ROUTING_USER_AGENT})
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.load(resp)
        route = data["routes"][0]
        points = [(lat, lng) for lng, lat in route["geometry"]["coordinates"]]
        if len(points) < 2:
            return None
        return {
            "points": points,
            "distance_m": float(route["distance"]),
            "duration_s": float(route["duration"]),
            "source": "osrm",
        }
    except Exception as exc:
        # Offline or rate limited: the straight-line corridor still gives a
        # usable deviation baseline instead of failing the whole journey.
        log_event(f"Route service unavailable ({type(exc).__name__}); using straight-line corridor.")
        return None


def build_route(origin: dict, destination: dict) -> dict:
    route = fetch_osrm_route(origin, destination)
    if route is None:
        distance = haversine_m(origin["lat"], origin["lng"], destination["lat"], destination["lng"])
        route = {
            "points": [(origin["lat"], origin["lng"]), (destination["lat"], destination["lng"])],
            "distance_m": distance,
            "duration_s": distance / 6.9,  # ~25 km/h city average
            "source": "straight-line",
        }
    route["cumulative"] = cumulative_distances(route["points"])
    return route


def route_metrics(lat: float, lng: float, route: dict):
    """Nearest distance to the planned route and how far along it we are."""
    points, cum = route["points"], route["cumulative"]
    best_dist, best_t, best_idx = float("inf"), 0.0, 0
    for i in range(len(points) - 1):
        d, t = segment_metrics(lat, lng, points[i], points[i + 1], lat, lng)
        if d < best_dist:
            best_dist, best_t, best_idx = d, t, i
    seg_len = cum[best_idx + 1] - cum[best_idx]
    travelled = cum[best_idx] + best_t * seg_len
    total = cum[-1] or 1.0
    return best_dist, max(0.0, min(1.0, travelled / total)), travelled


# --------------------------------------------------------------------------- #
# Session projection
# --------------------------------------------------------------------------- #
def public_session() -> dict:
    """Client-safe view: no PIN digests, no covert audit lines."""
    view = {k: v for k, v in SESSION.items() if k not in ("pin_hash", "duress_pin_hash", "covert_log")}
    view["logs"] = list(SESSION["logs"][:60])
    view["pin_configured"] = bool(SESSION["pin_hash"])
    view["covert_armed"] = SESSION["covert"]
    view["checkin"] = dict(SESSION["checkin"])
    # Route geometry is large and already delivered by /api/start-journey.
    view["journey"] = {k: v for k, v in SESSION["journey"].items() if k != "route"}
    return view


# --------------------------------------------------------------------------- #
# Alert composition
# --------------------------------------------------------------------------- #
def wa_number(phone: str) -> str:
    digits = "".join(ch for ch in phone if ch.isdigit())
    if len(digits) == 10:
        return "91" + digits
    return digits


def compose_alert(trigger: str, language: str, lat: float, lng: float,
                  guardian_name: str, user_name: str) -> str:
    maps_link = f"https://www.google.com/maps?q={lat},{lng}"
    fallback = (
        f"🚨 SOS from {user_name}! Trigger: {trigger}. "
        f"Risk: {SESSION['risk_score']}%. GPS: {maps_link} Please help immediately!"
    )

    groq_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not groq_key or not GROQ_AVAILABLE:
        return fallback

    try:
        client = Groq(api_key=groq_key, timeout=5.0)
        prompt = (
            f"Write a short, ultra-urgent SMS emergency alert in {language} for {guardian_name} "
            f"from {user_name}. Trigger: {trigger}. GPS: {maps_link}. "
            "Keep it under 160 characters, no emojis except one at the start."
        )
        res = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=90,
        )
        text = (res.choices[0].message.content or "").strip()
        return text or fallback
    except Exception as exc:  # network, quota and model errors all degrade to the fallback
        log_event(f"Groq error: {exc}")
        return fallback


def dispatch_links(message: str, lat: float, lng: float) -> dict:
    profile = SESSION.get("user_profile", {})
    g1_phone = profile.get("guardian_1_phone", "")
    g2_phone = profile.get("guardian_2_phone", "")
    body = urllib.parse.quote(message)
    maps_link = f"https://www.google.com/maps?q={lat},{lng}"
    return {
        "sms_link": f"sms:{g1_phone}?body={body}" if g1_phone else f"sms:?body={body}",
        "sms_link_guardian_2": f"sms:{g2_phone}?body={body}" if g2_phone else "",
        "whatsapp_link": f"https://wa.me/{wa_number(g1_phone)}?text={body}" if g1_phone else "",
        "maps_link": maps_link,
    }


def escalate_to_tier2(reason: str, covert: bool = False) -> dict:
    profile = SESSION.get("user_profile", {})
    coords = SESSION.get("last_coords") or {"lat": 28.2455, "lng": 77.0690}
    dispatched = [
        "Police PCR (112) — control room",
        "Campus Security QRT",
        f"Guardian 1: {profile.get('guardian_1_name', 'Guardian')}",
    ]
    if profile.get("guardian_2_phone"):
        dispatched.append(f"Guardian 2: {profile.get('guardian_2_name', 'Guardian')}")

    SESSION["sos_active"] = True
    SESSION["current_tier"] = "Tier 2: PCR 112 & Campus QRT Dispatched"
    SESSION["dispatch"] = dispatched
    # A covert escalation must not leave a readable trace in the client audit log.
    log_event(
        f"🚔 Tier-2 dispatch ({reason}) → {len(dispatched)} units at "
        f"{coords['lat']:.4f},{coords['lng']:.4f}",
        covert=covert,
    )
    return {
        "status": "ESCALATED_TIER_2",
        "reason": reason,
        "dispatched_to": dispatched,
        "coordinates": coords,
        "session": public_session(),
    }


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #
class UserRegistration(BaseModel):
    name: str
    phone: str
    guardian_1_name: str
    guardian_1_phone: str
    guardian_2_name: str = ""
    guardian_2_phone: str = ""
    pin: str = "1234"
    duress_pin: str = "9110"


class TelemetryInput(BaseModel):
    deviation_meters: float
    stop_seconds: float
    speed_kmh: float
    is_late_night: bool = True


class SOSInput(BaseModel):
    trigger_type: str = "Voice Code / Emergency"
    language: str = "Hindi"
    lat: float = 28.2455
    lng: float = 77.0690
    source: str = "manual"


class PinInput(BaseModel):
    pin: str
    lat: float = 28.2455
    lng: float = 77.0690


class CheckInStart(BaseModel):
    reason: str = "Critical anomaly detected"
    risk_score: int = 0


class CheckInResolve(BaseModel):
    safe: bool = True


class Waypoint(BaseModel):
    lat: float
    lng: float
    label: str = ""


class JourneyPlan(BaseModel):
    origin: Waypoint
    destination: Waypoint


class StartJourneyReq(BaseModel):
    origin: Waypoint | None = None
    destination: Waypoint | None = None
    language: str = "Hindi"


class TrackSample(BaseModel):
    lat: float
    lng: float
    speed_kmh: float = 0.0
    accuracy_m: float = 0.0
    ts: float = 0.0


# --------------------------------------------------------------------------- #
# Static shell
# --------------------------------------------------------------------------- #
@app.get("/")
def serve_frontend():
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return {"status": "HER GUARD Backend is running!", "session": public_session()}


@app.get("/manifest.webmanifest")
def serve_manifest():
    if os.path.exists("manifest.webmanifest"):
        return FileResponse("manifest.webmanifest", media_type="application/manifest+json")
    return {"error": "manifest missing"}


@app.get("/sw.js")
def serve_service_worker():
    if os.path.exists("sw.js"):
        return FileResponse("sw.js", media_type="application/javascript")
    return {"error": "service worker missing"}


@app.get("/icon-{size}.png")
def serve_icon(size: int):
    path = f"icon-{size}.png"
    if os.path.exists(path):
        return FileResponse(path, media_type="image/png")
    return {"error": "icon missing"}


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "groq_available": bool(GROQ_AVAILABLE and os.environ.get("GROQ_API_KEY", "").strip()),
        "checkin_window_seconds": CHECKIN_WINDOW_SECONDS,
    }


@app.get("/api/state")
def state():
    return {"session": public_session()}


# --------------------------------------------------------------------------- #
# Onboarding
# --------------------------------------------------------------------------- #
@app.post("/api/register-user")
def register_user(user: UserRegistration):
    name = user.name.strip()
    phone = user.phone.strip()

    if not name or not phone:
        return {"error": "Name and phone number are required."}
    if not valid_pin(user.pin):
        return {"error": "Safety PIN must be 4-8 digits."}
    if not valid_pin(user.duress_pin):
        return {"error": "Duress PIN must be 4-8 digits."}
    if user.pin == user.duress_pin:
        return {"error": "Duress PIN must differ from your safety PIN."}

    SESSION["user_registered"] = True
    SESSION["user_profile"] = {
        "name": name,
        "phone": phone,
        "guardian_1_name": user.guardian_1_name.strip(),
        "guardian_1_phone": user.guardian_1_phone.strip(),
        "guardian_2_name": user.guardian_2_name.strip(),
        "guardian_2_phone": user.guardian_2_phone.strip(),
    }
    # Only the PBKDF2 digest is retained, in memory. Nothing is written to disk.
    SESSION["pin_hash"] = hash_pin(user.pin)
    SESSION["duress_pin_hash"] = hash_pin(user.duress_pin)
    SESSION["pin_failed_attempts"] = 0
    SESSION["current_tier"] = "Standby (Registered)"
    SESSION["status"] = "Registered"
    log_event(f"👤 Profile saved for {name}. 2 guardians enrolled. PINs stored as PBKDF2 digests.")
    return {"message": "Registration successful", "session": public_session()}


# --------------------------------------------------------------------------- #
# Journey lifecycle
# --------------------------------------------------------------------------- #
def reset_checkin():
    SESSION["checkin"] = {
        "active": False,
        "prompt_id": SESSION["checkin"]["prompt_id"],
        "deadline": 0.0,
        "reason": "",
        "resolved": True,
    }


def disarm_session():
    """Visibly stop monitoring and drop location state. Used by End Journey and PIN unlock."""
    SESSION["journey_active"] = False
    SESSION["sos_active"] = False
    SESSION["risk_score"] = 0
    SESSION["dispatch"] = []
    SESSION["covert"] = False
    SESSION["covert_deadline"] = 0.0
    reset_checkin()
    # Privacy-first: coordinates and route history are dropped, not archived.
    SESSION["last_coords"] = {"lat": 28.2455, "lng": 77.0690}
    SESSION["trail"] = []
    SESSION["current_tier"] = "Privacy Mode ON (Data Purged)"


@app.post("/api/start-journey")
def start_journey(req: StartJourneyReq | None = None):
    if not SESSION["user_registered"]:
        return {"error": "Please register your profile first!"}

    destination = req.destination if req else None
    if destination is None:
        return {"error": "Choose a destination to start the journey."}

    origin = (req.origin if req and req.origin else None)
    if origin is None:
        origin = Waypoint(lat=SESSION["last_coords"]["lat"],
                          lng=SESSION["last_coords"]["lng"], label="Current location")

    o = {"lat": origin.lat, "lng": origin.lng, "label": origin.label or "Start"}
    d = {"lat": destination.lat, "lng": destination.lng,
         "label": destination.label or "Destination"}
    route = build_route(o, d)

    SESSION["journey_active"] = True
    SESSION["sos_active"] = False
    SESSION["tier1_acknowledged"] = False
    SESSION["covert"] = False
    SESSION["covert_deadline"] = 0.0
    SESSION["risk_score"] = 0
    SESSION["trail"] = []
    SESSION["dispatch"] = []
    reset_checkin()
    SESSION["current_tier"] = "Active Monitoring"
    SESSION["last_coords"] = {"lat": o["lat"], "lng": o["lng"]}

    SESSION["journey"] = {
        "origin": o,
        "destination": d,
        "route": route,
        "started_at": time.time(),
        "last_pos": None,
        "last_moved_at": time.time(),
        "progress": 0.0,
        "max_deviation_m": 0.0,
        "off_route_since": None,
        "voice_armed": False,
        "arrived": False,
    }

    name = SESSION["user_profile"].get("name", "User")
    log_event(
        f"Journey planned for {name}: {o['label']} → {d['label']} · "
        f"{route['distance_m'] / 1000:.1f} km via {route['source']}. Voice watch armed on anomalies."
    )
    return {
        "message": "Journey started",
        "origin": o,
        "destination": d,
        "distance_m": round(route["distance_m"]),
        "duration_s": round(route["duration_s"]),
        "route_source": route["source"],
        "route": [[round(lat, 6), round(lng, 6)] for lat, lng in route["points"]],
        "session": public_session(),
    }


@app.post("/api/end-journey")
def end_journey():
    disarm_session()
    SESSION["journey"] = {
        "origin": None, "destination": None, "route": None, "started_at": 0.0,
        "last_pos": None, "last_moved_at": 0.0, "progress": 0.0,
        "max_deviation_m": 0.0, "off_route_since": None, "voice_armed": False,
        "arrived": False,
    }
    log_event("Journey completed safely. Route, GPS trail and dispatch records purged.")
    return {"message": "Journey ended", "session": public_session()}


# --------------------------------------------------------------------------- #
# Destination search / route preview
# --------------------------------------------------------------------------- #
GEOCODE_CACHE: dict = {}
_last_geocode_at = [0.0]


@app.get("/api/geocode")
def geocode(q: str = Query(..., min_length=2), limit: int = Query(5, ge=1, le=8)):
    key = q.strip().lower()
    cached = GEOCODE_CACHE.get(key)
    if cached and time.time() - cached["at"] < 3600:
        return cached["data"]

    # Nominatim asks for at most one request per second.
    wait = 1.0 - (time.time() - _last_geocode_at[0])
    if wait > 0:
        time.sleep(min(wait, 1.0))
    _last_geocode_at[0] = time.time()

    params = urllib.parse.urlencode({
        "q": q, "format": "jsonv2", "limit": limit,
        "addressdetails": 0, "accept-language": "en",
    })
    try:
        req = urllib.request.Request(
            f"https://nominatim.openstreetmap.org/search?{params}",
            headers={"User-Agent": ROUTING_USER_AGENT},
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            raw = json.load(resp)
        results = []
        for item in raw:
            full = item.get("display_name", "")
            results.append({
                "label": ", ".join(full.split(",")[:2]).strip() or q,
                "full": full,
                "lat": float(item["lat"]),
                "lng": float(item["lon"]),
            })
        data = {"results": results}
    except Exception as exc:
        return {"results": [], "error": f"Search is unavailable right now ({type(exc).__name__})."}

    GEOCODE_CACHE[key] = {"at": time.time(), "data": data}
    return data


@app.post("/api/journey/plan")
def journey_plan(req: JourneyPlan):
    o = {"lat": req.origin.lat, "lng": req.origin.lng, "label": req.origin.label or "Start"}
    d = {"lat": req.destination.lat, "lng": req.destination.lng,
         "label": req.destination.label or "Destination"}
    route = build_route(o, d)
    return {
        "origin": o,
        "destination": d,
        "distance_m": round(route["distance_m"]),
        "duration_s": round(route["duration_s"]),
        "source": route["source"],
        "points": [[round(lat, 6), round(lng, 6)] for lat, lng in route["points"]],
    }


# --------------------------------------------------------------------------- #
# Autonomous journey tracking
# --------------------------------------------------------------------------- #
@app.post("/api/journey/track")
def journey_track(sample: TrackSample):
    if not SESSION["journey_active"]:
        return {"error": "Journey is not active!"}

    J = SESSION["journey"]
    route = J.get("route")
    if not route:
        return {"error": "No planned route for this journey."}

    now = time.time()
    deviation, progress, _travelled = route_metrics(sample.lat, sample.lng, route)
    accuracy = max(0.0, min(sample.accuracy_m or 0.0, 60.0))
    effective_dev = max(0.0, deviation - accuracy)

    J["progress"] = progress
    J["max_deviation_m"] = max(J["max_deviation_m"], effective_dev)

    prev = J.get("last_pos")
    moved = float("inf") if prev is None else haversine_m(prev["lat"], prev["lng"], sample.lat, sample.lng)
    if moved > 12:
        J["last_moved_at"] = now
    J["last_pos"] = {"lat": sample.lat, "lng": sample.lng}
    SESSION["last_coords"] = {"lat": sample.lat, "lng": sample.lng}

    stop_seconds = max(0.0, now - (J["last_moved_at"] or now))
    off_route = effective_dev > OFF_ROUTE_M
    if off_route:
        if J["off_route_since"] is None:
            J["off_route_since"] = now
        off_route_for = now - J["off_route_since"]
    else:
        J["off_route_since"] = None
        off_route_for = 0.0

    total_route = route["distance_m"] or 1.0
    remaining = max(0.0, total_route * (1.0 - progress))
    avg_speed = total_route / max(route["duration_s"], 1.0)
    eta_min = round((remaining / avg_speed) / 60) if avg_speed > 0 else 0
    arrived = remaining < ARRIVAL_M and effective_dev < OFF_ROUTE_M
    J["arrived"] = arrived

    hour = time.localtime().tm_hour
    late_night = hour >= 20 or hour < 6

    dev_score = min(45.0, (effective_dev / 400.0) * 45.0)
    if off_route_for > OFF_ROUTE_GRACE_S:
        dev_score = max(dev_score, 40.0)
    stop_score = min(30.0, (stop_seconds / 240.0) * 30.0)
    night_score = 15.0 if late_night else 4.0
    stall_score = 12.0 if (stop_seconds > 180 and remaining > ARRIVAL_M * 4) else 0.0
    total = int(min(98, dev_score + stop_score + night_score + stall_score))

    features = np.array([[effective_dev, stop_seconds, sample.speed_kmh or 0.0]])
    anomaly = int(ml_model.predict(features)[0]) == -1
    corroborated = effective_dev >= 100 or stop_seconds >= 120
    if anomaly and corroborated and total < 75:
        total = 78

    voice_required = (not arrived) and (
        total >= VOICE_RISK_THRESHOLD
        or off_route_for > OFF_ROUTE_GRACE_S
        or stop_seconds > STOP_ALERT_S
    )
    if voice_required:
        J["voice_armed"] = True

    factors = []
    if effective_dev >= 40:
        factors.append(f"{effective_dev:.0f} m from planned route")
    if stop_seconds >= 60:
        factors.append(f"stationary {stop_seconds / 60:.1f} min")
    if late_night:
        factors.append("late-night window")
    if not factors:
        factors.append(f"on route · {progress * 100:.0f}% complete")

    SESSION["risk_score"] = total
    if voice_required and not J.get("_voice_logged"):
        J["_voice_logged"] = True
        log_event(f"⚠️ Route anomaly — risk {total}%. Voice watch mode activated automatically.")
    if not voice_required:
        J["_voice_logged"] = False

    return {
        "risk_score": total,
        "factors": factors,
        "ml_anomaly_detected": anomaly,
        "deviation_m": round(effective_dev),
        "off_route": off_route,
        "off_route_seconds": round(off_route_for),
        "stop_seconds": round(stop_seconds),
        "progress": round(progress, 4),
        "remaining_m": round(remaining),
        "eta_min": eta_min,
        "voice_mode_required": voice_required,
        "check_in_required": total >= 75,
        "arrived": arrived,
        "route_source": route["source"],
    }


# --------------------------------------------------------------------------- #
# Live telemetry
# --------------------------------------------------------------------------- #
@app.post("/api/analyze-risk")
def analyze_risk(data: TelemetryInput):
    if not SESSION["journey_active"]:
        return {"error": "Journey is not active! Start journey first."}

    total, anomaly, explanation = compute_risk(
        data.deviation_meters, data.stop_seconds, data.speed_kmh, data.is_late_night
    )
    SESSION["risk_score"] = total
    check_in_required = total >= 75

    # Only anomalies are audited: the live loop re-scores every few seconds and a
    # per-poll log line would bury the events that matter.
    if check_in_required:
        log_event(f"⚠️ Anomaly detected — risk {total}%. Soft check-in pending.")

    return {
        "risk_score": total,
        "ml_anomaly_detected": anomaly,
        "check_in_required": check_in_required,
        "explanation": explanation,
        "checkin_window_seconds": CHECKIN_WINDOW_SECONDS,
    }


@app.post("/api/telemetry/point")
def telemetry_point(data: SOSInput):
    """Server-side breadcrumb for Tier-2 dispatch (memory only, purged on journey end)."""
    SESSION["last_coords"] = {"lat": data.lat, "lng": data.lng}
    trail = SESSION["trail"]
    trail.append({"lat": data.lat, "lng": data.lng, "t": time.time()})
    del trail[:-MAX_TRAIL_POINTS]
    return {"points": len(trail)}


# --------------------------------------------------------------------------- #
# Soft check-in
# --------------------------------------------------------------------------- #
@app.post("/api/checkin/start")
def checkin_start(req: CheckInStart):
    if not SESSION["journey_active"]:
        return {"error": "Journey is not active!"}

    prompt_id = SESSION["checkin"]["prompt_id"] + 1
    SESSION["checkin"] = {
        "active": True,
        "prompt_id": prompt_id,
        "deadline": time.time() + CHECKIN_WINDOW_SECONDS,
        "reason": req.reason,
        "resolved": False,
    }
    log_event(f"❓ Soft check-in #{prompt_id} sent — {req.reason}. {CHECKIN_WINDOW_SECONDS}s to respond.")
    return {
        "status": "CHECKIN_ACTIVE",
        "prompt_id": prompt_id,
        "window_seconds": CHECKIN_WINDOW_SECONDS,
        "deadline_epoch": SESSION["checkin"]["deadline"],
        "session": public_session(),
    }


@app.post("/api/checkin/resolve")
def checkin_resolve(req: CheckInResolve):
    SESSION["checkin"]["active"] = False
    SESSION["checkin"]["resolved"] = True

    if req.safe:
        SESSION["risk_score"] = max(0, SESSION["risk_score"] - 40)
        SESSION["current_tier"] = "Active Monitoring (User confirmed safe)"
        log_event("✅ User confirmed safety. Escalation cancelled, risk reduced.")
        return {"status": "USER_SAFE", "session": public_session()}

    log_event("❌ User reported UNSAFE. Escalating to Tier 2.")
    return escalate_to_tier2("User answered check-in as unsafe")


@app.post("/api/checkin/timeout")
def checkin_timeout():
    if SESSION["checkin"]["resolved"]:
        return {"status": "ALREADY_RESOLVED", "session": public_session()}
    SESSION["checkin"]["active"] = False
    SESSION["checkin"]["resolved"] = True
    log_event("⌛ Check-in unanswered. Automatic escalation triggered.")
    return escalate_to_tier2("Soft check-in unanswered")


# --------------------------------------------------------------------------- #
# PIN verification / covert duress
# --------------------------------------------------------------------------- #
@app.post("/api/verify-pin")
def verify_user_pin(req: PinInput):
    if not SESSION["pin_hash"]:
        return {"error": "No PIN configured. Register first."}

    if SESSION["pin_failed_attempts"] >= 5:
        return {"mode": "locked", "message": "Too many attempts. Use SOS, or restart the app."}

    is_normal = verify_pin(req.pin, SESSION["pin_hash"])
    is_duress = verify_pin(req.pin, SESSION["duress_pin_hash"])

    if not (is_normal or is_duress):
        SESSION["pin_failed_attempts"] += 1
        return {
            "mode": "invalid",
            "attempts_left": max(0, 5 - SESSION["pin_failed_attempts"]),
            "message": "Incorrect PIN.",
        }

    SESSION["pin_failed_attempts"] = 0

    if is_normal:
        disarm_session()
        SESSION["current_tier"] = "Standby (Disarmed by user)"
        log_event("🔓 Safety PIN accepted — monitoring disarmed.")
        return {"mode": "unlocked"}

    # Duress: same visible disarm, but the SOS pipeline stays armed and hidden.
    disarm_session()
    SESSION["covert"] = True
    SESSION["covert_deadline"] = time.time() + COVERT_ESCALATION_SECONDS
    SESSION["sos_active"] = True
    SESSION["tier1_acknowledged"] = False
    SESSION["current_tier"] = "Tier 1: Silent dispatch armed"

    profile = SESSION.get("user_profile", {})
    SESSION["last_coords"] = {"lat": req.lat, "lng": req.lng}
    message = compose_alert(
        "Duress PIN entered (covert)",
        "English",
        req.lat,
        req.lng,
        profile.get("guardian_1_name", "Guardian"),
        profile.get("name", "User"),
    )
    links = dispatch_links(message, req.lat, req.lng)

    log_event("🕵️ DURESS PIN used — silent Tier-1 dispatch armed, UI left untouched.", covert=True)
    log_event(f"🕵️ Payload built for {profile.get('guardian_1_name', 'Guardian')}.", covert=True)

    # Same shape as the normal path; the client renders nothing extra.
    return {
        "mode": "unlocked",
        "duress": True,
        "dispatch": "queued",
        "silent": {
            "message": message,
            "sms_link": links["sms_link"],
            "whatsapp_link": links["whatsapp_link"],
            "escalate_after_seconds": COVERT_ESCALATION_SECONDS,
        },
    }


@app.post("/api/covert/escalate")
def covert_escalate():
    """Called when the covert deadline lapses. Produces no visible change."""
    if not SESSION["covert"]:
        return {"status": "NO_COVERT_SESSION"}
    SESSION["covert_deadline"] = 0.0
    result = escalate_to_tier2("Covert duress — Tier-1 unreachable", covert=True)
    log_event("🕵️ Covert escalation completed to Tier 2.", covert=True)
    return {
        "status": "COVERT_ESCALATED",
        "dispatch": result["dispatched_to"],
        "coordinates": result["coordinates"],
    }


# --------------------------------------------------------------------------- #
# SOS + escalation
# --------------------------------------------------------------------------- #
@app.post("/api/trigger-sos")
def trigger_sos(req: SOSInput):
    SESSION["sos_active"] = True
    SESSION["tier1_acknowledged"] = False
    SESSION["current_tier"] = "Tier 1: Family SMS Alerted"
    SESSION["last_coords"] = {"lat": req.lat, "lng": req.lng}

    profile = SESSION.get("user_profile", {})
    g1_name = profile.get("guardian_1_name", "Guardian")
    user_name = profile.get("name", "User")

    message = compose_alert(req.trigger_type, req.language, req.lat, req.lng, g1_name, user_name)
    links = dispatch_links(message, req.lat, req.lng)

    log_event(f"🚨 SOS via {req.source} for {user_name} → {g1_name}. Risk {SESSION['risk_score']}%.")

    return {
        "status": "SOS_ACTIVE",
        "ai_message": message,
        "sms_link": links["sms_link"],
        "sms_link_guardian_2": links["sms_link_guardian_2"],
        "whatsapp_link": links["whatsapp_link"],
        "maps_link": links["maps_link"],
        "coordinates": {"lat": req.lat, "lng": req.lng},
        "session": public_session(),
    }


@app.post("/api/acknowledge-sos")
def acknowledge_sos():
    if not SESSION["sos_active"]:
        return {"status": "NO_ACTIVE_SOS"}

    SESSION["tier1_acknowledged"] = True
    SESSION["covert"] = False
    SESSION["covert_deadline"] = 0.0
    SESSION["current_tier"] = "Tier 1 Acknowledged by Family"
    log_event("✅ Guardian acknowledged the SOS. Escalation halted.")
    return {"status": "ACKNOWLEDGED", "session": public_session()}


@app.post("/api/escalate-tier2")
def escalate_tier2():
    if not SESSION["sos_active"]:
        return {"status": "NO_ACTIVE_SOS", "message": "Trigger SOS first."}
    if SESSION["tier1_acknowledged"]:
        return {"status": "ALREADY_ACKNOWLEDGED_BY_FAMILY"}
    return escalate_to_tier2("Manual Tier-2 override")


# --------------------------------------------------------------------------- #
# Safe havens
# --------------------------------------------------------------------------- #
@app.get("/api/safe-havens")
def safe_havens(
    lat: float = Query(28.2455),
    lng: float = Query(77.0690),
    limit: int = Query(SAFE_HAVEN_LIMIT, ge=1, le=len(SAFE_HAVENS)),
):
    ranked = []
    for haven in SAFE_HAVENS:
        distance_m = haversine_m(lat, lng, haven["lat"], haven["lng"])
        entry = dict(haven)
        entry["distance_m"] = round(distance_m)
        entry["eta_min"] = max(1, round(distance_m / 80 / 60))  # ~4.8 km/h walking pace
        ranked.append(entry)
    ranked.sort(key=lambda h: h["distance_m"])

    return {
        "origin": {"lat": lat, "lng": lng},
        "dataset": "demo",
        "nearest": ranked[:limit],
        "all": ranked,
    }
