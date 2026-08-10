"""NOAA OSPO Marine Pollution Surveillance Report poller.

Only analyst-produced polygon geometry from a report ZIP is emitted.  Report
map points and raw satellite scene footprints are never treated as slicks.
"""
from __future__ import annotations

import io
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any, Iterable, Optional

from ..models import PollutionIncident, PollutionSource
from ..registry import SourceUnavailableError, register_source
from ..scheduler import six_month_cutoff

ARCHIVE = "https://www.ospo.noaa.gov/products/ocean/marinepollution/archive.html"
USER_AGENT = "SEALv-Caspian-Pollution/1.0 (+https://sealv.org)"
# Broad prefilter only.  Final admission uses the analyst polygon itself.
CASPIAN_BOUNDS = (46.0, 36.0, 56.0, 48.0)
POLLUTION_TERMS = re.compile(r"\b(?:oil|slick|pollution|discharge|anomal(?:y|ies))\b", re.I)

SRC = PollutionSource(
    id="noaa_ospo_mpsr",
    name="NOAA OSPO analyst marine pollution reports",
    url=ARCHIVE,
    type="scrape",
    poll_method="GET archive TXT prefilter, then analyst ZIP GeoJSON polygons",
    update_freq="1h",
)


class _ArchiveRows(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.in_row = False
        self.text: list[str] = []
        self.links: list[str] = []
        self.rows: list[tuple[str, list[str]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        if tag == "tr":
            self.in_row = True
            self.text = []
            self.links = []
        elif self.in_row and tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(urllib.parse.urljoin(self.base_url, href))

    def handle_data(self, data: str) -> None:
        if self.in_row:
            self.text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "tr" and self.in_row:
            self.rows.append((" ".join(" ".join(self.text).split()), list(self.links)))
            self.in_row = False


def _get(url: str, accept: str, timeout: int = 20) -> tuple[bytes, str]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": accept},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read(), response.geturl()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SourceUnavailableError(f"NOAA OSPO request failed for {url}: {exc}") from exc


def _cutoff(since: Optional[str], now: datetime) -> datetime:
    oldest = six_month_cutoff(now)
    if not since:
        return now - timedelta(days=1)
    try:
        parsed = datetime.fromisoformat(since.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"invalid NOAA OSPO since timestamp: {since}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(oldest, parsed.astimezone(timezone.utc))


def _candidate_reports(html: str, page_url: str, cutoff: date) -> list[tuple[str, str, str]]:
    parser = _ArchiveRows(page_url)
    parser.feed(html)
    candidates: list[tuple[str, str, str]] = []
    for row_text, links in parser.rows:
        upper = row_text.upper()
        if "INTERNATIONAL WATERS" not in upper and "CASPIAN" not in upper:
            continue
        txt_url = next((link for link in links if link.lower().endswith(".txt")), None)
        zip_url = next((link for link in links if link.lower().endswith(".zip")), None)
        if not txt_url or not zip_url:
            continue
        stem = txt_url.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        match = re.match(r"(\d{8})_", stem)
        if not match:
            continue
        try:
            report_date = datetime.strptime(match.group(1), "%Y%m%d").date()
        except ValueError:
            continue
        if report_date >= cutoff:
            candidates.append((txt_url, zip_url, stem))
    return candidates


def _field(text: str, name: str) -> Optional[str]:
    match = re.search(rf"^{re.escape(name)}:\s*(.+?)\s*$", text, re.I | re.M)
    return match.group(1).strip() if match else None


def _report_location(text: str) -> Optional[tuple[float, float]]:
    value = _field(text, "LOCATION")
    if not value:
        return None
    dms = re.search(
        r"(\d{1,2})\D+(\d{1,2})\D+(\d{1,2}(?:\.\d+)?)\D*([NS])\s*[/,]\s*"
        r"(\d{1,3})\D+(\d{1,2})\D+(\d{1,2}(?:\.\d+)?)\D*([EW])",
        value,
        re.I,
    )
    if dms:
        lat = float(dms.group(1)) + float(dms.group(2)) / 60 + float(dms.group(3)) / 3600
        lng = float(dms.group(5)) + float(dms.group(6)) / 60 + float(dms.group(7)) / 3600
        if dms.group(4).upper() == "S":
            lat = -lat
        if dms.group(8).upper() == "W":
            lng = -lng
        return lat, lng
    decimal = re.search(r"(-?\d{1,2}(?:\.\d+)?)\s*[,/]\s*(-?\d{1,3}(?:\.\d+)?)", value)
    if decimal:
        return float(decimal.group(1)), float(decimal.group(2))
    return None


def _in_caspian(lat: float, lng: float) -> bool:
    west, south, east, north = CASPIAN_BOUNDS
    return south <= lat <= north and west <= lng <= east


def _txt_passes_prefilter(text: str) -> bool:
    if not POLLUTION_TERMS.search(text):
        return False
    if "CASPIAN" in text.upper():
        return True
    location = _report_location(text)
    return bool(location and _in_caspian(*location))


def _coordinates(value: Any) -> Iterable[tuple[float, float]]:
    if (
        isinstance(value, (list, tuple))
        and len(value) >= 2
        and isinstance(value[0], (int, float))
        and isinstance(value[1], (int, float))
    ):
        yield float(value[0]), float(value[1])
        return
    if isinstance(value, (list, tuple)):
        for child in value:
            yield from _coordinates(child)


def _polygon_parts(geometry: Any) -> Iterable[dict[str, Any]]:
    if not isinstance(geometry, dict):
        return
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon" and isinstance(coordinates, list):
        yield {"type": "Polygon", "coordinates": coordinates}
    elif geometry_type == "MultiPolygon" and isinstance(coordinates, list):
        for polygon in coordinates:
            if isinstance(polygon, list):
                yield {"type": "Polygon", "coordinates": polygon}


def _geometry_center_radius(geometry: dict[str, Any]) -> Optional[tuple[float, float, float]]:
    points = list(_coordinates(geometry.get("coordinates")))
    if not points:
        return None
    west, east = min(p[0] for p in points), max(p[0] for p in points)
    south, north = min(p[1] for p in points), max(p[1] for p in points)
    caspian_west, caspian_south, caspian_east, caspian_north = CASPIAN_BOUNDS
    if east < caspian_west or west > caspian_east or north < caspian_south or south > caspian_north:
        return None
    lng, lat = (west + east) / 2, (south + north) / 2
    max_distance = 0.0
    for point_lng, point_lat in points:
        dy = (point_lat - lat) * 111_320
        dx = (point_lng - lng) * 111_320 * math.cos(math.radians(lat))
        max_distance = max(max_distance, math.hypot(dx, dy))
    return lat, lng, max(50.0, min(100_000.0, max_distance))


def _observed_at(text: str, fallback: str) -> Optional[str]:
    image_date = _field(text, "IMAGE DATE")
    image_time = _field(text, "IMAGE TIME")
    if image_date and image_time:
        digits = "".join(re.findall(r"\d", image_time))[:4].zfill(4)
        try:
            value = datetime.strptime(f"{image_date} {digits}", "%m-%d-%Y %H%M")
            return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
        except ValueError:
            pass
    match = re.match(r"(\d{8})_(\d{4})", fallback)
    if not match:
        return None
    value = datetime.strptime("".join(match.groups()), "%Y%m%d%H%M")
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _confidence(text: str) -> Optional[float]:
    value = (_field(text, "CONFIDENCE") or "").lower()
    if "high" in value and "medium" in value:
        return 0.85
    if "high" in value:
        return 0.95
    if "medium" in value:
        return 0.7
    if "low" in value:
        return 0.5
    return None


def _zip_polygons(payload: bytes) -> list[dict[str, Any]]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as exc:
        raise SourceUnavailableError(f"invalid NOAA OSPO report ZIP: {exc}") from exc
    names = [
        name
        for name in archive.namelist()
        if name.lower().endswith(".geojson") and "point source" not in name.lower()
    ]
    if not names:
        raise SourceUnavailableError("NOAA OSPO report ZIP has no analyst polygon GeoJSON")
    polygons: list[dict[str, Any]] = []
    for name in names:
        try:
            payload = json.loads(archive.read(name))
        except (KeyError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise SourceUnavailableError(f"invalid NOAA OSPO polygon {name}: {exc}") from exc
        features = payload.get("features") if isinstance(payload, dict) else None
        if not isinstance(features, list):
            continue
        for feature in features:
            if isinstance(feature, dict):
                polygons.extend(_polygon_parts(feature.get("geometry")))
    return polygons


def poll(source: PollutionSource, since: Optional[str] = None) -> list[PollutionIncident]:
    now = datetime.now(timezone.utc)
    cutoff = _cutoff(since, now)
    years = range(cutoff.year, now.year + 1)
    reports: dict[str, tuple[str, str]] = {}
    for year in years:
        archive_url = f"{ARCHIVE}?{urllib.parse.urlencode({'year': year})}"
        body, final_url = _get(archive_url, "text/html")
        archive_text = body.decode("utf-8", errors="replace")
        if "Surveillance Reports" not in archive_text:
            raise SourceUnavailableError(
                f"NOAA OSPO archive page was not recognized: {final_url}"
            )
        for txt_url, zip_url, stem in _candidate_reports(
            archive_text, final_url, cutoff.date()
        ):
            reports[stem] = (txt_url, zip_url)

    incidents: list[PollutionIncident] = []
    for stem, (txt_url, zip_url) in sorted(reports.items()):
        txt_body, final_txt_url = _get(txt_url, "text/plain")
        report_text = txt_body.decode("utf-8", errors="replace")
        if not _txt_passes_prefilter(report_text):
            continue
        zip_body, final_zip_url = _get(zip_url, "application/zip")
        for index, geometry in enumerate(_zip_polygons(zip_body)):
            center = _geometry_center_radius(geometry)
            if center is None:
                continue
            lat, lng, radius_m = center
            incident = PollutionIncident(
                id=f"noaa_ospo_mpsr:{stem}:{index}",
                source_id=source.id,
                observed_at=_observed_at(report_text, stem),
                lat=lat,
                lng=lng,
                radius_m=radius_m,
                geom=geometry,
                kind="slick",
                area_km2=None,
                confidence=_confidence(report_text),
                location_precision="exact",
                raw={
                    "product_id": stem,
                    "text": report_text,
                    "original_url": final_txt_url,
                    "zip_url": final_zip_url,
                    "geometry_origin": "NOAA OSPO analyst report ZIP GeoJSON",
                },
            )
            incident.validate()
            incidents.append(incident)
    return incidents


register_source(SRC, poll)
