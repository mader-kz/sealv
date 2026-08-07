"""LocateAnything Studio - local FastAPI server.

Serves the single-page UI, holds uploaded media in a per-session workspace and
runs LocateAnything-3B over images or sampled video frames.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from . import consensus as consensus_mod
from . import countgd_engine
from . import frames as frames_mod
from .model_worker import WORKER, _point_radius

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
# Still the old project name, deliberately. The repo is `tulen` now and the
# service writes to ~/.tulen, but this prototype's uploads already live here on
# every machine that has run it - renaming the path for tidiness would orphan
# them silently rather than migrate them. The service is the thing whose naming
# has to be coherent; this is a local scratch dir with existing contents.
WORKSPACE = Path.home() / ".locateanything-studio" / "workspace"
WORKSPACE.mkdir(parents=True, exist_ok=True)

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}

SESSIONS: dict[str, dict] = {}


def _warm_model() -> None:
    try:
        WORKER.ensure_loaded()
    except Exception:
        pass  # state.detail already carries the error for the UI


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Only preload the MLX model when it is actually the engine. CountGD is the
    # default and runs out-of-process, so warming LocateAnything would cost
    # ~4 GB of RAM and a load for nothing.
    if not countgd_engine.available() or os.environ.get("LA_ENGINE") == "locateanything":
        threading.Thread(target=_warm_model, daemon=True).start()
    yield


app = FastAPI(title="LocateAnything Studio", lifespan=lifespan)


# ----------------------------------------------------------------- utilities

def _session(sid: str) -> dict:
    s = SESSIONS.get(sid)
    if not s:
        raise HTTPException(404, "session not found - re-upload the file")
    return s


def _persist(s: dict) -> None:
    """Write detections to the session dir.

    A detection pass over a video costs minutes of inference; losing it to a
    server restart before consensus can be built is not acceptable.
    """
    try:
        payload = {str(k): v for k, v in (s.get("results") or {}).items()}
        (s["dir"] / "results.json").write_text(json.dumps(payload))
    except Exception:
        pass


def _restore(s: dict) -> None:
    """Reload detections from disk when the in-memory session is empty."""
    if s.get("results"):
        return
    p = s["dir"] / "results.json"
    if not p.is_file():
        return
    try:
        raw = json.loads(p.read_text())
        s["results"] = {(None if k == "None" else int(k)): v for k, v in raw.items()}
    except Exception:
        pass


def _image_size(path: Path) -> tuple[int, int]:
    with Image.open(path) as im:
        return im.size


# -------------------------------------------------------------------- routes

@app.get("/api/state")
async def state():
    st = WORKER.state
    return {
        "status": st.status,
        "model_id": st.model_id,
        "detail": st.detail,
        "load_seconds": st.load_seconds,
        "capabilities": st.capabilities,
        "ffmpeg": bool(frames_mod.FFMPEG),
        "countgd": countgd_engine.available(),
    }


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    suffix = Path(file.filename or "upload").suffix.lower()
    if suffix in IMAGE_EXT:
        kind = "image"
    elif suffix in VIDEO_EXT:
        kind = "video"
    else:
        raise HTTPException(
            400, f"unsupported file type '{suffix or '?'}' - use an image or a video"
        )

    sid = uuid.uuid4().hex[:12]
    sdir = WORKSPACE / sid
    sdir.mkdir(parents=True, exist_ok=True)
    dest = sdir / f"source{suffix}"

    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)

    payload = {
        "id": sid,
        "kind": kind,
        "name": file.filename,
        "url": f"/media/{sid}/{dest.name}",
        "bytes": dest.stat().st_size,
    }

    if kind == "image":
        w, h = _image_size(dest)
        payload |= {"width": w, "height": h}
    else:
        try:
            info = frames_mod.probe(dest)
        except frames_mod.FFmpegMissing as exc:
            raise HTTPException(500, str(exc)) from exc
        payload |= {
            "width": info.width,
            "height": info.height,
            "duration": round(info.duration, 3),
            "fps": round(info.fps, 3),
        }

    SESSIONS[sid] = {"dir": sdir, "source": dest, **payload}
    return payload


@app.post("/api/frames")
async def make_frames(body: dict):
    s = _session(body.get("id", ""))
    if s["kind"] != "video":
        raise HTTPException(400, "frame extraction only applies to video")

    every = float(body.get("every", 1.0))
    start = float(body.get("start", 0.0))
    end = body.get("end")
    max_frames = int(body.get("max_frames", 240))

    def work():
        return frames_mod.extract(
            s["source"],
            s["dir"] / "frames",
            every=every,
            start=start,
            end=float(end) if end is not None else None,
            max_frames=max_frames,
        )

    try:
        extracted = await asyncio.to_thread(work)
    except frames_mod.FFmpegMissing as exc:
        raise HTTPException(500, str(exc)) from exc

    if not extracted:
        raise HTTPException(400, "no frames extracted - check the time range")

    for f in extracted:
        p = s["dir"] / "frames" / f["file"]
        f["width"], f["height"] = _image_size(p)
        f["url"] = f"/media/{s['id']}/frames/{f['file']}"

    s["frames"] = extracted
    return {"frames": extracted, "count": len(extracted)}


def _frame_target(s: dict, index: int | None) -> tuple[Path, int, int]:
    if s["kind"] == "image":
        return s["source"], s["width"], s["height"]

    fr = s.get("frames") or []
    if not fr:
        raise HTTPException(400, "extract frames first")
    if index is None or index < 0 or index >= len(fr):
        raise HTTPException(400, f"frame index out of range (0..{len(fr) - 1})")
    f = fr[index]
    return s["dir"] / "frames" / f["file"], f["width"], f["height"]


@app.post("/api/detect")
async def detect(body: dict):
    s = _session(body.get("id", ""))
    path, w, h = _frame_target(s, body.get("frame"))
    prompt = (body.get("prompt") or "Detect all objects in the image.").strip()

    # CountGD is the default: measured 389 found / 0 false positives / 2.1s on a
    # 1698x1082 still against LocateAnything's 248 / 1 / 67s, and 0 vs 23 false
    # positives on verified-empty ground in video. LocateAnything is opt-in.
    engine = body.get("engine") or (
        "countgd" if countgd_engine.available() else "locateanything"
    )
    if engine == "countgd":
        def work_countgd():
            return countgd_engine.detect(
                path, prompt=body.get("countgd_prompt") or "seal",
                threshold=float(body.get("threshold", 0.23)),
            )
        try:
            res = await asyncio.to_thread(work_countgd)
        except Exception as exc:
            raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
        s.setdefault("results", {})[body.get("frame")] = res["detections"]
        _persist(s)
        return {"frame": body.get("frame"), "width": w, "height": h,
                "raw": "", "text": f"{len(res['detections'])} via CountGD",
                "ms": 0, "engine": "countgd", **res}

    def work():
        return WORKER.detect_tiled(
            path, prompt, w, h,
            grid_n=int(body.get("tiles", 1)),
            max_tokens=int(body.get("max_tokens", 2048)),
            temperature=float(body.get("temperature", 0.0)),
            generation_mode=body.get("mode", "hybrid"),
            scratch=s["dir"] / "_tiles",
            tile_px=int(body.get("tile_px", 0)),
            denoise=float(body.get("denoise", 0.0)),
        )

    try:
        result = await asyncio.to_thread(work)
    except Exception as exc:
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc

    # retained so temporal consensus can be computed across frames afterwards
    s.setdefault("results", {})[body.get("frame")] = result["detections"]
    _persist(s)
    return {"frame": body.get("frame"), "width": w, "height": h, **result}


@app.get("/api/run")
async def run_all(request: Request, id: str, prompt: str = "", max_tokens: int = 2048,
                  temperature: float = 0.0, mode: str = "hybrid", tiles: int = 1,
                  tile_px: int = 0, denoise: float = 0.0):
    """Server-sent events: run detection across every extracted frame."""
    s = _session(id)
    prompt = (prompt or "Detect all objects in the image.").strip()
    targets = (
        [(None, s["source"], s["width"], s["height"])]
        if s["kind"] == "image"
        else [
            (f["index"], s["dir"] / "frames" / f["file"], f["width"], f["height"])
            for f in (s.get("frames") or [])
        ]
    )
    if not targets:
        raise HTTPException(400, "nothing to run - extract frames first")

    async def stream():
        started = time.perf_counter()
        total_boxes = 0
        yield f"event: start\ndata: {json.dumps({'total': len(targets)})}\n\n"

        for pos, (idx, path, w, h) in enumerate(targets):
            if await request.is_disconnected():
                return
            try:
                res = await asyncio.to_thread(
                    WORKER.detect_tiled, path, prompt, w, h, tiles,
                    max_tokens, temperature, mode, s["dir"] / "_tiles", tile_px,
                    denoise,
                )
                total_boxes += len(res["detections"])
                s.setdefault("results", {})[idx] = res["detections"]
                _persist(s)
                payload = {
                    "position": pos, "frame": idx,
                    "width": w, "height": h, **res,
                }
            except Exception as exc:
                payload = {
                    "position": pos, "frame": idx,
                    "error": f"{type(exc).__name__}: {exc}",
                    "detections": [], "raw": "", "text": "", "ms": 0,
                }
            yield f"event: frame\ndata: {json.dumps(payload)}\n\n"

        summary = {
            "frames": len(targets),
            "boxes": total_boxes,
            "seconds": round(time.perf_counter() - started, 2),
        }
        yield f"event: done\ndata: {json.dumps(summary)}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/consensus")
async def consensus(body: dict):
    """Confirm detections across frames, registering out camera drift first."""
    s = _session(body.get("id", ""))
    if s["kind"] != "video":
        raise HTTPException(400, "consensus needs a video with several frames")

    _restore(s)
    stored = {k: v for k, v in (s.get("results") or {}).items() if k is not None}
    if len(stored) < 2:
        raise HTTPException(400, "run detection on at least 2 frames first")

    fr = s.get("frames") or []
    ref_idx = body.get("reference")
    ref_idx = min(stored) if ref_idx is None else int(ref_idx)
    if ref_idx not in stored:
        ref_idx = min(stored)

    min_support = int(body.get("min_support", 2))
    radius = float(body.get("radius", 0)) or _point_radius(s["width"], s["height"])

    def work():
        ref_path = s["dir"] / "frames" / fr[ref_idx]["file"]
        shifts: dict = {ref_idx: (0.0, 0.0)}
        methods: dict[int, str] = {ref_idx: "reference"}
        for idx in stored:
            if idx == ref_idx:
                continue
            other = s["dir"] / "frames" / fr[idx]["file"]
            # similarity transform first (handles drone yaw and altitude change);
            # translation-only phase correlation is the fallback
            try:
                got = consensus_mod.estimate_transform(ref_path, other)
            except Exception:
                got = None
            if got is not None:
                M, inliers, total = got
                shifts[idx] = M
                methods[idx] = f"affine ({inliers}/{total} inliers)"
            else:
                try:
                    shifts[idx] = consensus_mod.estimate_shift(ref_path, other)
                    methods[idx] = "translation"
                except Exception:
                    shifts[idx] = (0.0, 0.0)
                    methods[idx] = "none"

        per_frame = sorted(stored.items())
        points = consensus_mod.build(per_frame, shifts, radius, min_support)
        hist = consensus_mod.support_histogram(per_frame, shifts, radius)
        return points, hist, methods

    try:
        points, hist, methods = await asyncio.to_thread(work)
    except Exception as exc:
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc

    return {
        "reference": ref_idx,
        "frames_used": sorted(stored),
        "min_support": min_support,
        "radius": round(radius, 1),
        "detections": points,
        "histogram": hist,
        "registration": {str(k): v for k, v in methods.items()},
        "width": s["width"], "height": s["height"],
    }


@app.get("/media/{sid}/{path:path}")
async def media(sid: str, path: str):
    base = (WORKSPACE / sid).resolve()
    target = (base / path).resolve()
    if not str(target).startswith(str(base)) or not target.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(target)


@app.get("/")
async def index():
    return FileResponse(WEB / "index.html")


app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
