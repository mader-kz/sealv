"""Official NCOC, Tengizchevroil, and KPO incident-news pollers.

The publisher pages contain mostly corporate news.  This module deliberately
requires evidence of an actual accident/pollution event and an explicit,
resolvable location before emitting an incident.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Optional
from urllib.parse import urljoin, urlsplit, urlunsplit

from ..fields import geocode_field
from ..models import PollutionIncident, PollutionSource
from ..registry import register_source

_USER_AGENT = "SEALv pollution operators/1.0 (+https://sealv.kz)"
_TIMEOUT_S = 15
_DEFAULT_HISTORY_DAYS = 183

# Strong event nouns, not generic environmental or ESG language.
_INCIDENT_RE = re.compile(
    r"\b(?:oil\s+spill|spill(?:ed|age)?|leak(?:ed|age)?|ruptur(?:e|ed)|"
    r"accident|emergency|fire|explosion|unauthori[sz]ed\s+discharge|"
    r"contamination\s+(?:was\s+)?(?:found|detected|reported)|"
    r"pollution\s+(?:incident|event|was\s+(?:found|detected|reported)))\b|"
    r"(?:разлив|утечк\w*|авари\w*|пожар\w*|взрыв\w*|"
    r"несанкционированн\w+\s+сброс\w*|загрязнен\w+\s+(?:обнаруж|зафикс|произош))",
    re.IGNORECASE,
)
_OCCURRED_RE = re.compile(
    r"\b(?:occurred|happened|reported|detected|found|contained|localized|"
    r"investigat(?:e|ed|ing)|respond(?:ed|ing)|caused|resulted)\b|"
    r"(?:произош\w*|случил\w*|обнаруж\w*|зафикс\w*|локализ\w*|ликвидир\w*)",
    re.IGNORECASE,
)
_PREPAREDNESS_RE = re.compile(
    r"\b(?:drill|exercise|training|workshop|forum|preparedness|readiness|"
    r"prevention|response\s+base|response\s+equipment|donat(?:e|ed|ion)|"
    r"sustainability|environmental\s+performance|biodiversity|landscaping)\b|"
    r"(?:учени\w*|трениров\w*|готовност\w*|предотвращен\w*|семинар\w*|"
    r"оборудован\w*|устойчив\w+\s+развит\w*)",
    re.IGNORECASE,
)
_COORD_RE = re.compile(
    r"(?<!\d)(?P<lat>3[6-9](?:\.\d+)?|4[0-9](?:\.\d+)?|5[0-3](?:\.\d+)?)"
    r"\s*[,; ]\s*(?P<lng>4[6-9](?:\.\d+)?|5[0-5](?:\.\d+)?)(?!\d)"
)
_ISO_DATE_RE = re.compile(r"\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b")
_DMY_DATE_RE = re.compile(r"\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.(20\d{2})\b")
_MONTH_DATE_RE = re.compile(
    r"\b(January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+(0?[1-9]|[12]\d|3[01])(?:,)?\s+(20\d{2})\b",
    re.IGNORECASE,
)
_MONTHS = {
    name.lower(): index
    for index, name in enumerate(
        "January February March April May June July August September October November December".split(), 1
    )
}


class _HTMLText(HTMLParser):
    """Extract visible article text and links without third-party dependencies."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.links: list[str] = []
        self._ignored = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "svg", "nav", "header", "footer"}:
            self._ignored += 1
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(html.unescape(href))

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style", "svg", "nav", "header", "footer"} and self._ignored:
            self._ignored -= 1

    def handle_data(self, data: str) -> None:
        if not self._ignored and data.strip():
            self.parts.append(data.strip())


def _fetch(url: str) -> bytes | None:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": _USER_AGENT, "Accept": "text/html,application/json;q=0.9,*/*;q=0.5"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as response:
            return response.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
        print(f"[pollution.operators] fetch_failed url={url!r} error={exc!r}")
        return None


def _decode(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


def _parse_html(data: bytes) -> tuple[str, list[str]]:
    parser = _HTMLText()
    try:
        parser.feed(_decode(data))
    except Exception as exc:
        print(f"[pollution.operators] html_parse_failed error={exc!r}")
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip(), parser.links


def _canonical_url(url: str) -> str:
    split = urlsplit(html.unescape(url))
    # Publisher cache hashes change without changing the KPO article identity.
    query = "&".join(part for part in split.query.split("&") if part and not part.lower().startswith("chash="))
    return urlunsplit((split.scheme.lower(), split.netloc.lower(), split.path, query, ""))


def _cutoff(since: str | None) -> datetime:
    if since:
        try:
            value = datetime.fromisoformat(since.replace("Z", "+00:00"))
            return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
        except ValueError:
            print(f"[pollution.operators] invalid_since value={since!r}; using six_month_cutoff")
    return datetime.now(timezone.utc) - timedelta(days=_DEFAULT_HISTORY_DAYS)


def _parse_date(text: str, url: str = "") -> datetime | None:
    match = _ISO_DATE_RE.search(url) or _ISO_DATE_RE.search(text)
    if match:
        try:
            return datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)), tzinfo=timezone.utc)
        except ValueError:
            pass
    match = _DMY_DATE_RE.search(text)
    if match:
        try:
            return datetime(int(match.group(3)), int(match.group(2)), int(match.group(1)), tzinfo=timezone.utc)
        except ValueError:
            pass
    match = _MONTH_DATE_RE.search(text)
    if match:
        try:
            return datetime(int(match.group(3)), _MONTHS[match.group(1).lower()], int(match.group(2)), tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def _has_incident_evidence(text: str) -> bool:
    if not _INCIDENT_RE.search(text):
        return False
    # Preparedness/ESG stories are not incidents unless the article also says an
    # event occurred, was detected, or was actively handled.
    if _PREPAREDNESS_RE.search(text) and not _OCCURRED_RE.search(text):
        return False
    return True


def _resolve_location(text: str) -> tuple[float, float, float, str, str] | None:
    coords = _COORD_RE.search(text)
    if coords:
        lat, lng = float(coords.group("lat")), float(coords.group("lng"))
        return lat, lng, 250.0, "coordinates_in_source", "exact"

    # Existing field/place table is source-reviewed.  A mapping is used only
    # when its canonical name or alias is literally present in article text.
    field = geocode_field(text)
    if not field:
        return None
    lat, lng, radius_m, matched_name = field
    return lat, lng, radius_m, matched_name, "field"


def _incident(source: PollutionSource, url: str, text: str, observed: datetime | None) -> PollutionIncident | None:
    if not _has_incident_evidence(text):
        print(f"[pollution.operators] rejected source={source.id} reason=no_incident_evidence url={url!r}")
        return None
    location = _resolve_location(text)
    if not location:
        print(f"[pollution.operators] rejected source={source.id} reason=unresolved_location url={url!r}")
        return None
    lat, lng, radius_m, place, precision = location
    canonical = _canonical_url(url)
    stable = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]
    incident = PollutionIncident(
        id=f"{source.id}:{stable}",
        source_id=source.id,
        observed_at=observed.isoformat().replace("+00:00", "Z") if observed else None,
        lat=lat,
        lng=lng,
        radius_m=radius_m,
        kind="spill",
        location_precision=precision,
        raw={"url": canonical, "text": text[:8000], "resolved_place": place},
    )
    try:
        incident.validate()
    except ValueError as exc:
        print(f"[pollution.operators] rejected source={source.id} reason=invalid_incident error={exc!r} url={url!r}")
        return None
    return incident


def _detail_links(list_url: str, predicate) -> tuple[list[str], list[str], str]:
    data = _fetch(list_url)
    if not data:
        return [], [], ""
    page_text, links = _parse_html(data)
    detail: list[str] = []
    pagination: list[str] = []
    for href in links:
        absolute = urljoin(list_url, href)
        if predicate(absolute):
            detail.append(_canonical_url(absolute))
        if "currentPage" in absolute or "currentpage" in absolute:
            pagination.append(absolute)
    return list(dict.fromkeys(detail)), list(dict.fromkeys(pagination)), page_text


def _oldest_dmy(text: str) -> datetime | None:
    dates: list[datetime] = []
    for day, month, year in _DMY_DATE_RE.findall(text):
        try:
            dates.append(datetime(int(year), int(month), int(day), tzinfo=timezone.utc))
        except ValueError:
            continue
    return min(dates) if dates else None


def _ncoc_links(cutoff: datetime) -> list[str]:
    links: list[str] = []
    for page in range(1, 44):
        api_url = f"https://www.ncoc.kz/api/v1/news?locale=en&page={page}"
        data = _fetch(api_url)
        if not data:
            break
        try:
            payload = json.loads(_decode(data))
            items = payload.get("data") or []
        except (ValueError, AttributeError) as exc:
            print(f"[pollution.operators] json_parse_failed url={api_url!r} error={exc!r}")
            break
        if not items:
            break
        oldest: datetime | None = None
        for item in items:
            if not isinstance(item, dict) or not item.get("slug"):
                continue
            published = _parse_date(str(item.get("published_at") or ""))
            if published and (oldest is None or published < oldest):
                oldest = published
            if not published or published >= cutoff:
                links.append(f"https://www.ncoc.kz/en/news/{item['slug']}")
        if oldest and oldest < cutoff:
            break
    return list(dict.fromkeys(links))


def _source_links(source: PollutionSource, cutoff: datetime) -> list[str]:
    if source.id == "ncoc_news":
        return _ncoc_links(cutoff)
    if source.id == "tco_news":
        links, _, _ = _detail_links(source.url, lambda u: "/tco-news/detail/" in u)
        return [u for u in links if (_parse_date("", u) or cutoff) >= cutoff]
    if source.id == "kpo_news":
        predicate = lambda u: "company-news" in u and "tx_news_pi1%5Bnews%5D=" in u
        first, pages, first_text = _detail_links(source.url, predicate)
        links = list(first)
        oldest = _oldest_dmy(first_text)
        if oldest and oldest < cutoff:
            return links
        # A six-month window is normally 2-4 archive pages; cap work to keep a
        # malformed paginator from creating an unbounded crawl.
        for page_url in pages[:11]:
            page_links, _, page_text = _detail_links(page_url, predicate)
            links.extend(page_links)
            oldest = _oldest_dmy(page_text)
            if oldest and oldest < cutoff:
                break
        return list(dict.fromkeys(links))
    print(f"[pollution.operators] unsupported_source id={source.id!r}")
    return []


def poll(source: PollutionSource, since: Optional[str] = None) -> list[PollutionIncident]:
    """Poll official operator history and return only located real incidents."""
    cutoff = _cutoff(since)
    output: list[PollutionIncident] = []
    for url in _source_links(source, cutoff):
        data = _fetch(url)
        if not data:
            continue
        text, _ = _parse_html(data)
        if not text:
            print(f"[pollution.operators] rejected source={source.id} reason=empty_detail url={url!r}")
            continue
        observed = _parse_date(text, url)
        if observed and observed < cutoff:
            continue
        incident = _incident(source, url, text, observed)
        if incident:
            output.append(incident)
    return output


NCOC_NEWS = PollutionSource(
    id="ncoc_news",
    name="North Caspian Operating Company news",
    url="https://www.ncoc.kz/en/news",
    type="scrape",
    poll_method="Daily GET news history/API index -> official HTML detail",
    update_freq="24h",
)
TCO_NEWS = PollutionSource(
    id="tco_news",
    name="Tengizchevroil news",
    url="https://tengizchevroil.com/tco-news",
    type="scrape",
    poll_method="Daily GET HTML history -> official HTML detail",
    update_freq="24h",
)
KPO_NEWS = PollutionSource(
    id="kpo_news",
    name="Karachaganak Petroleum Operating company news",
    url="https://www.kpo.kz/en/news-room/company-news/archive-company-news",
    type="scrape",
    poll_method="Daily GET paginated HTML history -> official HTML detail",
    update_freq="24h",
)

register_source(NCOC_NEWS, poll)
register_source(TCO_NEWS, poll)
register_source(KPO_NEWS, poll)
