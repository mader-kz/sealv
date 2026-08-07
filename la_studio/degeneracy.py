"""Detect when the model has stopped grounding and started counting.

An autoregressive coordinate decoder that runs past what it can actually see
does not stop - it emits a plausible-looking sequence. On a dense uniform
scene that shows up as a row of points marching across the frame at a fixed
stride: sixteen hits at identical y, x increasing by ~16px each time.

Those are not detections. They are the decoder pattern-completing, and they
are indistinguishable from real output if you only look at the count. This
module looks at the geometry instead, so the UI can say "the model
degenerated" rather than quietly reporting 128 seals that are not there.
"""

from __future__ import annotations

from collections import defaultdict


def _runs(values: list[float], tol: float) -> int:
    """Longest run of consecutive values with near-constant spacing."""
    if len(values) < 3:
        return 0
    vals = sorted(values)
    best = cur = 1
    prev_gap = None
    for a, b in zip(vals, vals[1:]):
        gap = b - a
        if prev_gap is not None and abs(gap - prev_gap) <= tol:
            cur += 1
            best = max(best, cur)
        else:
            cur = 2
        prev_gap = gap
    return best if best >= 3 else 0


def analyse(
    dets: list[dict],
    width: int,
    height: int,
    min_run: int = 6,
) -> dict:
    """Report evidence that `dets` is decoder drift rather than localisation.

    Returns {suspect: bool, reasons: [str], longest_run: int, ...}. Deliberately
    advisory - it flags, it does not silently delete, because a genuinely
    gridded scene (a car park, a spreadsheet, a contact sheet) is a real thing
    a user may want to detect.
    """
    points = [d for d in dets if d.get("kind") == "point"]
    reasons: list[str] = []

    if len(points) < min_run:
        return {"suspect": False, "reasons": [], "longest_run": 0,
                "points": len(points), "collinear": 0}

    band = max(3.0, 0.004 * max(width, height))
    tol = max(2.0, 0.004 * max(width, height))

    rows: dict[int, list[float]] = defaultdict(list)
    cols: dict[int, list[float]] = defaultdict(list)
    for p in points:
        rows[round(p["y1"] / band)].append(p["x1"])
        cols[round(p["x1"] / band)].append(p["y1"])

    longest = 0
    collinear = 0
    for group in (*rows.values(), *cols.values()):
        run = _runs(group, tol)
        longest = max(longest, run)
        if run >= min_run:
            collinear += run

    if longest >= min_run:
        reasons.append(
            f"{longest} points in a straight line at constant spacing - "
            f"characteristic of a runaway decode, not detection"
        )

    # Lopsided coverage is ADVISORY only, never grounds for rejection.
    # Whole-frame it is a strong tell. On a small tile it is normal: a crop
    # straddling the edge of a group genuinely has every target on one side,
    # and rejecting those tiles punches holes in exactly the boundary regions
    # a census needs. Constant-stride collinearity is the signal that does not
    # occur naturally, so that alone decides `suspect`.
    warnings: list[str] = []
    xs = [p["x1"] for p in points]
    ys = [p["y1"] for p in points]
    for axis, vals, extent in (("horizontally", xs, width), ("vertically", ys, height)):
        lo = sum(1 for v in vals if v < extent / 2)
        share = lo / len(vals)
        if share < 0.12 or share > 0.88:
            warnings.append(
                f"{max(share, 1 - share):.0%} of points sit in one half {axis}"
            )

    return {
        "suspect": longest >= min_run,
        "reasons": reasons,
        "warnings": warnings,
        "longest_run": longest,
        "collinear": collinear,
        "points": len(points),
    }
