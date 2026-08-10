"""Pollution source + incident models. Keep it boring — dataclass, no ORM."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class PollutionSource:
    """One pollable feed. Registered once, polled many times."""
    id: str  # e.g. firms_viirs, telegram_azh, lada_rss
    name: str
    url: str
    type: str  # api|rss|scrape|wms
    poll_method: str = ""  # human-readable: GET https://... selector ...
    update_freq: str = ""
    # poller is injected by registry — not stored in DB
    poller: Optional[str] = None  # module path for debug


@dataclass
class PollutionIncident:
    """One spill/slick/flare. Always has estimated point + radius (uncertainty)."""
    id: str  # source:external_id  e.g. firms:123, telegram:AzhKz_RU_68768
    source_id: str
    observed_at: Optional[str] = None  # ISO8601
    lat: float = 0.0
    lng: float = 0.0
    radius_m: float = 500.0  # uncertainty radius — exact 500m, field 10000m, approx 5000m
    geom: Optional[Any] = None  # GeoJSON Polygon for SAR, else None
    kind: str = "spill"  # slick|flare|spill|discharge
    area_km2: Optional[float] = None
    confidence: Optional[float] = None
    location_precision: str = "approximate"  # exact|field|approximate
    raw: Optional[dict] = field(default=None)  # original payload for audit

    def validate(self) -> None:
        if not (-90 <= self.lat <= 90 and -180 <= self.lng <= 180):
            raise ValueError(f"bad lat/lng {self.lat},{self.lng}")
        if self.radius_m <= 0 or self.radius_m > 100000:
            raise ValueError(f"bad radius_m {self.radius_m}")
