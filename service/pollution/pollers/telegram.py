"""Public Telegram preview ingestion for credible Caspian and regional channels.

The poller uses Telegram's public ``/s/`` pages; it does not require an account
or Bot API token.  Pagination is bounded by both a runtime six-calendar-month
cutoff and ``SEALV_POLLUTION_MAX_PAGES``.
"""
from __future__ import annotations

import calendar
import datetime as _dt
import html as _html
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

try:
    from service.pollution.classifier import is_pollution_article  # type: ignore
except ImportError:
    from ..classifier import is_pollution_article  # type: ignore

try:
    from service.pollution.opencode_geocoder import (  # type: ignore
        extract_report_details,
        geocode_via_opencode,
    )
except ImportError:
    from ..opencode_geocoder import extract_report_details, geocode_via_opencode  # type: ignore

from ..models import PollutionIncident, PollutionSource
from ..registry import register_source

_LOG = logging.getLogger(__name__)
_USER_AGENT = "Sealv-Pollution/1.0 (+https://github.com/sealv; public Telegram preview)"
_FETCH_TIMEOUT_SECONDS = 10
_DEFAULT_MAX_PAGES = 500
_MAX_CONFIGURED_PAGES = 2_000


@dataclass(frozen=True)
class _Channel:
    handle: str
    name: str


# Public channels verified in the Telegram web preview.  IDs are permanent;
# handles can be changed independently if a publisher renames a channel.
_CHANNELS: dict[str, _Channel] = {
    "telegram_azh": _Channel("AzhKz_RU", "Ак Жайык (Telegram)"),
    "telegram_lada": _Channel("ladakz", "LADA.KZ — Мангистау (Telegram)"),
    "telegram_petro": _Channel("Petro_council", "PetroCouncil.kz (Telegram)"),
    "telegram_orda": _Channel("orda_kz", "ORDA (Telegram)"),
    "telegram_mangystau_ecodep": _Channel(
        "mangystauecodep",
        "Департамент экологии по Мангистауской области (Telegram)",
    ),
    "telegram_twworld_kasp": _Channel(
        "twworldkasp",
        "Прозрачный Мир на Каспии (Telegram)",
    ),
    "telegram_kazhydromet": _Channel(
        "kazhydromet",
        "РГП «Казгидромет» (Telegram)",
    ),
    "telegram_atpress": _Channel("atpresskz", "ATPress.kz — Атырау (Telegram)"),
}

_CASPIAN_RE = re.compile(r"каспи|caspian", re.IGNORECASE)
# These are verified Caspian-region places, fields, facilities, or operators.
# Broad country-only words (Kazakhstan, Russia, Azerbaijan) are deliberately
# excluded because they do not establish regional relevance.
_REGIONAL_RE = re.compile(
    r"мангистау|маңғыстау|актау|ақтау|атырау|тенгиз|теңіз|tengiz|"
    r"кашаган|қашаған|kashagan|курык|құрық|kuryk|баутино|bautino|"
    r"форт[-\s]?шевченко|тупкараган|түпқараған|каламкас|қаламқас|"
    r"каражанбас|қаражанбас|жанаозен|жаңаөзен|карабатан|қарабатан|"
    r"каратурун|қаратұрын|дунга|dunga|бузачи|бозашы|аташ|"
    r"кульсары|құлсары|ncoc|нкок|анпз|атырауский нпз|"
    r"mangystau|aktau|atyrau",
    re.IGNORECASE,
)
_POLLUTION_RE = re.compile(
    r"разлив|нефтян(?:ое|ые|ой)\s+пятн|маслян(?:ое|ые|ой)\s+пятн|"
    r"пятн(?:о|а)-?слик|\bслик|судов(?:ой|ые)\s+сброс|"
    r"утечк|загрязнен|загрязнён|выброс|нефтепроявлен|"
    r"spill|oil\s+spot|oil\s+slick|slick|pollution|leak|discharge|"
    r"мұнай\s+төг|төгінді|ластан|шығарынд|ағып\s+кет",
    re.IGNORECASE,
)
# The shared classifier has this deliberately narrower Russian/English lexical
# contract.  Invoke it only when its vocabulary applies; regional-only messages
# have already passed the stronger local region + pollution conjunction.
_SHARED_CLASSIFIER_TERMS_RE = re.compile(
    r"разлив|пятн|выброс|утечка|загрязнение|масляные|spill|slick",
    re.IGNORECASE,
)
_NEGATIVE_RE = re.compile(
    r"не\s+(?:были\s+)?обнаружен|не\s+выявлен|не\s+зафиксирован|"
    r"не\s+подтвержден|не\s+подтверждён|not\s+(?:detected|found|confirmed)|"
    r"анықталмады|расталмады",
    re.IGNORECASE,
)
_SAR_RE = re.compile(r"sentinel|радиолокацион|\bSAR\b|спутников(?:ый|ого)\s+сним", re.IGNORECASE)
_DISCHARGE_RE = re.compile(r"сброс|выброс|discharge|шығарынд", re.IGNORECASE)
_FIELD_RE = re.compile(
    r"кашаган|қашаған|kashagan|тенгиз|теңіз|tengiz|каламкас|қаламқас|"
    r"каражанбас|қаражанбас|каратурун|қаратұрын|дунга|dunga|бузачи|бозашы",
    re.IGNORECASE,
)

_DECIMAL_COORD_RE = re.compile(
    r"(?<![\d.])([+-]?\d{1,2}(?:[.,]\d{1,7}))\s*[,;/\s]+\s*"
    r"([+-]?\d{1,3}(?:[.,]\d{1,7}))(?![\d.])"
)
_DMS_PAIR_RE = re.compile(
    r"(\d{1,2})\s*[°º]\s*(\d{1,2})\s*[′'’]?\s*"
    r"(?:(\d{1,2}(?:[.,]\d+)?)\s*[″\"”]?)?\s*[NnСс]?\s*[,;/\s]+\s*"
    r"(\d{1,3})\s*[°º]\s*(\d{1,2})\s*[′'’]?\s*"
    r"(?:(\d{1,2}(?:[.,]\d+)?)\s*[″\"”]?)?\s*[EeВв]?",
    re.IGNORECASE,
)

__all__ = ["telegram_poll"]


@dataclass(frozen=True)
class _Message:
    message_id: str
    observed_at: str
    observed_dt: _dt.datetime
    text: str
    url: str

@dataclass(frozen=True)
class _ResolvedLocation:
    lat: float
    lng: float
    radius_m: float
    precision: str
    source: str
    root_cause: str | None


def _six_month_cutoff(now: _dt.datetime | None = None) -> _dt.datetime:
    current = (now or _dt.datetime.now(_dt.timezone.utc)).astimezone(_dt.timezone.utc)
    absolute_month = current.year * 12 + current.month - 1 - 6
    year, zero_based_month = divmod(absolute_month, 12)
    month = zero_based_month + 1
    day = min(current.day, calendar.monthrange(year, month)[1])
    return current.replace(year=year, month=month, day=day)


def _parse_datetime(value: str | None) -> _dt.datetime | None:
    if not value:
        return None
    try:
        parsed = _dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed.astimezone(_dt.timezone.utc)


def _effective_cutoff(since: str | None) -> _dt.datetime:
    six_months_ago = _six_month_cutoff()
    requested = _parse_datetime(since)
    if since and requested is None:
        _LOG.warning("telegram invalid since=%r; using runtime six-month cutoff", since)
    return max(six_months_ago, requested) if requested is not None else six_months_ago


def _max_pages() -> int:
    raw = os.environ.get("SEALV_POLLUTION_MAX_PAGES")
    if raw is None:
        return _DEFAULT_MAX_PAGES
    try:
        value = int(raw)
    except ValueError:
        _LOG.warning("telegram invalid SEALV_POLLUTION_MAX_PAGES=%r; using %d", raw, _DEFAULT_MAX_PAGES)
        return _DEFAULT_MAX_PAGES
    return max(1, min(value, _MAX_CONFIGURED_PAGES))


def _page_delay_seconds() -> float:
    raw = os.environ.get("SEALV_POLLUTION_DELAY_SECONDS", "0")
    try:
        return max(0.0, min(float(raw), 5.0))
    except ValueError:
        return 0.0


def _page_url(handle: str, before: int | None = None) -> str:
    base = f"https://t.me/s/{urllib.parse.quote(handle, safe='')}"
    if before is None:
        return base
    return f"{base}?{urllib.parse.urlencode({'before': before})}"


def _fetch_html(handle: str, before: int | None = None) -> tuple[str, str] | None:
    url = _page_url(handle, before)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": _USER_AGENT, "Accept": "text/html,application/xhtml+xml"},
    )
    try:
        with urllib.request.urlopen(request, timeout=_FETCH_TIMEOUT_SECONDS) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return url, response.read().decode(charset, errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        _LOG.warning("telegram fetch failed url=%s error=%s", url, exc)
        return None


def _strip_tags(fragment: str) -> str:
    with_breaks = re.sub(r"<(?:br|/p|/div)\b[^>]*>", "\n", fragment, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", with_breaks)
    text = _html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _extract_messages(html: str, handle: str) -> list[_Message]:
    messages: list[_Message] = []
    for block in re.split(r'<div class="tgme_widget_message_wrap', html)[1:]:
        href_match = re.search(
            r'href="https://t\.me/(?:s/)?[^"/]+/(\d+)"',
            block,
            flags=re.IGNORECASE,
        )
        text_match = re.search(
            r'class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>',
            block,
            flags=re.DOTALL | re.IGNORECASE,
        )
        date_match = re.search(r'<time[^>]+datetime="([^"]+)"', block, flags=re.IGNORECASE)
        if not href_match or not text_match or not date_match:
            continue
        observed_dt = _parse_datetime(date_match.group(1))
        text = _strip_tags(text_match.group(1))
        if observed_dt is None or not text:
            continue
        message_id = href_match.group(1)
        messages.append(
            _Message(
                message_id=message_id,
                observed_at=observed_dt.isoformat(),
                observed_dt=observed_dt,
                text=text,
                url=f"https://t.me/{handle}/{message_id}",
            )
        )
    return messages


def _passes_relevance_gate(text: str, trusted_caspian_context: bool = False) -> bool:
    text_mentions_caspian = _CASPIAN_RE.search(text) is not None
    caspian = text_mentions_caspian or trusted_caspian_context
    regional = _REGIONAL_RE.search(text) is not None
    if not (caspian or regional) or _POLLUTION_RE.search(text) is None:
        return False
    if _NEGATIVE_RE.search(text) is not None:
        return False
    if text_mentions_caspian and _SHARED_CLASSIFIER_TERMS_RE.search(text) is not None:
        return is_pollution_article(text)
    return True


def _in_caspian_region(lat: float, lng: float) -> bool:
    return 35.0 <= lat <= 49.0 and 45.0 <= lng <= 55.0


def _all_source_coordinates(text: str) -> list[tuple[float, float]]:
    coordinates: list[tuple[float, float]] = []
    for match in _DMS_PAIR_RE.finditer(text):
        lat_degrees, lat_minutes, lat_seconds, lng_degrees, lng_minutes, lng_seconds = match.groups()
        try:
            lat_min = float(lat_minutes)
            lng_min = float(lng_minutes)
            lat_sec = float((lat_seconds or "0").replace(",", "."))
            lng_sec = float((lng_seconds or "0").replace(",", "."))
            if lat_min >= 60 or lng_min >= 60 or lat_sec >= 60 or lng_sec >= 60:
                continue
            lat = float(lat_degrees) + lat_min / 60.0 + lat_sec / 3600.0
            lng = float(lng_degrees) + lng_min / 60.0 + lng_sec / 3600.0
        except ValueError:
            continue
        if _in_caspian_region(lat, lng):
            coordinates.append((lat, lng))
    for match in _DECIMAL_COORD_RE.finditer(text):
        try:
            lat = float(match.group(1).replace(",", "."))
            lng = float(match.group(2).replace(",", "."))
        except ValueError:
            continue
        if _in_caspian_region(lat, lng):
            coordinates.append((lat, lng))
    # Preserve source order while removing coordinates repeated in captions.
    return list(dict.fromkeys((round(lat, 7), round(lng, 7)) for lat, lng in coordinates))


def _resolved_locations(text: str) -> list[_ResolvedLocation]:
    exact = _all_source_coordinates(text)
    if exact:
        details = extract_report_details(text)
        return [
            _ResolvedLocation(
                lat,
                lng,
                500.0,
                "exact",
                "source_coordinates",
                details.root_cause,
            )
            for lat, lng in exact
        ]
    resolved = geocode_via_opencode(text)
    if not resolved:
        return []
    if (
        not _in_caspian_region(resolved.lat, resolved.lng)
        or resolved.radius_m <= 0
    ):
        return []
    precision = "field" if _FIELD_RE.search(resolved.place) else "approximate"
    return [
        _ResolvedLocation(
            resolved.lat,
            resolved.lng,
            resolved.radius_m,
            precision,
            f"resolver:{resolved.place}",
            resolved.root_cause,
        )
    ]


def _kind(text: str) -> str:
    if _SAR_RE.search(text):
        return "slick"
    if _DISCHARGE_RE.search(text):
        return "discharge"
    return "spill"


def _incidents_for_message(
    source: PollutionSource,
    handle: str,
    message: _Message,
    page_url: str,
) -> list[PollutionIncident]:
    locations = _resolved_locations(message.text)
    incidents: list[PollutionIncident] = []
    for index, location in enumerate(locations, start=1):
        incident_id = f"{source.id}:{message.message_id}"
        if len(locations) > 1:
            incident_id += f":{index}"
        incident = PollutionIncident(
            id=incident_id,
            source_id=source.id,
            observed_at=message.observed_at,
            lat=location.lat,
            lng=location.lng,
            radius_m=location.radius_m,
            kind=_kind(message.text),
            location_precision=location.precision,
            raw={
                "text": message.text,
                "url": message.url,
                "page_url": page_url,
                "handle": handle,
                "message_id": message.message_id,
                "location_source": location.source,
                "coordinate_index": index if len(locations) > 1 else None,
                "root_cause": location.root_cause,
            },
        )
        try:
            incident.validate()
        except (TypeError, ValueError) as exc:
            _LOG.warning("telegram rejected id=%s reason=invalid_incident error=%s", incident_id, exc)
            continue
        incidents.append(incident)
    return incidents


def telegram_poll(source: PollutionSource, since: str | None = None) -> list[PollutionIncident]:
    """Poll one registered channel from ``since`` up to a six-month maximum."""
    channel = _CHANNELS.get(source.id)
    if channel is None:
        _LOG.warning("telegram unknown source id=%s", source.id)
        return []

    cutoff = _effective_cutoff(since)
    page_limit = _max_pages()
    delay_seconds = _page_delay_seconds()
    before: int | None = None
    previous_before: int | None = None
    seen_messages: set[str] = set()
    incidents: list[PollutionIncident] = []
    unresolved = 0
    reached_cutoff = False

    for page_number in range(1, page_limit + 1):
        fetched = _fetch_html(channel.handle, before)
        if fetched is None:
            break
        page_url, html = fetched
        messages = _extract_messages(html, channel.handle)
        if not messages:
            _LOG.warning("telegram empty page source=%s url=%s", source.id, page_url)
            break

        page_ids = [int(message.message_id) for message in messages]
        next_before = min(page_ids)
        dated_messages = [message for message in messages if message.observed_dt >= cutoff]
        for message in dated_messages:
            if message.message_id in seen_messages:
                continue
            seen_messages.add(message.message_id)
            if not _passes_relevance_gate(
                message.text,
                trusted_caspian_context=source.id == "telegram_twworld_kasp",
            ):
                continue
            resolved = _incidents_for_message(source, channel.handle, message, page_url)
            if not resolved:
                unresolved += 1
                continue
            incidents.extend(resolved)

        if min(message.observed_dt for message in messages) < cutoff:
            reached_cutoff = True
            break
        if next_before <= 1 or next_before == previous_before:
            _LOG.warning(
                "telegram pagination stalled source=%s before=%s page=%d",
                source.id,
                next_before,
                page_number,
            )
            break
        previous_before = next_before
        before = next_before
        if delay_seconds:
            time.sleep(delay_seconds)
    else:
        _LOG.warning(
            "telegram page limit reached source=%s pages=%d cutoff=%s",
            source.id,
            page_limit,
            cutoff.isoformat(),
        )

    if unresolved:
        _LOG.warning(
            "telegram rejected unresolved source=%s count=%d (no source coordinates or verified resolver result)",
            source.id,
            unresolved,
        )
    if not reached_cutoff and before is not None and len(seen_messages) > 0 and page_limit > 1:
        _LOG.info(
            "telegram poll ended before cutoff source=%s oldest_before=%s cutoff=%s",
            source.id,
            before,
            cutoff.isoformat(),
        )
    incidents.sort(key=lambda incident: (incident.observed_at or "", incident.id))
    return incidents


for _source_id, _channel in _CHANNELS.items():
    register_source(
        PollutionSource(
            id=_source_id,
            name=_channel.name,
            url=f"https://t.me/s/{_channel.handle}",
            type="scrape",
            poll_method=(
                f"GET t.me/s/{_channel.handle}?before=<message_id> "
                "selector .tgme_widget_message_text"
            ),
            update_freq="15m",
        ),
        telegram_poll,
    )
