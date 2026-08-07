"""Telemetry parsing and pixel -> world projection.

A count without coordinates is a number; a count with coordinates is a survey.
This module turns whatever the drone wrote next to the footage - a DJI `.SRT`
subtitle track, a JSON sidecar, or a single manual pin - into a flight track,
and then turns detection pixels into lat/lng so points land on the map.

Two things make this messier than it looks:

**DJI does not write one format.** Across firmware generations the same field
appears as `GPS(lng,lat,alt)`, as `[latitude: ..] [longitude: ..]`, or as a bare
comma-separated line, wrapped in HTML font tags or not. All three are parsed
here because we do not control which airframe flies the sortie.

**The coordinate order is genuinely ambiguous.** Some firmware writes
(lat,lng), some writes (lng,lat), and nothing in the file says which. Guessing
wrong puts a Caspian haul-out in Uzbekistan. The fix is the survey area itself:
every point must land in the Caspian basin, and a pair that fails is retried
swapped and accepted only if the swap passes. See `_orient`.

Projection is a nadir pinhole approximation - see `pixel_to_latlng` for what
that assumes and when it stops being true.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Optional

try:  # when service/ is imported as a package
    from .contract import gsd_from_altitude
except ImportError:  # direct execution, or service/ on sys.path
    from contract import gsd_from_altitude


# The survey area, generously bounded. The Caspian spans roughly 36.5-47.2 N,
# 46.6-54.9 E; these are padded so a coastal site or a transit leg is not
# rejected. The gate is deliberately coarse - its job is to catch a swapped
# pair or a no-fix 0.0, not to validate a position.
CASPIAN_LAT_RANGE = (36.0, 48.0)
CASPIAN_LNG_RANGE = (46.0, 56.0)

METRES_PER_DEG_LAT = 111320.0

# Below this the two track points are the same point as far as bearing goes -
# a hovering drone's GPS jitter would otherwise produce a random heading.
MIN_HEADING_DISPLACEMENT_M = 1.0

# --- SRT lexicon -----------------------------------------------------------

_TIMING = re.compile(
    r"(\d{1,3}):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})\s*-->\s*"
    r"(\d{1,3}):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})"
)

_NUM = r"[-+]?\d+(?:\.\d+)?"

# `GPS(51.180000,43.650000,120.5)`. Matching the literal `GPS` keyword matters:
# the same cue often carries `HOME(lng,lat)`, which is the takeoff point and not
# where the camera is looking. A no-fix cue is written `GPS(-,-,0.0)` and simply
# fails to match, which is the behaviour we want.
_GPS = re.compile(rf"GPS\s*\(\s*({_NUM})\s*,\s*({_NUM})\s*(?:,\s*({_NUM})\s*)?\)", re.I)

_LAT_LABEL = re.compile(rf"(?<![a-z_])(?:latitude|lat)\s*[:=]\s*({_NUM})", re.I)
_LNG_LABEL = re.compile(rf"(?<![a-z_])(?:longitude|long|lng|lon)\s*[:=]\s*({_NUM})", re.I)

# Altitude in priority order. `rel_alt` is height above the takeoff point, which
# is what GSD needs; `abs_alt` is height above the ellipsoid and is useless for
# scale, so it is the last resort rather than the first match.
_ALT_LABELS = (
    re.compile(rf"rel_alt\s*[:=]\s*({_NUM})", re.I),
    re.compile(rf"(?<![a-z_])(?:altitude|alt)\s*[:=]\s*({_NUM})", re.I),
    re.compile(rf"(?<![a-z_])barometer\s*[:=]\s*({_NUM})", re.I),
    re.compile(rf"abs_alt\s*[:=]\s*({_NUM})", re.I),
)

# A whole line that is nothing but 2-3 numbers. Anchoring both ends is what
# keeps it off the DJI clock line `2026-08-06 07:14:00,123,456`.
_BARE = re.compile(rf"^\s*({_NUM})\s*,\s*({_NUM})\s*(?:,\s*({_NUM})\s*)?$")

_TAGS = re.compile(r"<[^>]*>")

# `2026-08-06 07:14:00,123` and `2026.08.06 07:14:00` and the ISO `T` form.
_WALL_CLOCK = re.compile(
    r"(\d{4})[-./](\d{2})[-./](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[,.](\d{1,3}))?"
)


def _in_basin(lat: float, lng: float) -> bool:
    return (
        CASPIAN_LAT_RANGE[0] <= lat <= CASPIAN_LAT_RANGE[1]
        and CASPIAN_LNG_RANGE[0] <= lng <= CASPIAN_LNG_RANGE[1]
    )


def _orient(a: float, b: float) -> Optional[tuple[float, float]]:
    """Resolve an ambiguous coordinate pair into (lat, lng), or reject it.

    `a` is whatever the file presented first. If (a, b) reads as a sane basin
    position we take it. If it does not but (b, a) does, the writer used the
    opposite order and we swap - DJI's `GPS()` form is (lng,lat,alt) on several
    firmwares while the labelled form is (lat,lng), and some sidecars mislabel
    outright. If neither order lands in the basin the pair is rejected: it is a
    no-fix 0.0, a home point from another continent, or not a coordinate at all.

    The two ranges overlap between 46 and 48, so a point there is ambiguous
    under this test. We keep the declared order in that case - swapping is only
    ever a rescue for a pair that is otherwise unusable, never a correction of a
    pair that already reads fine.
    """
    if _in_basin(a, b):
        return a, b
    if _in_basin(b, a):
        return b, a
    return None


def _to_float(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _cue_seconds(m: re.Match) -> float:
    """Cue START in seconds. The end is ignored - a track point is an instant."""
    h, mm, s = (int(g) for g in m.group(1, 2, 3))
    # SubRip writes three digits, but a short field is a decimal fraction: ",5"
    # is 500ms, not 5ms. `_cue_timestamp` already pads it that way, and the two
    # must agree - a cue whose position says t=1.005 and whose wall clock says
    # .500 is half a second of flight apart, which is metres on the ground.
    ms = int(m.group(4).ljust(3, "0"))
    return h * 3600.0 + mm * 60.0 + s + ms / 1000.0


def _cue_timestamp(block: str) -> Optional[str]:
    """Wall clock of the cue as ISO8601, if the firmware wrote one.

    Nothing in `track_point` stores this, but the first cue's clock is where
    `survey.captured_at` comes from, and tide state is meaningless without it.
    """
    m = _WALL_CLOCK.search(block)
    if not m:
        return None
    y, mo, d, h, mi, s = m.group(1, 2, 3, 4, 5, 6)
    frac = m.group(7)
    stamp = f"{y}-{mo}-{d}T{h}:{mi}:{s}"
    return f"{stamp}.{frac.ljust(3, '0')}" if frac else stamp


def _cue_alt(block: str, gps_alt: Optional[float]) -> Optional[float]:
    """Altitude for the cue, preferring height above takeoff over anything else."""
    rel = _ALT_LABELS[0].search(block)
    if rel:
        return _to_float(rel.group(1))
    if gps_alt is not None:
        return gps_alt
    for pattern in _ALT_LABELS[1:]:
        m = pattern.search(block)
        if m:
            return _to_float(m.group(1))
    return None


def _cue_fix(block: str) -> Optional[dict]:
    """Pull one position out of an SRT cue body, trying each known DJI form.

    Forms are tried most-explicit first. A form that yields numbers which fail
    the basin gate does not abort the cue - we fall through to the next form,
    because a cue carrying a bogus `HOME` and a good `GPS` is a real file.
    """
    text = _TAGS.sub(" ", block)

    # (a) labelled: [latitude: 43.65] [longitude: 51.18] [rel_alt: 120.5 ...]
    lat_m, lng_m = _LAT_LABEL.search(text), _LNG_LABEL.search(text)
    if lat_m and lng_m:
        a, b = _to_float(lat_m.group(1)), _to_float(lng_m.group(1))
        if a is not None and b is not None:
            pair = _orient(a, b)
            if pair:
                return {"lat": pair[0], "lng": pair[1], "alt": _cue_alt(text, None)}

    # (b) GPS(lng,lat,alt) - or (lat,lng,alt), the basin decides
    gps_m = _GPS.search(text)
    if gps_m:
        a, b = _to_float(gps_m.group(1)), _to_float(gps_m.group(2))
        alt = _to_float(gps_m.group(3)) if gps_m.group(3) else None
        if a is not None and b is not None:
            pair = _orient(a, b)
            if pair:
                return {"lat": pair[0], "lng": pair[1], "alt": _cue_alt(text, alt)}

    # (c) a bare `51.18,43.65,120` line
    for line in text.splitlines():
        bare = _BARE.match(line)
        if not bare:
            continue
        a, b = _to_float(bare.group(1)), _to_float(bare.group(2))
        alt = _to_float(bare.group(3)) if bare.group(3) else None
        if a is None or b is None:
            continue
        pair = _orient(a, b)
        if pair:
            return {"lat": pair[0], "lng": pair[1], "alt": _cue_alt(text, alt)}

    return None


def parse_srt(text: str) -> list[dict]:
    """Parse a DJI SRT telemetry track into [{t, lat, lng, alt, timestamp}].

    `t` is seconds from the start of the media, taken from the cue's START
    timecode. Cues without a usable position are dropped silently - a no-fix
    prefix at the top of a flight is normal and is not an error.

    Cues are sliced on the timecode lines rather than on blank lines, because
    some writers omit the blank separator. A file with no timecodes at all
    (a bare coordinate dump) falls back to one point per parseable line at 1 Hz:
    interpolation between them still works, absolute times do not.
    """
    if not text:
        return []
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    out: list[dict] = []
    timings = list(_TIMING.finditer(text))

    if timings:
        for i, m in enumerate(timings):
            end = timings[i + 1].start() if i + 1 < len(timings) else len(text)
            block = text[m.end():end]
            fix = _cue_fix(block)
            if fix:
                out.append({
                    "t": _cue_seconds(m),
                    "lat": fix["lat"],
                    "lng": fix["lng"],
                    "alt": fix["alt"],
                    "timestamp": _cue_timestamp(block),
                })
    else:
        for line in text.splitlines():
            fix = _cue_fix(line)
            if fix:
                out.append({
                    "t": float(len(out)),
                    "lat": fix["lat"],
                    "lng": fix["lng"],
                    "alt": fix["alt"],
                    "timestamp": _cue_timestamp(line),
                })

    out.sort(key=lambda p: p["t"])
    return out


# --- JSON sidecar ----------------------------------------------------------

_LAT_KEYS = ("lat", "latitude")
_LNG_KEYS = ("lng", "lon", "long", "longitude")
_ALT_KEYS = ("alt", "altitude", "rel_alt", "relative_altitude", "elevation", "height")

# `height` is the one alias that collides with something common. A manually
# pinned still is written as `{lat, lng, width, height}` often enough that
# reading 1082 *pixels* as 1082 *metres* is a live failure, and it is a silent
# one: it feeds `survey.gsd_cm_px`, which scales every projected coordinate and
# picks the tile size, so the count and the map both go wrong with no error.
# When `width` is in the same object the pair is image dimensions, not telemetry.
_ALT_KEYS_NO_HEIGHT = tuple(k for k in _ALT_KEYS if k != "height")
_WIDTH_KEYS = ("width",)
_T_KEYS = ("t", "time_s", "seconds", "offset", "elapsed", "time")
_TS_KEYS = ("timestamp", "datetime", "date", "captured_at", "time")


def _pick(d: dict, keys: tuple[str, ...]) -> Any:
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
        # tolerate CamelCase / spaced keys without indexing every variant
        for actual in d:
            if isinstance(actual, str) and actual.replace(" ", "_").lower() == k:
                if d[actual] is not None:
                    return d[actual]
    return None


def _sidecar_point(item: Any, index: int) -> Optional[dict]:
    if not isinstance(item, dict):
        return None
    a = _to_float(_pick(item, _LAT_KEYS))
    b = _to_float(_pick(item, _LNG_KEYS))
    if a is None or b is None:
        return None
    pair = _orient(a, b)
    if pair is None:
        return None

    t = _to_float(_pick(item, _T_KEYS))
    raw_ts = _pick(item, _TS_KEYS)
    timestamp = raw_ts if isinstance(raw_ts, str) else None
    alt_keys = _ALT_KEYS_NO_HEIGHT if _pick(item, _WIDTH_KEYS) is not None else _ALT_KEYS
    return {
        "t": t if t is not None else float(index),
        "lat": pair[0],
        "lng": pair[1],
        "alt": _to_float(_pick(item, alt_keys)),
        "timestamp": timestamp,
    }


def parse_json_sidecar(obj: Any) -> list[dict]:
    """Parse a JSON telemetry sidecar into the same shape as `parse_srt`.

    There is no standard here - every tool that exports a drone track invents a
    wrapper - so we accept `{track:[..]}`, `{points:[..]}`, `{gps:[..]}`, a bare
    list, or a single `{lat,lng}` object (a manually pinned still). Key aliases
    cover lat/latitude and lng/lon/longitude. Points missing `t` are numbered by
    position at 1 Hz, same fallback as an SRT with no timecodes.

    The basin gate and the swap rescue apply here too: a sidecar is no more
    trustworthy about coordinate order than the SRT it was derived from.
    """
    if isinstance(obj, (str, bytes, bytearray)):
        try:
            obj = json.loads(obj)
        except (ValueError, TypeError):
            return []

    items: Any = None
    if isinstance(obj, list):
        items = obj
    elif isinstance(obj, dict):
        for key in ("track", "points", "gps", "telemetry", "path", "samples", "data"):
            v = obj.get(key)
            if isinstance(v, list):
                items = v
                break
        if items is None:
            items = [obj]  # a single pin
    if items is None:
        return []

    out = [p for i, p in ((i, _sidecar_point(it, i)) for i, it in enumerate(items)) if p]
    out.sort(key=lambda p: p["t"])
    return out


# --- track queries ---------------------------------------------------------

def track_at(track: Optional[list[dict]], t: float) -> Optional[dict]:
    """Position at time `t`, linearly interpolated between bracketing points.

    Clamped at both ends: a frame sampled a moment before the first telemetry
    cue is at the first cue's position, not nowhere. Returns None only for an
    empty track, which is the caller's signal to leave lat/lng NULL rather than
    invent a position.
    """
    if not track:
        return None
    pts = sorted(track, key=lambda p: p["t"])

    if t <= pts[0]["t"]:
        first = pts[0]
        return {"lat": first["lat"], "lng": first["lng"], "alt": first.get("alt")}
    last = pts[-1]
    if t >= last["t"]:
        return {"lat": last["lat"], "lng": last["lng"], "alt": last.get("alt")}

    for a, b in zip(pts, pts[1:]):
        if a["t"] <= t <= b["t"]:
            span = b["t"] - a["t"]
            f = 0.0 if span <= 0 else (t - a["t"]) / span
            return {
                "lat": a["lat"] + (b["lat"] - a["lat"]) * f,
                "lng": a["lng"] + (b["lng"] - a["lng"]) * f,
                "alt": _lerp_optional(a.get("alt"), b.get("alt"), f),
            }
    return {"lat": last["lat"], "lng": last["lng"], "alt": last.get("alt")}


def _lerp_optional(a: Optional[float], b: Optional[float], f: float) -> Optional[float]:
    """Altitude is often missing on one side; a known end beats no answer."""
    if a is None:
        return b
    if b is None:
        return a
    return a + (b - a) * f


def estimate_heading(track: Optional[list[dict]], t: float) -> float:
    """Course over ground at `t` in degrees clockwise from north, 0.0 if unknown.

    This is the drone's direction of travel, used as a stand-in for camera yaw.
    That substitution holds for a survey transect flown nose-forward and breaks
    if the gimbal is panned independently - when the SRT carries a real yaw
    field, prefer it over this.

    The segment bracketing `t` is used, but a hovering drone's segment is pure
    GPS noise, so segments shorter than `MIN_HEADING_DISPLACEMENT_M` are skipped
    in favour of the nearest one that actually moved. Everything stationary
    returns 0.0 - unknown, not north.

    `t` outside the track is clamped to the nearest end, matching `track_at`.
    """
    if not track or len(track) < 2:
        return 0.0
    pts = sorted(track, key=lambda p: p["t"])

    # Index of the segment containing t, clamped at BOTH ends. Clamping low
    # matters as much as high: a no-fix prefix at the top of a DJI flight is
    # normal and those cues are dropped, so frame 0 at t=0 routinely sits before
    # the first surviving sample. Falling through to the last segment there
    # reads the heading off the END of the sortie, which on a lawnmower transect
    # is the reciprocal leg - 180 degrees out, rotating every detection in the
    # frame about its centre by up to the frame's own diagonal.
    if t <= pts[0]["t"]:
        seg = 0
    elif t >= pts[-1]["t"]:
        seg = len(pts) - 2
    else:
        seg = next(
            (i for i in range(len(pts) - 1) if pts[i]["t"] <= t <= pts[i + 1]["t"]),
            0,
        )

    # walk outward from the bracketing segment to the nearest real displacement
    for offset in range(len(pts)):
        for i in (seg - offset, seg + offset):
            if not 0 <= i < len(pts) - 1:
                continue
            a, b = pts[i], pts[i + 1]
            if _ground_distance_m(a, b) >= MIN_HEADING_DISPLACEMENT_M:
                return _bearing(a["lat"], a["lng"], b["lat"], b["lng"])
    return 0.0


def _ground_distance_m(a: dict, b: dict) -> float:
    """Equirectangular approximation - exact enough over a few metres."""
    mid = math.radians((a["lat"] + b["lat"]) / 2.0)
    dn = (b["lat"] - a["lat"]) * METRES_PER_DEG_LAT
    de = (b["lng"] - a["lng"]) * METRES_PER_DEG_LAT * math.cos(mid)
    return math.hypot(dn, de)


def _bearing(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360.0


# --- projection ------------------------------------------------------------

def pixel_to_latlng(
    x: float,
    y: float,
    width: int,
    height: int,
    center_lat: float,
    center_lng: float,
    gsd_cm_px: float,
    heading_deg: float = 0.0,
) -> Optional[tuple[float, float]]:
    """Project a detection pixel to (lat, lng) under a nadir pinhole model.

    The assumption: the camera points straight down, the ground under it is
    flat, and scale is therefore one constant - `gsd_cm_px` - across the whole
    frame. Offset from the image centre in pixels becomes metres, rotates by the
    camera heading, and converts to degrees.

    **This is invalid for oblique shots.** The moment the gimbal tilts off nadir
    the scale stops being constant: the far edge of the frame is metres per
    pixel coarser than the near edge, and error grows with distance from centre
    rather than staying bounded. A 30 degree tilt is not a small correction to
    this model, it is a different model (it needs the full camera pose and a
    ground-plane intersection). Survey sorties are flown nadir; if one is not,
    the coordinates from here are indicative only and must not be published as
    positions. Terrain relief is ignored for the same reason - a haul-out beach
    is flat, a cliff is not.

    `heading_deg` is clockwise from north and describes where the top of the
    image points. With heading 0 the top of the image is north.

    Returns None when the scale is unknown, and that is deliberate: the obvious
    alternative - fall back to the frame centre - collapses every detection in
    the frame onto one coordinate that is indistinguishable, on the map and in
    an export, from a measured position. `point.lat` is nullable exactly so that
    "we do not know" is sayable; saying it is always better than emitting a
    coordinate nothing measured.
    """
    if gsd_cm_px is None or gsd_cm_px <= 0 or width <= 0 or height <= 0:
        return None

    m_per_px = gsd_cm_px / 100.0
    right_m = (x - width / 2.0) * m_per_px
    up_m = (height / 2.0 - y) * m_per_px  # image y grows downward

    h = math.radians(heading_deg or 0.0)
    # image-up points along the heading; image-right is 90 degrees clockwise of it
    north_m = up_m * math.cos(h) - right_m * math.sin(h)
    east_m = up_m * math.sin(h) + right_m * math.cos(h)

    lat = center_lat + north_m / METRES_PER_DEG_LAT
    cos_lat = math.cos(math.radians(center_lat))
    if abs(cos_lat) < 1e-9:  # a pole; not reachable in this basin, but do not divide by 0
        return None
    lng = center_lng + east_m / (METRES_PER_DEG_LAT * cos_lat)
    # A NaN anywhere upstream survives `<= 0` (every NaN comparison is False) and
    # would be written into `point.lat` as NaN, which is corrupt in the database
    # and not even valid JSON on the way out. One check at the end covers a
    # non-finite value in any argument.
    if not (math.isfinite(lat) and math.isfinite(lng)):
        return None
    return float(lat), float(lng)


def gsd_for_media(
    altitude_m: float,
    width_px: int,
    sensor_width_mm: float = 13.2,
    focal_mm: float = 8.8,
) -> float:
    """Ground sample distance in cm/px for a piece of media, 0.0 if unknowable.

    A thin wrapper on `contract.gsd_from_altitude` so that the airframe optics
    live at exactly one call site: GSD feeds both the tiling decision and every
    projected coordinate, and those two must never disagree about scale.
    """
    alt = _to_float(altitude_m)
    if alt is None or alt <= 0 or not width_px or width_px <= 0:
        return 0.0
    return gsd_from_altitude(alt, int(width_px), sensor_width_mm, focal_mm)


# --- self-test -------------------------------------------------------------

if __name__ == "__main__":
    import sys

    _failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"{'PASS' if ok else 'FAIL'}  {name}{'  -- ' + detail if detail else ''}")
        if not ok:
            _failures.append(name)

    def near(a: float | None, b: float, tol: float = 1e-6) -> bool:
        return a is not None and abs(a - b) <= tol

    # (a) GPS(lng,lat,alt) - Phantom/Mavic firmware, coordinates transposed
    SRT_GPS = """1
00:00:00,000 --> 00:00:01,000
HOME(51.1801,43.6499) 2026.08.06 07:14:00
GPS(51.180000,43.650000,120.5) BAROMETER:120.5
ISO:100 SHUTTER:1000 EV:0 Fnum:F2.8

2
00:00:01,000 --> 00:00:02,000
HOME(51.1801,43.6499) 2026.08.06 07:14:01
GPS(51.181000,43.651000,121.5) BAROMETER:121.5
ISO:100 SHUTTER:1000 EV:0 Fnum:F2.8
"""

    # (b) labelled brackets inside font tags - Mavic 3 / Air 2S firmware
    SRT_LABELLED = """1
00:00:00,000 --> 00:00:00,033
<font size="28">FrameCnt: 1, DiffTime: 33ms
2026-08-06 07:14:00,123,456
[iso : 100] [shutter : 1/1000] [fnum : 280] [ev : 0] [focal_len : 240] \
[latitude: 43.650000] [longitude: 51.180000] [rel_alt: 120.500 abs_alt: 145.200] </font>

2
00:00:00,033 --> 00:00:00,066
<font size="28">FrameCnt: 2, DiffTime: 33ms
2026-08-06 07:14:00,156,456
[iso : 100] [shutter : 1/1000] [fnum : 280] [ev : 0] [focal_len : 240] \
[latitude: 43.650100] [longitude: 51.180100] [rel_alt: 120.600 abs_alt: 145.300] </font>
"""

    # (c) bare numeric line, already in (lat,lng,alt) order
    SRT_BARE = """1
00:00:02,000 --> 00:00:03,000
43.652000,51.182000,122
"""

    # labelled but transposed by the writer - the swap rescue must fire
    SRT_SWAPPED = """1
00:00:00,000 --> 00:00:01,000
[latitude: 51.180000] [longitude: 43.650000] [rel_alt: 118.0]
"""

    # a fix from outside the survey area (Paris) - must be rejected outright
    SRT_OUT_OF_BASIN = """1
00:00:00,000 --> 00:00:01,000
GPS(2.352200,48.856600,120.0)

2
00:00:01,000 --> 00:00:02,000
GPS(51.180000,43.650000,120.5)
"""

    print("-- parse_srt ------------------------------------------------")

    a = parse_srt(SRT_GPS)
    check("gps form: two cues", len(a) == 2, f"got {len(a)}")
    check("gps form: cue start seconds", a and near(a[0]["t"], 0.0) and near(a[1]["t"], 1.0))
    check("gps form: lng,lat transposition resolved",
          bool(a) and near(a[0]["lat"], 43.65) and near(a[0]["lng"], 51.18),
          f"{a[0]['lat']},{a[0]['lng']}" if a else "")
    check("gps form: altitude from third value", bool(a) and near(a[0]["alt"], 120.5))
    check("gps form: HOME() not mistaken for a fix",
          bool(a) and near(a[1]["lat"], 43.651) and near(a[1]["lng"], 51.181))
    check("gps form: wall clock", bool(a) and a[0]["timestamp"] == "2026-08-06T07:14:00",
          str(a[0]["timestamp"]) if a else "")

    b = parse_srt(SRT_LABELLED)
    check("labelled form: two cues", len(b) == 2, f"got {len(b)}")
    check("labelled form: coordinates",
          bool(b) and near(b[0]["lat"], 43.65) and near(b[0]["lng"], 51.18))
    check("labelled form: rel_alt preferred over abs_alt",
          bool(b) and near(b[0]["alt"], 120.5), str(b[0]["alt"]) if b else "")
    check("labelled form: millisecond wall clock",
          bool(b) and b[0]["timestamp"] == "2026-08-06T07:14:00.123",
          str(b[0]["timestamp"]) if b else "")
    check("labelled form: 33ms cue start", bool(b) and near(b[1]["t"], 0.033))

    c = parse_srt(SRT_BARE)
    check("bare form: one cue", len(c) == 1, f"got {len(c)}")
    check("bare form: coordinates and altitude",
          bool(c) and near(c[0]["lat"], 43.652) and near(c[0]["lng"], 51.182)
          and near(c[0]["alt"], 122.0))
    check("bare form: clock line not read as coordinates",
          all(p["lat"] != 2026.0 for p in parse_srt(SRT_LABELLED)))

    d = parse_srt(SRT_SWAPPED)
    check("swap rescue: transposed labels corrected",
          len(d) == 1 and near(d[0]["lat"], 43.65) and near(d[0]["lng"], 51.18),
          str(d))

    e = parse_srt(SRT_OUT_OF_BASIN)
    check("out of basin: Paris fix dropped, Caspian fix kept",
          len(e) == 1 and near(e[0]["lat"], 43.65) and near(e[0]["t"], 1.0), str(e))
    check("no-fix zeros dropped",
          parse_srt("1\n00:00:00,000 --> 00:00:01,000\n[latitude: 0.0] [longitude: 0.0]\n") == [])
    check("empty input", parse_srt("") == [] and parse_srt("nothing here") == [])
    short_ms = parse_srt(
        "1\n00:00:01,5 --> 00:00:02,0\n2026-08-06 07:14:00,5\nGPS(51.18,43.65,120)\n"
    )
    check("short millisecond field reads as a fraction in both t and the clock",
          len(short_ms) == 1 and near(short_ms[0]["t"], 1.5)
          and short_ms[0]["timestamp"] == "2026-08-06T07:14:00.500", str(short_ms))

    print("-- parse_json_sidecar ---------------------------------------")

    j1 = parse_json_sidecar({"track": [
        {"t": 0.0, "lat": 43.65, "lng": 51.18, "alt": 120.0},
        {"t": 2.0, "lat": 43.66, "lng": 51.19, "alt": 122.0},
    ]})
    check("sidecar: {track:[..]}", len(j1) == 2 and near(j1[1]["lat"], 43.66))

    j2 = parse_json_sidecar([
        {"latitude": 43.65, "longitude": 51.18, "altitude": 120.0},
        {"latitude": 43.66, "lon": 51.19},
    ])
    check("sidecar: bare list with aliases",
          len(j2) == 2 and near(j2[0]["alt"], 120.0) and near(j2[1]["lng"], 51.19))
    check("sidecar: missing t numbered at 1 Hz",
          len(j2) == 2 and near(j2[0]["t"], 0.0) and near(j2[1]["t"], 1.0))

    j3 = parse_json_sidecar({"lat": 43.65, "lng": 51.18})
    check("sidecar: single pin", len(j3) == 1 and near(j3[0]["lng"], 51.18))

    j4 = parse_json_sidecar({"points": [{"lat": 51.18, "lng": 43.65}]})
    check("sidecar: swap rescue", len(j4) == 1 and near(j4[0]["lat"], 43.65))

    j5 = parse_json_sidecar({"gps": [
        {"lat": 48.8566, "lng": 2.3522},
        {"lat": 43.65, "lng": 51.18, "timestamp": "2026-08-06T07:14:00Z"},
    ]})
    check("sidecar: out-of-basin dropped, timestamp kept",
          len(j5) == 1 and j5[0]["timestamp"] == "2026-08-06T07:14:00Z", str(j5))
    j6 = parse_json_sidecar({"lat": 43.65, "lng": 51.18, "width": 1698, "height": 1082})
    check("sidecar: image dimensions are not read as altitude",
          len(j6) == 1 and j6[0]["alt"] is None, str(j6))
    check("sidecar: height IS altitude when there are no dimensions alongside",
          near((parse_json_sidecar([{"lat": 43.65, "lng": 51.18, "height": 120.0}])
                or [{}])[0].get("alt"), 120.0))
    check("sidecar: junk tolerated",
          parse_json_sidecar(None) == [] and parse_json_sidecar("not json") == []
          and parse_json_sidecar('{"track":[{"lat":43.65,"lng":51.18}]}') != [])

    print("-- track_at -------------------------------------------------")

    track = parse_srt(SRT_GPS)
    mid = track_at(track, 0.5)
    check("interpolation: midpoint",
          mid is not None and near(mid["lat"], 43.6505) and near(mid["lng"], 51.1805)
          and near(mid["alt"], 121.0), str(mid))
    check("interpolation: clamped before start",
          (track_at(track, -10.0) or {}).get("lat") == 43.65)
    check("interpolation: clamped after end",
          (track_at(track, 999.0) or {}).get("lat") == 43.651)
    check("interpolation: exact sample", near((track_at(track, 1.0) or {})["lat"], 43.651))
    check("interpolation: empty track is None",
          track_at([], 1.0) is None and track_at(None, 1.0) is None)
    check("interpolation: single point track",
          near((track_at([{"t": 5.0, "lat": 43.65, "lng": 51.18, "alt": None}], 0.0) or {})["lat"],
               43.65))

    print("-- projection -----------------------------------------------")

    W, H = 1698, 1082
    CLAT, CLNG, GSD = 43.65, 51.18, 3.1

    lat, lng = pixel_to_latlng(W / 2, H / 2, W, H, CLAT, CLNG, GSD)
    check("centre pixel returns the centre", lat == CLAT and lng == CLNG, f"{lat},{lng}")

    lat, lng = pixel_to_latlng(W / 2 + 100, H / 2, W, H, CLAT, CLNG, GSD)
    east_m = 100 * GSD / 100.0
    check("100px right at heading 0 is due east",
          near(lat, CLAT, 1e-12)
          and near(lng, CLNG + east_m / (METRES_PER_DEG_LAT * math.cos(math.radians(CLAT))), 1e-9),
          f"{lat},{lng}")

    lat, lng = pixel_to_latlng(W / 2, H / 2 - 100, W, H, CLAT, CLNG, GSD)
    check("100px up at heading 0 is due north",
          near(lat, CLAT + east_m / METRES_PER_DEG_LAT, 1e-9) and near(lng, CLNG, 1e-12),
          f"{lat},{lng}")

    lat, lng = pixel_to_latlng(W / 2 + 100, H / 2, W, H, CLAT, CLNG, GSD, heading_deg=90.0)
    check("heading 90 turns image-right into due south",
          lat < CLAT and near(lat, CLAT - east_m / METRES_PER_DEG_LAT, 1e-9)
          and near(lng, CLNG, 1e-9), f"{lat},{lng}")

    check("unknown scale returns None, it does not invent a position",
          pixel_to_latlng(0, 0, W, H, CLAT, CLNG, 0.0) is None
          and pixel_to_latlng(0, 0, W, H, CLAT, CLNG, None) is None
          and pixel_to_latlng(0, 0, 0, 0, CLAT, CLNG, GSD) is None,
          str(pixel_to_latlng(0, 0, W, H, CLAT, CLNG, 0.0)))
    check("a non-finite input yields None, never a NaN coordinate",
          pixel_to_latlng(0, 0, W, H, CLAT, CLNG, float("nan")) is None
          and pixel_to_latlng(0, 0, W, H, CLAT, CLNG, GSD, float("nan")) is None
          and pixel_to_latlng(float("inf"), 0, W, H, CLAT, CLNG, GSD) is None)

    print("-- gsd_for_media --------------------------------------------")

    g = gsd_for_media(120.0, 5472)
    check("120m over a 5472px frame is ~3.3 cm/px", 3.0 < g < 3.5, f"{g:.3f}")
    check("matches the contract exactly", g == gsd_from_altitude(120.0, 5472, 13.2, 8.8))
    check("unknown altitude is 0.0",
          gsd_for_media(0.0, 5472) == 0.0 and gsd_for_media(None, 5472) == 0.0
          and gsd_for_media(120.0, 0) == 0.0)

    print("-- estimate_heading -----------------------------------------")

    h = estimate_heading(track, 0.5)
    check("north-east leg reads ~36 degrees", 30.0 < h < 42.0, f"{h:.2f}")
    check("empty and single-point tracks are unknown",
          estimate_heading([], 0.0) == 0.0
          and estimate_heading([{"t": 0.0, "lat": 43.65, "lng": 51.18}], 0.0) == 0.0)
    hover = [{"t": float(i), "lat": 43.65 + i * 1e-7, "lng": 51.18} for i in range(4)]
    check("a hover reads unknown, not north", estimate_heading(hover, 1.5) == 0.0)
    due_east = [
        {"t": 0.0, "lat": 43.65, "lng": 51.18},
        {"t": 1.0, "lat": 43.65, "lng": 51.19},
    ]
    check("due-east leg reads ~90 degrees",
          89.0 < estimate_heading(due_east, 0.5) < 91.0,
          f"{estimate_heading(due_east, 0.5):.2f}")
    check("heading is clamped past the end of the track",
          89.0 < estimate_heading(due_east, 99.0) < 91.0)

    # A lawnmower transect whose telemetry starts late, which is what a dropped
    # no-fix prefix produces. Frame 0 is sampled at t=0, before the first
    # surviving cue: its heading must come from the FIRST leg, not the last.
    lawnmower = [
        {"t": 5.0, "lat": 43.650, "lng": 51.180},
        {"t": 6.0, "lat": 43.650, "lng": 51.190},   # east  (090)
        {"t": 7.0, "lat": 43.651, "lng": 51.190},
        {"t": 8.0, "lat": 43.651, "lng": 51.180},   # west  (270), reciprocal
    ]
    check("heading before the first sample clamps to the FIRST leg",
          89.0 < estimate_heading(lawnmower, 0.0) < 91.0,
          f"{estimate_heading(lawnmower, 0.0):.2f}")
    check("heading after the last sample still clamps to the last leg",
          269.0 < estimate_heading(lawnmower, 99.0) < 271.0,
          f"{estimate_heading(lawnmower, 99.0):.2f}")
    check("no-fix prefix through parse_srt: frame 0 gets the first leg",
          89.0 < estimate_heading(parse_srt(
              "1\n00:00:00,000 --> 00:00:01,000\nGPS(-,-,0.0)\n\n"
              "2\n00:00:05,000 --> 00:00:06,000\nGPS(51.180000,43.650000,120)\n\n"
              "3\n00:00:06,000 --> 00:00:07,000\nGPS(51.190000,43.650000,120)\n\n"
              "4\n00:00:08,000 --> 00:00:09,000\nGPS(51.180000,43.651000,120)\n"
          ), 0.0) < 91.0)

    print("-- end to end -----------------------------------------------")

    # a frame sampled at t=0.5s, detection at the top-left corner of the frame
    pos = track_at(track, 0.5)
    gsd = gsd_for_media(pos["alt"], W)
    plat, plng = pixel_to_latlng(0, 0, W, H, pos["lat"], pos["lng"], gsd,
                                 estimate_heading(track, 0.5))
    check("top-left detection lands within ~200m of the drone",
          _ground_distance_m({"lat": pos["lat"], "lng": pos["lng"]},
                             {"lat": plat, "lng": plng}) < 200.0,
          f"{plat:.6f},{plng:.6f} gsd={gsd:.2f}cm/px")
    check("projected point stays in the basin", _in_basin(plat, plng))

    print("-------------------------------------------------------------")
    if _failures:
        print(f"FAILED {len(_failures)}: {', '.join(_failures)}")
        sys.exit(1)
    print("ALL PASS")
