"""Tiled inference for dense small-object scenes.

A colony of animals shot from altitude puts dozens of targets into a frame,
each only a few dozen pixels across. Run whole-frame and the vision encoder
has already downsampled them into mush; run over overlapping crops and each
target arrives at the encoder several times larger.

The cost is duplicates along the seams, which is what `nms` cleans up.
"""

from __future__ import annotations


def grid_by_size(
    width: int,
    height: int,
    tile_px: int,
    overlap: float = 0.18,
) -> list[tuple[int, int, int, int]]:
    """Cover the frame with crops of roughly `tile_px` source pixels.

    Tile SIZE is the parameter that matters, not grid count. The model grounds
    individual targets only when they arrive at the encoder large enough; below
    that threshold its coordinate decoder degenerates into a fixed-stride
    sequence that looks like detections and is not. Measured on aerial seal
    footage: ~180px source crops (targets ~150px after upscaling) ground
    correctly, ~283x503 tiles do not.

    A square-ish tile count is derived per axis, so a portrait frame gets more
    rows than columns instead of stretched tiles.
    """
    if tile_px <= 0:
        return [(0, 0, width, height)]
    cols = max(1, round(width / tile_px))
    rows = max(1, round(height / tile_px))
    return _grid_rc(width, height, rows, cols, overlap)


def grid(width: int, height: int, n: int, overlap: float = 0.18) -> list[tuple[int, int, int, int]]:
    """`n` x `n` crop windows covering the frame, overlapping by `overlap`.

    Returns pixel boxes (x0, y0, x1, y1). n=1 gives the whole frame back.
    """
    if n <= 1:
        return [(0, 0, width, height)]
    return _grid_rc(width, height, n, n, overlap)


def _grid_rc(
    width: int, height: int, rows: int, cols: int, overlap: float
) -> list[tuple[int, int, int, int]]:
    if rows <= 1 and cols <= 1:
        return [(0, 0, width, height)]

    overlap = min(max(overlap, 0.0), 0.5)
    step_x = width / cols
    step_y = height / rows
    pad_x = step_x * overlap
    pad_y = step_y * overlap

    out: list[tuple[int, int, int, int]] = []
    for row in range(rows):
        for col in range(cols):
            x0 = max(0, int(col * step_x - pad_x))
            y0 = max(0, int(row * step_y - pad_y))
            x1 = min(width, int((col + 1) * step_x + pad_x))
            y1 = min(height, int((row + 1) * step_y + pad_y))
            if x1 - x0 > 8 and y1 - y0 > 8:
                out.append((x0, y0, x1, y1))
    return out


def _iou(a: dict, b: dict) -> float:
    ix1 = max(a["x1"], b["x1"])
    iy1 = max(a["y1"], b["y1"])
    ix2 = min(a["x2"], b["x2"])
    iy2 = min(a["y2"], b["y2"])
    iw = ix2 - ix1
    ih = iy2 - iy1
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    area_a = max(0.0, a["x2"] - a["x1"]) * max(0.0, a["y2"] - a["y1"])
    area_b = max(0.0, b["x2"] - b["x1"]) * max(0.0, b["y2"] - b["y1"])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _contained(a: dict, b: dict) -> float:
    """Fraction of the smaller box that sits inside the larger one."""
    ix1 = max(a["x1"], b["x1"])
    iy1 = max(a["y1"], b["y1"])
    ix2 = min(a["x2"], b["x2"])
    iy2 = min(a["y2"], b["y2"])
    iw, ih = ix2 - ix1, iy2 - iy1
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    area_a = max(1e-6, (a["x2"] - a["x1"]) * (a["y2"] - a["y1"]))
    area_b = max(1e-6, (b["x2"] - b["x1"]) * (b["y2"] - b["y1"]))
    return inter / min(area_a, area_b)


def nms(
    dets: list[dict],
    iou_thresh: float = 0.45,
    contain_thresh: float = 0.80,
    point_radius: float = 12.0,
) -> list[dict]:
    """Greedy per-label suppression, largest box first.

    Two detections collapse when they overlap past `iou_thresh`, or when one
    sits almost entirely inside the other (`contain_thresh`) - the seam case,
    where a partial animal in one tile is a whole animal in its neighbour.

    Points have no area, so they dedupe by proximity instead: anything within
    `point_radius` pixels of a kept point is treated as the same target. Set
    that from the frame size, not a constant - on a dense colony the spacing
    between neighbouring animals is what decides whether two hits are one
    animal seen twice or two animals side by side.
    """
    kept: list[dict] = []
    by_label: dict[str, list[dict]] = {}
    for d in dets:
        by_label.setdefault(d["label"].lower(), []).append(d)

    for group in by_label.values():
        group.sort(
            key=lambda d: (d["x2"] - d["x1"]) * (d["y2"] - d["y1"]),
            reverse=True,
        )
        survivors: list[dict] = []
        for cand in group:
            if cand.get("kind") == "point":
                r2 = point_radius * point_radius
                if any(
                    (cand["x1"] - s["x1"]) ** 2 + (cand["y1"] - s["y1"]) ** 2 < r2
                    for s in survivors
                    if s.get("kind") == "point"
                ):
                    continue
                survivors.append(cand)
                continue
            if any(
                _iou(cand, s) > iou_thresh or _contained(cand, s) > contain_thresh
                for s in survivors
            ):
                continue
            survivors.append(cand)
        kept.extend(survivors)

    kept.sort(key=lambda d: (d["y1"], d["x1"]))
    return kept


def offset(dets: list[dict], dx: int, dy: int, full_w: int, full_h: int) -> list[dict]:
    """Shift tile-local detections into full-frame coordinates."""
    out = []
    for d in dets:
        e = dict(d)
        e["x1"] += dx
        e["x2"] += dx
        e["y1"] += dy
        e["y2"] += dy
        e["nx1"] = e["x1"] / full_w
        e["nx2"] = e["x2"] / full_w
        e["ny1"] = e["y1"] / full_h
        e["ny2"] = e["y2"] / full_h
        out.append(e)
    return out


def drop_frame_sized(dets: list[dict], width: int, height: int, ratio: float = 0.92) -> list[dict]:
    """Discard boxes that are basically the whole frame.

    On a dense uniform scene the model sometimes answers with one box around
    the entire colony instead of the individuals. That box is never the answer
    anyone wants and it swallows every real detection during NMS.
    """
    limit = width * height * ratio
    return [
        d for d in dets
        if d.get("kind") == "point"
        or (d["x2"] - d["x1"]) * (d["y2"] - d["y1"]) < limit
    ]
