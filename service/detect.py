"""Detection pipeline: one piece of media in, a count BAND out.

Why a band and never an integer: four frames of the same haul-out, sampled
1.5s apart, on animals that barely moved, returned 656 / 643 / 570 / 551 - a
25% spread with nothing in the world having changed. Reporting the middle of
that as a single number would be false precision, and false precision is the
fastest way for a counting product to lose the trust of the people who have to
defend the number in a report. So every run reports three:

    high  seen by any frame at all     - permissive, the most the looks allow
    best  consensus at min_support     - the number to lead with
    low   confirmed in every frame     - conservative, high confidence

For a still there is only one look, so the band collapses (low = best = high)
and says so in `basis`. That is honest about there being no temporal evidence,
rather than pretending a single frame carries the same weight as agreement.

The detector is CountGD only (measured: 389 animals, 0 false positives, 2.1s on
a 1698x1082 still; 0 false positives on hand-verified empty water and sand),
and the two structural corrections around it are:

  tiling      - below ~40px per animal the whole-frame path loses targets and
                destabilises (one frame collapsed 525 -> 218), so the frame is
                cut into ~10x-target crops. See contract.auto_tile_px.
  consensus   - CountGD scores each detection but cannot know whether a hit on
                wet sand is an animal. Agreement across registered frames can.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np
from PIL import Image

# service/ is not a package and the reusable modules live one level up in
# la_studio/, so make the repo root importable however this file is entered
# (uvicorn service.api:app, python service/detect.py, or a worker process).
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from la_studio import consensus as consensus_mod  # noqa: E402
from la_studio import countgd_engine  # noqa: E402
from la_studio import frames as frames_mod  # noqa: E402
from la_studio import tiling  # noqa: E402

try:  # imported as `service.detect` from the API, or run directly from service/
    from .contract import (
        SEAL_LENGTH_CM, TILE_TO_TARGET_RATIO, CountBand, JobParams, auto_tile_px,
    )
except ImportError:  # pragma: no cover - script entry
    from contract import (  # type: ignore
        SEAL_LENGTH_CM, TILE_TO_TARGET_RATIO, CountBand, JobParams, auto_tile_px,
    )

ENGINE_NAME = "countgd"

# Measured on aerial colony footage: overlapping the crops by this much is what
# lets an animal cut by a seam still arrive whole in the neighbouring tile.
TILE_OVERLAP = 0.18

# CountGD resizes its input to 800px on the short side, so a small crop handed
# over at source scale is downsampled straight back into mush. Enlarging first
# is the whole point of tiling.
CROP_MIN_LONG_EDGE = 900
CROP_JPEG_QUALITY = 92

ProgressCb = Optional[Callable[[int, int, str], None]]


# --------------------------------------------------------------------- setup

def _point_radius(width: int, height: int) -> float:
    """Merge distance for point detections, scaled to the frame.

    ~1.2% of the long edge. Tight enough that neighbouring animals in a packed
    colony stay separate, loose enough to collapse the same animal reported by
    two overlapping tiles. Mirrors the constant the desktop tool was measured
    with; it is duplicated rather than imported because model_worker pulls in
    MLX, which the service must not depend on.
    """
    return max(6.0, 0.012 * max(width, height))


def resolve_tile_px(tiling_param: Any, gsd_cm_px: float | None) -> int:
    """Turn the `tiling` job parameter into a crop size in source pixels.

    "auto" derives it from ground sample distance (the operator never picks a
    tile size), "off" forces one whole-frame pass, an explicit number wins over
    both because an operator looking at a bad result needs a manual override.
    0 means whole frame.
    """
    if tiling_param is None:
        return auto_tile_px(gsd_cm_px)
    if isinstance(tiling_param, bool):  # bool is an int subclass - check first
        return auto_tile_px(gsd_cm_px) if tiling_param else 0
    if isinstance(tiling_param, str):
        key = tiling_param.strip().lower()
        if key in ("", "auto"):
            return auto_tile_px(gsd_cm_px)
        if key in ("off", "none", "false", "0"):
            return 0
        try:
            return max(0, int(float(key)))
        except ValueError as exc:
            raise ValueError(
                f"unknown tiling setting {tiling_param!r} - "
                "use 'auto', 'off', or a tile size in pixels"
            ) from exc
    return max(0, int(tiling_param))


# ------------------------------------------------------------- one detection

@dataclass
class FramePass:
    """Result of running the detector over exactly one image file."""
    dets: list[dict]
    width: int
    height: int
    seconds: float
    tile_px: int
    tiles: int
    pre_nms: int
    failed_tiles: list[dict] = field(default_factory=list)
    frame_sized_dropped: int = 0

    @property
    def count(self) -> int:
        return len(self.dets)

    @property
    def complete(self) -> bool:
        """True when every tile of this frame produced an answer.

        A frame that lost a tile is an undercount of one region, not a report
        that the region is empty, so it cannot be used as evidence that an
        animal is absent.
        """
        return not self.failed_tiles


def _rescale(det: dict, scale: float) -> dict:
    """Map coordinates from an upscaled crop back into source-crop pixels.

    countgd_engine reports in the pixel space of the file it was handed, and
    we hand it an enlarged crop, so every coordinate comes back `scale` times
    too large. Getting this wrong does not crash - it silently scatters points.
    """
    out = dict(det)
    for k in ("x1", "y1", "x2", "y2"):
        out[k] = det[k] / scale
    return out


def _detect_one(
    path: Path,
    tile_px: int,
    target: str,
    threshold: float,
    scratch: Path | None = None,
) -> FramePass:
    """Detect on a single image file, tiled or whole-frame."""
    started = time.perf_counter()

    if tile_px <= 0:
        res = countgd_engine.detect(path, prompt=target, threshold=threshold)
        dets = res["detections"]
        # No NMS here on purpose: with one pass there are no seam duplicates to
        # merge, and the whole-frame figures this service is calibrated against
        # (389 on the still, 525 on frame 0) were measured on the raw output.
        return FramePass(
            dets=dets,
            width=int(res["width"]),
            height=int(res["height"]),
            seconds=time.perf_counter() - started,
            tile_px=0,
            tiles=1,
            pre_nms=len(dets),
        )

    scratch = scratch or path.parent / "_tiles"
    scratch.mkdir(parents=True, exist_ok=True)

    merged: list[dict] = []
    failed: list[dict] = []
    frame_sized = 0

    with Image.open(path) as opened:
        full = opened.convert("RGB")
        width, height = full.size
        windows = tiling.grid_by_size(width, height, tile_px, TILE_OVERLAP)

        for i, (x0, y0, x1, y1) in enumerate(windows):
            crop = full.crop((x0, y0, x1, y1))
            cw, ch = crop.size
            scale = 1.0
            if max(cw, ch) < CROP_MIN_LONG_EDGE:
                scale = CROP_MIN_LONG_EDGE / max(cw, ch)
                crop = crop.resize(
                    (max(1, int(cw * scale)), max(1, int(ch * scale))), Image.LANCZOS
                )

            crop_path = scratch / f"{path.stem}_t{i:04d}.jpg"
            crop.save(crop_path, quality=CROP_JPEG_QUALITY)
            try:
                res = countgd_engine.detect(
                    crop_path, prompt=target, threshold=threshold
                )
            except Exception as exc:
                # One flaky subprocess must not throw away the minutes of
                # inference already spent, but the loss of a tile is a loss of
                # animals, so it is reported rather than absorbed.
                failed.append({
                    "tile": i,
                    "window": [x0, y0, x1, y1],
                    "error": f"{type(exc).__name__}: {exc}",
                })
                continue
            finally:
                crop_path.unlink(missing_ok=True)

            local = res["detections"]
            if scale != 1.0:
                local = [_rescale(d, scale) for d in local]
            kept = tiling.drop_frame_sized(local, cw, ch)
            # Counted rather than assumed: a box swallowing a whole tile is a
            # degenerate answer, and how often that happens is the one honest
            # signal that the detector is drifting. Structurally 0 for CountGD,
            # which only ever emits points - but reporting a measured 0 and
            # reporting a hardcoded 0 are not the same claim.
            frame_sized += len(local) - len(kept)
            merged.extend(tiling.offset(kept, x0, y0, width, height))

    if windows and len(failed) == len(windows):
        # Every tile failing is an environment fault (no checkpoint, no venv),
        # not a scene with nothing in it. Returning 0 would be a wrong answer.
        raise RuntimeError(
            f"detection failed on all {len(windows)} tiles of {path.name}: "
            f"{failed[0]['error']}"
        )

    dets = tiling.nms(merged, point_radius=_point_radius(width, height))
    return FramePass(
        dets=dets,
        width=width,
        height=height,
        seconds=time.perf_counter() - started,
        tile_px=tile_px,
        tiles=len(windows),
        pre_nms=len(merged),
        failed_tiles=failed,
        frame_sized_dropped=frame_sized,
    )


def _engine_params(target: str, threshold: float, tile_px: int, **extra: Any) -> dict:
    params = {
        "name": ENGINE_NAME,
        # Which weights produced the count. None when the checkpoint cannot be
        # identified - a run that cannot name its engine says so rather than
        # reporting a version nobody can check against.
        "version": countgd_engine.version(),
        "target": target,
        "threshold": threshold,
        "tiling": tile_px,
        "tile_overlap": TILE_OVERLAP if tile_px else 0.0,
        "crop_min_long_edge": CROP_MIN_LONG_EDGE if tile_px else 0,
    }
    params.update(extra)
    return params


def _false_positive_risk(
    tile_px: int, gsd_cm_px: float | None, malformed_dropped: int
) -> tuple[str, list[str]]:
    """How far this run sat from the conditions where FPs were actually measured.

    §3 of the plan asks for `false_positive_risk`, and the only honest way to
    answer is from measurements this project took. There are two:

    * CountGD returned **0 false positives** on the 1698x1082 still (whole
      frame) and on verified-empty water and sand in the video. That is the
      whole of the evidence about this engine's FP rate, and it was taken with
      crops no finer than `auto_tile_px` chooses.
    * Crops finer than that are measurably worse (`contract.TILE_TO_TARGET_RATIO`):
      they put proportionally more of the frame on bare ground, where texture
      reads as animals.

    So the label is a statement about run conditions versus measured conditions
    - never a score the detector emitted and never a bare adjective. Every label
    ships with the reasons that produced it, and conditions that were never
    measured return "unknown" rather than a reassuring guess.
    """
    reasons: list[str] = []

    if malformed_dropped:
        reasons.append(
            f"{malformed_dropped} frame-sized detection(s) were dropped - the "
            "detector emitted degenerate boxes on this media, which is the one "
            "engine behaviour that does produce false positives"
        )

    if tile_px:
        if not gsd_cm_px or gsd_cm_px <= 0:
            # Tiled with no ground scale: there is no way to say whether these
            # crops are the measured-good size or several times too fine.
            return "unknown", reasons + [
                f"tiling was forced to {tile_px}px with no known ground scale, so "
                "crop size could not be checked against the measured-good ratio"
            ]
        # The ratio, not `auto_tile_px`, is the measured quantity. Auto returns 0
        # for big targets because the whole frame is *sufficient* there, not
        # because tiling is harmful - so comparing against 0 would have called a
        # correctly-sized manual tile "elevated". What was actually measured is
        # crop-size relative to animal-size, and that applies at every scale.
        target_px = SEAL_LENGTH_CM / gsd_cm_px
        measured = target_px * TILE_TO_TARGET_RATIO
        if tile_px < measured:
            reasons.append(
                f"tiles are {tile_px}px against a ~{target_px:.0f}px target, "
                f"below the ~{measured:.0f}px that measured clean at this scale; "
                "finer crops put proportionally more of the frame on bare "
                "ground, where texture reads as animals"
            )

    if reasons:
        return "elevated", reasons
    return "low", [
        "measured on this project's own footage: 0 false positives from CountGD "
        "on a verified still and on verified-empty water and sand, at crops no "
        "finer than this run used"
    ]


def _emit(cb: ProgressCb, done: int, total: int, stage: str) -> None:
    if cb is None:
        return
    try:
        cb(done, total, stage)
    except Exception:
        pass  # a progress sink must never kill a job that costs minutes


# --------------------------------------------------------------------- image

def detect_image(
    path: Path,
    params: JobParams,
    gsd_cm_px: float | None = None,
    *,
    scratch: Path | None = None,
) -> dict:
    """Count one still.

    A still still returns a band. There is no second look to disagree with the
    first, so low = best = high and `basis` records that the three numbers are
    one measurement, not three - which is exactly what a reader needs to know
    before comparing it with a video's band.
    """
    path = Path(path)
    started = time.perf_counter()
    tile_px = resolve_tile_px(params.tiling, gsd_cm_px)

    frame = _detect_one(
        path, tile_px, params.target, params.threshold, scratch=scratch
    )
    count = frame.count

    points = []
    for d in frame.dets:
        points.append({
            "x": round((d["x1"] + d["x2"]) / 2, 2),
            "y": round((d["y1"] + d["y2"]) / 2, 2),
            "score": round(float(d["score"]), 4) if d.get("score") is not None else None,
            # A still has no frame index and no temporal support. NULL here is
            # the schema's own answer for a point that came from one look.
            "frame_idx": None,
            "support": None,
        })

    quality = {
        "tile_px": tile_px,
        "tiles": frame.tiles,
        "tiles_failed": len(frame.failed_tiles),
        "tile_failures": frame.failed_tiles,
        # Screening counters, kept in the payload so a run row has the same
        # shape whichever engine produced it. `tiles_rejected` is structurally 0
        # for CountGD - it returns parsed JSON, so there is no malformed output
        # to reject a whole tile over - while `malformed_dropped` is measured,
        # because a frame-sized box is something any engine can emit.
        "tiles_rejected": 0,
        "malformed_dropped": frame.frame_sized_dropped,
        "detections_pre_nms": frame.pre_nms,
        "detections": count,
        "width": frame.width,
        "height": frame.height,
        "gsd_cm_px": gsd_cm_px,
        # A still is one look, and one look is one per-frame record. Leaving
        # this out made `result.per_frame` an empty array on every image run,
        # which reads as "no frames were counted" rather than "one was". Every
        # field is measured; `t` and `file` are absent because a still has no
        # timestamp and no extracted frame, and inventing either would put a
        # frame on screen that the pipeline never produced.
        "frames": [{
            "index": 0,
            "t": None,
            "count": count,
            "tiles": frame.tiles,
            "tiles_failed": len(frame.failed_tiles),
            "detections_pre_nms": frame.pre_nms,
            "seconds": round(frame.seconds, 2),
        }],
    }
    risk, why = _false_positive_risk(tile_px, gsd_cm_px, frame.frame_sized_dropped)
    quality["false_positive_risk"] = risk
    quality["false_positive_basis"] = why
    if tile_px:
        quality["match_radius_px"] = round(_point_radius(frame.width, frame.height), 2)

    # A still has one look, so the band collapses - but if tiles were lost the
    # three numbers describe only the part of the frame that was searched. There
    # is no second frame to fall back on, so the shortfall goes into `basis`,
    # where every consumer of a count already has to read it.
    if frame.failed_tiles:
        basis = (
            f"single_image_{frame.tiles - len(frame.failed_tiles)}"
            f"_of_{frame.tiles}_tiles"
        )
    else:
        basis = "single_image"

    return {
        "band": CountBand(low=count, best=count, high=count, basis=basis),
        "points": points,
        "quality": quality,
        "seconds": round(time.perf_counter() - started, 2),
        "engine": ENGINE_NAME,
        "engine_params": _engine_params(
            params.target, params.threshold, tile_px, gsd_cm_px=gsd_cm_px
        ),
    }


# --------------------------------------------------------------------- video

def _register(ref: Path, other: Path) -> tuple[Any, str, int, int]:
    """Register `other` onto `ref`; returns (warp, method, inliers, matches).

    Similarity transform first, because a drone yaws and changes altitude
    between frames and a translation-only fit left residuals of tens of pixels
    - enough that matching at a seal-sized radius confirmed only 34 of ~600
    animals. Phase correlation is the documented fallback, and identity is the
    last resort: it confirms almost nothing, so it is reported loudly rather
    than left to look like a real registration.
    """
    try:
        got = consensus_mod.estimate_transform(ref, other)
    except Exception:
        got = None
    if got is not None:
        matrix, inliers, matches = got
        return matrix, "affine", int(inliers), int(matches)

    try:
        return consensus_mod.estimate_shift(ref, other), "translation", 0, 0
    except Exception:
        return (0.0, 0.0), "none", 0, 0


def _score_points(
    points: list[dict],
    per_frame: list[tuple[int, list[dict]]],
    shifts: dict,
    radius: float,
) -> list[Optional[float]]:
    """Re-attach the detector's own confidence to each consensus point.

    consensus.build averages positions and keeps only `support`, but a point in
    the API carries a score and CountGD is the only thing here entitled to
    produce one. Each consensus point takes the highest score among the
    registered detections inside its matching radius - a real number from a
    real detection. Nothing is synthesised: a point with no scored detection
    nearby gets None.
    """
    xs: list[float] = []
    ys: list[float] = []
    scores: list[float] = []
    for frame_idx, dets in per_frame:
        warp = shifts.get(frame_idx, (0.0, 0.0))
        is_matrix = hasattr(warp, "shape")
        for d in dets:
            if d.get("score") is None:
                continue
            # x1/y1 is the anchor consensus.build clusters on; using anything
            # else here would score a point against a different neighbourhood.
            if is_matrix:
                x, y = consensus_mod.apply_transform(warp, d["x1"], d["y1"])
            else:
                x, y = d["x1"] + warp[0], d["y1"] + warp[1]
            xs.append(x)
            ys.append(y)
            scores.append(float(d["score"]))

    if not points:
        return []
    if not scores:
        return [None] * len(points)

    dx = np.asarray(xs)
    dy = np.asarray(ys)
    sc = np.asarray(scores)
    px = np.asarray([p["x1"] for p in points])
    py = np.asarray([p["y1"] for p in points])
    r2 = radius * radius

    out: list[Optional[float]] = []
    for start in range(0, len(px), 512):  # chunked: the full matrix is n_points x n_dets
        cx = px[start:start + 512, None]
        cy = py[start:start + 512, None]
        near = ((cx - dx[None, :]) ** 2 + (cy - dy[None, :]) ** 2) <= r2
        best = np.where(near, sc[None, :], -1.0).max(axis=1)
        out.extend(None if b < 0 else round(float(b), 4) for b in best)
    return out


def detect_video(
    path: Path,
    workdir: Path,
    params: JobParams,
    gsd_cm_px: float | None = None,
    progress_cb: ProgressCb = None,
) -> dict:
    """Sample a clip, detect per frame, and turn agreement into a count band.

    The band comes out of the same clustering at three support thresholds, so
    the three numbers are directly comparable: `high` is everything any frame
    saw at all, `best` is what min_support frames agreed on, `low` is what every
    frame agreed on. The returned points are the consensus set at min_support,
    each carrying the support that earned it. Because those are nested filters
    on one cluster set, low <= best <= high holds by construction.

    "Every frame" means every frame admitted as evidence, and admission is
    deliberately strict, because `low` is an intersection and one bad frame
    vetoes every animal in the colony. A frame is evidence only if it detected
    something, was searched in full, and registered onto the reference. The
    frames that drop out are listed in `quality` (`frames_empty`,
    `frames_incomplete`, `registration_failed`, `frames_failed`) and marked
    `excluded` in their own per-frame record, so the band is never quietly
    computed over fewer frames than the caller thinks.
    """
    path = Path(path)
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    _emit(progress_cb, 0, 0, "extract")
    info = frames_mod.probe(path)
    frame_dir = workdir / "frames"
    sampled = frames_mod.extract(
        path,
        frame_dir,
        every=params.sampling.every_s,
        max_frames=params.sampling.max_frames,
    )
    if not sampled:
        raise RuntimeError(
            f"no frames extracted from {path.name} "
            f"(duration {info.duration:.1f}s, every_s={params.sampling.every_s})"
        )

    with Image.open(frame_dir / sampled[0]["file"]) as im:
        frame_w, frame_h = im.size

    # frames.extract caps the long edge at 2048, so one extracted pixel can
    # cover more ground than one source pixel. Tiling must be chosen for the
    # pixels the model actually sees, or a downscaled 4K clip gets the tile
    # size of a resolution it no longer has.
    frame_gsd = gsd_cm_px
    if gsd_cm_px and info.width and frame_w and frame_w != info.width:
        frame_gsd = gsd_cm_px * (info.width / frame_w)
    tile_px = resolve_tile_px(params.tiling, frame_gsd)

    total = len(sampled)
    passes: list[tuple[int, FramePass]] = []
    frame_quality: list[dict] = []
    failed_tiles = 0
    frame_sized_dropped = 0

    _emit(progress_cb, 0, total, "detect")
    for pos, meta in enumerate(sampled):
        fpath = frame_dir / meta["file"]
        record = {
            "index": meta["index"],
            "t": meta["t"],
            "file": meta["file"],
            "count": None,
            "tiles": None,
            "seconds": None,
        }
        try:
            passed = _detect_one(
                fpath, tile_px, params.target, params.threshold,
                scratch=workdir / "_tiles",
            )
        except Exception as exc:
            record["error"] = f"{type(exc).__name__}: {exc}"
            frame_quality.append(record)
            _emit(progress_cb, pos + 1, total, "detect")
            continue

        passes.append((meta["index"], passed))
        failed_tiles += len(passed.failed_tiles)
        frame_sized_dropped += passed.frame_sized_dropped
        record.update({
            "count": passed.count,
            "tiles": passed.tiles,
            "tiles_failed": len(passed.failed_tiles),
            "detections_pre_nms": passed.pre_nms,
            "seconds": round(passed.seconds, 2),
        })
        frame_quality.append(record)
        _emit(progress_cb, pos + 1, total, "detect")

    if not passes:
        raise RuntimeError(
            f"detection failed on every sampled frame of {path.name} - "
            f"first error: {frame_quality[0].get('error')}"
        )

    rec_by_index = {r["index"]: r for r in frame_quality}

    # The best any single frame that actually ran produced - including the
    # frames barred from consensus below, since barring a frame never invents
    # detections it did not have. This is one input to `high`, not `high`
    # itself: see the union term where the band is assembled.
    frame_max = max(p.count for _, p in passes)

    # Which frames are allowed to be EVIDENCE is the whole ballgame, because
    # `low` is an intersection: one bad frame vetoes every animal.
    #
    # Measured on the reference clip with the contract's own defaults: CountGD's
    # whole-frame path returned 525/493/419/218 on frames 0-3 and then exactly 0
    # on frames 4, 5 and 6 - three collapses on a scene that ORB still registers
    # to frame 0 at 858/937 inliers, i.e. demonstrably the same colony. Counting
    # those zeros as agreement drove `low` from 155 to 0 and the job still
    # reported success. A frame that found nothing cannot confirm anything; it
    # can only veto, so it is not evidence. Same for a frame that lost tiles to
    # a crashed subprocess - that is an undercount of a region, not a report
    # that the region is empty.
    # Mutually exclusive, and incomplete wins: a frame that lost tiles AND found
    # nothing was not searched, so "no detections" would name the wrong cause.
    incomplete = [idx for idx, p in passes if not p.complete]
    empty = [idx for idx, p in passes if p.complete and p.count == 0]
    evidence = [(idx, p) for idx, p in passes if p.complete and p.count]

    if not evidence:
        if any(p.count for _, p in passes):
            # Animals were found, but not one frame was searched in full, so
            # there is no frame whose zero regions mean anything. Reporting a
            # band off these would be reporting the tile failures as a count.
            raise RuntimeError(
                f"no complete frame in {path.name}: every frame that detected "
                f"anything lost tiles ({failed_tiles} tile failures in total) - "
                f"first: {next(p.failed_tiles[0]['error'] for _, p in passes if p.failed_tiles)}"
            )
        # Every frame that ran found nothing, and CountGD is measured at zero
        # false positives on hand-verified empty water and sand. "Nothing here"
        # is a real survey answer and must not be dressed up as a failure, so
        # the empty frames stay in and the band comes out an honest zero.
        evidence = list(passes)
        empty = []

    for idx in empty:
        rec_by_index[idx]["excluded"] = "no_detections"
    for idx in incomplete:
        rec_by_index[idx]["excluded"] = "tiles_failed"

    ref_idx = evidence[0][0]
    ref_path = frame_dir / next(m["file"] for m in sampled if m["index"] == ref_idx)

    shifts: dict = {ref_idx: (0.0, 0.0)}
    registration = {str(ref_idx): "reference"}
    by_index = {m["index"]: m for m in sampled}
    unregistered: list[int] = []
    n_evidence = len(evidence)

    for done, (idx, _) in enumerate(evidence):
        if idx == ref_idx:
            _emit(progress_cb, done + 1, n_evidence, "register")
            continue
        warp, method, inliers, matches = _register(
            ref_path, frame_dir / by_index[idx]["file"]
        )
        shifts[idx] = warp
        label = f"{method} {inliers}/{matches}" if method == "affine" else method
        registration[str(idx)] = label
        if method == "none":
            # Identity is not a registration. Measured drone drift between
            # sampled frames is ~57px against a 15px matching radius, so an
            # unregistered frame does not merely fail to confirm - consensus
            # averages the positions it contributes, so it drags every cluster
            # centroid it touches off the animal. Excluded, and said so.
            unregistered.append(idx)
            rec_by_index[idx]["excluded"] = "unregistered"
        rec_by_index[idx].update({
            "registered": method != "none",
            "registration": method,
            "inliers": inliers,
            "matches": matches,
        })
        _emit(progress_cb, done + 1, n_evidence, "register")

    rec_by_index[ref_idx].update(
        {"registered": True, "registration": "reference", "inliers": 0, "matches": 0}
    )

    per_frame: list[tuple[int, list[dict]]] = [
        (idx, p.dets) for idx, p in evidence if idx not in unregistered
    ]
    used = [idx for idx, _ in per_frame]

    _emit(progress_cb, len(used), len(used), "consensus")
    radius = _point_radius(frame_w, frame_h)
    n_used = len(per_frame)
    requested_support = max(1, int(params.consensus.min_support))
    # Asking for agreement from more frames than were detected would make
    # `best` zero and put it below `low`, which is nonsense rather than a
    # conservative answer. Clamp, and say that the clamp happened.
    min_support = min(requested_support, n_used)

    # One clustering pass answers every support level: build() groups the same
    # way whatever min_support is, and only filters on it at the end. So the
    # band and the histogram are guaranteed to describe one clustering rather
    # than three that merely ought to agree.
    clusters = consensus_mod.build(per_frame, shifts, radius, min_support=1)
    histogram = {
        str(k): sum(1 for c in clusters if c["support"] >= k)
        for k in range(1, n_used + 1)
    }
    best_points = [c for c in clusters if c["support"] >= min_support]

    # `high` is the permissive end of the band, so it has to be the largest
    # number the evidence can support - and the largest single frame is NOT
    # that. build() never puts two detections from the same frame in one
    # cluster, so the union (support >= 1) is >= every frame's own count by
    # construction, and it is the union that counts an animal one frame saw and
    # another missed. Taking the frame maximum alone put the stated ceiling
    # BELOW the pipeline's own count on every consensus run measured
    # (525 vs 691, 532 vs 726, 610 vs 683), and below `best` outright whenever
    # min_support was low enough - a band that excludes its own lead number.
    # The frame maximum stays in the max() because frames excluded from
    # consensus (unregistered, incomplete) contribute to it but not to the
    # union, and dropping a frame must never lower the ceiling.
    union = histogram["1"]
    high = max(frame_max, union)

    band = CountBand(
        low=histogram[str(n_used)],
        best=len(best_points),
        high=high,
        # A single usable frame is a still with extra steps - nothing exists to
        # confirm or contradict it - and calling that "consensus" would dress
        # one look up as agreement. Neither is min_support=1: that accepts a
        # detection no other frame corroborated, which is a union over frames,
        # not agreement between them. Both get named for what they are.
        basis=(
            f"consensus_{n_used}_frames" if n_used > 1 and min_support > 1
            else f"union_{n_used}_frames" if n_used > 1
            else "single_frame"
        ),
    )

    scores = _score_points(best_points, per_frame, shifts, radius)
    points = []
    for p, score in zip(best_points, scores):
        points.append({
            "x": round(p["x1"], 2),
            "y": round(p["y1"], 2),
            "score": score,
            # Consensus coordinates live in the reference frame's pixel space,
            # so that is the frame index a point can honestly be pinned to.
            "frame_idx": ref_idx,
            "support": int(p["support"]),
        })

    quality = {
        "tile_px": tile_px,
        "tiles_per_frame": next(
            (r["tiles"] for r in frame_quality if r.get("tiles")), None
        ),
        "tiles_failed": failed_tiles,
        "tiles_rejected": 0,
        "malformed_dropped": frame_sized_dropped,
        "frames_sampled": total,
        "frames_used": used,
        "frames_failed": [r["index"] for r in frame_quality if "error" in r],
        # Every way a sampled frame can drop out of the count, listed separately
        # because they mean different things to whoever has to defend the
        # number: `frames_empty` is the detector collapsing on a scene that is
        # there, `frames_incomplete` is inference lost to a crash, and
        # `registration_failed` is a frame in the wrong coordinate system.
        "frames_empty": empty,
        "frames_incomplete": incomplete,
        "frames": frame_quality,
        "registration": registration,
        "registration_failed": unregistered,
        "reference_frame": ref_idx,
        "support_histogram": histogram,
        "match_radius_px": round(radius, 2),
        "min_support": min_support,
        "min_support_requested": requested_support,
        "width": frame_w,
        "height": frame_h,
        "source_width": info.width,
        "source_height": info.height,
        "duration_s": round(info.duration, 3),
        "gsd_cm_px": gsd_cm_px,
        "frame_gsd_cm_px": frame_gsd,
    }
    # Judged against `frame_gsd`, not the survey's GSD: tiling was chosen for
    # the pixels the model actually saw after downscaling, so that is the scale
    # the crop size has to be defended at.
    risk, why = _false_positive_risk(tile_px, frame_gsd, frame_sized_dropped)
    quality["false_positive_risk"] = risk
    quality["false_positive_basis"] = why

    return {
        "band": band,
        "points": points,
        "quality": quality,
        "seconds": round(time.perf_counter() - started, 2),
        "engine": ENGINE_NAME,
        "engine_params": _engine_params(
            params.target, params.threshold, tile_px,
            every_s=params.sampling.every_s,
            max_frames=params.sampling.max_frames,
            min_support=min_support,
            match_radius_px=round(radius, 2),
            gsd_cm_px=frame_gsd,
        ),
    }


# ----------------------------------------------------------------- cli entry

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}


def _cli(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            "usage: python service/detect.py <image-or-video> [gsd_cm_px]\n"
            "\n"
            "Runs the real pipeline against a real file - there is no sample\n"
            "media and no synthetic mode, because a fabricated count would be\n"
            "indistinguishable from a measured one in the output.\n"
            "\n"
            "  gsd_cm_px  ground sample distance; drives automatic tiling.\n"
            "             Omit it and the whole-frame path is used.",
            file=sys.stderr,
        )
        return 2

    media = Path(argv[1]).expanduser().resolve()
    if not media.is_file():
        print(f"not a file: {media}", file=sys.stderr)
        return 2
    if not countgd_engine.available():
        print(
            "CountGD is not installed - needs .venv-countgd and "
            "vendor/CountGD/checkpoints/checkpoint_best_regular.pth. See README.",
            file=sys.stderr,
        )
        return 3

    try:
        gsd = float(argv[2]) if len(argv) > 2 else None
    except ValueError:
        print(f"gsd_cm_px must be a number, got {argv[2]!r}", file=sys.stderr)
        return 2
    params = JobParams()

    def show(done: int, total: int, stage: str) -> None:
        print(f"  [{stage:<9}] {done}/{total}", file=sys.stderr, flush=True)

    if media.suffix.lower() in VIDEO_EXT:
        workdir = media.parent / f".detect_{media.stem}"
        result = detect_video(media, workdir, params, gsd, progress_cb=show)
    else:
        result = detect_image(media, params, gsd)

    band = result["band"]
    q = result["quality"]
    print(f"\nmedia   : {media}")
    print(f"engine  : {result['engine']} {json.dumps(result['engine_params'])}")
    print(f"count   : low {band.low} | best {band.best} | high {band.high}  ({band.basis})")
    print(f"points  : {len(result['points'])}")
    print(f"seconds : {result['seconds']}")
    for rec in q.get("frames", []):
        print(
            f"  frame {rec['index']:>3} t={rec['t']:<7} count={rec['count']} "
            f"reg={rec.get('registration', '-')} "
            f"inliers={rec.get('inliers', '-')}/{rec.get('matches', '-')}"
            + (f" EXCLUDED {rec['excluded']}" if "excluded" in rec else "")
            + (f" ERROR {rec['error']}" if "error" in rec else "")
        )
    if q.get("support_histogram"):
        print(f"support : {q['support_histogram']}")
    print("\nquality :")
    print(json.dumps({k: v for k, v in q.items() if k != "frames"}, indent=2))
    for p in result["points"][:5]:
        print(f"  point   {p}")
    if len(result["points"]) > 5:
        print(f"  ... {len(result['points']) - 5} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv))
