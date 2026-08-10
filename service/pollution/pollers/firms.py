"""NASA FIRMS thermal-anomaly poller.

FIRMS detections are heat sources, not oil observations.  They are therefore
emitted only as ``flare`` incidents.
"""
from __future__ import annotations

import csv
import io
import math
import os
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from pathlib import Path
from ..fields import FIELDS
from ..net import fetch_text

from ..models import PollutionIncident, PollutionSource
from ..registry import SourceUnavailableError, register_source
from ..scheduler import six_month_cutoff

SRC = PollutionSource(
    id="firms_viirs",
    name="NASA FIRMS thermal anomalies",
    url="https://firms.modaps.eosdis.nasa.gov/api/area/csv",
    type="api",
    poll_method="GET /api/area/csv/{MAP_KEY}/{SOURCE}/47,36,55,47/{DAYS}[/{DATE}]",
    update_freq="30m",
)

# The four global near-real-time thermal products.  LANDSAT_NRT is excluded
# because FIRMS documents it as US/Canada-only.
DATASETS = (
    "MODIS_NRT",
    "VIIRS_SNPP_NRT",
    "VIIRS_NOAA20_NRT",
    "VIIRS_NOAA21_NRT",
)
AREA = "47,36,55,47"
BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
AVAILABILITY_BASE = "https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv"
USER_AGENT = "SEALv-Caspian-Pollution/1.0 (+https://sealv.org)"
MAX_FIRMS_DAY_RANGE = 5
FRP_THRESHOLD_MW = 5.0

# FIRMS reports every heat source in the bounding box, including wildfires.
# Only detections close to a verified oil field are credible flare candidates.
_OIL_SITE_NAMES = {
    "Kashagan",
    "Tengiz",
    "Karachaganak",
    "Dunga",
    "Kalamkas-Khazar",
    "Kulzhan",
    "Karazhanbas",
}
MAX_OIL_SITE_DISTANCE_KM = 20.0


def _distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 6371.0088 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _nearest_oil_site(lat: float, lng: float) -> tuple[str, float] | None:
    candidates = (
        (name, _distance_km(lat, lng, values[0], values[1]))
        for name, values in FIELDS.items()
        if name in _OIL_SITE_NAMES
    )
    name, distance = min(candidates, key=lambda item: item[1])
    return (name, distance) if distance <= MAX_OIL_SITE_DISTANCE_KM else None


def _map_key() -> str:
    configured = (os.environ.get("FIRMS_MAP_KEY") or "").strip()
    if configured:
        return configured
    key_path = Path(
        os.environ.get(
            "FIRMS_MAP_KEY_FILE",
            "~/.config/sealv/firms-map-key",
        )
    ).expanduser()
    try:
        return key_path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""

def _request_text(url: str, audit_url: Optional[str] = None) -> str:
    return fetch_text(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "text/csv"},
        timeout=20,
        max_bytes=10 * 1024 * 1024,
        audit_url=audit_url,
    )


def _fetch(key: str, dataset: str, days: int, start: Optional[date]) -> tuple[str, str]:
    url = f"{BASE}/{key}/{dataset}/{AREA}/{days}"
    if start is not None:
        url += f"/{start.isoformat()}"
    audit_url = url.replace(f"/{key}/", "/{MAP_KEY}/")
    return _request_text(url, audit_url), audit_url

def _availability(key: str) -> dict[str, tuple[date, date]]:
    url = f"{AVAILABILITY_BASE}/{key}/ALL"
    text = _request_text(url, url.replace(f"/{key}/", "/{MAP_KEY}/"))
    available: dict[str, tuple[date, date]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        dataset = (row.get("data_id") or "").strip()
        try:
            first = date.fromisoformat((row.get("min_date") or "").strip())
            last = date.fromisoformat((row.get("max_date") or "").strip())
        except ValueError:
            continue
        if dataset:
            available[dataset] = (first, last)
    missing = [dataset for dataset in DATASETS if dataset not in available]
    if missing:
        raise SourceUnavailableError(
            f"NASA FIRMS availability omitted expected datasets: {', '.join(missing)}"
        )
    return available


def _parse_since(value: Optional[str], now: datetime) -> tuple[datetime, bool]:
    oldest = six_month_cutoff(now)
    if not value:
        return now - timedelta(days=1), False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"invalid FIRMS since timestamp: {value}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(parsed.astimezone(timezone.utc), oldest), True


def _windows(
    cutoff: datetime,
    now: datetime,
    explicit: bool,
    available: Optional[tuple[date, date]] = None,
) -> list[tuple[int, Optional[date]]]:
    if not explicit:
        return [(1, None)]
    windows: list[tuple[int, Optional[date]]] = []
    first_available, last_available = available or (cutoff.date(), now.date())
    cursor = max(cutoff.date(), first_available)
    final = min(now.date(), last_available)
    while cursor <= final:
        days = min(MAX_FIRMS_DAY_RANGE, (final - cursor).days + 1)
        windows.append((days, cursor))
        cursor += timedelta(days=days)
    return windows


def _observed_at(row: dict[str, str]) -> Optional[str]:
    acquired_date = (row.get("acq_date") or "").strip()
    acquired_time = (row.get("acq_time") or "").strip().zfill(4)
    if not acquired_date or len(acquired_time) != 4 or not acquired_time.isdigit():
        return None
    try:
        observed = datetime.strptime(
            f"{acquired_date} {acquired_time}", "%Y-%m-%d %H%M"
        ).replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return observed.isoformat().replace("+00:00", "Z")


def _confidence(value: str) -> Optional[float]:
    normalized = value.strip().lower()
    categorical = {"h": 1.0, "n": 0.8, "l": 0.5}
    if normalized in categorical:
        return categorical[normalized]
    try:
        return max(0.0, min(1.0, float(normalized) / 100.0))
    except ValueError:
        return None


def poll(source: PollutionSource, since: Optional[str] = None) -> list[PollutionIncident]:
    key = _map_key()
    if not key:
        raise SourceUnavailableError("FIRMS_MAP_KEY is not configured")

    now = datetime.now(timezone.utc)
    cutoff, explicit = _parse_since(since, now)
    needs_archive_bounds = explicit and cutoff < now - timedelta(days=2)
    availability = _availability(key) if needs_archive_bounds else {}
    out: list[PollutionIncident] = []
    seen: set[str] = set()
    failures = 0
    retry_after_seconds: float | None = None

    for dataset in DATASETS:
        for days, start in _windows(cutoff, now, explicit, availability.get(dataset)):
            try:
                text, request_url = _fetch(key, dataset, days, start)
            except SourceUnavailableError as exc:
                failures += 1
                if exc.retry_after_seconds is not None:
                    retry_after_seconds = max(retry_after_seconds or 0, exc.retry_after_seconds)
                continue
            for row in csv.DictReader(io.StringIO(text)):
                try:
                    lat_s = (row.get("latitude") or "").strip()
                    lon_s = (row.get("longitude") or "").strip()
                    frp = float((row.get("frp") or "").strip())
                    observed_at = _observed_at(row)
                    if not lat_s or not lon_s or not observed_at or frp <= FRP_THRESHOLD_MW:
                        continue
                    if observed_at < cutoff.isoformat().replace("+00:00", "Z"):
                        continue
                    lat, lng = float(lat_s), float(lon_s)
                    if not (36 <= lat <= 48 and 46 <= lng <= 56):
                        continue

                except (TypeError, ValueError):
                    continue

                oil_site = _nearest_oil_site(lat, lng)
                if oil_site is None:
                    continue
                oil_site_name, oil_site_distance_km = oil_site

                incident_id = (
                    f"firms_viirs:{dataset.lower()}:{lat_s}:{lon_s}:"
                    f"{observed_at.replace(':', '').replace('-', '')}"
                )
                if incident_id in seen:
                    continue
                seen.add(incident_id)
                raw = dict(row)
                raw.update(
                    {
                        "dataset": dataset,
                        "original_url": request_url,
                        "classification": "thermal_anomaly_near_verified_oil_site",
                        "nearest_oil_site": oil_site_name,
                        "oil_site_distance_km": round(oil_site_distance_km, 3),
                    }
                )
                incident = PollutionIncident(
                    id=incident_id,
                    source_id=source.id,
                    observed_at=observed_at,
                    lat=lat,
                    lng=lng,
                    radius_m=500,
                    kind="flare",
                    area_km2=None,
                    confidence=_confidence(row.get("confidence") or ""),
                    location_precision="exact",
                    raw=raw,
                )
                incident.validate()
                out.append(incident)
    if failures:
        raise SourceUnavailableError(
            f"incomplete {source.id} scan: {failures} dataset requests failed",
            retry_after_seconds=retry_after_seconds,
            partial_incidents=out,
        )
    return out


register_source(SRC, poll)
