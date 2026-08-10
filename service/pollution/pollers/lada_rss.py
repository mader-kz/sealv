"""Lada.kz + KMG + Tumba RSS pollers. Boring functions, stdlib only."""
from __future__ import annotations

import calendar
import os
import re
import time
import xml.etree.ElementTree as ET
import urllib.parse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional

from ..classifier import is_pollution_article
from ..net import fetch_bytes
from ..opencode_geocoder import geocode_via_opencode, is_water
from ..models import PollutionIncident, PollutionSource
from ..registry import SourceUnavailableError, register_source

# kept for reference; actual filtering via classifier prefilter + spill check
_PATTERN = re.compile(r"разлив|утечка|пятно|Каспий|Кашаган|Аташ|Тенгиз", re.IGNORECASE)
_KMG_EVENT_RE = re.compile(
    r"\b(?:oil\s+spill|spill(?:ed|age)?|leak(?:ed|age)?|ruptur(?:e|ed)|"
    r"accident|emergency|fire|explosion|unauthori[sz]ed\s+discharge)\b|"
    r"(?:разлив|утечк\w*|авари\w*|пожар\w*|взрыв\w*)",
    re.IGNORECASE,
)
_KMG_PREPAREDNESS_RE = re.compile(
    r"\b(?:drill|exercise|training|workshop|preparedness|readiness|prevention|"
    r"response\s+base|response\s+equipment|sustainability)\b|"
    r"(?:учени\w*|трениров\w*|готовност\w*|предотвращен\w*|устойчив\w+\s+развит\w*)",
    re.IGNORECASE,
)
_KMG_OCCURRED_RE = re.compile(
    r"\b(?:occurred|reported|detected|contained|localized|investigat(?:e|ed|ing)|responded)\b|"
    r"(?:произош\w*|обнаруж\w*|зафикс\w*|локализ\w*|ликвидир\w*)",
    re.IGNORECASE,
)

# Pagination — respect SEALV_POLLUTION_MAX_PAGES without changing poll contract.
_LADA_ECOLOGY_BASE = "https://www.lada.kz/aktau_news/ecology/"
_DEFAULT_MAX_PAGES = 1
_MAX_CONFIGURED_PAGES = 500
# HTML parsing for /ecology/page/N/
_LADA_ITEM_RE = re.compile(
    r'<a\s+href="(?P<href>/aktau_news/ecology/[^"]+)"[^>]*>.*?</a>.*?'
    r'<a[^>]*class="[^"]*news__link[^"]*"[^>]*>(?P<title>.*?)</a>.*?'
    r'<span[^>]*class="[^"]*news__date[^"]*"[^>]*>(?P<date>[^<]+)</span>',
    re.DOTALL | re.IGNORECASE,
)
_LADA_LINK_RE = re.compile(r'<a[^>]*class="[^"]*news__link[^"]*"[^>]*>(.*?)</a>', re.DOTALL | re.IGNORECASE)
_LADA_DATE_RE = re.compile(r'<span[^>]*class="[^"]*news__date[^"]*"[^>]*>(.*?)</span>', re.DOTALL | re.IGNORECASE)
_LADA_HREF_RE = re.compile(r'<a\s+href="(/aktau_news/ecology/[^"]+)"', re.IGNORECASE)


def _fetch(url: str) -> bytes:
    return fetch_bytes(
        url,
        headers={"User-Agent": "SEALv pollution poller"},
        timeout=10,
        max_bytes=5 * 1024 * 1024,
    )


def _fetch_text(url: str) -> str | None:
    data = _fetch(url)
    if data is None:
        return None
    try:
        return data.decode("utf-8", errors="replace")
    except Exception:
        return data.decode(errors="replace")


def _parse_pubdate(s: str | None) -> str | None:
    if not s:
        return None
    try:
        dt = parsedate_to_datetime(s)
        if dt is None:
            return None
        return dt.isoformat()
    except Exception:
        return None


def _parse_lada_date(raw: str | None) -> str | None:
    """Parse Lada HTML date like '09.08.2026, 19:32' -> ISO."""
    if not raw:
        return None
    s = raw.strip()
    for fmt in ("%d.%m.%Y, %H:%M", "%d.%m.%Y, %H:%M:%S", "%d.%m.%Y"):
        try:
            dt = datetime.strptime(s, fmt)
            dt = dt.replace(tzinfo=timezone.utc)
            return dt.isoformat().replace("+00:00", "Z")
        except Exception:
            continue
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def _since_filter(observed_at: str | None, since: str | None) -> bool:
    """Return True if should skip (observed < since)."""
    if not since or not observed_at:
        return False
    try:
        oa = observed_at.replace("Z", "+00:00")
        si = since.replace("Z", "+00:00")
        try:
            o_dt = datetime.fromisoformat(oa)
            s_dt = datetime.fromisoformat(si)
            return o_dt < s_dt
        except Exception:
            return observed_at < since
    except Exception:
        return False


def _max_pages() -> int:
    raw = os.environ.get("SEALV_POLLUTION_MAX_PAGES")
    if raw is None or raw.strip() == "":
        return _DEFAULT_MAX_PAGES
    try:
        v = int(raw.strip())
        return max(1, min(v, _MAX_CONFIGURED_PAGES))
    except Exception:
        return _DEFAULT_MAX_PAGES


def _resolve_max_pages(since: str | None) -> int:
    """Resolve effective max pages: env > backfill marker > since-supplied cutoff pagination."""
    raw = os.environ.get("SEALV_POLLUTION_MAX_PAGES")
    if raw is not None and raw.strip() != "":
        try:
            v = int(raw.strip())
            return max(1, min(v, _MAX_CONFIGURED_PAGES))
        except Exception:
            pass
    if os.environ.get("SEALV_POLLUTION_BACKFILL") == "1":
        return _MAX_CONFIGURED_PAGES
    if since is not None:
        return _MAX_CONFIGURED_PAGES
    return _DEFAULT_MAX_PAGES


def _page_delay() -> float:
    raw = os.environ.get("SEALV_POLLUTION_DELAY_SECONDS", "0")
    try:
        return max(0.0, float(raw))
    except Exception:
        return 0.0


def _six_month_cutoff(now: datetime | None = None) -> datetime:
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    absolute_month = current.year * 12 + current.month - 1 - 6
    year, zero_based_month = divmod(absolute_month, 12)
    month = zero_based_month + 1
    day = min(current.day, calendar.monthrange(year, month)[1])
    return current.replace(year=year, month=month, day=day)


def _utc_datetime(value: str) -> datetime:
    raw = value.strip()
    if not raw:
        raise ValueError("empty date")
    if len(raw) == 10:
        raw += "T00:00:00+00:00"
    else:
        raw = raw.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _effective_cutoff(since: str | None) -> datetime:
    six = _six_month_cutoff()
    if not since:
        return six
    try:
        req = _utc_datetime(since)
        return max(six, req)
    except Exception:
        return six


def _strip_tags(s: str) -> str:
    return re.sub(r"<[^>]+>", " ", s).strip()


def _lada_page_url(page: int) -> str:
    if page <= 1:
        return _LADA_ECOLOGY_BASE
    return f"{_LADA_ECOLOGY_BASE}page/{page}/"


def _extract_lada_items(html: str) -> list[dict]:
    """Parse Lada ecology HTML page into list of {title, link, date_raw}."""
    items: list[dict] = []
    for m in _LADA_ITEM_RE.finditer(html):
        href = m.group("href").strip()
        title_raw = m.group("title").strip()
        date_raw = m.group("date").strip()
        title = _strip_tags(title_raw)
        link = urllib.parse.urljoin("https://www.lada.kz", href)
        items.append({"title": title, "link": link, "date_raw": date_raw, "description": ""})
    if items:
        return items
    hrefs = _LADA_HREF_RE.findall(html)
    titles = [_strip_tags(t) for t in _LADA_LINK_RE.findall(html)]
    dates = [_strip_tags(d) for d in _LADA_DATE_RE.findall(html)]
    n = min(len(hrefs), len(titles), len(dates))
    for i in range(n):
        link = urllib.parse.urljoin("https://www.lada.kz", hrefs[i])
        items.append({"title": titles[i], "link": link, "date_raw": dates[i], "description": ""})
    return items


def _incident_from_text(
    source: PollutionSource,
    title: str,
    link: str,
    description: str,
    observed_at: str | None,
    since: str | None,
) -> PollutionIncident | None:
    text = f"{title} {description}".strip()
    if "каспи" not in text.lower():
        return None
    if not is_pollution_article(text):
        return None
    if source.id == "kmg_rss":
        if not _KMG_EVENT_RE.search(text):
            return None
        if _KMG_PREPAREDNESS_RE.search(text) and not _KMG_OCCURRED_RE.search(text):
            return None
    if _since_filter(observed_at, since):
        return None
    geo = geocode_via_opencode(text)
    if not geo:
        return None
    low = geo.place.lower()
    if "пляж" in low or "beach" in low:
        precision = "exact"
    elif any(k in low for k in ["кашаган", "тенгиз", "каламкас", "industrial", "месторождение", "kashagan", "tengiz"]):
        precision = "field"
    else:
        try:
            if is_water(geo.lat, geo.lng):
                precision = "exact"
            else:
                precision = "approximate"
        except Exception:
            precision = "approximate"
    ext_id = link or title
    ext_id_clean = ext_id.strip().replace("\n", "").replace("\r", "")
    inc_id = f"{source.id}:{ext_id_clean}"
    inc = PollutionIncident(
        id=inc_id,
        source_id=source.id,
        observed_at=observed_at,
        lat=geo.lat,
        lng=geo.lng,
        radius_m=geo.radius_m,
        kind="spill",
        location_precision=precision,
        raw={
            "title": title,
            "link": link,
            "description": description,
            "root_cause": geo.root_cause,
        },
    )
    try:
        inc.validate()
    except Exception:
        return None
    return inc


def _poll_single(source: PollutionSource, since: Optional[str] = None) -> list[PollutionIncident]:
    """Single-page RSS poll (original behavior)."""
    url = source.url
    data = _fetch(url)
    if not data:
        return []
    try:
        root = ET.fromstring(data)
    except Exception as exc:
        raise SourceUnavailableError(f"invalid Lada RSS XML: {exc}") from exc

    out: list[PollutionIncident] = []
    items = root.findall(".//item")
    if not items:
        items = [e for e in root.iter() if e.tag.endswith("item")]

    for item in items:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        guid = (item.findtext("guid") or "").strip()
        ext_id = link or guid or title
        if not ext_id:
            continue
        description = (item.findtext("description") or "").strip()
        if not description:
            for child in item:
                tag = child.tag.lower()
                if "description" in tag or "content" in tag or "summary" in tag:
                    if child.text:
                        description = child.text.strip()
                        break
        pub_raw = (item.findtext("pubDate") or "").strip()
        if not pub_raw:
            for child in item:
                tag = child.tag.lower()
                if tag.endswith("date") or tag.endswith("published") or tag.endswith("updated"):
                    if child.text:
                        pub_raw = child.text.strip()
                        break

        observed_at = _parse_pubdate(pub_raw) if pub_raw else None
        title_c = title
        desc_c = description
        link_c = link or guid
        inc = _incident_from_text(source, title_c, link_c, desc_c, observed_at, since)
        if inc is not None:
            out.append(inc)

    return out


def _poll_lada_paginated(source: PollutionSource, since: Optional[str] = None, max_pages: int | None = None) -> list[PollutionIncident]:
    """Paginated Lada ecology archive + RSS, bounded by SEALV_POLLUTION_MAX_PAGES."""
    if max_pages is None:
        max_pages = _resolve_max_pages(since)
    max_pages = max(1, min(max_pages, _MAX_CONFIGURED_PAGES))
    delay = _page_delay()
    cutoff = _effective_cutoff(since)
    cutoff_iso = cutoff.isoformat().replace("+00:00", "Z")
    filter_since = cutoff_iso
    if since:
        try:
            if _utc_datetime(since) > cutoff:
                filter_since = _utc_datetime(since).isoformat().replace("+00:00", "Z")
        except Exception:
            filter_since = since

    seen: set[str] = set()
    incidents: list[PollutionIncident] = []
    reached_cutoff = False

    rss_incidents = _poll_single(source, filter_since)
    for inc in rss_incidents:
        if inc.id not in seen:
            seen.add(inc.id)
            incidents.append(inc)

    for page in range(1, max_pages + 1):
        url = _lada_page_url(page)
        try:
            html = _fetch_text(url)
        except SourceUnavailableError as exc:
            raise SourceUnavailableError(
                f"incomplete {source.id} scan: page {page} failed: {exc}",
                retry_after_seconds=exc.retry_after_seconds,
                partial_incidents=incidents,
            ) from exc
        if html is None:
            if page == 1:
                continue
            break
        raw_items = _extract_lada_items(html)
        if not raw_items:
            break

        page_oldest: datetime | None = None
        new_on_page = 0
        for it in raw_items:
            link = it["link"]
            if link in seen or f"{source.id}:{link}" in seen:
                continue
            title = it["title"]
            desc = it.get("description", "")
            observed_at = _parse_lada_date(it.get("date_raw"))
            if observed_at:
                try:
                    dt = _utc_datetime(observed_at)
                    if page_oldest is None or dt < page_oldest:
                        page_oldest = dt
                except Exception:
                    pass
            if observed_at and _since_filter(observed_at, filter_since):
                continue
            inc = _incident_from_text(source, title, link, desc, observed_at, filter_since)
            if inc is None:
                continue
            if inc.id in seen:
                continue
            seen.add(inc.id)
            seen.add(link)
            incidents.append(inc)
            new_on_page += 1

        if page_oldest is not None and page_oldest < cutoff:
            reached_cutoff = True
            break

        if delay and page < max_pages:
            time.sleep(delay)

        if reached_cutoff:
            break
    else:
        if max_pages > 1 and not reached_cutoff:
            print(f"[lada_rss] page limit reached source={source.id} pages={max_pages} cutoff={cutoff.isoformat()}")

    incidents.sort(key=lambda x: (x.observed_at or "", x.id))
    return incidents


def poll(source: PollutionSource, since: Optional[str] = None) -> list[PollutionIncident]:
    """Generic RSS poller — dispatches to paginated Lada when archive pagination is needed."""
    if source.id == "lada_rss":
        mp = _resolve_max_pages(since)
        if mp > 1:
            return _poll_lada_paginated(source, since, mp)
    return _poll_single(source, since)


# --- Source definitions + registration ---

_lada = PollutionSource(
    id="lada_rss",
    name="Lada.kz",
    url="https://www.lada.kz/rss.xml",
    type="rss",
    poll_method="GET https://www.lada.kz/rss.xml + GET https://www.lada.kz/aktau_news/ecology/page/N/",
    update_freq="1h",
)

_tumba = PollutionSource(
    id="tumba_rss",
    name="Tumba.kz",
    url="https://tumba.kz/rss.php",
    type="rss",
    poll_method="GET https://tumba.kz/rss.php",
    update_freq="1h",
)

_kmg = PollutionSource(
    id="kmg_rss",
    name="KMG Press Releases",
    url="https://www.kmg.kz/en/press-center/press-releases/rss/",
    type="rss",
    poll_method="GET https://www.kmg.kz/en/press-center/press-releases/rss/",
    update_freq="1h",
)

register_source(_lada, poll)
register_source(_tumba, poll)
register_source(_kmg, poll)
