"""Status-only satellite catalogue inputs.

These catalogues expose raw satellite scenes, not analyst-confirmed pollution.
Polling them records readiness and cached input metadata but intentionally never
creates :class:`PollutionIncident` objects.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from ..models import PollutionIncident, PollutionSource
from ..registry import SourceUnavailableError, register_source
from ..scheduler import six_month_cutoff

USER_AGENT = "SEALv-Caspian-Pollution/1.0 (+https://sealv.org)"
COPERNICUS_ODATA = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products"
EUMETSAT_CATALOGUE = "https://user.eumetsat.int/catalogue"
CASPIAN_WKT = "POLYGON((46 36,56 36,56 48,46 48,46 36))"

SENTINEL_SOURCE = PollutionSource(
    id="copernicus_sentinel1_catalogue",
    name="Copernicus Sentinel-1 catalogue inputs",
    url=COPERNICUS_ODATA,
    type="api",
    poll_method="GET OData Sentinel-1 IW GRD catalogue; status/input only",
    update_freq="1h",
)

EUMETSAT_SOURCE = PollutionSource(
    id="eumetsat_catalogue_status",
    name="EUMETSAT public catalogue status",
    url=EUMETSAT_CATALOGUE,
    type="api",
    poll_method="GET public catalogue availability; status only",
    update_freq="6h",
)

# Deliberately not incident storage.  Callers that build an analyst workflow may
# consume a copy of this metadata as SAR inputs.
LAST_SENTINEL_SCENES: list[dict[str, Any]] = []
LAST_EUMETSAT_STATUS: dict[str, Any] = {}


def _get(url: str, accept: str, timeout: int = 20) -> tuple[bytes, str, int]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": accept},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read(), response.geturl(), int(response.status)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SourceUnavailableError(f"satellite catalogue request failed for {url}: {exc}") from exc


def _cutoff(since: Optional[str], now: datetime) -> datetime:
    oldest = six_month_cutoff(now)
    if not since:
        return now - timedelta(days=1)
    try:
        parsed = datetime.fromisoformat(since.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"invalid satellite catalogue since timestamp: {since}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(oldest, parsed.astimezone(timezone.utc))


def _sentinel_url(cutoff: datetime) -> str:
    timestamp = cutoff.isoformat(timespec="seconds").replace("+00:00", "Z")
    filters = (
        "Collection/Name eq 'SENTINEL-1' "
        f"and ContentDate/Start ge {timestamp} "
        "and contains(Name,'IW_GRD') "
        f"and OData.CSC.Intersects(area=geography'SRID=4326;{CASPIAN_WKT}')"
    )
    query = urllib.parse.urlencode(
        {
            "$filter": filters,
            "$orderby": "ContentDate/Start desc",
            "$top": "100",
        }
    )
    return f"{COPERNICUS_ODATA}?{query}"


def poll_sentinel(
    source: PollutionSource, since: Optional[str] = None
) -> list[PollutionIncident]:
    """Refresh raw Sentinel-1 input metadata and always return zero incidents."""
    now = datetime.now(timezone.utc)
    requested_url = _sentinel_url(_cutoff(since, now))
    body, final_url, status = _get(requested_url, "application/json")
    try:
        payload = json.loads(body)
        products = payload.get("value")
        if not isinstance(products, list):
            raise ValueError("OData response has no value list")
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise SourceUnavailableError(f"invalid Copernicus catalogue response: {exc}") from exc

    scenes: list[dict[str, Any]] = []
    for product in products:
        if not isinstance(product, dict):
            continue
        name = str(product.get("Name") or "")
        content_date = product.get("ContentDate") or {}
        if "IW_GRD" not in name or not isinstance(content_date, dict):
            continue
        product_id = str(product.get("Id") or "")
        if not product_id:
            continue
        scenes.append(
            {
                "id": product_id,
                "name": name,
                "start": content_date.get("Start"),
                "end": content_date.get("End"),
                "footprint": product.get("GeoFootprint"),
                "catalogue_url": f"{COPERNICUS_ODATA}({product_id})",
                "query_url": final_url,
                "http_status": status,
                "classification": "raw_sar_scene_input_not_pollution",
            }
        )

    LAST_SENTINEL_SCENES.clear()
    LAST_SENTINEL_SCENES.extend(scenes)
    return []


def poll_eumetsat(
    source: PollutionSource, since: Optional[str] = None
) -> list[PollutionIncident]:
    """Check the optional public catalogue without manufacturing observations."""
    body, final_url, status = _get(EUMETSAT_CATALOGUE, "text/html")
    if not body or b"EUMETSAT" not in body.upper():
        raise SourceUnavailableError(
            "EUMETSAT public catalogue returned an unrecognized response"
        )
    LAST_EUMETSAT_STATUS.clear()
    LAST_EUMETSAT_STATUS.update(
        {
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "url": final_url,
            "http_status": status,
            "bytes": len(body),
            "classification": "catalogue_status_only_no_observations_parsed",
        }
    )
    return []


def get_sentinel_inputs() -> list[dict[str, Any]]:
    """Return copies so callers cannot mutate the readiness cache."""
    return [dict(scene) for scene in LAST_SENTINEL_SCENES]


register_source(SENTINEL_SOURCE, poll_sentinel)
register_source(EUMETSAT_SOURCE, poll_eumetsat)
