"""Environmental sources for the Caspian: one client per PROVEN feed.

Every source in this file was verified with a live request over the basin
before a line of it was written, and the evidence is recorded in
`docs/research/2026-08-10-caspian-data-sources.md`. That document is the
contract this module implements; it also lists the feeds that are dead, and
those are not merely absent here - some of them are named in `_BANNED_MODELS`
so that a future edit cannot quietly reintroduce one.

Why so much care about which feed: the Caspian is an endorheic basin. Global
ocean MODELS mask it as land, satellite RETRIEVALS do not (their lake masks
know about it). That single fact predicts almost every result. The dangerous
consequence is that a masked model does not always answer with an error - NCEP
GFS-Wave returns `[0.0, 0.0, 0.0, ...]` with HTTP 200 and not one null over a
basin where it has zero grid nodes. A pipeline that swallows those zeros learns
that the Caspian is always calm. Hence the rule this module enforces everywhere:

    a source that returns a fill value, a null, or a NaN must return None.
    It must never return zero, and it must never be silently dropped.

The shape every client returns
------------------------------
One normalised sample dict, or None when the source genuinely has no value at
that point and time:

    {
      "source":        "mur",                    # stable id, see SOURCES
      "dataset":       "jplMURSST41",            # exact product identifier
      "measured_at":   "2026-08-05T09:00:00Z",   # the SLICE's time, not now
      "lat": 44.85, "lng": 50.35,                # the CELL CENTRE returned,
                                                 # not the coordinate asked for
      "values":        {"sst_c": 27.407},        # only the keys it measured
      "resolution_m":  1000,                     # NULL for a basin-wide figure
      "resolution":    "0.01° (~1 km)",     # human form of the same fact
      "scope":         "point",                  # point | basin
      "latency_note":  "L4 analysis, ~2 days behind",
    }

`measured_at` and `source` travel with the value all the way to the UI. "26.8
°C" on its own is not an acceptable thing to show a biologist; "26.8 °C
· MUR 1 km · slice 2026-08-05" is. The value carries its own
provenance because one point and one time is served by five or six different
feeds with different lags and different cell sizes, and mixing them into a
single smooth field would be a picture of something nobody measured.

Caching and rate
----------------
Responses are cached on disk (`$SEALV_ENV_CACHE`, else `<workspace>/env-cache`)
keyed by the exact request URL, with a per-source TTL. That is what makes a
backfill of twenty surveys cost twenty requests once and zero on every rerun,
and it is also the politeness budget: ERDDAP is a free public service run for
scientists, and hammering it is how a free source stops being one. On top of
the cache there is a per-host minimum interval between live requests.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import re
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

__all__ = [
    "SourceError", "SOURCES", "CASPIAN_BBOX", "is_caspian_water",
    "openmeteo_forecast", "openmeteo_archive", "openmeteo_waves",
    "mur_sst", "coraltemp_sst", "viirs_ice", "ims_ice", "viirs_chl",
    "gwm_sea_level", "weather", "collect_point", "collect_grid",
    "VALUE_COLUMNS", "as_utc", "iso", "cache_dir", "caspian_grid",
    "weather_source_for", "POINT_SOURCES",
]


# --------------------------------------------------------------------------
# what a sample may carry
# --------------------------------------------------------------------------

#: Every measurable this module can produce, in the order the schema declares
#: them. A client may fill any subset; anything it did not measure is simply
#: absent from `values` (absent, never 0.0 - see the module docstring).
VALUE_COLUMNS = (
    "wind_ms", "wind_dir", "gust_ms", "air_t", "pressure", "cloud",
    "wave_m", "wave_period_s",
    "sst_c", "sst_anomaly_c",
    "ice_class", "ice_conc", "ice_thickness_m",
    "chl_a", "sea_level_m",
)

#: Bounding box of the basin, generous on every side. Used for the coarse
#: collection grid and to refuse a point that is obviously not the Caspian.
CASPIAN_BBOX = {"lat_min": 36.5, "lat_max": 47.5, "lng_min": 46.0, "lng_max": 54.5}

#: Hull around the water, [lng, lat], ported verbatim from the frontend's
#: `lib/caspian.ts` so that the grid this module collects and the grid the map
#: draws agree about what is sea. It is an approximation and is only ever used
#: to decide where to SAMPLE - never to move a measured coordinate.
CASPIAN_HULL: tuple[tuple[float, float], ...] = (
    (47.1, 47.4), (48.2, 47.0), (49.4, 46.1), (50.4, 45.0), (51.0, 44.2),
    (51.3, 43.4), (51.55, 42.6), (51.7, 41.6), (51.6, 40.3), (51.1, 39.1),
    (50.3, 38.0), (49.2, 37.1), (48.0, 36.9), (47.1, 37.3), (46.6, 38.2),
    (46.4, 39.6), (46.45, 41.0), (46.7, 42.6), (47.0, 44.2), (47.1, 47.4),
)


def is_caspian_water(lat: float, lng: float) -> bool:
    """Approximately: is this point sea rather than steppe?

    Only used to choose grid cells worth requesting. A false negative costs one
    unsampled cell; a false positive costs one wasted request that the source
    will answer with a land NaN, which this module turns into None anyway.
    """
    if not (CASPIAN_BBOX["lat_min"] <= lat <= CASPIAN_BBOX["lat_max"]):
        return False
    if not (CASPIAN_BBOX["lng_min"] <= lng <= CASPIAN_BBOX["lng_max"]):
        return False
    inside = False
    pts = CASPIAN_HULL
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > lat) != (yj > lat):
            if lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi:
                inside = not inside
        j = i
    if not inside:
        return False
    # East coast: everything east of the Kazakh shoreline is land.
    if lat > 45.2:
        east = 50.85
    elif lat > 44.2:
        east = 51.05
    elif lat > 42.8:
        east = 51.00
    elif lat > 41.8:
        east = 51.45
    elif lat > 39.5:
        east = 51.4
    else:
        east = 51.0
    return lng <= east


# --------------------------------------------------------------------------
# registry
# --------------------------------------------------------------------------

#: Source ids are stable strings stored in the database and rendered by the
#: frontend through t("env.source.<id>"). Renaming one rewrites history, so
#: they are chosen to name the PRODUCT rather than the vendor's current URL.
SOURCES: dict[str, dict] = {
    "openmeteo_icon_eu": {
        "dataset": "icon_eu",
        "vars": ("wind_ms", "wind_dir", "gust_ms", "air_t", "pressure", "cloud"),
        "resolution_m": 6500,
        "resolution": "6.5 km (ICON-EU)",
        "scope": "point",
        "latency_note": "Forecast model, 3-hourly cycle; the finest atmospheric grid published over the basin",
        "ttl_s": 3 * 3600,
        "window_h": 3,
    },
    "openmeteo_era5": {
        "dataset": "era5",
        "vars": ("wind_ms", "wind_dir", "gust_ms", "air_t", "pressure", "cloud"),
        "resolution_m": 27000,
        "resolution": "0.25° (~27 km)",
        "scope": "point",
        "latency_note": "ERA5 reanalysis, hourly back to 1940, ~5 days behind real time",
        "ttl_s": 30 * 86400,
        "window_h": 3,
    },
    "openmeteo_mfwam": {
        "dataset": "meteofrance_wave",
        "vars": ("wave_m", "wave_period_s"),
        "resolution_m": 8000,
        "resolution": "0.08° (~8 km)",
        "scope": "point",
        "latency_note": "MFWAM wave model, 3-hourly steps; free tier is non-commercial (see the research doc §5)",
        "ttl_s": 3 * 3600,
        "window_h": 3,
    },
    "mur": {
        "dataset": "jplMURSST41",
        "vars": ("sst_c",),
        "resolution_m": 1000,
        "resolution": "0.01° (~1 km)",
        "scope": "point",
        "latency_note": "GHRSST MUR L4 analysis, ~2 days behind; the Caspian is mask=5 open_lake",
        "ttl_s": 7 * 86400,
        "window_h": 120,
    },
    "coraltemp": {
        "dataset": "CoralTemp v3.1 (dhw_5km)",
        "vars": ("sst_c", "sst_anomaly_c"),
        "resolution_m": 5000,
        "resolution": "5 km",
        "scope": "point",
        "latency_note": "CoralTemp daily, ~2 days behind; the long baseline the anomaly is measured against",
        "ttl_s": 7 * 86400,
        "window_h": 120,
    },
    "ims": {
        "dataset": "NOAA IMS 1 km (NSIDC G02156)",
        "vars": ("ice_class",),
        "resolution_m": 1000,
        "resolution": "1 km",
        "scope": "point",
        "latency_note": "Daily analyst-drawn ice chart, ~2 days behind; boundary only, no concentration",
        "ttl_s": 30 * 86400,
        "window_h": 120,
    },
    "viirs_ice": {
        "dataset": "noaacwVIIRSn20ice*XZ00Daily",
        "vars": ("ice_conc", "ice_thickness_m"),
        "resolution_m": 750,
        "resolution": "750 m",
        "scope": "point",
        "latency_note": "VIIRS Enterprise Ice; thickness comes from a 4-day composite, so it lags ~6 days. A NaN here is usually cloud, not open water - read IMS for that",
        "ttl_s": 7 * 86400,
        "window_h": 168,
    },
    "viirs_chl": {
        "dataset": "noaacwNPPN20VIIRSDINEOFDaily",
        "vars": ("chl_a",),
        "resolution_m": 9000,
        "resolution": "9 km",
        "scope": "point",
        "latency_note": "VIIRS chlorophyll with DINEOF cloud-gap filling - a RECONSTRUCTION where the sky was closed, which at Tyuleniy is 60-75% of days",
        "ttl_s": 7 * 86400,
        "window_h": 168,
    },
    "gwm_sea_level": {
        "dataset": "NASA GSFC GWM target 000270 (lake000270.10d.2)",
        "vars": ("sea_level_m",),
        "resolution_m": None,
        "resolution": "whole basin",
        "scope": "basin",
        "latency_note": "Radar altimetry, one figure per 10 days for the whole sea, ~6 days behind",
        "ttl_s": 86400,
        "window_h": 480,
    },
}

#: Models proven to answer over the Caspian with fabricated data rather than an
#: error. Requesting one is a bug, so it is refused in code rather than left to
#: a comment somebody deletes. See the research doc §4.
_BANNED_MODELS = {
    "ncep_gfswave025", "ncep_gfswave016", "gfswave",      # all-zero waves, HTTP 200
    "era5_land", "era5_seamless", "best_match",           # soil temperature over 583 m of water
}


class SourceError(RuntimeError):
    """The source could not be reached or answered with something unusable.

    Distinct from returning None, which means "reached it, it has no value
    here". The difference decides whether a caller should retry later or
    accept that this cell has no measurement, and collapsing the two is how a
    transport outage turns into a permanent hole in the archive.
    """


# --------------------------------------------------------------------------
# http, cache, rate
# --------------------------------------------------------------------------

USER_AGENT = os.environ.get(
    "SEALV_ENV_UA",
    "SEALv/1.0 (Caspian seal aerial survey platform; environmental layer ingest)",
)

DEFAULT_TIMEOUT = float(os.environ.get("SEALV_ENV_TIMEOUT") or 60.0)
DEFAULT_ATTEMPTS = int(os.environ.get("SEALV_ENV_ATTEMPTS") or 3)

#: Minimum seconds between two live requests to the same host, per process.
#: ERDDAP is a shared public service; a backfill loop with no spacing is how a
#: free source acquires a rate limit.
HOST_MIN_INTERVAL_S = float(os.environ.get("SEALV_ENV_HOST_INTERVAL") or 1.0)

_HOST_LOCK = threading.Lock()
_HOST_LAST: dict[str, float] = {}


def cache_dir() -> Path:
    raw = (os.environ.get("SEALV_ENV_CACHE") or "").strip()
    if raw:
        path = Path(raw).expanduser()
    else:
        ws = (os.environ.get("SEALV_WORKSPACE") or "").strip()
        base = Path(ws).expanduser() if ws else Path.home() / ".sealv" / "workspace"
        path = base / "env-cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _cache_path(url: str) -> Path:
    return cache_dir() / (hashlib.sha256(url.encode("utf-8")).hexdigest()[:32] + ".cache")


def _space_out(host: str) -> None:
    with _HOST_LOCK:
        last = _HOST_LAST.get(host, 0.0)
        wait = HOST_MIN_INTERVAL_S - (time.monotonic() - last)
        if wait > 0:
            time.sleep(wait)
        _HOST_LAST[host] = time.monotonic()


def fetch(
    url: str,
    *,
    ttl_s: float,
    timeout: float = DEFAULT_TIMEOUT,
    attempts: int = DEFAULT_ATTEMPTS,
    on_404: str = "raise",
) -> Optional[bytes]:
    """GET with a disk cache, spacing and bounded retry.

    404 gets its own handling because on these hosts it is not one thing.
    ERDDAP answers 404 both for "your query produced no matching results" - a
    real, cacheable answer meaning the cell is empty - and for "currently
    unknown datasetID", which is what a node says about its own catalogue while
    it is still reloading after a restart. Caching the second as "no data" for
    a week would turn a twenty-minute outage into a week-long hole nobody could
    see. So:

      on_404="raise"  - the default; a 404 is a failure.
      on_404="none"   - return None and remember it for `ttl_s` (a day the
                        producer never published).
      on_404="body"   - return the error body UNCACHED and let the caller read
                        which of the two it is.

    Retries cover 5xx, 429 and transport errors only. A 502 from the CoastWatch
    proxy is a daily fact of life on that host and a retry a minute later
    usually works; retrying a 400 would just be a slower 400.
    """
    path = _cache_path(url)
    if ttl_s > 0 and path.is_file():
        age = time.time() - path.stat().st_mtime
        if age < ttl_s:
            body = path.read_bytes()
            # A cached empty body is the memo of a 404, not a truncated read.
            return None if body == b"" else body

    host = urllib.parse.urlsplit(url).netloc
    last: Optional[Exception] = None
    for attempt in range(1, max(1, attempts) + 1):
        _space_out(host)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
            if ttl_s > 0:
                path.write_bytes(body)
            return body
        except urllib.error.HTTPError as exc:
            if exc.code == 404 and on_404 != "raise":
                if on_404 == "body":
                    try:
                        return exc.read()
                    except Exception:  # noqa: BLE001 - body already consumed
                        return b""
                if ttl_s > 0:
                    path.write_bytes(b"")
                return None
            last = exc
            if exc.code < 500 and exc.code != 429:
                break
        except Exception as exc:  # noqa: BLE001 - timeouts, DNS, reset, TLS
            last = exc
        if attempt < attempts:
            time.sleep(min(20.0, 2.0 ** attempt))
    raise SourceError(f"{url.split('?')[0]}: {type(last).__name__}: {last}")


def _fetch_json(url: str, **kw: Any) -> Optional[dict]:
    body = fetch(url, **kw)
    if body is None:
        return None
    text = body.decode("utf-8", "replace").lstrip()
    if not text.startswith("{") and not text.startswith("["):
        # ERDDAP answers "Error { code=404; ... }" as text/plain, and the
        # CoastWatch proxy answers with an HTML 502 page carrying HTTP 200.
        # Both would otherwise surface as a JSONDecodeError three frames away.
        raise SourceError(f"{url.split('?')[0]}: not JSON: {text[:160]!r}")
    return json.loads(text)


# --------------------------------------------------------------------------
# values that are not values
# --------------------------------------------------------------------------

def _num(value: Any) -> Optional[float]:
    """A finite float, or None. The single gate every measured number passes.

    NaN and infinity both arrive from real sources - NaN is how ERDDAP spells a
    masked cell in JSON (as the bare token `null`, but netCDF fill values also
    survive as float('nan') through some encodings), and infinity is what an
    overflowing text field becomes. Neither is a measurement, and neither may
    be written to the archive as 0.0.
    """
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_time(value: Any) -> Optional[datetime]:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _as_utc(when: Any) -> datetime:
    if isinstance(when, datetime):
        return when.replace(tzinfo=timezone.utc) if when.tzinfo is None else when.astimezone(timezone.utc)
    parsed = _parse_time(when)
    if parsed is None:
        raise ValueError(f"not a timestamp: {when!r}")
    return parsed


#: Public aliases. The worker and the backfill both need to turn an operator's
#: `--time` into the same UTC instant these clients use, and a second parser
#: elsewhere is how two timestamps quietly stop meaning the same moment.
as_utc = _as_utc
iso = _iso


def _sample(source: str, measured_at: str, lat: float, lng: float, values: dict) -> Optional[dict]:
    """Assemble a sample, or None when nothing survived the fill-value gate.

    A sample with an empty `values` is not a measurement of anything, and
    storing one would put a row in the archive whose only content is a source
    name and a time - which reads, on a chart, exactly like a zero.
    """
    kept = {k: v for k, v in values.items() if v is not None}
    if not kept:
        return None
    meta = SOURCES[source]
    return {
        "source": source,
        "dataset": meta["dataset"],
        "measured_at": measured_at,
        "lat": round(float(lat), 4),
        "lng": round(float(lng), 4),
        "values": kept,
        "resolution_m": meta["resolution_m"],
        "resolution": meta["resolution"],
        "scope": meta["scope"],
        "latency_note": meta["latency_note"],
    }


# --------------------------------------------------------------------------
# Open-Meteo (wind, air, waves)
# --------------------------------------------------------------------------

OPENMETEO_FORECAST = "https://api.open-meteo.com/v1/forecast"
OPENMETEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
OPENMETEO_MARINE = "https://marine-api.open-meteo.com/v1/marine"

_ATMO_VARS = (
    ("wind_speed_10m", "wind_ms"),
    ("wind_direction_10m", "wind_dir"),
    ("wind_gusts_10m", "gust_ms"),
    ("temperature_2m", "air_t"),
    ("surface_pressure", "pressure"),
    ("cloud_cover", "cloud"),
)
_WAVE_VARS = (("wave_height", "wave_m"), ("wave_period", "wave_period_s"))


def _openmeteo(base: str, params: dict, *, ttl_s: float) -> dict:
    model = params.get("models")
    if model in _BANNED_MODELS:
        # Not a defensive check against a typo: `best_match` on the archive API
        # resolves to era5_seamless, which prefers ERA5-Land, which reports a
        # soil temperature over 583 m of water (22.9 C at 42.0N/50.5E in the
        # research doc). It looks exactly like a sea temperature.
        raise SourceError(f"{model} is on the proven-fabricates list; refusing to call it")
    url = base + "?" + urllib.parse.urlencode(params)
    body = _fetch_json(url, ttl_s=ttl_s)
    if body is None:
        raise SourceError(f"{base}: 404")
    if body.get("error"):
        raise SourceError(f"{base}: {body.get('reason')}")
    return body


def _pick_hour(body: dict, when: datetime, pairs: Iterable[tuple[str, str]]) -> tuple[Optional[str], dict]:
    """The hour nearest `when`, and what it measured.

    Nearest rather than the containing hour: a survey at 07:14 is described by
    the 07:00 slice, and one at 07:46 by 08:00. The slice's own timestamp goes
    into the sample, so the reader can always see how far the two are apart.
    """
    hourly = body.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        return None, {}
    best_i, best_gap = None, None
    for i, raw in enumerate(times):
        parsed = _parse_time(raw if str(raw).endswith("Z") else f"{raw}Z")
        if parsed is None:
            continue
        gap = abs((parsed - when).total_seconds())
        if best_gap is None or gap < best_gap:
            best_i, best_gap = i, gap
    if best_i is None:
        return None, {}
    stamp = str(times[best_i])
    measured_at = stamp if stamp.endswith("Z") else f"{stamp}Z"
    if len(measured_at) == 17:  # "YYYY-MM-DDTHH:MMZ"
        measured_at = measured_at[:-1] + ":00Z"
    values = {}
    for api_name, column in pairs:
        series = hourly.get(api_name) or []
        if best_i < len(series):
            values[column] = _num(series[best_i])
    return measured_at, values


def _all_zero(body: dict, key: str) -> bool:
    """The GFS-Wave signature: a full series of exact zeros and not one null.

    Real water is never exactly 0.000 for twenty-four consecutive hours while
    also never being unavailable. This is checked on every wave response even
    though the model is pinned, because the check costs nothing and the failure
    it catches is silent, permanent and teaches a model that the basin is calm.
    """
    series = (body.get("hourly") or {}).get(key) or []
    return bool(series) and all(v == 0.0 for v in series)


def openmeteo_forecast(lat: float, lng: float, when: Any) -> Optional[dict]:
    """Wind, gusts, air temperature, pressure and cloud from ICON-EU (6.5 km).

    Covers roughly the last 90 days and the next 5. Older dates belong to
    `openmeteo_archive`; `weather()` picks between them.
    """
    when = _as_utc(when)
    day = when.date().isoformat()
    body = _openmeteo(
        OPENMETEO_FORECAST,
        {
            "latitude": f"{lat:.4f}", "longitude": f"{lng:.4f}",
            "hourly": ",".join(n for n, _ in _ATMO_VARS),
            "models": "icon_eu",
            "wind_speed_unit": "ms",
            "timezone": "GMT",
            "cell_selection": "sea",
            "start_date": day, "end_date": day,
        },
        ttl_s=SOURCES["openmeteo_icon_eu"]["ttl_s"],
    )
    measured_at, values = _pick_hour(body, when, _ATMO_VARS)
    if not measured_at:
        return None
    return _sample("openmeteo_icon_eu", measured_at,
                   body.get("latitude", lat), body.get("longitude", lng), values)


def openmeteo_archive(lat: float, lng: float, when: Any) -> Optional[dict]:
    """The same variables from ERA5, hourly, back to 1940.

    `models=era5` is pinned deliberately - see `_openmeteo` for what the
    default would do over 583 metres of water.
    """
    when = _as_utc(when)
    day = when.date().isoformat()
    body = _openmeteo(
        OPENMETEO_ARCHIVE,
        {
            "latitude": f"{lat:.4f}", "longitude": f"{lng:.4f}",
            "hourly": ",".join(n for n, _ in _ATMO_VARS),
            "models": "era5",
            "wind_speed_unit": "ms",
            "timezone": "GMT",
            "start_date": day, "end_date": day,
        },
        ttl_s=SOURCES["openmeteo_era5"]["ttl_s"],
    )
    measured_at, values = _pick_hour(body, when, _ATMO_VARS)
    if not measured_at:
        return None
    return _sample("openmeteo_era5", measured_at,
                   body.get("latitude", lat), body.get("longitude", lng), values)


#: How far back the forecast API still serves, and how far forward. Outside
#: this window `weather()` uses the reanalysis instead.
FORECAST_WINDOW_DAYS = (-5.0, 85.0)


def weather_source_for(when: Any) -> str:
    """Which of the two atmospheric sources `weather()` will use for a date.

    Exposed so a caller can tell "this source had nothing to say" from "this
    source was never asked about this date". They look identical in an empty
    result and mean opposite things - one is a feed to go and fix, the other
    is a feed that correctly stood aside.
    """
    age_days = (datetime.now(timezone.utc) - _as_utc(when)).total_seconds() / 86400.0
    return ("openmeteo_icon_eu"
            if FORECAST_WINDOW_DAYS[0] <= age_days <= FORECAST_WINDOW_DAYS[1]
            else "openmeteo_era5")


def weather(lat: float, lng: float, when: Any) -> Optional[dict]:
    """Atmosphere from whichever of the two feeds actually covers that date.

    They are separate sources with separate ids, not a blend: a reader has to
    be able to tell a 6.5 km forecast field from a 27 km reanalysis, because
    the two disagree, and the disagreement is information.
    """
    when = _as_utc(when)
    if weather_source_for(when) == "openmeteo_icon_eu":
        return openmeteo_forecast(lat, lng, when)
    return openmeteo_archive(lat, lng, when)


def openmeteo_waves(lat: float, lng: float, when: Any) -> Optional[dict]:
    """Significant wave height and period from MFWAM (0.08°).

    The finest wave model that actually resolves the basin. NCEP GFS-Wave is
    never used here at any resolution; see `_BANNED_MODELS`.
    """
    when = _as_utc(when)
    day = when.date().isoformat()
    body = _openmeteo(
        OPENMETEO_MARINE,
        {
            "latitude": f"{lat:.4f}", "longitude": f"{lng:.4f}",
            "hourly": ",".join(n for n, _ in _WAVE_VARS),
            "models": "meteofrance_wave",
            "timezone": "GMT",
            "start_date": day, "end_date": day,
        },
        ttl_s=SOURCES["openmeteo_mfwam"]["ttl_s"],
    )
    if _all_zero(body, "wave_height"):
        raise SourceError(
            "wave_height came back as a full series of exact zeros with no nulls - "
            "that is the masked-basin fill signature, not a calm day; discarding"
        )
    measured_at, values = _pick_hour(body, when, _WAVE_VARS)
    if not measured_at:
        return None
    return _sample("openmeteo_mfwam", measured_at,
                   body.get("latitude", lat), body.get("longitude", lng), values)


# --------------------------------------------------------------------------
# ERDDAP (SST, chlorophyll, ice concentration and thickness)
# --------------------------------------------------------------------------

ERDDAP_HOSTS = {
    "mur": ("https://coastwatch.pfeg.noaa.gov/erddap",),
    # CoralTemp, in host order. PacIOOS `dhw_5km` leads because it carries the
    # SST and the ANOMALY in one dataset - the CoastWatch node splits them
    # across `noaacrwsstDaily` and a separate anomaly dataset, so the fallback
    # there answers with SST alone and the anomaly comes back missing rather
    # than invented. Same product, different host, and which one answered is
    # visible in the sample's dataset field.
    "coraltemp": (
        ("https://pae-paha.pacioos.hawaii.edu/erddap", "dhw_5km", "CRW_SST", "CRW_SSTANOMALY"),
        ("https://coastwatch.noaa.gov/erddap", "noaacrwsstDaily", "analysed_sst", None),
    ),
    "viirs": (os.environ.get("SEALV_VIIRS_ERDDAP", "https://coastwatch.noaa.gov/erddap"),),
}


def _erddap_url(host: str, dataset: str, query: str) -> str:
    return f"{host}/griddap/{dataset}.json?{urllib.parse.quote(query, safe='[]():,.-+*')}"


def _erddap_rows(host: str, dataset: str, query: str, *, ttl_s: float) -> list[dict]:
    """Run one griddap query and return its rows as dicts.

    ERDDAP reports "there is nothing here" in several different registers - an
    HTTP 404 for a retired dataset id, a text `Error { code=404; ... }` body
    for a time outside the axis, and a row of nulls for a masked cell. Only the
    last of those is a normal answer, so the first two become None/raise here
    rather than surfacing as a parse error somewhere downstream.
    """
    url = _erddap_url(host, dataset, query)
    body = fetch(url, ttl_s=ttl_s, on_404="body")
    if body is None:
        return []
    text = body.decode("utf-8", "replace").lstrip()
    if text.startswith("Error"):
        head = text[:300]
        if "produced no matching results" in head or "no data" in head.lower():
            return []  # a real answer: nothing measured in that box and window
        # "Currently unknown datasetID" is the node talking about itself while
        # it reloads its catalogue, not a statement about the Caspian. It has
        # to reach the caller as a failure, or a restart becomes a silent hole.
        raise SourceError(f"{host}/{dataset}: {head}")
    if not text.startswith("{"):
        raise SourceError(f"{host}/{dataset}: not JSON: {text[:160]!r}")
    table = (json.loads(text) or {}).get("table") or {}
    names = table.get("columnNames") or []
    return [dict(zip(names, row)) for row in (table.get("rows") or [])]


#: Dimension order per (host, dataset, variable), from the dataset's own DDS.
_DIMS: dict[tuple[str, str, str], tuple[str, ...]] = {}

#: What a constraint for an axis that is neither time, latitude nor longitude
#: should say. Every gridded product here is a surface field, so the one such
#: axis that occurs is a degenerate `altitude = 1` at 0 m.
_FIXED_AXIS = {"altitude": "(0.0)", "depth": "(0.0)", "level": "(0.0)"}

_DDS_ARRAY = re.compile(r"ARRAY:\s*\n\s*\w+\s+(\w+)((?:\[[^\]]+\])+)")


def _erddap_dims(host: str, dataset: str, var: str) -> tuple[str, ...]:
    """The axes of one griddap variable, in order, from the dataset's DDS.

    Not a nicety. `noaacwNPPN20VIIRSDINEOFDaily` is
    `chlor_a[time][altitude][latitude][longitude]` - four axes - and a
    three-axis constraint against it is answered with

        Query error: For variable=chlor_a axis#1=altitude ...
        "Start" is greater than the axis maximum=44.85 (and even 0.0)

    i.e. the latitude was silently read as an altitude, and the 404 that came
    back says "produced no matching results" - indistinguishable from an empty
    cell. Reading the real axis order once per dataset is what stops a product
    being written off as "no data over the Caspian" because of a bracket.

    An empty tuple means the DDS could not be read; callers fall back to the
    conventional [time][latitude][longitude] and let the request fail loudly.
    """
    key = (host, dataset, var)
    if key in _DIMS:
        return _DIMS[key]
    dims: tuple[str, ...] = ()
    try:
        body = fetch(f"{host}/griddap/{dataset}.dds", ttl_s=_AXIS_TTL_S, on_404="body")
    except SourceError:
        body = None
    if body:
        text = body.decode("utf-8", "replace")
        for name, block in _DDS_ARRAY.findall(text):
            if name != var:
                continue
            dims = tuple(
                part.split("=")[0].strip()
                for part in re.findall(r"\[([^\]]+)\]", block)
            )
            break
    _DIMS[key] = dims
    return dims


def _erddap_cell(
    host: str, dataset: str, var: str, lo: str, hi: str, lat: float, lng: float
) -> str:
    """The bracket string for one point over one time window, axes in the
    dataset's own order."""
    dims = _erddap_dims(host, dataset, var) or ("time", "latitude", "longitude")
    out = []
    for dim in dims:
        low = dim.lower()
        if low.startswith("time"):
            out.append(f"[({lo}):({hi})]")
        elif low.startswith("lat"):
            out.append(f"[({lat:.4f})]")
        elif low.startswith("lon"):
            out.append(f"[({lng:.4f})]")
        else:
            out.append(f"[{_FIXED_AXIS.get(low, '0')}]")
    return "".join(out)


#: Resolved time axes, per (host, dataset). In-memory on top of the disk cache
#: because a grid cycle asks for the same axis once per variable.
_AXIS: dict[tuple[str, str], tuple[Optional[datetime], Optional[datetime]]] = {}
_AXIS_TTL_S = float(os.environ.get("SEALV_ENV_AXIS_TTL") or 6 * 3600)


def _axis_end(host: str, dataset: str, index: str) -> Optional[datetime]:
    url = _erddap_url(host, dataset, f"time[{index}]")
    body = fetch(url, ttl_s=_AXIS_TTL_S, on_404="body")
    if not body:
        return None
    text = body.decode("utf-8", "replace").lstrip()
    if not text.startswith("{"):
        return None
    rows = ((json.loads(text) or {}).get("table") or {}).get("rows") or []
    return _parse_time(rows[0][0]) if rows and rows[0] else None


def _erddap_axis(host: str, dataset: str) -> tuple[Optional[datetime], Optional[datetime]]:
    """First and last time on a dataset's axis, cached.

    Two cheap requests that prevent an expensive class of silent loss. ERDDAP
    answers a range whose stop is past the end of the axis with

        Error { code=404; ... produced no matching results. Query error: ...
                "Stop" is greater than the axis maximum=... }

    and "produced no matching results" is also how it says "that cell is
    empty" - so without this, asking for "now ± 5 days" against a product that
    is two days behind reads as *no measurement at all*, on every operational
    request, forever. It cost the first run of the self-check MUR, CoralTemp
    and chlorophyll simultaneously, which is exactly the shape of a bug that
    looks like "the Caspian has no data" instead of "the query was wrong".

    Either end may be None - a node that will not answer for its own axis is
    not a reason to refuse the data request, which is left to fail on its own
    terms and say why.
    """
    key = (host, dataset)
    if key not in _AXIS:
        _AXIS[key] = (_axis_end(host, dataset, "0"), _axis_end(host, dataset, "last"))
    return _AXIS[key]


def _erddap_window(
    host: str, dataset: str, when: datetime, hours: float
) -> Optional[tuple[str, str]]:
    """`when ± hours`, clipped to what the dataset actually publishes.

    None when the request lies wholly outside the axis - a date before the
    product existed, or a date in the future. That is a real answer ("this
    source cannot describe that moment") and it must not be dressed up as a
    transport failure, nor as a value.
    """
    lo, hi = when - timedelta(hours=hours), when + timedelta(hours=hours)
    first, last = _erddap_axis(host, dataset)
    if first is not None:
        if hi < first:
            return None
        lo = max(lo, first)
    if last is not None:
        if lo > last:
            return None
        hi = min(hi, last)
    if lo > hi:
        return None
    return _iso(lo), _iso(hi)


def _nearest_row(rows: list[dict], when: datetime, need: Iterable[str]) -> Optional[dict]:
    """The row closest in time that actually measured something.

    Closest-with-a-value, not simply closest: MUR and CoralTemp publish a slice
    every day whether or not a given cell was retrievable, so the nearest slice
    to a survey is quite often the one whose cell is masked. Skipping to the
    next one keeps the honest thing (its own older `measured_at`) instead of
    reporting a hole.
    """
    best, best_gap = None, None
    for row in rows:
        stamp = _parse_time(row.get("time"))
        if stamp is None:
            continue
        if not any(_num(row.get(k)) is not None for k in need):
            continue
        gap = abs((stamp - when).total_seconds())
        if best_gap is None or gap < best_gap:
            best, best_gap = row, gap
    return best


def mur_sst(lat: float, lng: float, when: Any) -> Optional[dict]:
    """Sea surface temperature, GHRSST MUR L4, 1 km.

    The finest SST published over the basin and the reason the plan's 0.25°
    OISST layer was retired: an SST GRADIENT - the thing a seal is thought to
    follow - simply does not exist at 20 km.

    A hard rule that belongs on this function and nowhere else: MUR's winter
    field is only weakly constrained over ice and will report ~3 °C where
    IMS and VIIRS both see a metre of it. MUR is never an ice indicator.
    """
    when = _as_utc(when)
    host = ERDDAP_HOSTS["mur"][0]
    window = _erddap_window(host, "jplMURSST41", when, SOURCES["mur"]["window_h"])
    if window is None:
        return None
    lo, hi = window
    rows = _erddap_rows(
        host, "jplMURSST41",
        "analysed_sst" + _erddap_cell(host, "jplMURSST41", "analysed_sst", lo, hi, lat, lng),
        ttl_s=SOURCES["mur"]["ttl_s"],
    )
    row = _nearest_row(rows, when, ("analysed_sst",))
    if row is None:
        return None
    return _sample("mur", _iso(_parse_time(row["time"])),
                   _num(row.get("latitude")) or lat, _num(row.get("longitude")) or lng,
                   {"sst_c": _num(row.get("analysed_sst"))})


def coraltemp_sst(lat: float, lng: float, when: Any) -> Optional[dict]:
    """SST and its anomaly against the long baseline, CoralTemp 5 km.

    Carried for the anomaly, which MUR cannot give: "27.4 °C" says nothing
    on its own, "27.4 °C, +1.6 above this week's normal" is the number a
    biologist can act on.
    """
    when = _as_utc(when)
    problems = []
    for host, dataset, sst_var, anom_var in ERDDAP_HOSTS["coraltemp"]:
        window = _erddap_window(host, dataset, when, SOURCES["coraltemp"]["window_h"])
        if window is None:
            return None
        lo, hi = window
        cell = _erddap_cell(host, dataset, sst_var, lo, hi, lat, lng)
        query = f"{sst_var}{cell}" + (
            f",{anom_var}{_erddap_cell(host, dataset, anom_var, lo, hi, lat, lng)}"
            if anom_var else ""
        )
        try:
            rows = _erddap_rows(host, dataset, query, ttl_s=SOURCES["coraltemp"]["ttl_s"])
        except SourceError as exc:
            problems.append(str(exc))
            continue
        row = _nearest_row(rows, when, (sst_var,))
        if row is None:
            return None
        return _sample("coraltemp", _iso(_parse_time(row["time"])),
                       _num(row.get("latitude")) or lat, _num(row.get("longitude")) or lng,
                       {"sst_c": _num(row.get(sst_var)),
                        "sst_anomaly_c": _num(row.get(anom_var)) if anom_var else None})
    raise SourceError("; ".join(problems) or "coraltemp: no host answered")


#: Ice concentration and thickness ship as separate ERDDAP datasets on the same
#: sector grid, so they are separate requests.
_VIIRS_ICE = (
    ("noaacwVIIRSn20iceconcXZ00Daily", "IceConc", "ice_conc"),
    ("noaacwVIIRSn20icethickXZ00Daily", "IceThickness", "ice_thickness_m"),
)

#: Hosts tried in order for the two datasets above.
#:
#: Observed on 2026-08-10, and the reason this is a LIST rather than a string:
#: coastwatch.noaa.gov answered `Currently unknown datasetID=` for both ids for
#: several minutes - its catalogue was mid-reload, and while it was, the whole
#: node reported only 104 datasets - and then served them normally again
#: (`IceConc` 1.0, `IceThickness` 1.1113 m at 45.79875/49.49625 on 2026-02-10,
#: which is the research doc's own reference pixel). That transient is exactly
#: what `_erddap_rows` refuses to cache as "no data": a twenty-minute
#: catalogue reload must not become a permanent hole in the archive.
#:
#: Note that a miss here is survivable by design. IMS 1 km is the PRIMARY ice
#: layer and does not depend on ERDDAP at all; what is lost while this is down
#: is concentration and THICKNESS, and a thickness nobody measured has to read
#: as absent rather than as thin ice.
VIIRS_ICE_HOSTS: tuple[str, ...] = tuple(
    dict.fromkeys(
        h.strip().rstrip("/")
        for h in (
            os.environ.get("SEALV_VIIRS_ERDDAP", ""),
            "https://coastwatch.noaa.gov/erddap",
            "https://polarwatch.noaa.gov/erddap",
            "https://coastwatch.pfeg.noaa.gov/erddap",
        )
        if h and h.strip()
    )
)


def viirs_ice(lat: float, lng: float, when: Any) -> Optional[dict]:
    """Ice concentration and thickness, VIIRS Enterprise Ice, 750 m.

    The only free source that gives ice THICKNESS over the basin, which is what
    decides whether a floe will hold a pupping female. Thickness comes from a
    four-day composite, so its `measured_at` is legitimately older than the
    concentration's - they are stored as one sample under the slice each was
    published for, and the composite lag is stated in the latency note.

    A NaN here usually means cloud rather than water. IMS is what closes that
    gap, which is why both ice sources are collected rather than one.
    """
    when = _as_utc(when)
    values: dict[str, Optional[float]] = {}
    stamp: Optional[datetime] = None
    cell_lat, cell_lng = lat, lng
    problems = []
    for dataset, var, column in _VIIRS_ICE:
        row = None
        for host in VIIRS_ICE_HOSTS:
            try:
                window = _erddap_window(host, dataset, when, SOURCES["viirs_ice"]["window_h"])
                if window is None:
                    break
                lo, hi = window
                rows = _erddap_rows(
                    host, dataset,
                    var + _erddap_cell(host, dataset, var, lo, hi, lat, lng),
                    ttl_s=SOURCES["viirs_ice"]["ttl_s"],
                )
            except SourceError as exc:
                problems.append(str(exc))
                continue
            row = _nearest_row(rows, when, (var,))
            break
        if row is None:
            continue
        values[column] = _num(row.get(var))
        cell_lat = _num(row.get("latitude")) or cell_lat
        cell_lng = _num(row.get("longitude")) or cell_lng
        found = _parse_time(row.get("time"))
        # The older of the two slices is the honest stamp for the pair: it is
        # the age of the thing the reader is least entitled to assume is fresh.
        if found and (stamp is None or found < stamp):
            stamp = found
    if not values:
        if problems:
            raise SourceError("; ".join(problems))
        return None
    return _sample("viirs_ice", _iso(stamp or when), cell_lat, cell_lng, values)


def viirs_chl(lat: float, lng: float, when: Any) -> Optional[dict]:
    """Chlorophyll-a, VIIRS with DINEOF gap filling, 9 km.

    A proxy for the food base, and the closest thing to a fisheries signal that
    exists for this basin at any price. Gap-filled ON PURPOSE: raw ocean colour
    at Tyuleniy is NaN on 60-75% of days, and a feature with holes that big
    kills a model quietly. The reconstruction is stated in the latency note
    because a reconstructed value is not an observed one.
    """
    when = _as_utc(when)
    host = ERDDAP_HOSTS["viirs"][0]
    window = _erddap_window(host, "noaacwNPPN20VIIRSDINEOFDaily", when,
                            SOURCES["viirs_chl"]["window_h"])
    if window is None:
        return None
    lo, hi = window
    rows = _erddap_rows(
        host, "noaacwNPPN20VIIRSDINEOFDaily",
        "chlor_a" + _erddap_cell(host, "noaacwNPPN20VIIRSDINEOFDaily", "chlor_a",
                                 lo, hi, lat, lng),
        ttl_s=SOURCES["viirs_chl"]["ttl_s"],
    )
    row = _nearest_row(rows, when, ("chlor_a",))
    if row is None:
        return None
    return _sample("viirs_chl", _iso(_parse_time(row["time"])),
                   _num(row.get("latitude")) or lat, _num(row.get("longitude")) or lng,
                   {"chl_a": _num(row.get("chlor_a"))})


# --------------------------------------------------------------------------
# NOAA IMS 1 km ice chart (GeoTIFF, read without GDAL)
# --------------------------------------------------------------------------

IMS_BASE = os.environ.get(
    "SEALV_IMS_BASE", "https://noaadata.apps.nsidc.org/NOAA/G02156/GIS/1km",
).rstrip("/")

#: What a pixel means. 0 is "outside the product", not "no ice".
IMS_CLASSES = {1: "sea", 2: "land", 3: "sea_ice", 4: "snow_covered_land"}

# The grid, straight out of the file's own GeoTIFF tags (verified by reading
# them): 24576 x 24576 pixels of 1000 m, upper-left corner at (-12288000,
# 12288000), polar stereographic north, standard parallel 60 N, central
# meridian -80, on the a=6378137 / b=6356257 ellipsoid.
_IMS_N = 24576
_IMS_PIX = 1000.0
_IMS_ULX, _IMS_ULY = -12288000.0, 12288000.0
_IMS_A, _IMS_B = 6378137.0, 6356257.0
_IMS_LAT_TS = math.radians(60.0)
_IMS_LON0 = math.radians(-80.0)
_IMS_E = math.sqrt(1.0 - (_IMS_B * _IMS_B) / (_IMS_A * _IMS_A))


def _ims_t(lat_rad: float) -> float:
    s = math.sin(lat_rad)
    return math.tan(math.pi / 4 - lat_rad / 2) / (((1 - _IMS_E * s) / (1 + _IMS_E * s)) ** (_IMS_E / 2))


_IMS_MC = math.cos(_IMS_LAT_TS) / math.sqrt(1 - _IMS_E ** 2 * math.sin(_IMS_LAT_TS) ** 2)
_IMS_TC = _ims_t(_IMS_LAT_TS)


def ims_rowcol(lat: float, lng: float) -> tuple[int, int]:
    """Grid row/column for a coordinate. Pure geometry, no I/O.

    Ellipsoidal polar stereographic (EPSG 9829, variant B). Verified against
    every pixel the research doc proved: 44.85/50.35, 45.8/49.5, 46.5/50.5 and
    46.0/52.5 all come back class 3 on 2026-02-10, 42.0/50.5 and 44.0/50.0
    class 1, and the Ustyurt control at 44.85/56.5 class 4.
    """
    rho = _IMS_A * _IMS_MC * _ims_t(math.radians(lat)) / _IMS_TC
    dlon = math.radians(lng) - _IMS_LON0
    x = rho * math.sin(dlon)
    y = -rho * math.cos(dlon)
    return int((_IMS_ULY - y) // _IMS_PIX), int((x - _IMS_ULX) // _IMS_PIX)


def _ims_window() -> tuple[int, int, int, int]:
    """Row/col bounds of the basin, with a margin. Cached window, not the grid.

    The full raster is 604 MB uncompressed and every date is a fresh one. What
    the Caspian needs out of it is a patch under a megabyte, so the extractor
    below decompresses the gzip stream up to the last row it wants, keeps that
    patch and throws the rest away as it goes.
    """
    rows, cols = [], []
    lat0, lat1 = CASPIAN_BBOX["lat_min"] - 0.5, CASPIAN_BBOX["lat_max"] + 0.5
    lng0, lng1 = CASPIAN_BBOX["lng_min"] - 0.5, CASPIAN_BBOX["lng_max"] + 0.5
    steps = 40
    for i in range(steps + 1):
        for lat, lng in (
            (lat0 + (lat1 - lat0) * i / steps, lng0),
            (lat0 + (lat1 - lat0) * i / steps, lng1),
            (lat0, lng0 + (lng1 - lng0) * i / steps),
            (lat1, lng0 + (lng1 - lng0) * i / steps),
        ):
            r, c = ims_rowcol(lat, lng)
            rows.append(r)
            cols.append(c)
    return min(rows) - 2, min(cols) - 2, max(rows) + 3, max(cols) + 3


def _ims_header_ok(head: bytes) -> bool:
    """Check the one assumption the streaming extractor rests on.

    IDL writes the TIFF directory at the END of the file, so StripOffsets are
    only readable after 604 MB have gone past - which is precisely what the
    extractor cannot afford. It therefore does not read them: the raster is
    UNCOMPRESSED (Compression=1) with one row per strip and a fixed 24576-byte
    row, so row N starts at `8 + N * 24576`, 8 being the first byte after the
    TIFF header. Verified by reading the tags of a real file. All this can
    check on a stream is that the header is still the little-endian TIFF the
    layout belongs to; if NSIDC ever ships a tiled or deflated v1.4, this is
    where it stops being silently wrong.
    """
    return len(head) >= 8 and head[:2] == b"II" and struct.unpack("<H", head[2:4])[0] == 42


def _ims_extract(raw_gz: bytes) -> tuple[int, int, int, int, bytes]:
    """Decompress only as far as the basin and return that patch.

    Returns (row0, col0, height, width, bytes) with the patch in row-major
    order. Stops reading the stream as soon as the last needed row is out, so a
    604 MB raster costs ~230 MB of streaming and ~700 KB of memory.
    """
    row0, col0, row1, col1 = _ims_window()
    height, width = row1 - row0, col1 - col0
    stride = _IMS_N
    out = bytearray()
    with gzip.GzipFile(fileobj=_BytesReader(raw_gz)) as fh:
        head = fh.read(8)
        if not _ims_header_ok(head):
            raise SourceError("IMS GeoTIFF is not the little-endian layout this reader assumes")
        pos = 8
        want_from = 8 + row0 * stride
        # Skip whole rows in chunks rather than one read(), which would
        # materialise a quarter of a gigabyte.
        while pos < want_from:
            step = min(1 << 20, want_from - pos)
            chunk = fh.read(step)
            if not chunk:
                raise SourceError("IMS GeoTIFF ended before the basin")
            pos += len(chunk)
        for _ in range(height):
            row = fh.read(stride)
            if len(row) < stride:
                raise SourceError("IMS GeoTIFF ended mid-basin")
            out += row[col0:col1]
    return row0, col0, height, width, bytes(out)


class _BytesReader:
    """Minimal file-like over bytes; gzip.GzipFile needs read() and seek-less
    streaming, and BytesIO would be fine except that this keeps the intent
    explicit at the one call site that matters."""

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    def read(self, n: int = -1) -> bytes:
        if n is None or n < 0:
            n = len(self._data) - self._pos
        out = self._data[self._pos:self._pos + n]
        self._pos += len(out)
        return out


def _ims_patch(day: datetime) -> Optional[tuple[int, int, int, int, bytes]]:
    """The basin patch for one date, from cache when possible.

    Two layers of cache: the raw download (shared with every other source
    through `fetch`) and the extracted patch, which is what makes sampling 350
    grid cells for one date cost one decompression rather than 350.
    """
    stamp = f"{day.year}{day.timetuple().tm_yday:03d}"
    patch_file = cache_dir() / f"ims-{stamp}.patch"
    if patch_file.is_file():
        blob = patch_file.read_bytes()
        row0, col0, height, width = struct.unpack("<4i", blob[:16])
        return row0, col0, height, width, blob[16:]

    url = f"{IMS_BASE}/{day.year}/ims{stamp}_1km_GIS_v1.3.tif.gz"
    raw = fetch(url, ttl_s=0, on_404="none", timeout=max(DEFAULT_TIMEOUT, 180.0))
    if raw is None:
        return None
    row0, col0, height, width, data = _ims_extract(raw)
    patch_file.write_bytes(struct.pack("<4i", row0, col0, height, width) + data)
    return row0, col0, height, width, data


def ims_ice(lat: float, lng: float, when: Any) -> Optional[dict]:
    """Ice / open water / land class from the NOAA IMS 1 km daily chart.

    Analyst-drawn, so unlike a satellite retrieval it has no cloud holes - it
    is the layer that says where the ice edge WAS on a given day. It carries no
    concentration and no thickness; VIIRS carries those.

    Land and snow-covered land are returned as the class they are rather than
    dropped: a survey flying the Tyuleniy spit in February wants to know that
    the pixel under it was snow-covered land, and turning that into None would
    make it indistinguishable from an outage.
    """
    when = _as_utc(when)
    if lat <= 0:
        return None  # northern-hemisphere product; nothing to look up
    # The chart for day D is published a day or two later; walk back until one
    # exists rather than reporting nothing for a survey flown the day before.
    for back in range(0, 5):
        day = when - timedelta(days=back)
        patch = _ims_patch(day)
        if patch is None:
            continue
        row0, col0, height, width, data = patch
        row, col = ims_rowcol(lat, lng)
        if not (row0 <= row < row0 + height and col0 <= col < col0 + width):
            return None
        klass = data[(row - row0) * width + (col - col0)]
        if klass == 0:
            return None  # outside the product, which is not "no ice"
        return _sample(
            "ims", _iso(day.replace(hour=0, minute=0, second=0, microsecond=0)),
            lat, lng, {"ice_class": float(klass)},
        )
    return None


# --------------------------------------------------------------------------
# NASA GSFC Global Water Monitor - sea level
# --------------------------------------------------------------------------

#: The research doc records the FILE (`lake000270.10d.2.txt`) but not a URL,
#: and the USDA G-REALM mirror it is often quoted from answers 404 for it now.
#: This is the current NASA GSFC home, confirmed by reading the target's own
#: page (`earth.gsfc.nasa.gov/gwm/lake/270` links exactly this file): 110956
#: bytes, 1413 lines, last record 2026-08-04 = -1.88 m relative / -28.46 m
#: EGM2008 - the same numbers the research doc proved.
GWM_URL = os.environ.get(
    "SEALV_GWM_URL", "https://earth.gsfc.nasa.gov/gwm/timeseries/lake000270.10d.2.txt",
)
#: Where the altimetry pass crosses, from the file's own header. A basin-scale
#: figure still needs A coordinate to be stored against, and this is the honest
#: one - not the centre of whatever survey happens to be asking.
GWM_TARGET = (41.970, 50.385)

#: The file's declared defaults. Writing either of these as a number would put
#: a sea level of +999.99 m in the archive.
_GWM_FILL = {999.99, 9999.99, 99.999}


def _gwm_records() -> list[dict]:
    body = fetch(GWM_URL, ttl_s=SOURCES["gwm_sea_level"]["ttl_s"])
    if not body:
        raise SourceError("GWM returned an empty body")
    out = []
    for line in body.decode("utf-8", "replace").splitlines():
        parts = line.split()
        if len(parts) < 16 or not re.fullmatch(r"\d{8}", parts[2] if len(parts) > 2 else ""):
            continue
        try:
            stamp = datetime(
                int(parts[2][:4]), int(parts[2][4:6]), int(parts[2][6:8]),
                int(parts[3]) % 24, int(parts[4]) % 60, tzinfo=timezone.utc,
            )
        except ValueError:
            continue
        egm = _num(parts[14])
        if egm is None or egm in _GWM_FILL:
            continue
        out.append({"time": stamp, "sea_level_m": egm, "mission": parts[0]})
    return out


def gwm_sea_level(when: Any, lat: float = GWM_TARGET[0], lng: float = GWM_TARGET[1]) -> Optional[dict]:
    """Caspian level in the EGM2008 datum, one figure per ten days since 1992.

    Stored basin-wide on purpose. The sea is falling 1.63 m per decade over
    water 2-5 m deep around Tyuleniy, so the geography of the haul-outs is not
    drifting, it is being rewritten - islands joining the mainland, and land
    predators walking out to pupping grounds that used to be unreachable. It
    joins to every survey by date, which is why it is collected from day one.
    """
    when = _as_utc(when)
    records = _gwm_records()
    if not records:
        return None
    # The record at or before the date, never the one after: a survey in March
    # cannot be described by a measurement taken in April.
    earlier = [r for r in records if r["time"] <= when]
    chosen = earlier[-1] if earlier else None
    if chosen is None:
        return None
    return _sample("gwm_sea_level", _iso(chosen["time"]), lat, lng,
                   {"sea_level_m": chosen["sea_level_m"]})


# --------------------------------------------------------------------------
# collection
# --------------------------------------------------------------------------

#: Everything a point collection tries, in the order a reader would want it.
POINT_SOURCES: tuple[str, ...] = (
    "weather", "openmeteo_mfwam", "mur", "coraltemp",
    "ims", "viirs_ice", "viirs_chl", "gwm_sea_level",
)

_CLIENTS: dict[str, Callable[..., Optional[dict]]] = {
    "weather": weather,
    "openmeteo_forecast": openmeteo_forecast,
    "openmeteo_archive": openmeteo_archive,
    "openmeteo_mfwam": openmeteo_waves,
    "mur": mur_sst,
    "coraltemp": coraltemp_sst,
    "ims": ims_ice,
    "viirs_ice": viirs_ice,
    "viirs_chl": viirs_chl,
}


def collect_point(
    lat: float, lng: float, when: Any, sources: Optional[Iterable[str]] = None
) -> tuple[list[dict], list[dict]]:
    """Every source for one point and time.

    Returns (samples, problems). Problems are returned rather than raised
    because a chlorophyll host being down is not a reason to lose the wind: the
    caller stores what it got and can see, per source, why the rest is missing.
    A missing value must be visible as missing, and an invisible failure is the
    fastest way to a chart that quietly stops updating.
    """
    when = _as_utc(when)
    samples: list[dict] = []
    problems: list[dict] = []
    for name in (sources or POINT_SOURCES):
        try:
            if name == "gwm_sea_level":
                sample = gwm_sea_level(when)
            else:
                fn = _CLIENTS.get(name)
                if fn is None:
                    problems.append({"source": name, "error": "no such source"})
                    continue
                sample = fn(lat, lng, when)
            if sample is None:
                problems.append({"source": name, "error": "no value at this point and time"})
            else:
                samples.append(sample)
        except SourceError as exc:
            problems.append({"source": name, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - a broken client must not stop the rest
            problems.append({"source": name, "error": f"{type(exc).__name__}: {exc}"})
    return samples, problems


def caspian_grid(step_deg: float = 0.5) -> list[tuple[float, float]]:
    """Water cells of the coarse collection grid, south-west corner first."""
    out = []
    lat = CASPIAN_BBOX["lat_min"]
    while lat <= CASPIAN_BBOX["lat_max"] + 1e-9:
        lng = CASPIAN_BBOX["lng_min"]
        while lng <= CASPIAN_BBOX["lng_max"] + 1e-9:
            if is_caspian_water(lat, lng):
                out.append((round(lat, 4), round(lng, 4)))
            lng += step_deg
        lat += step_deg
    return out


def _erddap_grid(
    source: str, host: str, dataset: str, var: str, column: str,
    when: datetime, step_deg: float,
) -> list[dict]:
    """One strided griddap request for the whole basin.

    The map layer is the reason this exists: 350 separate point requests per
    variable per cycle would be both slow and rude, and ERDDAP will subsample a
    box in a single response. The stride is computed from the product's own
    cell size, so what comes back are REAL cells of that product, spaced out -
    never an interpolation onto a grid of our choosing.
    """
    meta = SOURCES[source]
    cell_deg = (meta["resolution_m"] or 25000) / 111320.0
    stride = max(1, int(round(step_deg / cell_deg)))
    window = _erddap_window(host, dataset, when, meta["window_h"])
    if window is None:
        return []
    lo, hi = window
    dims = _erddap_dims(host, dataset, var) or ("time", "latitude", "longitude")
    brackets = []
    for dim in dims:
        low = dim.lower()
        if low.startswith("time"):
            brackets.append(f"[({lo}):({hi})]")
        elif low.startswith("lat"):
            brackets.append(
                f"[({CASPIAN_BBOX['lat_min']:.3f}):{stride}:({CASPIAN_BBOX['lat_max']:.3f})]")
        elif low.startswith("lon"):
            brackets.append(
                f"[({CASPIAN_BBOX['lng_min']:.3f}):{stride}:({CASPIAN_BBOX['lng_max']:.3f})]")
        else:
            brackets.append(f"[{_FIXED_AXIS.get(low, '0')}]")
    rows = _erddap_rows(host, dataset, var + "".join(brackets), ttl_s=meta["ttl_s"])
    if not rows:
        return []
    stamps = {r.get("time") for r in rows if r.get("time")}
    if not stamps:
        return []
    # One slice per response, the one nearest the requested time. Mixing two
    # days into one "grid at time T" would draw a seam nobody measured.
    best = min(stamps, key=lambda s: abs(((_parse_time(s) or when) - when).total_seconds()))
    out = []
    for row in rows:
        if row.get("time") != best:
            continue
        value = _num(row.get(var))
        if value is None:
            continue
        lat, lng = _num(row.get("latitude")), _num(row.get("longitude"))
        if lat is None or lng is None or not is_caspian_water(lat, lng):
            continue
        sample = _sample(source, _iso(_parse_time(best)), lat, lng, {column: value})
        if sample is not None:
            out.append(sample)
    return out


def collect_grid(
    when: Any, *, step_deg: float = 0.5, sources: Optional[Iterable[str]] = None
) -> tuple[list[dict], list[dict]]:
    """The coarse basin grid: SST and ice, the two fields that make a map.

    Chlorophyll is available on the same mechanism but is left out of the
    default cycle - it is a 9 km product, and drawing it beside a 1 km SST is
    exactly the mixing the honesty rules forbid unless each is drawn at its own
    cell size. The layer that wants it asks for it explicitly.
    """
    when = _as_utc(when)
    wanted = tuple(sources or ("mur", "ims"))
    samples: list[dict] = []
    problems: list[dict] = []

    if "mur" in wanted:
        try:
            samples += _erddap_grid("mur", ERDDAP_HOSTS["mur"][0], "jplMURSST41",
                                    "analysed_sst", "sst_c", when, step_deg)
        except SourceError as exc:
            problems.append({"source": "mur", "error": str(exc)})

    if "coraltemp" in wanted:
        ok = False
        errs = []
        for host, dataset, sst_var, _anom in ERDDAP_HOSTS["coraltemp"]:
            try:
                samples += _erddap_grid("coraltemp", host, dataset, sst_var,
                                        "sst_c", when, step_deg)
                ok = True
                break
            except SourceError as exc:
                errs.append(str(exc))
        if not ok:
            problems.append({"source": "coraltemp", "error": "; ".join(errs)})

    if "viirs_chl" in wanted:
        try:
            samples += _erddap_grid("viirs_chl", ERDDAP_HOSTS["viirs"][0],
                                    "noaacwNPPN20VIIRSDINEOFDaily", "chlor_a",
                                    "chl_a", when, step_deg)
        except SourceError as exc:
            problems.append({"source": "viirs_chl", "error": str(exc)})

    if "ims" in wanted:
        # One download, then every cell is a byte lookup - the opposite of the
        # ERDDAP path, and the reason IMS is cheap to collect densely.
        try:
            hit = False
            for cell_lat, cell_lng in caspian_grid(step_deg):
                sample = ims_ice(cell_lat, cell_lng, when)
                if sample is not None:
                    samples.append(sample)
                    hit = True
            if not hit:
                problems.append({"source": "ims", "error": "no chart within 5 days of that date"})
        except SourceError as exc:
            problems.append({"source": "ims", "error": str(exc)})

    return samples, problems


# --------------------------------------------------------------------------
# self-check
# --------------------------------------------------------------------------

def main(argv: Optional[list[str]] = None) -> int:
    """Probe every source at Tyuleniy and print what each one actually said.

    Tyuleniy (44.85 N, 50.35 E) is the reference point of the whole research
    document, so its numbers can be compared against proven values by eye.
    Sources are probed at two dates on purpose: today for the operational
    feeds, and 2026-02-10 for the ice, because in August there is no ice and a
    None would be indistinguishable from a broken client.
    """
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m service.env",
        description="Probe every Caspian environmental source and print a table.",
    )
    parser.add_argument("--lat", type=float, default=44.85)
    parser.add_argument("--lng", type=float, default=50.35)
    parser.add_argument("--time", default=None, help="ISO8601, default: now")
    parser.add_argument("--ice-time", default="2026-02-10T12:00:00Z")
    # The research doc's own VIIRS reference pixel. VIIRS is a RETRIEVAL: at
    # Tyuleniy on that date the sky was closed and it answers NaN, which this
    # module correctly turns into None - so probing only Tyuleniy would leave
    # the ice-concentration client untested by a table that looked complete.
    # IMS, being analyst-drawn, has no cloud holes and answers at both.
    parser.add_argument("--ice-lat", type=float, default=45.79875)
    parser.add_argument("--ice-lng", type=float, default=49.49625)
    parser.add_argument("--no-cache", action="store_true")
    args = parser.parse_args(argv)

    if args.no_cache:
        for stale in cache_dir().glob("*.cache"):
            stale.unlink()

    now = _as_utc(args.time) if args.time else datetime.now(timezone.utc)
    ice_when = _as_utc(args.ice_time)

    ice_sources = ("ims", "viirs_ice")

    print(f"SEALv environmental sources - probe at {args.lat}, {args.lng}")
    print(f"  operational date: {_iso(now)}")
    print(f"  ice date:         {_iso(ice_when)}  at {args.ice_lat}, {args.ice_lng} "
          "(August has no ice; a None in August proves nothing)")
    print(f"  cache:            {cache_dir()}")
    print()
    header = (f"{'source':<20} {'measured_at':<21} {'res':>16}  "
              f"{'cell':<19} {'values':<46} note")
    print(header)
    print("-" * len(header))

    rows: list[tuple[str, Optional[dict], Optional[str]]] = []
    for name in POINT_SOURCES:
        ice = name in ice_sources
        when = ice_when if ice else now
        lat = args.ice_lat if ice else args.lat
        lng = args.ice_lng if ice else args.lng
        try:
            if name == "gwm_sea_level":
                sample = gwm_sea_level(when)
            else:
                sample = _CLIENTS[name](lat, lng, when)
            rows.append((name, sample, None))
        except SourceError as exc:
            rows.append((name, None, str(exc)))
        except Exception as exc:  # noqa: BLE001
            rows.append((name, None, f"{type(exc).__name__}: {exc}"))

    ok = 0
    for name, sample, error in rows:
        if sample is None:
            # Collapsed to one line: an ERDDAP error body is a pretty-printed
            # block, and letting it break the table hides the rows under it.
            note = " ".join((error or "reached it; no value at this cell and time").split())
            print(f"{name:<20} {'-':<21} {'-':>16}  {'-':<19} "
                  f"{'MISSING (never 0)':<46} {note[:150]}")
            continue
        ok += 1
        values = ", ".join(
            f"{k}={v:g}" if isinstance(v, float) else f"{k}={v}"
            for k, v in sample["values"].items()
        )
        res = sample["resolution"] if sample["resolution_m"] else "basin"
        cell = f"{sample['lat']},{sample['lng']}"
        print(f"{sample['source']:<20} {sample['measured_at']:<21} {res:>16}  "
              f"{cell:<19} {values:<46} {sample['dataset']}")

    print()
    print(f"{ok}/{len(rows)} sources answered with a value.")
    print("A MISSING row is a fact, not a failure of this table: it is what the UI must show.")
    print("Every value above carries the slice it was measured in, not the moment it was asked for -")
    print("the distance between the two is the latency the operator has to be told about.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
