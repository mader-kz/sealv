"""Public NGO and research pollution feeds for the Caspian region.

Every record must pass the shared regional/pollution classifier and provide both a
source date and either source coordinates or a verified named-place resolution.
Unresolved reports are logged and rejected; no fallback coordinate is used.
"""
from __future__ import annotations

import json
import hashlib
import html as html_lib
import logging
import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Iterable, Optional
from urllib.parse import quote, urljoin, urlsplit

from ..classifier import is_pollution_article, lexical_prefilter
from ..net import fetch_text
try:
    from service.pollution.opencode_geocoder import geocode_via_opencode  # type: ignore
except ImportError:
    try:
        from ..opencode_geocoder import geocode_via_opencode  # type: ignore
    except ImportError:
        from ..fields import geocode_field as _geocode_field_fallback  # type: ignore

        def geocode_via_opencode(text):  # type: ignore
            r = _geocode_field_fallback(text)
            if not r:
                return None
            lat, lng, rad, name = r
            # mimic GeocodeResult
            class _R:
                pass
            o = _R()
            o.lat = lat
            o.lng = lng
            o.radius_m = rad
            o.place = name
            o.root_cause = None
            return o
from ..models import PollutionIncident, PollutionSource
from ..registry import SourceUnavailableError, register_source

logger = logging.getLogger(__name__)

_USER_AGENT = "SEALv-Pollution/1.0 (+https://sealv.org)"
_DMS_RE = re.compile(
    r"(?<!\d)(\d{1,2})\s*°\s*(\d{1,2})\s*[′'’]\s*(\d{1,2}(?:[.,]\d+)?)\s*[″\"”]*\s*([NS])"
    r"\s*[,;]?\s*"
    r"(\d{1,3})\s*°\s*(\d{1,2})\s*[′'’]\s*(\d{1,2}(?:[.,]\d+)?)\s*[″\"”]*\s*([EW])",
    re.IGNORECASE,
)
_DECIMAL_RE = re.compile(
    r"(?<![\d.])([3-4]\d|5[0-2])\.(\d{3,})\s*[,;/ ]\s*(4[4-9]|5[0-8])\.(\d{3,})(?![\d.])"
)
_AREA_RE = re.compile(
    r"([0-9]+(?:[.,][0-9]+)?)\s*(?:km\s*[²2]|sq\.?\s*km|кв\.?\s*км)", re.IGNORECASE
)
_POSITIVE_RE = re.compile(
    r"(?:обнаруж(?:ен|ено|ены)|зафиксирован\w*|выявлен\w*|"
    r"detected|recorded|observed|reported|"
    r"загрязнен\w*|загрязнён\w*|polluted|contaminated|"
    r"разлив\w*|сброс\w*|spill\w*|discharg\w*|leak\w*|slick\w*|"
    r"превышен\w*|exceed(?:ed|ance))",
    re.IGNORECASE,
)
_NEGATIVE_RE = re.compile(
    r"(?:no|not)\s+[^.!?\n]{0,180}(?:slick|spill|seep|pollut)[^.!?\n]{0,80}(?:detect|find|observ)\w*"
    r"|(?:пят(?:ен|на)|слик(?:ов|и)|нефтепроявлен\w*)[^.!?\n]{0,180}не\s+обнаруж\w*",
    re.IGNORECASE,
)
_SAR_RE = re.compile(r"sentinel|synthetic aperture|\bsar\b|радиолокац|\bрли\b|satellite", re.IGNORECASE)
_UNCERTAIN_RE = re.compile(r"possible|probable|likely|возможн\w*|вероятн\w*", re.IGNORECASE)
_POLLUTION_TITLE_RE = re.compile(
    r"нефт|разлив|загряз|сброс|сточн|нефтешлам|oil|spill|slick|pollut|discharg|contamin",
    re.IGNORECASE,
)
_TAG_RE = re.compile(r"<[^>]+>")
_LINK_RE = re.compile(r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", re.IGNORECASE | re.DOTALL)


def _timeout() -> float:
    try:
        value = float(os.environ.get("POLLUTION_FETCH_TIMEOUT", "12"))
    except ValueError:
        value = 12.0
    return min(30.0, max(2.0, value))


def _max_pages(default: int) -> int:
    raw = os.environ.get("SEALV_POLLUTION_MAX_PAGES")
    if raw:
        try:
            return min(100, max(1, int(raw)))
        except ValueError:
            logger.warning("invalid SEALV_POLLUTION_MAX_PAGES=%r; using %d", raw, default)
    return default


def _fetch(url: str) -> str:
    return fetch_text(
        url,
        headers={
            "User-Agent": _USER_AGENT,
            "Accept": "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.5",
        },
        timeout=_timeout(),
        max_bytes=10 * 1024 * 1024,
    )


def _text(markup: str) -> str:
    markup = re.sub(r"<(?:script|style)\b.*?</(?:script|style)>", " ", markup, flags=re.I | re.S)
    markup = re.sub(r"<(?:br|/p|/div|/li|/h[1-6])\b[^>]*>", "\n", markup, flags=re.I)
    value = html_lib.unescape(_TAG_RE.sub(" ", markup))
    return re.sub(r"[ \t\r\f\v]+", " ", re.sub(r"\n\s*\n+", "\n", value)).strip()


def _article_text(markup: str) -> str:
    match = re.search(r"<article\b[^>]*>(.*?)</article>", markup, re.IGNORECASE | re.DOTALL)
    return _text(match.group(1) if match else markup)


def _links(markup: str, base: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for match in _LINK_RE.finditer(markup):
        href = urljoin(base, html_lib.unescape(match.group(1)))
        if href in seen:
            continue
        seen.add(href)
        out.append((_text(match.group(2)), href))
    return out


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _report_time(text: str, fallback: Optional[str] = None) -> Optional[str]:
    patterns = (
        r"(?:получен[оа]?|acquired(?:\s+on)?|recorded(?:\s+on)?)\D{0,30}"
        r"(20\d{2})[-./](\d{1,2})[-./](\d{1,2})[, T]+(\d{1,2}):(\d{2})(?::(\d{2}))?",
        r"(?:получен[оа]?|acquired(?:\s+on)?|recorded(?:\s+on)?)\D{0,30}"
        r"(\d{1,2})[-./](\d{1,2})[-./](20\d{2})[, ]+(\d{1,2}):(\d{2})(?::(\d{2}))?",
        r"\b(20\d{2})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?",
        r"\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})(?:[, ]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?",
    )
    for index, pattern in enumerate(patterns):
        match = re.search(pattern, text, re.IGNORECASE)
        if not match:
            continue
        groups = match.groups(default="0")
        try:
            if index in (0, 2):
                year, month, day, hour, minute, second = map(int, groups)
            else:
                day, month, year, hour, minute, second = map(int, groups)
            return _iso(datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc))
        except ValueError:
            continue
    parsed = _parse_iso(fallback)
    return _iso(parsed) if parsed else None


def _rss_time(value: str) -> Optional[str]:
    try:
        return _iso(parsedate_to_datetime(value))
    except (TypeError, ValueError, OverflowError):
        return _report_time(value)


def _keep(observed_at: Optional[str], since: Optional[str]) -> bool:
    if not observed_at:
        return False
    cutoff = _parse_iso(since)
    observed = _parse_iso(observed_at)
    return observed is not None and (cutoff is None or observed >= cutoff)


def _dms_decimal(match: re.Match[str]) -> tuple[float, float]:
    lat_deg, lat_min = int(match.group(1)), int(match.group(2))
    lng_deg, lng_min = int(match.group(5)), int(match.group(6))
    lat_sec = float(match.group(3).replace(",", "."))
    lng_sec = float(match.group(7).replace(",", "."))
    if lat_deg > 90 or lng_deg > 180 or lat_min >= 60 or lng_min >= 60 or lat_sec >= 60 or lng_sec >= 60:
        raise ValueError("invalid DMS coordinate")
    lat = lat_deg + lat_min / 60 + lat_sec / 3600
    lng = lng_deg + lng_min / 60 + lng_sec / 3600
    if match.group(4).upper() == "S":
        lat = -lat
    if match.group(8).upper() == "W":
        lng = -lng
    return lat, lng


def _area_near(text: str, position: int) -> Optional[float]:
    # Reports list an area immediately after each coordinate. Prefer that
    # direction so an earlier coordinate's area cannot bleed into the next one.
    match = _AREA_RE.search(text[position : position + 220])
    if not match:
        matches = list(_AREA_RE.finditer(text[max(0, position - 140) : position]))
        match = matches[-1] if matches else None
    if not match:
        return None
    try:
        return float(match.group(1).replace(",", "."))
    except ValueError:
        return None


def _positive_evidence(text: str) -> bool:
    without_denials = _NEGATIVE_RE.sub(" ", text)
    return bool(_POSITIVE_RE.search(without_denials))


def _kind_confidence(text: str) -> tuple[str, float]:
    if _SAR_RE.search(text):
        return "slick", 0.55 if _UNCERTAIN_RE.search(text) else 0.72
    if re.search(r"сброс|discharg", text, re.IGNORECASE):
        return "discharge", 0.72
    return "spill", 0.68


def _external_id(url: str, fallback: str) -> str:
    telegram = re.search(r"twworldkasp/(\d+)", url)
    if telegram:
        return telegram.group(1)
    path = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
    if path and len(path) <= 100:
        return re.sub(r"[^a-zA-Z0-9_-]+", "-", path).strip("-")
    return fallback or hashlib.sha256(url.encode()).hexdigest()[:16]


def _explicit_coordinates(text: str) -> list[tuple[float, float, int]]:
    out: list[tuple[float, float, int]] = []
    for match in _DMS_RE.finditer(text):
        try:
            lat, lng = _dms_decimal(match)
        except (ValueError, OverflowError):
            continue
        out.append((lat, lng, match.start()))
    for match in _DECIMAL_RE.finditer(text):
        try:
            lat = float(f"{match.group(1)}.{match.group(2)}")
            lng = float(f"{match.group(3)}.{match.group(4)}")
        except ValueError:
            continue
        out.append((lat, lng, match.start()))
    return out


def _resolve_named_place(text: str):
    # primary: opencode geocoder (extract place via deepseek -> Nominatim -> water mask)
    try:
        geo = geocode_via_opencode(text)
    except Exception:
        geo = None
    if geo is not None:
        # geocode_via_opencode returns GeocodeResult with lat/lng/radius_m/place/root_cause
        try:
            return geo.lat, geo.lng, geo.radius_m, geo.place, getattr(geo, "root_cause", None)
        except AttributeError:
            # fallback tuple
            return geo
    if re.search(r"kokzhide|к[өо]кжиде", text, re.IGNORECASE):
        query = quote("Kenkiyak, Temir District, Aktobe Region, Kazakhstan")
        url = f"https://nominatim.openstreetmap.org/search?q={query}&format=json&limit=3&countrycodes=kz"
        try:
            results = json.loads(_fetch(url))
        except Exception as exc:
            logger.warning("Kokzhide named-place lookup failed url=%s error=%s", url, exc)
            return None
        for result in results:
            display_name = str(result.get("display_name") or "")
            name = str(result.get("name") or "")
            if not re.search(r"кеңқияқ|кенкияк|kenkiyak|keñqïyaq", name, re.IGNORECASE):
                continue
            if result.get("class") != "place" or result.get("type") not in {"town", "village"}:
                continue
            try:
                lat, lng = float(result["lat"]), float(result["lon"])
            except (KeyError, TypeError, ValueError):
                continue
            return lat, lng, 50000.0, f"Kokzhide area near {display_name}", None
    return None


def _incidents_from_record(
    source: PollutionSource,
    record: dict,
    since: Optional[str],
) -> list[PollutionIncident]:
    text = str(record.get("text") or "")
    observed_at = _report_time(text, record.get("published_at"))
    if not _keep(observed_at, since):
        return []
    if not is_pollution_article(text) or not _positive_evidence(text):
        return []

    url = str(record.get("url") or source.url)
    external_id = str(record.get("external_id") or _external_id(url, "record"))
    precision = "exact"
    resolver: Optional[str] = None
    radius_m = 500.0
    confidence_override: Optional[float] = None
    root_cause: Optional[str] = None
    coords = _explicit_coordinates(text)
    if not coords:
        resolved = _resolve_named_place(text)
        if not resolved:
            logger.info("[%s] rejected dated pollution report without resolvable location: %s", source.id, url)
            return []
        # handle both 4-tuple legacy and 5-tuple with root_cause
        if len(resolved) == 5:
            lat, lng, radius_m, resolver, root_cause = resolved
        else:
            lat, lng, radius_m, resolver = resolved
            root_cause = None
        coords = [(lat, lng, 0)]
        precision = "field" if radius_m <= 10000 else "approximate"
        confidence_override = 0.52

    kind, confidence = _kind_confidence(text)
    if confidence_override is not None:
        confidence = confidence_override
    incidents: list[PollutionIncident] = []
    seen: set[tuple[float, float]] = set()
    for lat, lng, position in coords:
        if not (35 <= lat <= 53 and 44 <= lng <= 59):
            continue
        coordinate_key = (round(lat, 5), round(lng, 5))
        if coordinate_key in seen:
            continue
        seen.add(coordinate_key)
        date_key = observed_at[:10]
        incident_id = f"{source.id}:{lat:.5f}:{lng:.5f}:{date_key}"
        raw = {
            "url": url,
            "original_url": url,
            "external_id": external_id,
            "published_at": record.get("published_at"),
            "text": text[:4000],
        }
        if resolver:
            raw["resolved_place"] = resolver
        if root_cause:
            raw["root_cause"] = root_cause
        incident = PollutionIncident(
            id=incident_id,
            source_id=source.id,
            observed_at=observed_at,
            lat=round(lat, 6),
            lng=round(lng, 6),
            radius_m=radius_m,
            kind=kind,
            area_km2=_area_near(text, int(position)),
            confidence=confidence,
            location_precision=precision,
            raw=raw,
        )
        try:
            incident.validate()
        except ValueError as exc:
            logger.warning("[%s] rejected invalid incident %s: %s", source.id, incident_id, exc)
            continue
        incidents.append(incident)
    return incidents


def _telegram_records(markup: str) -> tuple[list[dict], Optional[str]]:
    starts = list(re.finditer(r'data-post=["\'](twworldkasp/(\d+))["\']', markup, re.IGNORECASE))
    records: list[dict] = []
    for index, start in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else len(markup)
        block = markup[start.start() : end]
        timestamp = re.search(r'<time\b[^>]*datetime=["\']([^"\']+)', block, re.IGNORECASE)
        post_id = start.group(2)
        records.append(
            {
                "external_id": post_id,
                "url": f"https://t.me/s/twworldkasp/{post_id}",
                "published_at": timestamp.group(1) if timestamp else None,
                "text": _text(block),
            }
        )
    before = re.search(r'href=["\'][^"\']*\?before=(\d+)', markup, re.IGNORECASE)
    return records, before.group(1) if before else None


def _poll_transparent(source: PollutionSource, since: Optional[str]) -> list[PollutionIncident]:
    url = "https://t.me/s/twworldkasp"
    records_by_id: dict[str, dict] = {}
    for _ in range(_max_pages(6)):
        try:
            markup = _fetch(url)
        except SourceUnavailableError as exc:
            partial = _dedupe(source, records_by_id.values(), since)
            raise SourceUnavailableError(
                f"incomplete {source.id} scan: {url}: {exc}",
                retry_after_seconds=exc.retry_after_seconds,
                partial_incidents=partial,
            ) from exc
        page_records, before = _telegram_records(markup)
        for record in page_records:
            records_by_id[str(record["external_id"])] = record
        if not before or not page_records:
            break
        oldest = min((_parse_iso(r.get("published_at")) for r in page_records), default=None)
        cutoff = _parse_iso(since)
        if oldest and cutoff and oldest < cutoff:
            break
        next_url = f"https://t.me/s/twworldkasp?before={before}"
        if next_url == url:
            break
        url = next_url
    return _dedupe(source, records_by_id.values(), since)


FetchFailure = tuple[str, float | None]


def _save_caspian_records(source: PollutionSource) -> tuple[list[dict], list[FetchFailure]]:
    listing = _fetch(source.url)
    detail_urls = [
        href.replace("http://savethecaspiansea.com", "https://savethecaspiansea.com")
        for _, href in _links(listing, source.url)
        if "/tpost/" in href
    ]
    records: list[dict] = []
    errors: list[FetchFailure] = []
    for url in detail_urls[: 20 * _max_pages(2)]:
        try:
            markup = _fetch(url)
        except SourceUnavailableError as exc:
            errors.append((f"{url}: {exc}", exc.retry_after_seconds))
            continue
        text = _text(markup)
        records.append({"url": url, "external_id": _external_id(url, "tpost"), "text": text})
    return records, errors


def _rss_records(source: PollutionSource) -> tuple[list[dict], list[FetchFailure]]:
    records: list[dict] = []
    errors: list[FetchFailure] = []
    for page in range(1, _max_pages(3) + 1):
        url = source.url if page == 1 else f"{source.url}?paged={page}"
        try:
            markup = _fetch(url)
        except SourceUnavailableError as exc:
            errors.append((f"{url}: {exc}", exc.retry_after_seconds))
            break
        try:
            root = ET.fromstring(markup)
        except ET.ParseError as exc:
            raise SourceUnavailableError(f"invalid RSS from {url}: {exc}") from exc
        items = root.findall(".//item")
        if not items:
            break
        for item in items:
            link = (item.findtext("link") or source.url).strip()
            title = item.findtext("title") or ""
            published_at = _rss_time(item.findtext("pubDate") or "")
            parts = [title, item.findtext("description") or ""]
            for child in item:
                if child.tag.endswith("encoded") and child.text:
                    parts.append(child.text)
            text = _text("\n".join(parts))
            # RSS is discovery only. Follow relevant items so location and
            # incident claims come from the canonical detail, not a teaser.
            if lexical_prefilter(text):
                try:
                    text = f"{text}\n{_article_text(_fetch(link))}"
                except SourceUnavailableError as exc:
                    errors.append((f"{link}: {exc}", exc.retry_after_seconds))
            records.append(
                {
                    "url": link,
                    "external_id": _external_id(link, "rss"),
                    "published_at": published_at,
                    "text": text,
                }
            )
    return records, errors


def _eco_mangystau_records(source: PollutionSource) -> tuple[list[dict], list[FetchFailure]]:
    records: list[dict] = []
    errors: list[FetchFailure] = []
    urls = [source.url]
    pages = _max_pages(2)
    urls.extend(f"https://ecomangystau.kz/eko-kultura?page={page}" for page in range(1, pages + 1))
    detail_urls: dict[str, Optional[str]] = {}
    for listing_url in urls:
        try:
            markup = _fetch(listing_url)
        except SourceUnavailableError as exc:
            errors.append((f"{listing_url}: {exc}", exc.retry_after_seconds))
            continue
        for anchor_text, href in _links(markup, listing_url):
            if urlsplit(href).netloc != "ecomangystau.kz" or href.rstrip("/") == listing_url.rstrip("/"):
                continue
            date = _report_time(anchor_text)
            if date or re.search(r"/(?:eko-kultura|grazhdanskoe-obrazovanie)/[^/?#]+", href):
                detail_urls[href] = date
    for url, listing_date in list(detail_urls.items())[: 20 * pages]:
        try:
            markup = _fetch(url)
        except SourceUnavailableError as exc:
            errors.append((f"{url}: {exc}", exc.retry_after_seconds))
            continue
        records.append(
            {
                "url": url,
                "external_id": _external_id(url, "eco"),
                "published_at": listing_date,
                "text": _text(markup),
            }
        )
    return records, errors


def _published_meta(markup: str) -> Optional[str]:
    match = re.search(
        r'<meta\b[^>]*(?:property|name|itemprop)=["\'](?:article:published_time|datePublished|date)["\'][^>]*content=["\']([^"\']+)',
        markup,
        re.IGNORECASE,
    )
    if not match:
        match = re.search(r'<time\b[^>]*datetime=["\']([^"\']+)', markup, re.IGNORECASE)
    return _report_time(match.group(1), match.group(1)) if match else None


def _eco_citizens_records(source: PollutionSource) -> tuple[list[dict], list[FetchFailure]]:
    markup = _fetch(source.url)
    marker_re = re.compile(
        r"L\.marker\(\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\].*?"
        r"marker\.bindPopup\([\"'](?:<a\s+href=[\"']([^\"']+)[\"']>)?([^<\"']+)",
        re.IGNORECASE | re.DOTALL,
    )
    records: list[dict] = []
    errors: list[FetchFailure] = []
    for match in marker_re.finditer(markup):
        title = html_lib.unescape(match.group(4)).strip()
        if not _POLLUTION_TITLE_RE.search(title):
            continue
        url = urljoin(source.url, html_lib.unescape(match.group(3) or ""))
        if url == source.url:
            continue
        try:
            detail = _fetch(url)
        except SourceUnavailableError as exc:
            errors.append((f"{url}: {exc}", exc.retry_after_seconds))
            continue
        records.append(
            {
                "url": url,
                "external_id": _external_id(url, "hotspot"),
                "published_at": _published_meta(detail),
                "text": f"{title}\n{_text(detail)}",
                "coordinates": [(float(match.group(1)), float(match.group(2)), 0)],
            }
        )
    return records, errors


def _dedupe(source: PollutionSource, records: Iterable[dict], since: Optional[str]) -> list[PollutionIncident]:
    by_key: dict[tuple[str, float, float, str], PollutionIncident] = {}
    for record in records:
        for incident in _incidents_from_record(source, record, since):
            key = (incident.source_id, round(incident.lat, 5), round(incident.lng, 5), incident.observed_at or "")
            existing = by_key.get(key)
            if existing is None or (incident.confidence or 0) > (existing.confidence or 0):
                by_key[key] = incident
    return sorted(by_key.values(), key=lambda incident: (incident.observed_at or "", incident.id), reverse=True)

def _finish_records(
    source: PollutionSource,
    result: tuple[list[dict], list[FetchFailure]],
    since: Optional[str],
) -> list[PollutionIncident]:
    records, errors = result
    incidents = _dedupe(source, records, since)
    retry_values = [retry for _, retry in errors if retry is not None]
    if errors:
        raise SourceUnavailableError(
            f"incomplete {source.id} scan: {len(errors)} fetch failures",
            retry_after_seconds=max(retry_values, default=None),
            partial_incidents=incidents,
        )
    return incidents



def poll(source: PollutionSource, since: Optional[str] = None) -> list[PollutionIncident]:
    """Poll one NGO source using the stable ``(source, since)`` contract."""
    if source.id == "transparent_world":
        return _poll_transparent(source, since)
    if source.id == "save_caspian":
        return _finish_records(source, _save_caspian_records(source), since)
    if source.id == "crude_accountability":
        return _finish_records(source, _rss_records(source), since)
    if source.id == "eco_mangystau":
        return _finish_records(source, _eco_mangystau_records(source), since)
    if source.id == "eco_citizens_hotspots":
        return _finish_records(source, _eco_citizens_records(source), since)
    return []


transparent_world = PollutionSource(
    id="transparent_world",
    name="Transparent World on the Caspian",
    url="https://transparentworld.tech/",
    type="scrape",
    poll_method="GET public Telegram channel; paginate ?before=; parse dated SAR details",
    update_freq="daily",
)
save_caspian = PollutionSource(
    id="save_caspian",
    name="Save the Caspian Sea",
    url="https://savethecaspiansea.com/news",
    type="scrape",
    poll_method="GET Tilda news index; follow /tpost/ details with source dates",
    update_freq="daily",
)
crude_accountability = PollutionSource(
    id="crude_accountability",
    name="Crude Accountability",
    url="https://crudeaccountability.org/feed/",
    type="rss",
    poll_method="GET WordPress RSS; paginate ?paged=; require incident location evidence",
    update_freq="daily",
)
eco_mangystau = PollutionSource(
    id="eco_mangystau",
    name="EcoMangystau",
    url="https://ecomangystau.kz/",
    type="scrape",
    poll_method="GET public article listings and details; require date plus pollution evidence",
    update_freq="daily",
)
eco_citizens_hotspots = PollutionSource(
    id="eco_citizens_hotspots",
    name="EcoCitizens Kazakhstan Hotspots",
    url="https://ecocitizens.kz/",
    type="scrape",
    poll_method="GET Leaflet hotspot source coordinates; follow details; reject undated hotspots",
    update_freq="weekly",
)

for _source in (
    transparent_world,
    save_caspian,
    crude_accountability,
    eco_mangystau,
    eco_citizens_hotspots,
):
    register_source(_source, poll)
