"""Official Kazhydromet pollution document pollers.

VZ/EVZ DOCX files are incident-bearing.  Atyrau and Mangystau monthly
bulletins are incident-bearing only where the text explicitly describes an
oil-product exceedance and names a place we can resolve.  Weekly Caspian
bulletins are hydrometeorological context, never pollution incidents.
"""
from __future__ import annotations

import hashlib
import html as _html
import io
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from typing import Optional
from ..net import fetch_bytes

from ..fields import VERIFIED_PLACE_SOURCES, geocode_field
from ..opencode_geocoder import geocode_place
from ..models import PollutionIncident, PollutionSource
from ..registry import SourceUnavailableError, register_source

VZ_URL = "https://www.kazhydromet.kz/ru/ecology/svedeniya-o-sluchayah-vysokogo-zagryazneniya-i-ekstremalno-vysokogo-zagryazneniya-okruzhayuschey-sredy"
MONTHLY_URL = "https://www.kazhydromet.kz/ru/ecology/ezhemesyachnyy-informacionnyy-byulleten-o-sostoyanii-okruzhayuschey-sredy"
WEEKLY_URL = "https://www.kazhydromet.kz/ru/kaspiyskoe-more/byulleten-po-kaspiyskomu-moryu"
_USER_AGENT = "SEALv/1.0 pollution-poller (+https://github.com/aissultan/sealv)"
_TIMEOUT_S = 15
_MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

_MONTHS = {
    "январ": 1, "yanvar": 1,
    "феврал": 2, "fevral": 2,
    "март": 3, "mart": 3,
    "апрел": 4, "aprel": 4,
    "май": 5, "may": 5,
    "июн": 6, "iyun": 6,
    "июл": 7, "iyul": 7,
    "август": 8, "avgust": 8,
    "сентябр": 9, "sentyabr": 9,
    "октябр": 10, "oktyabr": 10,
    "ноябр": 11, "noyabr": 11,
    "декабр": 12, "dekabr": 12,
}
_HREF_RE = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)
_NUMERIC_DATE_RE = re.compile(r"(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?!\d)")
_RUSSIAN_DATE_RE = re.compile(
    r"(?<!\d)(\d{1,2})\s+(январ[ья]|феврал[ья]|марта|апрел[ья]|мая|июн[ья]|июл[ья]|августа|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья])\s+(\d{4})(?!\d)",
    re.IGNORECASE,
)
_OIL_RE = re.compile(r"нефтепродукт|разлив\w*\s+нефт(?:и|епродукт)|утечк\w*\s+нефт(?:и|епродукт)|нефтян\w*\s+загрязнен", re.IGNORECASE)
_EXPLICIT_OIL_EXCEED_RE = re.compile(
    r"(?:нефтепродукт.{0,220}(?<!не\s)превыш\w*|(?<!не\s)превыш\w*.{0,220}нефтепродукт)",
    re.IGNORECASE | re.DOTALL,
)
_MONTHLY_REGION_RE = re.compile(r"atyrau|атырау|mang(?:i|y)stau|манг(?:и|ы)стау", re.IGNORECASE)
_NAMED_LOCATION_RE = re.compile(
    r"(?:\b(?:с|п|пос)\.?\s*|\bрайон\s+|\b(?:г|город)\.?\s*)([А-ЯЁҚҒҢҮҰІӘӨҺ][А-Яа-яЁёҚқҒғҢңҮүҰұІіӘәӨөҺһ-]{2,})"
)
_PLACE_CACHE: dict[str, tuple[float, float, float, str] | None] = {}

# Refreshed by poll_weekly_context.  This is deliberately metadata rather than
# PollutionIncident data because a weather/sea-state forecast is not oil.
WEEKLY_CONTEXT: list[dict[str, str]] = []


def _fetch(url: str) -> bytes:
    return fetch_bytes(
        url,
        headers={"User-Agent": _USER_AGENT},
        timeout=_TIMEOUT_S,
        max_bytes=_MAX_DOCUMENT_BYTES,
    )


def _html_links(data: bytes, base_url: str, suffix: str) -> list[str]:
    text = data.decode("utf-8", errors="replace")
    seen: set[str] = set()
    links: list[str] = []
    for href in _HREF_RE.findall(text):
        url = urllib.parse.urljoin(base_url, _html.unescape(href))
        clean = urllib.parse.urlsplit(url).path.lower()
        if not clean.endswith(suffix) or url in seen:
            continue
        seen.add(url)
        links.append(url)
    return links


def _selected_year(data: bytes) -> int:
    text = data.decode("utf-8", errors="replace")
    match = re.search(r"<option[^>]*selected[^>]*>\s*(20\d{2})\s*</option>", text, re.IGNORECASE)
    if not match:
        match = re.search(r"<option[^>]*>\s*(20\d{2})\s*</option>", text, re.IGNORECASE)
    return int(match.group(1)) if match else datetime.now(timezone.utc).year


def _month_number(text: str) -> int | None:
    low = urllib.parse.unquote(text).lower().replace("ё", "е")
    for stem, month in _MONTHS.items():
        if stem in low:
            return month
    return None


def _document_month(url: str, default_year: int) -> datetime | None:
    name = urllib.parse.unquote(urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1]).lower()
    month = _month_number(name)
    if month is None:
        return None
    years = re.findall(r"(?<!\d)(20\d{2})(?!\d)", name)
    year = int(years[-1]) if years else default_year
    return datetime(year, month, 1, tzinfo=timezone.utc)


def _since_datetime(since: str | None) -> datetime | None:
    if not since:
        return None
    try:
        parsed = datetime.fromisoformat(since.strip().replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        print(f"[kazhydromet] invalid_since value={since!r}")
        return None


def _month_is_new_enough(month: datetime, since: datetime | None) -> bool:
    if since is None:
        return True
    return (month.year, month.month) >= (since.year, since.month)


def _iso_date(year: int, month: int, day: int) -> str | None:
    try:
        return datetime(year, month, day, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def _parse_russian_date(text: str, fallback: datetime) -> str:
    numeric = _NUMERIC_DATE_RE.search(text)
    if numeric:
        day, month, year = map(int, numeric.groups())
        if year < 100:
            year += 2000
        parsed = _iso_date(year, month, day)
        if parsed:
            return parsed
    named = _RUSSIAN_DATE_RE.search(text)
    if named:
        day = int(named.group(1))
        month = _month_number(named.group(2))
        if month:
            parsed = _iso_date(int(named.group(3)), month, day)
            if parsed:
                return parsed
    return fallback.isoformat().replace("+00:00", "Z")


def _docx_rows(data: bytes) -> list[str]:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            xml = archive.read("word/document.xml")
        root = ET.fromstring(xml)
        namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        rows = [
            re.sub(r"\s+", " ", " ".join(node.text for node in row.findall(".//w:t", namespace) if node.text)).strip()
            for row in root.findall(".//w:tr", namespace)
        ]
        rows = [row for row in rows if row]
        if rows:
            return rows
        text = " ".join(node.text for node in root.findall(".//w:t", namespace) if node.text)
        return [re.sub(r"\s+", " ", text).strip()] if text.strip() else []
    except Exception as exc:
        raise SourceUnavailableError(f"invalid Kazhydromet DOCX: {exc}") from exc


def _pdf_text(data: bytes, url: str) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise SourceUnavailableError("Kazhydromet PDF support requires pypdf") from exc
    try:
        reader = PdfReader(io.BytesIO(data))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as exc:
        raise SourceUnavailableError(f"invalid Kazhydromet PDF {url}: {exc}") from exc


def _monthly_location(text: str, position: int):
    """Resolve the nearest explicitly named station; never use a region centroid."""
    before = text[max(0, position - 500):position]
    close_context = before[-300:] + text[position:min(len(text), position + 120)]
    resolved = geocode_field(close_context)
    if resolved:
        place = resolved[3]
        # A region/operator mention is not a station. City points are accepted
        # only when the report labels the city in the local context.
        if place in {"Atyrau", "Aktau"} and not re.search(
            rf"(?:\bг\.?\s*|\bгород\s+){'Атырау' if place == 'Atyrau' else 'Актау'}\b",
            close_context,
            re.IGNORECASE,
        ):
            return None
        precision = (
            "field"
            if place in {"Kashagan", "Tengiz", "Dunga", "Kalamkas-Khazar", "Kulzhan", "Karazhanbas"}
            else "approximate"
        )
        return (*resolved, precision)

    named = list(_NAMED_LOCATION_RE.finditer(before))
    if not named:
        return None
    stated_place = named[-1].group(1)
    query = f"{stated_place}, Атырауская область, Казахстан"
    if query not in _PLACE_CACHE:
        _PLACE_CACHE[query] = geocode_place(query)
    resolved = _PLACE_CACHE[query]
    return (*resolved, "approximate") if resolved else None


def _reject(source_id: str, url: str, reason: str, text: str) -> None:
    compact = re.sub(r"\s+", " ", text).strip()[:240]
    print(f"[{source_id}] rejected reason={reason} url={url!r} text={compact!r}")


def poll(source: PollutionSource, since: Optional[str] = None) -> list[PollutionIncident]:
    """Poll all monthly VZ/EVZ DOCX files at or after ``since``'s month."""
    index = _fetch(source.url)
    if not index:
        return []
    year = _selected_year(index)
    cutoff = _since_datetime(since)
    documents: list[tuple[str, datetime]] = []
    for url in _html_links(index, source.url, ".docx"):
        name = urllib.parse.unquote(urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1])
        if "vz" not in name.lower() and "вз" not in name.lower():
            continue
        month = _document_month(url, year)
        if month is None:  # quarterly/half-year reports duplicate monthly data
            continue
        if _month_is_new_enough(month, cutoff):
            documents.append((url, month))

    incidents: list[PollutionIncident] = []
    failures = 0
    retry_after_seconds: float | None = None
    for doc_url, month in documents:
        try:
            raw_document = _fetch(doc_url)
            if not raw_document:
                continue
            rows = _docx_rows(raw_document)
        except SourceUnavailableError as exc:
            failures += 1
            if exc.retry_after_seconds is not None:
                retry_after_seconds = max(retry_after_seconds or 0, exc.retry_after_seconds)
            continue
        doc_name = urllib.parse.unquote(urllib.parse.urlsplit(doc_url).path.rsplit("/", 1)[-1])
        for row_number, row in enumerate(rows):
            if not _OIL_RE.search(row):
                continue
            geo = geocode_field(row)
            if not geo:
                _reject(source.id, doc_url, "unresolved_location", row)
                continue
            lat, lng, radius_m, place = geo
            if not (40.0 <= lat <= 49.5 and 46.0 <= lng <= 56.5):
                _reject(source.id, doc_url, "outside_caspian_region", row)
                continue
            observed_at = _parse_russian_date(row, month)
            if cutoff:
                observed = _since_datetime(observed_at)
                # Rows without an exact date inherit the report month and stay
                # eligible when the report month overlaps the cutoff month.
                if observed and observed < cutoff and (
                    _NUMERIC_DATE_RE.search(row) or _RUSSIAN_DATE_RE.search(row)
                ):
                    continue
            incident = PollutionIncident(
                id=f"{source.id}:{doc_name}:{row_number}",
                source_id=source.id,
                observed_at=observed_at,
                lat=lat,
                lng=lng,
                radius_m=radius_m,
                kind="discharge",
                location_precision="field",
                raw={
                    "doc": doc_name,
                    "row": row,
                    "url": doc_url,
                    "resolved_place": place,
                    "location_source": VERIFIED_PLACE_SOURCES.get(place),
                },
            )
            try:
                incident.validate()
            except Exception as exc:
                _reject(source.id, doc_url, f"invalid_incident:{exc}", row)
                continue
            incidents.append(incident)
    if failures:
        raise SourceUnavailableError(
            f"incomplete {source.id} scan: {failures} document failures",
            retry_after_seconds=retry_after_seconds,
            partial_incidents=incidents,
        )
    return incidents


def poll_monthly(source: PollutionSource, since: Optional[str] = None) -> list[PollutionIncident]:
    """Extract explicit oil-product exceedances from regional monthly PDFs."""
    index = _fetch(source.url)
    if not index:
        return []
    year = _selected_year(index)
    cutoff = _since_datetime(since)
    documents: list[tuple[str, datetime]] = []
    for url in _html_links(index, source.url, ".pdf"):
        if not _MONTHLY_REGION_RE.search(urllib.parse.unquote(url)):
            continue
        if any(token in url.lower() for token in ("kvartal_", "polugodie_")):
            continue
        month = _document_month(url, year)
        if month and _month_is_new_enough(month, cutoff):
            documents.append((url, month))

    incidents: list[PollutionIncident] = []
    failures = 0
    retry_after_seconds: float | None = None
    for pdf_url, month in documents:
        try:
            raw_document = _fetch(pdf_url)
            if not raw_document:
                continue
            text = _pdf_text(raw_document, pdf_url)
        except SourceUnavailableError as exc:
            failures += 1
            if exc.retry_after_seconds is not None:
                retry_after_seconds = max(retry_after_seconds or 0, exc.retry_after_seconds)
            continue
        if not text:
            continue
        for match_number, exceedance_match in enumerate(_EXPLICIT_OIL_EXCEED_RE.finditer(text)):
            window_start = max(0, exceedance_match.start() - 350)
            window_end = min(len(text), exceedance_match.end() + 350)
            window = text[window_start:window_end]
            geo = _monthly_location(text, exceedance_match.start())
            if not geo:
                _reject(source.id, pdf_url, "unresolved_exceedance_location", window)
                continue
            lat, lng, radius_m, place, location_precision = geo
            snippet = re.sub(r"\s+", " ", window).strip()
            digest = hashlib.sha256(f"{pdf_url}\n{match_number}\n{snippet}".encode("utf-8")).hexdigest()[:16]
            incident = PollutionIncident(
                id=f"{source.id}:{digest}",
                source_id=source.id,
                observed_at=month.isoformat().replace("+00:00", "Z"),
                lat=lat,
                lng=lng,
                radius_m=radius_m,
                kind="discharge",
                location_precision=location_precision,
                raw={
                    "url": pdf_url,
                    "text": snippet,
                    "resolved_place": place,
                    "location_source": VERIFIED_PLACE_SOURCES.get(place),
                    "document_month": f"{month.year:04d}-{month.month:02d}",
                    "classification": "explicit_oil_product_exceedance",
                },
            )
            try:
                incident.validate()
            except Exception as exc:
                _reject(source.id, pdf_url, f"invalid_incident:{exc}", snippet)
                continue
            incidents.append(incident)
    if failures:
        raise SourceUnavailableError(
            f"incomplete {source.id} scan: {failures} document failures",
            retry_after_seconds=retry_after_seconds,
            partial_incidents=incidents,
        )
    return incidents


def _weekly_period_end(period: str) -> datetime | None:
    match = re.search(r"[-–]\s*(\d{1,2})[.-](\d{1,2})[.-](\d{2,4})", period)
    if not match:
        return None
    day, month, year = map(int, match.groups())
    if year < 100:
        year += 2000
    try:
        return datetime(year, month, day, tzinfo=timezone.utc)
    except ValueError:
        return None


def poll_weekly_context(source: PollutionSource, since: Optional[str] = None) -> list[PollutionIncident]:
    """Refresh official weekly sea-state metadata; never emit oil incidents."""
    cutoff = _since_datetime(since)
    index = _fetch(source.url)
    if not index:
        return []
    html = index.decode("utf-8", errors="replace")
    entries: list[dict[str, str]] = []
    seen: set[str] = set()
    for match in _HREF_RE.finditer(html):
        url = urllib.parse.urljoin(source.url, _html.unescape(match.group(1)))
        if not urllib.parse.urlsplit(url).path.lower().endswith(".pdf") or "byulleten" not in url.lower() or url in seen:
            continue
        seen.add(url)
        nearby = re.sub(r"<[^>]+>", " ", html[match.end():match.end() + 280])
        nearby = re.sub(r"\s+", " ", _html.unescape(nearby)).strip()
        period_match = re.search(r"\d{1,2}(?:[.-]\d{1,2})?(?:[.-]\d{2,4})?\s*[-–]\s*\d{1,2}[.-]\d{1,2}[.-]\d{2,4}", nearby)
        period = period_match.group(0) if period_match else "unknown"
        period_end = _weekly_period_end(period)
        if cutoff and period_end and period_end < cutoff:
            continue
        entries.append({"url": url, "period": period})
    WEEKLY_CONTEXT[:] = entries
    if entries:
        print(f"[{source.id}] context={json.dumps(entries[-1], ensure_ascii=False, sort_keys=True)}")
    else:
        print(f"[{source.id}] context_missing url={source.url!r}")
    return []


SRC = PollutionSource(
    id="kazhydromet_vz",
    name="Kazhydromet VZ/EVZ",
    url=VZ_URL,
    type="scrape",
    poll_method="GET index -> every monthly VZ/EVZ DOCX at/after since",
    update_freq="monthly",
)
MONTHLY_SRC = PollutionSource(
    id="kazhydromet_monthly",
    name="Kazhydromet Atyrau/Mangystau monthly environment bulletins",
    url=MONTHLY_URL,
    type="scrape",
    poll_method="GET index -> regional PDF -> explicit oil-product exceedances",
    update_freq="monthly",
)
WEEKLY_SRC = PollutionSource(
    id="kazhydromet_weekly",
    name="Kazhydromet weekly Caspian bulletin metadata",
    url=WEEKLY_URL,
    type="scrape",
    poll_method="GET index -> retain weekly PDF URL/period as non-incident context",
    update_freq="weekly",
)

register_source(SRC, poll)
register_source(MONTHLY_SRC, poll_monthly)
register_source(WEEKLY_SRC, poll_weekly_context)
