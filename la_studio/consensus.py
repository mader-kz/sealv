"""Temporal consensus: confirm detections across frames.

The model gives no confidence score - every point it emits is asserted equally.
This manufactures one from agreement over time.

A hauled-out animal barely moves across a few seconds of footage, so it should
be found at the same place in frame after frame. A false positive on ambiguous
ground (wet sand, shingle) is far more likely to appear once and vanish. The
number of frames a detection survives in becomes its confidence.

The wrinkle is that the camera moves. A drone drifts between frames, so raw
coordinates do not line up and naive matching confirms nothing. Frames are
registered by phase correlation first, which recovers the global translation
that dominates short-interval drone motion.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image


def _gray(path: Path, max_side: int = 512) -> np.ndarray:
    """Downscaled float greyscale - registration does not need full resolution."""
    with Image.open(path) as im:
        im = im.convert("L")
        scale = max_side / max(im.size)
        if scale < 1:
            im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))))
        a = np.asarray(im, dtype=np.float64)
    # window the edges so the FFT does not lock onto the frame border
    wy = np.hanning(a.shape[0])[:, None]
    wx = np.hanning(a.shape[1])[None, :]
    a = (a - a.mean()) * wy * wx
    return a


def estimate_shift(ref: Path, other: Path) -> tuple[float, float]:
    """Correction (dx, dy) to ADD to a point measured in `other` to land in `ref`.

    Note the sign: this is the negative of the image translation. If the scene
    content moved +25px right between ref and other, a target at x=100 in ref
    sits at x=125 in other, and this returns -25 so that 125 + (-25) = 100.
    That is the form `build()` consumes.

    Phase correlation: the cross-power spectrum of two translated images has a
    single impulse at the offset. Robust to brightness changes and to the scene
    content itself, which matters here because every frame looks like sand.
    Accurate to about a pixel at the 512px registration scale - well inside the
    matching radius. Measured drone drift on real footage is ~57px between
    sampled frames, so skipping this step would confirm nothing at all.
    """
    a, b = _gray(ref), _gray(other)
    if a.shape != b.shape:
        return 0.0, 0.0

    A = np.fft.rfft2(a)
    B = np.fft.rfft2(b)
    R = A * np.conj(B)
    mag = np.abs(R)
    R = np.divide(R, mag, out=np.zeros_like(R), where=mag > 1e-12)
    corr = np.fft.irfft2(R, s=a.shape)

    dy, dx = np.unravel_index(int(np.argmax(corr)), corr.shape)
    h, w = a.shape
    if dy > h // 2:
        dy -= h
    if dx > w // 2:
        dx -= w

    # rescale from the downscaled registration image back to source pixels
    with Image.open(ref) as im:
        full_w = im.width
    scale = full_w / w
    return float(dx) * scale, float(dy) * scale


def estimate_transform(ref: Path, other: Path, max_side: int = 1024):
    """Full similarity transform (rotation + scale + translation) as a 2x3 matrix.

    Translation alone is not enough. A drone yaws and changes altitude between
    frames, and the residual after a translation-only fit was tens of pixels -
    enough that matching at a seal-sized radius confirmed only 34 of ~600
    animals in all four frames, while widening the radius to 60px "recovered"
    them by merging neighbours instead.

    ORB features + RANSAC, which tolerates the many wrong matches you get on a
    field of near-identical animals. Returns None if it cannot find a stable
    fit, in which case the caller falls back to phase correlation.
    """
    try:
        import cv2
    except ImportError:
        return None

    def prep(p: Path):
        with Image.open(p) as im:
            im = im.convert("L")
            scale = max_side / max(im.size)
            if scale < 1:
                im = im.resize((int(im.width * scale), int(im.height * scale)))
            else:
                scale = 1.0
            return np.asarray(im), scale

    a, sa = prep(ref)
    b, sb = prep(other)

    orb = cv2.ORB_create(nfeatures=4000)
    ka, da = orb.detectAndCompute(a, None)
    kb, db = orb.detectAndCompute(b, None)
    if da is None or db is None or len(ka) < 12 or len(kb) < 12:
        return None

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    raw = matcher.knnMatch(db, da, k=2)
    good = [m for m, n in (p for p in raw if len(p) == 2) if m.distance < 0.75 * n.distance]
    if len(good) < 12:
        return None

    src = np.float32([kb[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([ka[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    M, inliers = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0,
        maxIters=5000, confidence=0.995,
    )
    if M is None or inliers is None or int(inliers.sum()) < 10:
        return None

    # lift the transform from registration scale back to source pixels
    M = M.copy()
    M[:, 2] /= sa
    return M, int(inliers.sum()), len(good)


def apply_transform(M, x: float, y: float) -> tuple[float, float]:
    return (
        float(M[0, 0] * x + M[0, 1] * y + M[0, 2]),
        float(M[1, 0] * x + M[1, 1] * y + M[1, 2]),
    )


@dataclass
class Cluster:
    x: float
    y: float
    frames: set = field(default_factory=set)
    xs: list = field(default_factory=list)
    ys: list = field(default_factory=list)

    def add(self, x: float, y: float, frame: int) -> None:
        self.xs.append(x)
        self.ys.append(y)
        self.frames.add(frame)
        self.x = sum(self.xs) / len(self.xs)
        self.y = sum(self.ys) / len(self.ys)


def build(
    per_frame: list[tuple[int, list[dict]]],
    shifts: dict,
    radius: float,
    min_support: int,
) -> list[dict]:
    """Cluster detections across frames into consensus targets.

    `per_frame` is [(frame_index, detections)], `shifts` maps frame index to the
    (dx, dy) that registers it onto the reference frame. Each returned point
    carries `support` - how many distinct frames found it - which is the
    confidence signal the model itself never provides.
    """
    clusters: list[Cluster] = []
    r2 = radius * radius

    for frame_idx, dets in per_frame:
        warp = shifts.get(frame_idx, (0.0, 0.0))
        is_matrix = hasattr(warp, "shape")
        for d in dets:
            if is_matrix:
                x, y = apply_transform(warp, d["x1"], d["y1"])
            else:
                x = d["x1"] + warp[0]
                y = d["y1"] + warp[1]
            hit = None
            best = r2
            for c in clusters:
                dist = (c.x - x) ** 2 + (c.y - y) ** 2
                if dist < best and frame_idx not in c.frames:
                    best, hit = dist, c
            if hit is None:
                c = Cluster(x=x, y=y)
                c.add(x, y, frame_idx)
                clusters.append(c)
            else:
                hit.add(x, y, frame_idx)

    out = []
    for c in clusters:
        if len(c.frames) >= min_support:
            out.append({
                "label": "target",
                "kind": "point",
                "x1": c.x, "y1": c.y, "x2": c.x, "y2": c.y,
                "support": len(c.frames),
            })
    out.sort(key=lambda d: (-d["support"], d["y1"], d["x1"]))
    return out


def support_histogram(
    per_frame: list[tuple[int, list[dict]]],
    shifts: dict[int, tuple[float, float]],
    radius: float,
) -> dict[int, int]:
    """How many targets survive at each support level - the precision/recall curve."""
    all_clusters = build(per_frame, shifts, radius, min_support=1)
    hist: dict[int, int] = {}
    total = len(per_frame)
    for k in range(1, total + 1):
        hist[k] = sum(1 for c in all_clusters if c["support"] >= k)
    return hist
