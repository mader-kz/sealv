"""Shared contract for the detection service.

Every module in `service/` and the frontend agree on the shapes here. Changing
one of these is an API change; changing anything else is not.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Literal, Optional

JobStatus = Literal["queued", "running", "done", "failed", "cancelled"]
PointStatus = Literal["auto", "validated", "false_positive"]
MediaKind = Literal["image", "video"]

# An adult Caspian seal, used to turn GSD into a pixel size.
SEAL_LENGTH_CM = 130.0

# Measured: targets >= this many pixels are detected fine whole-frame; below it
# the whole-frame path loses animals and destabilises, so we tile.
WHOLE_FRAME_MIN_PX = 40.0

# Measured: tile ~10x target size. Smaller tiles are worse, not better - they put
# proportionally more crops on bare ground, where texture reads as animals.
TILE_TO_TARGET_RATIO = 10.0

DEFAULT_THRESHOLD = 0.23
DEFAULT_TARGET = "seal"


@dataclass
class Sampling:
    every_s: float = 1.5
    max_frames: int = 8


@dataclass
class ConsensusParams:
    min_support: int = 3


@dataclass
class JobParams:
    target: str = DEFAULT_TARGET
    threshold: float = DEFAULT_THRESHOLD
    tiling: Any = "auto"            # "auto" | "off" | int px
    sampling: Sampling = field(default_factory=Sampling)
    consensus: ConsensusParams = field(default_factory=ConsensusParams)

    @classmethod
    def from_dict(cls, d: dict | None) -> "JobParams":
        d = dict(d or {})
        s = d.pop("sampling", None) or {}
        c = d.pop("consensus", None) or {}
        known = {k: v for k, v in d.items() if k in {"target", "threshold", "tiling"}}
        return cls(
            sampling=Sampling(**{k: v for k, v in s.items() if k in {"every_s", "max_frames"}}),
            consensus=ConsensusParams(**{k: v for k, v in c.items() if k in {"min_support"}}),
            **known,
        )

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class CountBand:
    """Never a single integer.

    low   - confirmed in every sampled frame; conservative, high confidence
    best  - consensus at min_support; the number to lead with
    high  - permissive upper bound: everything any frame saw, corroborated or
            not (for a video, the union of the cross-frame clusters, floored at
            the largest single frame so that excluding a frame can never lower
            the ceiling). Never the frame maximum alone - that sits below the
            union and so is not an upper bound on anything.

    low <= best <= high always. A band that does not contain its own best
    estimate is not a band, and the lead number is the one this product exists
    to make defensible.
    """
    low: int
    best: int
    high: int
    basis: str

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class Point:
    x: float
    y: float
    lat: Optional[float] = None
    lng: Optional[float] = None
    score: Optional[float] = None
    support: Optional[int] = None
    frame_idx: Optional[int] = None
    status: PointStatus = "auto"
    id: Optional[int] = None

    def as_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None or k in ("lat", "lng")}


# Tile size used when the scale is UNKNOWN. The old behaviour ("trust whole
# frame") was measured to collapse on small targets — the docstring numbers
# below — and in the field it returned 0 detections on a frame holding a dense
# colony of ~600 (FIELD_0001 at 22s, drone high, ~12px per animal; frames at
# 9s with large animals still counted fine, which is exactly the failure shape
# the measurements predict). 256 is the measured sweet spot at ~25px targets,
# and a tile larger than any plausible survey animal, so the only cost on
# close-ups is overlap-merge overhead.
UNKNOWN_SCALE_TILE_PX = 256


def auto_tile_px(gsd_cm_px: float | None, image_long_edge: int | None = None) -> int:
    """Choose tile size from ground sample distance. 0 means whole frame.

    Measured on real footage: a target at >=40px is found reliably in one pass
    (389 animals, 2.1s); at ~25px the whole-frame path drops to 525 and once
    collapsed to 218, while 250px tiles gave 656. So the decision is purely a
    function of how many pixels one animal occupies — and when the scale is
    unknown, that function cannot promise the whole-frame pass is safe, so the
    default is to tile (an operator can still force `tiling: off`).
    """
    if not gsd_cm_px or gsd_cm_px <= 0:
        return UNKNOWN_SCALE_TILE_PX
    target_px = SEAL_LENGTH_CM / gsd_cm_px
    if target_px >= WHOLE_FRAME_MIN_PX:
        return 0
    return max(120, int(round(target_px * TILE_TO_TARGET_RATIO / 10.0) * 10))


def gsd_from_altitude(
    altitude_m: float,
    image_width_px: int,
    sensor_width_mm: float = 13.2,   # DJI 1" sensor, Mavic/Phantom class
    focal_length_mm: float = 8.8,
) -> float:
    """Ground sample distance in cm/pixel.

    gsd = (sensor_width * altitude) / (focal_length * image_width)
    Defaults suit a DJI 1-inch sensor; override per airframe when known.
    """
    if altitude_m <= 0 or image_width_px <= 0:
        return 0.0
    gsd_m_px = (sensor_width_mm * altitude_m) / (focal_length_mm * image_width_px)
    return gsd_m_px * 100.0
