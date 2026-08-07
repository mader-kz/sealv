"""Parsing of LocateAnything-3B structured coordinate output.

The model emits semantic labels and quantised coordinates, e.g.

    <ref>remote</ref><box><64><152><273><244></box>

Coordinates are normalised integers in [0, 1000]. A box block carries four
values (x1, y1, x2, y2); a point block carries two (x, y). A single <ref> may
be followed by several <box> blocks when multiple instances are found.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict

# <ref>label</ref>  |  <box><12><34><56><78></box>  |  <box>12,34,56,78</box>
_CHUNK = re.compile(
    r"<ref>(?P<label>.*?)</ref>"
    r"|<box>(?P<angle>(?:\s*<\d+>\s*)+)</box>"
    r"|<box>(?P<plain>[\d\s.,]+)</box>",
    re.DOTALL,
)
_NUM = re.compile(r"\d+(?:\.\d+)?")

QUANT = 1000.0


@dataclass
class Detection:
    label: str
    kind: str  # "box" | "point"
    # pixel-space coordinates
    x1: float
    y1: float
    x2: float
    y2: float
    # normalised 0..1 coordinates, useful for re-rendering at any scale
    nx1: float
    ny1: float
    nx2: float
    ny2: float

    def as_dict(self) -> dict:
        return asdict(self)


def parse(text: str, width: int, height: int) -> list[Detection]:
    """Turn raw model output into pixel-space detections.

    Unknown or malformed blocks are skipped rather than raising - the model is
    generative and an occasional stray token should not fail a whole frame.
    """
    out: list[Detection] = []
    label = "object"

    for m in _CHUNK.finditer(text or ""):
        if m.group("label") is not None:
            cleaned = m.group("label").strip()
            label = cleaned or "object"
            continue

        raw = m.group("angle") or m.group("plain") or ""
        vals = [float(v) for v in _NUM.findall(raw)]

        if len(vals) >= 4:
            x1, y1, x2, y2 = vals[:4]
            kind = "box"
        elif len(vals) == 2:
            x1 = x2 = vals[0]
            y1 = y2 = vals[1]
            kind = "point"
        else:
            continue

        # normalise, clamp, and fix inverted corners
        nx1, nx2 = sorted((x1 / QUANT, x2 / QUANT))
        ny1, ny2 = sorted((y1 / QUANT, y2 / QUANT))
        nx1, nx2 = max(0.0, nx1), min(1.0, nx2)
        ny1, ny2 = max(0.0, ny1), min(1.0, ny2)

        out.append(
            Detection(
                label=clean_label(label),
                kind=kind,
                x1=nx1 * width,
                y1=ny1 * height,
                x2=nx2 * width,
                y2=ny2 * height,
                nx1=nx1,
                ny1=ny1,
                nx2=nx2,
                ny2=ny2,
            )
        )

    return out


_POINT_PREFIX = re.compile(
    r"^\s*point\s+(?:at|to)\s+(?:every|each|all|the|a|an)?\s*", re.IGNORECASE
)
_DETECT_PREFIX = re.compile(
    r"^\s*detect\s+(?:all|every|each)?\s*", re.IGNORECASE
)


def is_point_prompt(prompt: str) -> bool:
    """True when the prompt puts the model into point mode."""
    return bool(re.match(r"^\s*point\s+(?:at|to)\b", prompt or "", re.IGNORECASE))


def clean_label(label: str) -> str:
    """Reduce an echoed instruction to the thing being located.

    In point mode the model sets <ref> to the prompt itself, so a census comes
    back with 432 detections of the class "Point at every animal". Harmless to
    the geometry, useless in a legend. Strip the instruction wrapper and keep
    the subject.
    """
    out = (label or "").strip().rstrip(".")
    out = _POINT_PREFIX.sub("", out)
    out = _DETECT_PREFIX.sub("", out)
    out = re.sub(r"\s+in\s+the\s+image$", "", out, flags=re.IGNORECASE).strip()
    return (out or "target").lower()


def strip_markup(text: str) -> str:
    """Human-readable remainder once coordinate markup is removed."""
    return re.sub(r"<[^>]*>", " ", text or "").strip()
