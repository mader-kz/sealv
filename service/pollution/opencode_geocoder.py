"""Coordinate and verified-place resolution for Caspian pollution reports."""
from __future__ import annotations

import json
from dataclasses import dataclass
import logging
import math
import os
import re
from urllib.parse import quote

from .completion_config import completion_config
from .net import fetch

try:
    from .fields import geocode_field
except ImportError:  # pragma: no cover - direct script import
    from service.pollution.fields import geocode_field

logger = logging.getLogger(__name__)

@dataclass(frozen=True)
class ReportExtraction:
    place: str | None
    root_cause: str | None


@dataclass(frozen=True)
class GeocodeResult:
    lat: float
    lng: float
    radius_m: float
    place: str
    root_cause: str | None

# Coarse display-only Caspian mask retained for poller precision labels. It must
# never be used to move or invent an incident coordinate.
HULL = [
    (47.1, 47.4),
    (48.2, 47.0),
    (49.4, 46.1),
    (50.4, 45.0),
    (51.0, 44.2),
    (51.3, 43.4),
    (51.55, 42.6),
    (51.7, 41.6),
    (51.6, 40.3),
    (51.1, 39.1),
    (50.3, 38.0),
    (49.2, 37.1),
    (48.0, 36.9),
    (47.1, 37.3),
    (46.6, 38.2),
    (46.4, 39.6),
    (46.45, 41.0),
    (46.7, 42.6),
    (47.0, 44.2),
    (47.1, 47.4),
]


def _in_poly(lng: float, lat: float) -> bool:
    inside = False
    for index in range(len(HULL)):
        xi, yi = HULL[index]
        xj, yj = HULL[index - 1]
        if (yi > lat) != (yj > lat) and lng < (
            (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi
        ):
            inside = not inside
    return inside


def is_water(lat: float, lng: float) -> bool:
    if lat < 36.6 or lat > 47.6 or lng < 46.0 or lng > 52.0:
        return False
    if not _in_poly(lng, lat):
        return False
    east = (
        50.85
        if lat > 45.2
        else 51.05
        if lat > 44.2
        else 51.0
        if lat > 42.8
        else 51.45
        if lat > 41.8
        else 51.4
        if lat > 39.5
        else 51.0
    )
    if lng > east:
        return False
    west = 47.0 if lat > 42.5 else 46.8 if lat > 40.5 else 46.6 if lat > 38.5 else 47.5
    return lng >= west


def snap_to_water(
    lat: float, lng: float, clat: float = 42.8, clng: float = 50.1
) -> tuple[float, float] | None:
    """Compatibility validator; never move a coordinate to arbitrary water."""
    del clat, clng
    return (lat, lng) if is_water(lat, lng) else None


isWater = is_water
snapToWater = snap_to_water

_COMPONENT_RE = re.compile(
    r"(?<!\d)"
    r"(?P<degrees>\d{1,3}(?:[.,]\d+)?)\s*(?:°|º|deg)?\s*"
    r"(?:(?P<minutes>\d{1,2}(?:[.,]\d+)?)\s*(?:['′’]|min)\s*)?"
    r"(?:(?P<seconds>\d{1,2}(?:[.,]\d+)?)\s*(?:[\"″”]|sec)\s*)?"
    r"(?P<direction>[NSEW])\b",
    re.IGNORECASE,
)
_PREFIX_COMPONENT_RE = re.compile(
    r"\b(?P<direction>[NSEW])\s*"
    r"(?P<degrees>\d{1,3}(?:[.,]\d+)?)\s*(?:°|º|deg)?\s*"
    r"(?:(?P<minutes>\d{1,2}(?:[.,]\d+)?)\s*(?:['′’]|min)\s*)?"
    r"(?:(?P<seconds>\d{1,2}(?:[.,]\d+)?)\s*(?:[\"″”]|sec))?",
    re.IGNORECASE,
)
_DECIMAL_DOT_RE = re.compile(
    r"(?<![\d.])(?:lat(?:itude)?\s*[:=]\s*)?"
    r"(?P<first>[-+]?\d{1,3}\.\d{3,})"
    r"(?:\s*[,;/]\s*|\s+(?:lon(?:gitude)?\s*[:=]\s*)?)"
    r"(?P<second>[-+]?\d{1,3}\.\d{3,})(?![\d.])",
    re.IGNORECASE,
)
_DECIMAL_COMMA_RE = re.compile(
    r"(?<![\d,])(?P<first>[-+]?\d{1,3},\d{3,})"
    r"(?:\s*;\s*|\s+)"
    r"(?P<second>[-+]?\d{1,3},\d{3,})(?![\d,])"
)


def _normalise_directions(text: str) -> str:
    replacements = {
        r"С\s*\.?\s*Ш\s*\.?": "N",
        r"Ю\s*\.?\s*Ш\s*\.?": "S",
        r"В\s*\.?\s*Д\s*\.?": "E",
        r"З\s*\.?\s*Д\s*\.?": "W",
    }
    result = text
    for pattern, replacement in replacements.items():
        result = re.sub(pattern, replacement, result, flags=re.IGNORECASE)
    return result


def _decimal_places(raw: str) -> int:
    parts = re.split(r"[.,]", raw, maxsplit=1)
    return len(parts[1]) if len(parts) == 2 else 0


def _component(match: re.Match[str]) -> tuple[str, float, float] | None:
    direction = match.group("direction").upper()
    degrees_raw = match.group("degrees").replace(",", ".")
    minutes_raw = match.group("minutes")
    seconds_raw = match.group("seconds")
    degrees = float(degrees_raw)
    if minutes_raw is None and seconds_raw is None and "." not in degrees_raw:
        return None
    minutes = float(minutes_raw.replace(",", ".")) if minutes_raw else 0.0
    seconds = float(seconds_raw.replace(",", ".")) if seconds_raw else 0.0
    if minutes >= 60 or seconds >= 60:
        return None
    value = degrees + minutes / 60.0 + seconds / 3600.0
    if direction in ("S", "W"):
        value = -value
    if seconds_raw:
        radius = max(15.0, 31.0 / (10 ** _decimal_places(seconds_raw)))
    elif minutes_raw:
        radius = max(50.0, 1000.0 / (10 ** _decimal_places(minutes_raw)))
    else:
        radius = max(25.0, 55500.0 / (10 ** _decimal_places(degrees_raw)))
    axis = "lat" if direction in ("N", "S") else "lng"
    return axis, value, radius


def _valid_regional_pair(lat: float, lng: float) -> bool:
    return 35.0 <= lat <= 49.5 and 45.0 <= lng <= 56.5


def _ordered_pair(first: float, second: float) -> tuple[float, float] | None:
    if _valid_regional_pair(first, second):
        return first, second
    if _valid_regional_pair(second, first):
        return second, first
    return None


def _coordinate_match(text: str) -> tuple[float, float, float] | None:
    normalised = _normalise_directions(text)
    components: dict[str, tuple[float, float]] = {}
    for pattern in (_COMPONENT_RE, _PREFIX_COMPONENT_RE):
        for match in pattern.finditer(normalised):
            parsed = _component(match)
            if parsed and parsed[0] not in components:
                components[parsed[0]] = (parsed[1], parsed[2])
    if "lat" in components and "lng" in components:
        lat, lat_radius = components["lat"]
        lng, lng_radius = components["lng"]
        if _valid_regional_pair(lat, lng):
            return lat, lng, max(lat_radius, lng_radius)

    for pattern in (_DECIMAL_DOT_RE, _DECIMAL_COMMA_RE):
        match = pattern.search(text)
        if not match:
            continue
        first_raw = match.group("first")
        second_raw = match.group("second")
        pair = _ordered_pair(
            float(first_raw.replace(",", ".")),
            float(second_raw.replace(",", ".")),
        )
        if pair:
            precision = min(_decimal_places(first_raw), _decimal_places(second_raw))
            radius = max(25.0, 55500.0 / (10**precision))
            return pair[0], pair[1], radius
    return None


def extract_coordinates(text: str) -> tuple[float, float] | None:
    """Parse regional decimal, DM, or DMS source coordinates."""
    if not isinstance(text, str) or not text:
        return None
    match = _coordinate_match(text)
    return (match[0], match[1]) if match else None


def _timeout_seconds(name: str, default: float = 5.0) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return min(30.0, max(1.0, value))


def _extract_json_object(content: str) -> dict[str, object]:
    decoder = json.JSONDecoder()
    for index, character in enumerate(content):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(content[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ValueError("report extractor returned no JSON object")


def _validated_place(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    place = " ".join(value.split())
    return place if 1 <= len(place) <= 200 else None


def validate_root_cause(value: object) -> str | None:
    """Accept only the uncertainty-qualified one-sentence root-cause contract."""
    if not isinstance(value, str):
        return None
    cause = " ".join(value.split())
    if not cause or len(cause) > 240:
        return None
    if cause == "Cause not yet determined.":
        return cause
    if not (cause.startswith("Reported ") or cause.startswith("Suspected ")):
        return None
    without_final_mark = cause[:-1] if cause[-1:] in ".!?" else cause
    if re.search(r"[.!?]\s+\S", without_final_mark):
        return None
    return cause


def extract_report_details(text: str) -> ReportExtraction:
    """Extract one stated place and uncertainty-qualified cause in one completion."""
    if not isinstance(text, str) or not text.strip():
        return ReportExtraction(None, None)
    verified = geocode_field(text)
    verified_place = verified[3] if verified else None
    config = completion_config(
        "POLLUTION_GEOCODER", fallback_prefix="POLLUTION_CLASSIFIER"
    )
    if config is None:
        return ReportExtraction(verified_place, None)
    endpoint, model, key = config
    prompt = (
        "Read this Russian, Kazakh, or English pollution report. Extract the most "
        "specific location explicitly stated and the reported or alleged causal "
        "event. Return only JSON with exactly these fields: "
        '{"place":"name or null","root_cause":"sentence"}. Use null for place '
        "when no location is stated. root_cause must be one concise factual "
        "sentence of at most 240 characters and must start with Reported or "
        "Suspected. If the text does not report or allege a causal event, use "
        'exactly "Cause not yet determined." Never infer a cause from the '
        "location, pollutant, nearby industry, or headline framing. Never copy "
        "the article title as the cause, and never name an actor, vessel, or "
        "equipment that the text does not identify.\n\n"
        f"Text:\n{text[:3000]}"
    )
    payload = json.dumps(
        {
            "model": model,
            "temperature": 0,
            "max_tokens": 256,
            "messages": [{"role": "user", "content": prompt}],
        }
    ).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "SEALv-Pollution/1.0",
    }
    if key:
        headers["Authorization"] = f"Bearer {key}"
    try:
        response = fetch(
            endpoint,
            data=payload,
            headers=headers,
            method="POST",
            timeout=_timeout_seconds("POLLUTION_GEOCODER_TIMEOUT", 20.0),
            max_bytes=1024 * 1024,
        )
        data = json.loads(response.body.decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        extracted = _extract_json_object(content) if isinstance(content, str) else {}
        return ReportExtraction(
            verified_place or _validated_place(extracted.get("place")),
            validate_root_cause(extracted.get("root_cause")),
        )
    except Exception as exc:
        logger.warning(
            "pollution report extraction failed: endpoint=%s error=%s",
            endpoint,
            type(exc).__name__,
        )
        return ReportExtraction(verified_place, None)


def _normalise_words(value: str) -> list[str]:
    return [
        word
        for word in re.sub(r"[\W_]+", " ", value.casefold(), flags=re.UNICODE).split()
        if len(word) >= 4
        and word
        not in {
            "field",
            "месторождение",
            "область",
            "region",
            "район",
            "district",
            "пляж",
            "beach",
            "город",
            "city",
        }
    ]


def _result_matches_place(place: str, display_name: str) -> bool:
    display = " ".join(_normalise_words(display_name))
    return any(word in display for word in _normalise_words(place))


def _result_radius(item: dict[str, object], lat: float) -> float:
    box = item.get("boundingbox")
    if isinstance(box, list) and len(box) == 4:
        try:
            south, north, west, east = (float(value) for value in box)
            half_height = abs(north - south) * 111000.0 / 2.0
            half_width = (
                abs(east - west) * 111000.0 * math.cos(math.radians(lat)) / 2.0
            )
            return max(100.0, round(math.hypot(half_height, half_width) / 100.0) * 100.0)
        except (TypeError, ValueError):
            pass
    kind = f"{item.get('category', '')} {item.get('class', '')} {item.get('type', '')}".lower()
    if "industrial" in kind:
        return 10000.0
    if "city" in kind or "town" in kind or "village" in kind:
        return 5000.0
    if "bay" in kind:
        return 10000.0
    return 3000.0


def geocode_place(place: str) -> tuple[float, float, float, str] | None:
    """Resolve source coordinates or a verified named place; never snap/default."""
    if not isinstance(place, str) or not place.strip():
        return None
    coordinate = _coordinate_match(place)
    if coordinate:
        return coordinate[0], coordinate[1], coordinate[2], "source coordinates"
    verified = geocode_field(place)
    if verified:
        return verified

    params = (
        f"q={quote(place)}&format=jsonv2&limit=5&addressdetails=1"
        "&countrycodes=kz,ru,az,tm,ir&bounded=1&viewbox=45,49.5,56.5,35"
    )
    endpoint = f"https://nominatim.openstreetmap.org/search?{params}"
    headers = {
        "Accept": "application/json",
        "User-Agent": os.environ.get(
            "POLLUTION_USER_AGENT", "SEALv-Pollution/1.0"
        ),
    }
    try:
        response = fetch(
            endpoint,
            headers=headers,
            timeout=_timeout_seconds("POLLUTION_GEOCODER_TIMEOUT"),
            max_bytes=2 * 1024 * 1024,
        )
        results = json.loads(response.body.decode("utf-8"))
    except Exception as exc:
        logger.warning("Nominatim place lookup failed: place=%r error=%s", place, exc)
        return None
    if not isinstance(results, list):
        logger.warning("Nominatim returned a non-list response for place=%r", place)
        return None
    for item in results:
        if not isinstance(item, dict):
            continue
        display_name = str(item.get("display_name") or "")
        if not _result_matches_place(place, display_name):
            continue
        try:
            lat = float(item["lat"])
            lng = float(item["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not _valid_regional_pair(lat, lng):
            continue
        return lat, lng, _result_radius(item, lat), display_name
    logger.info("place unresolved after verified lookup: %r", place)
    return None


def geocode_via_opencode(text: str) -> GeocodeResult | None:
    """Resolve coordinates and attach one combined place/root-cause extraction."""
    if not isinstance(text, str) or not text.strip():
        return None
    coordinate = _coordinate_match(text)
    details = extract_report_details(text)
    if coordinate:
        return GeocodeResult(
            coordinate[0],
            coordinate[1],
            coordinate[2],
            "source coordinates",
            details.root_cause,
        )
    if not details.place:
        logger.info("pollution location unresolved: no coordinates or named place")
        return None
    resolved = geocode_place(details.place)
    if resolved is None:
        return None
    return GeocodeResult(
        resolved[0],
        resolved[1],
        resolved[2],
        resolved[3],
        details.root_cause,
    )
