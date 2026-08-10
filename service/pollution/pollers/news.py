"""Caspian pollution news pollers with bounded six-month archive traversal."""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sqlite3
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any, Iterable, Optional
from urllib.parse import parse_qsl, quote_plus, urlencode, urljoin, urlsplit, urlunsplit

from service.db import connect as _connect

from .. import db as pollution_db
from ..classifier import is_pollution_article
from ..net import fetch_text
from ..models import PollutionIncident, PollutionSource
from ..opencode_geocoder import (
    extract_report_details,
    geocode_place,
    geocode_via_opencode,
)
from ..registry import SourceUnavailableError, register_source

_USER_AGENT = "SEALv pollution-news/1.0 (+public Caspian environmental monitor)"
_TIMEOUT_SECONDS = 12
_SIX_MONTHS = timedelta(days=183)

_REGION_RE = re.compile(
    r"каспи|caspian|kaspi|атырау|atyrau|мангист|mangist|актау|aktau|кульсары|kulsary|"
    r"кашаган|kashagan|тенгиз|tengiz|ncoc|ncoс|казмунайгаз|kazmunaigas|kmg|анпз",
    re.IGNORECASE,
)
_POLLUTION_RE = re.compile(
    r"разлив|razliv|загряз|zagryaz|нефт(?:яное|яной|и)?\s+пятн|neft[^\s/]*[-_ ]+pyatn|"
    r"утеч|utech|leak|сброс|sbros|слив|sliv|сточ|stoc|sewage|выброс|vybros|"
    r"отход|otkhod|pollution|discharge|spill|slick",
    re.IGNORECASE,
)
_PLACE_RE = re.compile(
    r"пляж\s+(?:Аташ|Дюбенди)|месторождени[ея]\s+Морское|Аташ|Дюбенди|Пираллахы|Кашаган|Тенгиз|Каламкас|Дунга|"
    r"Кульсары|Атырау|Актау|Мангистауская область|Мангистау|Dubendi|Pirallahi|Kashagan|Tengiz|"
    r"Kalamkas|Dunga|Kulsary|Atyrau|Aktau|Mangystau",
    re.IGNORECASE,
)
_ARTICLE_PATHS = {
    "azh_news": re.compile(r"/ru/news/view/\d+(?:$|[?#])"),
    "tengrinews_search": re.compile(r"tengrinews\.kz/[a-z_-]+/.+-\d+/?(?:$|[?#])"),
    "atpress_ecology": re.compile(r"atpress\.kz/ru/news/ekologiya/[^/?#]+"),
}
_TRACKING_QUERY_KEYS = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"}


@dataclass(frozen=True)
class Candidate:
    url: str
    title: str = ""
    listed_at: Optional[str] = None


@dataclass(frozen=True)
class Article:
    url: str
    title: str
    body: str
    observed_at: Optional[str]
    source_coordinates: Optional[tuple[float, float]]

@dataclass(frozen=True)
class _ResolvedCoordinates:
    lat: float
    lng: float
    radius_m: float
    place: str
    precision: str
    coordinate_basis: str
    root_cause: str | None


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self._href: Optional[str] = None
        self._parts: list[str] = []
        self._inside_anchor = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        if tag.lower() != "a" or self._inside_anchor:
            return
        values = dict(attrs)
        self._href = values.get("href")
        self._parts = []
        self._inside_anchor = True

    def handle_data(self, data: str) -> None:
        if self._inside_anchor:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "a" or not self._inside_anchor:
            return
        if self._href:
            self.links.append((self._href, _clean_text(" ".join(self._parts))))
        self._href = None
        self._parts = []
        self._inside_anchor = False


class _ArticleParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.canonical: Optional[str] = None
        self.times: list[str] = []
        self.h1: list[str] = []
        self.paragraphs: list[str] = []
        self.article_paragraphs: list[str] = []
        self.json_ld: list[str] = []
        self._h1_depth = 0
        self._p_depth = 0
        self._article_depth = 0
        self._script_depth = 0
        self._h1_parts: list[str] = []
        self._p_parts: list[str] = []
        self._script_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        tag = tag.lower()
        values = {str(k).lower(): v or "" for k, v in attrs}
        if tag in {"article", "main"}:
            self._article_depth += 1
        if tag == "meta":
            key = (values.get("property") or values.get("name") or values.get("itemprop") or "").lower()
            content = values.get("content", "").strip()
            if key and content:
                self.meta[key] = content
        elif tag == "link" and "canonical" in values.get("rel", "").lower():
            self.canonical = values.get("href") or self.canonical
        elif tag == "time" and values.get("datetime"):
            self.times.append(values["datetime"].strip())
        elif tag == "h1":
            self._h1_depth += 1
            if self._h1_depth == 1:
                self._h1_parts = []
        elif tag == "p":
            self._p_depth += 1
            if self._p_depth == 1:
                self._p_parts = []
        elif tag == "script" and "ld+json" in values.get("type", "").lower():
            self._script_depth += 1
            if self._script_depth == 1:
                self._script_parts = []

    def handle_data(self, data: str) -> None:
        if self._h1_depth:
            self._h1_parts.append(data)
        if self._p_depth:
            self._p_parts.append(data)
        if self._script_depth:
            self._script_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "h1" and self._h1_depth:
            self._h1_depth -= 1
            if self._h1_depth == 0:
                value = _clean_text(" ".join(self._h1_parts))
                if value:
                    self.h1.append(value)
        elif tag == "p" and self._p_depth:
            self._p_depth -= 1
            if self._p_depth == 0:
                value = _clean_text(" ".join(self._p_parts))
                if value:
                    self.paragraphs.append(value)
                    if self._article_depth:
                        self.article_paragraphs.append(value)
        elif tag == "script" and self._script_depth:
            self._script_depth -= 1
            if self._script_depth == 0:
                value = "".join(self._script_parts).strip()
                if value:
                    self.json_ld.append(value)
        if tag in {"article", "main"} and self._article_depth:
            self._article_depth -= 1


LAST_REJECTIONS: dict[str, list[dict[str, str]]] = {}
LAST_POLL_STATUS: dict[str, dict[str, Any]] = {}


def _clean_text(value: str) -> str:
    return " ".join(html.unescape(value or "").split())


def _fetch(url: str) -> str:
    return fetch_text(
        url,
        headers={
            "User-Agent": _USER_AGENT,
            "Accept": "text/html,application/xml;q=0.9,*/*;q=0.8",
        },
        timeout=_TIMEOUT_SECONDS,
        max_bytes=10 * 1024 * 1024,
    )


def _max_pages(default: int) -> int:
    value = os.environ.get("SEALV_POLLUTION_MAX_PAGES", "").strip()
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return max(1, min(parsed, 100))


def _parse_datetime(value: Optional[str], default_tz: timezone = timezone.utc) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        parsed = None
        for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%Y/%m/%d"):
            try:
                parsed = datetime.strptime(text[:10], fmt)
                break
            except ValueError:
                continue
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=default_tz)
    return parsed


def _runtime_cutoff(since: Optional[str]) -> datetime:
    six_month_cutoff = datetime.now(timezone.utc) - _SIX_MONTHS
    supplied = _parse_datetime(since)
    if supplied is None:
        return six_month_cutoff
    return max(six_month_cutoff, supplied.astimezone(timezone.utc))


def _canonicalize(url: str) -> str:
    parts = urlsplit(url.strip())
    query = urlencode([(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key.lower() not in _TRACKING_QUERY_KEYS])
    path = re.sub(r"/{2,}", "/", parts.path) or "/"
    return urlunsplit(((parts.scheme or "https").lower(), parts.netloc.lower(), path, query, ""))


def _listing_prefilter(text: str) -> bool:
    """Cheaply filter title/URL slugs before downloading article details."""
    return bool(_REGION_RE.search(text or "") and _POLLUTION_RE.search(text or ""))


def parse_listing(document: str, base_url: str, source_id: str) -> list[Candidate]:
    """Parse one HTML listing page. Exposed for stable fixture tests."""
    parser = _LinkParser()
    parser.feed(document)
    pattern = _ARTICLE_PATHS.get(source_id)
    candidates: list[Candidate] = []
    seen: set[str] = set()
    for href, title in parser.links:
        url = _canonicalize(urljoin(base_url, href))
        if pattern is None or not pattern.search(url):
            continue
        if url in seen:
            continue
        seen.add(url)
        candidates.append(Candidate(url=url, title=title))
    return candidates


def parse_sitemap(document: str) -> tuple[list[Candidate], list[str]]:
    """Return article rows and nested sitemap URLs from a sitemap document."""
    root = ET.fromstring(document)
    rows: list[Candidate] = []
    nested: list[str] = []
    for element in root.iter():
        local = element.tag.rsplit("}", 1)[-1]
        if local == "sitemap":
            loc = next(((_clean_text(child.text or "")) for child in element if child.tag.rsplit("}", 1)[-1] == "loc"), "")
            if loc:
                nested.append(loc)
        elif local == "url":
            values: dict[str, str] = {}
            for child in element.iter():
                key = child.tag.rsplit("}", 1)[-1]
                if key in {"loc", "lastmod", "publication_date", "title"} and child.text:
                    values[key] = _clean_text(child.text)
            if values.get("loc"):
                rows.append(Candidate(values["loc"], values.get("title", ""), values.get("publication_date") or values.get("lastmod")))
    return rows, nested


def _json_values(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _json_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from _json_values(child)

def _json_location_coordinates(article_item: dict[str, Any]) -> Optional[tuple[float, float]]:
    for key in ("contentLocation", "locationCreated", "spatialCoverage"):
        for item in _json_values(article_item.get(key)):
            if str(item.get("@type", "")).lower() != "geocoordinates":
                continue
            try:
                return float(item["latitude"]), float(item["longitude"])
            except (KeyError, TypeError, ValueError):
                continue
    return None


def parse_article(document: str, requested_url: str, listed_at: Optional[str] = None) -> Article:
    """Parse canonical URL, date, title, body and explicit source coordinates."""
    parser = _ArticleParser()
    parser.feed(document)
    canonical = _canonicalize(urljoin(requested_url, parser.canonical or requested_url))
    title = _clean_text(
        parser.meta.get("og:title")
        or parser.meta.get("twitter:title")
        or parser.meta.get("headline")
        or (parser.h1[0] if parser.h1 else "")
    )
    date_value = (
        parser.meta.get("article:published_time")
        or parser.meta.get("datepublished")
        or parser.meta.get("publish-date")
        or parser.meta.get("date")
        or (parser.times[0] if parser.times else None)
    )
    source_coordinates: Optional[tuple[float, float]] = None
    geo_position = parser.meta.get("geo.position")
    if geo_position:
        match = re.match(r"\s*(-?\d+(?:\.\d+)?)\s*[;,]\s*(-?\d+(?:\.\d+)?)", geo_position)
        if match:
            source_coordinates = (float(match.group(1)), float(match.group(2)))
    for payload in parser.json_ld:
        try:
            data = json.loads(payload)
        except (TypeError, ValueError):
            continue
        for item in _json_values(data):
            if not date_value and isinstance(item.get("datePublished"), str):
                date_value = item["datePublished"]
            if not title and isinstance(item.get("headline"), str):
                title = _clean_text(item["headline"])
            item_type = str(item.get("@type", "")).lower()
            if source_coordinates is None and "article" in item_type:
                source_coordinates = _json_location_coordinates(item)
    paragraphs = parser.article_paragraphs or parser.paragraphs
    body = _clean_text("\n".join(paragraphs))
    if not body:
        body = _clean_text(parser.meta.get("description") or parser.meta.get("og:description") or "")
    observed = _parse_datetime(date_value, timezone(timedelta(hours=5)))
    return Article(
        url=canonical,
        title=title,
        body=body[:20000],
        observed_at=observed.isoformat() if observed else None,
        source_coordinates=source_coordinates,
    )


def _list_html_pages(
    source: PollutionSource, cutoff: datetime
) -> tuple[list[Candidate], int, list[str]]:
    pages: list[str] = []
    incremental = cutoff >= datetime.now(timezone.utc) - timedelta(days=2)
    if source.id == "azh_news":
        maximum = 1 if incremental else _max_pages(12)
        for category in ("ecology", "neft-i-gaz"):
            pages.extend(f"https://azh.kz/ru/news/{category}" + (f"?page={page}" if page > 1 else "") for page in range(1, maximum + 1))
    elif source.id == "tengrinews_search":
        maximum = 1 if incremental else _max_pages(8)
        for query in ("Каспий разлив", "Каспий загрязнение", "Атырау выброс"):
            encoded = quote_plus(query)
            pages.append(f"https://tengrinews.kz/search/?text={encoded}")
            pages.extend(f"https://tengrinews.kz/search/page/{page}/?field=all&text={encoded}" for page in range(2, maximum + 1))
        tag = "https://tengrinews.kz/tag/%D1%8D%D0%BA%D0%BE%D0%BB%D0%BE%D0%B3%D0%B8%D1%8F/"
        pages.append(tag)
        pages.extend(f"{tag}page/{page}/" for page in range(2, maximum + 1))
    elif source.id == "atpress_ecology":
        maximum = 1 if incremental else _max_pages(24)
        pages.extend("https://atpress.kz/ru/news/ekologiya" + (f"?start={(page - 1) * 12}" if page > 1 else "") for page in range(1, maximum + 1))
    candidates: list[Candidate] = []
    errors: list[str] = []
    fetched = 0
    for page_url in pages:
        try:
            document = _fetch(page_url)
        except SourceUnavailableError as exc:
            if exc.retry_after_seconds is not None:
                raise
            errors.append(str(exc))
            print(f"[pollution] {source.id} listing failure: {exc}")
            continue
        fetched += 1
        candidates.extend(parse_listing(document, page_url, source.id))
    return candidates, fetched, errors


def _numeric_sitemap_order(url: str) -> tuple[int, str]:
    match = re.search(r"/(\d+)\.xml$", url)
    return (int(match.group(1)) if match else -1, url)


def _list_sitemaps(source: PollutionSource, cutoff: datetime) -> tuple[list[Candidate], int, list[str]]:
    errors: list[str] = []
    fetched = 0
    try:
        index_document = _fetch(source.url)
        fetched += 1
    except SourceUnavailableError:
        raise
    except RuntimeError as exc:
        raise SourceUnavailableError(str(exc)) from exc
    try:
        rows, nested = parse_sitemap(index_document)
    except (ET.ParseError, ValueError) as exc:
        raise SourceUnavailableError(f"invalid sitemap {source.url}: {exc}") from exc
    candidates = list(rows)
    incremental = cutoff >= datetime.now(timezone.utc) - timedelta(days=2)
    if source.id == "informburo_sitemap":
        archive = sorted(
            (url for url in nested if "/sitemaps/articles/" in url),
            key=_numeric_sitemap_order,
            reverse=True,
        )
        news = [url for url in nested if url.endswith("sitemap-news.xml")]
        sitemap_urls = (news + archive)[: (2 if incremental else _max_pages(30))]
    else:
        archive = sorted(
            (url for url in nested if re.search(r"/sitemap/\d+\.xml$", url)),
            key=_numeric_sitemap_order,
            reverse=True,
        )
        sitemap_urls = archive[: (1 if incremental else _max_pages(4))]
        if source.url.endswith("google-news-sitemap.xml"):
            sitemap_urls = []
    for sitemap_url in sitemap_urls:
        try:
            document = _fetch(sitemap_url)
            fetched += 1
            child_rows, _ = parse_sitemap(document)
        except SourceUnavailableError as exc:
            if exc.retry_after_seconds is not None:
                raise
            errors.append(f"{sitemap_url}: {exc}")
            print(f"[pollution] {source.id} sitemap failure: {sitemap_url}: {exc}")
            continue
        except (ET.ParseError, ValueError) as exc:
            errors.append(f"{sitemap_url}: {exc}")
            print(f"[pollution] {source.id} invalid sitemap: {sitemap_url}: {exc}")
            continue
        for row in child_rows:
            listed = _parse_datetime(row.listed_at)
            if listed and listed.astimezone(timezone.utc) < cutoff:
                continue
            candidates.append(row)
    return candidates, fetched, errors


def _dedupe_candidates(candidates: Iterable[Candidate]) -> list[Candidate]:
    selected: dict[str, Candidate] = {}
    for candidate in candidates:
        url = _canonicalize(candidate.url)
        current = selected.get(url)
        if current is None or (not current.title and candidate.title):
            selected[url] = Candidate(url, candidate.title, candidate.listed_at)
    return [selected[url] for url in sorted(selected)]



def _cached_record(source_id: str, record_key: str) -> Optional[dict]:
    conn = _connect()
    try:
        return pollution_db.get_record(conn, source_id, record_key)
    except sqlite3.Error:
        return None
    finally:
        conn.close()

def _record_rejection(source_id: str, url: str, reason: str) -> None:
    LAST_REJECTIONS.setdefault(source_id, []).append({"url": url, "reason": reason})
    print(f"[pollution] {source_id} rejected {url}: {reason}")


def _resolve_coordinates(article: Article, text: str) -> Optional[_ResolvedCoordinates]:
    if article.source_coordinates is not None:
        lat, lng = article.source_coordinates
        if 35.0 <= lat <= 49.5 and 45.0 <= lng <= 56.5:
            details = extract_report_details(text)
            return _ResolvedCoordinates(
                lat,
                lng,
                500.0,
                "source coordinates",
                "exact",
                "source",
                details.root_cause,
            )
    places: list[str] = []
    for match in _PLACE_RE.finditer(text):
        place = match.group(0)
        if place.casefold() not in {value.casefold() for value in places}:
            places.append(place)
    places.sort(
        key=lambda value: (
            0
            if any(term in value.lower() for term in ("месторожд", "кашаган", "тенгиз", "каламкас", "kashagan", "tengiz", "kalamkas"))
            else 1
            if any(term in value.lower() for term in ("пляж", "дюбенди", "пираллах", "dubendi", "pirallahi"))
            else 2
        )
    )
    for place in places:
        resolved = geocode_place(place)
        if resolved:
            lat, lng, radius_m, display_name = resolved
            precision = "field" if any(key in place.lower() for key in ("кашаган", "тенгиз", "каламкас", "kashagan", "tengiz", "kalamkas")) else "approximate"
            details = extract_report_details(text)
            return _ResolvedCoordinates(
                lat,
                lng,
                float(radius_m),
                display_name,
                precision,
                "verified_named_place",
                details.root_cause,
            )
    resolved = geocode_via_opencode(text)
    if resolved:
        coordinate_basis = "source" if resolved.place == "source coordinates" else "verified_named_place"
        precision = "exact" if coordinate_basis == "source" else "field" if any(key in resolved.place.lower() for key in ("кашаган", "тенгиз", "каламкас", "kashagan", "tengiz", "kalamkas")) else "approximate"
        return _ResolvedCoordinates(
            resolved.lat,
            resolved.lng,
            resolved.radius_m,
            resolved.place,
            precision,
            coordinate_basis,
            resolved.root_cause,
        )
    return None


def _incident_from_article(source: PollutionSource, article: Article, cutoff: datetime) -> Optional[PollutionIncident]:
    if not article.title or not article.body:
        _record_rejection(source.id, article.url, "missing parsed title or body")
        return None
    observed = _parse_datetime(article.observed_at)
    if observed is None:
        _record_rejection(source.id, article.url, "missing publication date")
        return None
    if observed.astimezone(timezone.utc) < cutoff:
        return None
    text = f"{article.title}\n{article.body}"
    if not is_pollution_article(text):
        _record_rejection(source.id, article.url, "classifier rejected")
        return None
    location = _resolve_coordinates(article, text)
    if location is None:
        _record_rejection(source.id, article.url, "unresolved named place")
        return None
    lat = location.lat
    lng = location.lng
    radius_m = location.radius_m
    place = location.place
    precision = location.precision
    coordinate_basis = location.coordinate_basis
    digest = hashlib.sha256(article.url.encode("utf-8")).hexdigest()[:20]
    lower = text.lower()
    kind = "discharge" if any(term in lower for term in ("сброс", "сточн", "sewage", "discharge")) else "spill"
    incident = PollutionIncident(
        id=f"{source.id}:{digest}",
        source_id=source.id,
        observed_at=observed.isoformat(),
        lat=lat,
        lng=lng,
        radius_m=radius_m,
        kind=kind,
        location_precision=precision,
        raw={
            "url": article.url,
            "canonical_url": article.url,
            "original_url": article.url,
            "title": article.title,
            "body": article.body,
            "resolved_place": place,
            "coordinate_basis": coordinate_basis,
            "root_cause": location.root_cause,
        },
    )
    try:
        incident.validate()
    except ValueError as exc:
        _record_rejection(source.id, article.url, f"invalid resolved coordinates: {exc}")
        return None
    return incident


def poll(source: PollutionSource, since: Optional[str] = None) -> list[PollutionIncident]:
    """Poll one news source, traversing no earlier than the runtime six-month cutoff."""
    cutoff = _runtime_cutoff(since)
    LAST_REJECTIONS[source.id] = []
    if source.id in {"informburo_sitemap", "zakon_news"}:
        candidates, fetched_pages, errors = _list_sitemaps(source, cutoff)
    else:
        candidates, fetched_pages, errors = _list_html_pages(source, cutoff)
    if fetched_pages == 0:
        message = errors[0] if errors else f"no listing pages fetched for {source.id}"
        raise SourceUnavailableError(message)
    candidate_cache: dict[str, Optional[dict]] = {}
    filtered_candidates: list[Candidate] = []
    recheck_after = datetime.now(timezone.utc) - timedelta(days=7)
    for candidate in _dedupe_candidates(candidates):
        listed = _parse_datetime(candidate.listed_at)
        if listed is not None and listed.astimezone(timezone.utc) < cutoff:
            continue
        cached = _cached_record(source.id, candidate.url)
        candidate_cache[candidate.url] = cached
        if cached is not None and (
            listed is None or listed.astimezone(timezone.utc) < recheck_after
        ):
            continue
        filtered_candidates.append(candidate)
    candidates = filtered_candidates
    incidents: list[PollutionIncident] = []
    detail_failures = 0
    lexical_candidates = [candidate for candidate in candidates if _listing_prefilter(f"{candidate.title} {candidate.url}")]
    for candidate in lexical_candidates:
        try:
            document = _fetch(candidate.url)
            content_hash = hashlib.sha256(document.encode("utf-8")).hexdigest()
            cached = candidate_cache.get(candidate.url)
            if cached is not None and cached.get("content_hash") == content_hash:
                continue
            article = parse_article(document, candidate.url, candidate.listed_at)
        except SourceUnavailableError as exc:
            if exc.retry_after_seconds is not None:
                raise SourceUnavailableError(
                    str(exc),
                    retry_after_seconds=exc.retry_after_seconds,
                    partial_incidents=incidents,
                ) from exc
            detail_failures += 1
            _record_rejection(source.id, candidate.url, str(exc))
            continue
        incident = _incident_from_article(source, article, cutoff)
        if incident is not None:
            incident.raw["_content_hash"] = content_hash
            incidents.append(incident)
    incidents.sort(key=lambda item: (item.observed_at or "", item.id))
    LAST_POLL_STATUS[source.id] = {
        "fetched_listing_pages": fetched_pages,
        "listing_errors": len(errors),
        "discovered_candidates": len(candidates),
        "lexical_candidates": len(lexical_candidates),
        "detail_failures": detail_failures,
        "rejections": len(LAST_REJECTIONS[source.id]),
        "accepted": len(incidents),
        "cutoff": cutoff.isoformat(),
    }
    if errors or detail_failures:
        raise SourceUnavailableError(
            f"incomplete {source.id} scan: {len(errors)} listing failures, "
            f"{detail_failures} detail failures",
            partial_incidents=incidents,
        )
    return incidents


register_source(
    PollutionSource(
        id="azh_news",
        name="Azh.kz Ecology and Oil & Gas",
        url="https://azh.kz/ru/news/ecology",
        type="scrape",
        poll_method="GET ecology and oil-gas category pages, then canonical article details",
        update_freq="1h",
    ),
    poll,
)
register_source(
    PollutionSource(
        id="tengrinews_search",
        name="Tengrinews Caspian Search",
        url="https://tengrinews.kz/search/?text=%D0%9A%D0%B0%D1%81%D0%BF%D0%B8%D0%B9",
        type="scrape",
        poll_method="GET targeted search pagination, then canonical article details",
        update_freq="3h",
    ),
    poll,
)
register_source(
    PollutionSource(
        id="informburo_sitemap",
        name="Informburo News Sitemap",
        url="https://informburo.kz/sitemap.xml",
        type="scrape",
        poll_method="GET news/archive sitemaps, lexical URL prefilter, then article details",
        update_freq="3h",
    ),
    poll,
)
register_source(
    PollutionSource(
        id="zakon_news",
        name="Zakon.kz News Sitemap",
        url="https://www.zakon.kz/sitemap/index.xml",
        type="scrape",
        poll_method="GET ordered sitemap archive, lexical URL prefilter, then article details",
        update_freq="3h",
    ),
    poll,
)
register_source(
    PollutionSource(
        id="atpress_ecology",
        name="AtyrauPress Ecology",
        url="https://atpress.kz/ru/news/ekologiya",
        type="scrape",
        poll_method="GET ecology pagination, then canonical article details",
        update_freq="3h",
    ),
    poll,
)
