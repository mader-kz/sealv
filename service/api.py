"""HTTP surface for the SEALv detection service.

Section 3 of `docs/DETECTION_BACKEND_PLAN.md` is the contract SEALv already
codes against, so the response shapes here reproduce it verbatim rather than
improve on it.

Nothing expensive happens inside a request. A still is ~2s and a sortie is
minutes, so every detection is enqueued and a worker (`service/worker.py`)
claims it; an HTTP handler that ran a 500-frame sortie would time out long
before it finished. Handlers therefore only touch SQLite and the filesystem,
and even that goes through `asyncio.to_thread` - a SQLite connection belongs to
the thread that opened it, and one slow disk should not stall the event loop
for every other caller.

Division of labour: `db` owns rows, `geo` owns coordinates, `detect` owns the
count, and this file owns shapes. SQL appears here only for the counts and
aggregates that are purely presentational - /v1/stats above all - because those
belong to a dashboard rather than to the data layer.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import shutil
import sqlite3
import uuid
from contextlib import asynccontextmanager, contextmanager
from dataclasses import fields as dc_fields
from pathlib import Path
from typing import Any, BinaryIO, Iterator, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from PIL import Image

from la_studio import frames as frames_mod

from . import db, geo, preflight
from .contract import ConsensusParams, JobParams, Sampling, auto_tile_px

# Derived from the dataclasses rather than typed out, so a new field in the
# contract cannot leave this file rejecting something it now supports.
_PARAM_KEYS = {f.name for f in dc_fields(JobParams)}
_SAMPLING_KEYS = {f.name for f in dc_fields(Sampling)}
_CONSENSUS_KEYS = {f.name for f in dc_fields(ConsensusParams)}

# The request bodies of §3. `media` is the plan's block; `media_id` is how this
# service actually refers to something it has already ingested.
_JOB_BODY_KEYS = {"media_id", "media", "survey", "params"}
_MEDIA_REF_KEYS = {"id", "media_id", "url", "kind", "width", "height"}
# §3's survey block plus the §4 columns the upload route already accepts.
_SURVEY_KEYS = {
    "site_id", "captured_at", "altitude_m", "gsd_cm_px",
    "tide_state", "sea_ice_pct", "operator", "notes",
}

# $SEALV_WORKSPACE, absolute, or ~/.sealv/workspace. Resolved in one place -
# `preflight.workspace_path` - because the worker writes each job's frames and
# tile crops under the media file this directory holds, and two definitions that
# disagreed would put a run's evidence somewhere the API cannot serve it. It is
# also, with the database, the only thing on a container that survives a deploy:
# see the module docstring in preflight for what a blank or relative value costs.
WORKSPACE = preflight.workspace_path()
WORKSPACE.mkdir(parents=True, exist_ok=True)

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
SIDECAR_EXT = {".srt", ".json"}

# Frame filenames arrive from the URL, so they are matched against this before
# they are ever joined onto a path.
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

# SSE poll cadence. The job row is the only thing worth watching and a worker
# writes to it once per frame, so sub-second polling would be pure churn.
EVENT_POLL_S = 0.5
EVENT_HEARTBEAT_S = 15.0

MAX_LATEST_RUNS = 20


@asynccontextmanager
async def lifespan(_: FastAPI):
    def prepare() -> None:
        # Before the schema, not after: the checks include whether the volume
        # holding the database is mounted and writable, and `init_db` against an
        # unmounted mount point succeeds - onto the image's own filesystem,
        # where the survey archive lasts until the next deploy.
        preflight.require("api")
        with _conn() as conn:
            db.init_db(conn)

    await asyncio.to_thread(prepare)
    yield


app = FastAPI(title="SEALv detection service", lifespan=lifespan)

# Permissive by design: this service sits behind SEALv's own front end for now,
# and Phase 5 of the plan is where auth and origin pinning arrive.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# ------------------------------------------------------------------ db access

@contextmanager
def _conn() -> Iterator[sqlite3.Connection]:
    """One connection per unit of work, opened on the thread that uses it."""
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


def _scalar(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> Any:
    row = conn.execute(sql, params).fetchone()
    return None if row is None else row[0]


# -------------------------------------------------------------------- helpers

def _as_float(value: Any, field: str) -> Optional[float]:
    """Multipart fields arrive as strings, and unset ones arrive as empty ones.

    Finiteness is checked because `float()` is not a validator: it happily
    returns inf for `"inf"`, for `"1e400"`, and for the JSON number `1e400`,
    which json.loads overflows to inf without a word. An infinite coordinate
    then INSERTs fine - SQLite has no opinion about it - and the damage only
    lands on the way back out, where Starlette's JSONResponse encodes with
    allow_nan=False and raises. That ordering is what makes this worth a guard
    rather than a stack trace: the row is already committed by then, so one
    request permanently 500s every later read of that run's points AND of the
    job that produced them, `verified_count` is silently inflated, and the
    remove operation that would undo it 500s on its own response too - the run
    cannot be repaired through the API at all. `geo.pixel_to_latlng` already
    refuses non-finite values on the projection path; this is the same rule on
    the operator-edit path, applied before anything is written.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        number = float(text)
    except ValueError as exc:
        raise HTTPException(400, f"{field} must be a number, got {text!r}") from exc
    if not math.isfinite(number):
        raise HTTPException(400, f"{field} must be a finite number, got {text!r}")
    return number


def _clean(value: Any, field: str = "value") -> Optional[str]:
    """Trim a text field down to None-or-content.

    A JSON body is untyped, so a caller can put an object where an operator
    name belongs. `str()` on that would quietly store a Python repr as if a
    human had typed it, so containers are rejected rather than coerced.
    """
    if value is None:
        return None
    if isinstance(value, (dict, list, tuple, set)):
        raise HTTPException(400, f"{field} must be text, got {type(value).__name__}")
    text = str(value).strip()
    return text or None


def _number(value: Any, field: str) -> float:
    """A JSON number, not something that merely looks like one.

    `bool` is excluded before `int` because it is an int subclass, and
    `{"threshold": true}` is a typo rather than a threshold of 1.0.

    inf and nan are excluded because `json.loads` produces them silently -
    `1e400` overflows to inf, and the literals `Infinity`/`NaN` are accepted by
    Python's parser outright. Neither survives a range check honestly: nan fails
    every comparison, so `sampling.every_s = NaN` passes `<= 0` and is stored as
    a sampling interval, and `int(inf)` raises OverflowError, which is a 500
    where a 400 belongs.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HTTPException(400, f"{field} must be a number, got {value!r}")
    if not math.isfinite(value):
        raise HTTPException(400, f"{field} must be a finite number, got {value!r}")
    return float(value)


def _whole(value: Any, field: str) -> int:
    """A whole number. JSON has one numeric type, so 8 and 8.0 are one request."""
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value != int(value)
    ):
        raise HTTPException(400, f"{field} must be a whole number, got {value!r}")
    return int(value)


def _tiling(value: Any) -> Any:
    """`auto` | `off` | a size in pixels, per §3 of the plan."""
    if isinstance(value, str):
        key = value.strip().lower()
        if key in ("auto", "off"):
            return key
        raise HTTPException(400, "tiling must be 'auto', 'off' or a pixel size")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HTTPException(400, "tiling must be 'auto', 'off' or a pixel size")
    px = int(value)
    if px < 0:
        raise HTTPException(400, "tiling in pixels cannot be negative")
    return px


def _reject_unknown(d: dict, allowed: set[str], where: str) -> None:
    """A field this service does not read is a field the caller must hear about.

    `JobParams.from_dict` filters by key, so `{"thresh": 0.5}` used to queue a
    202 and then run at the default 0.23 - the caller believing one threshold
    while the count came from another. That is the wrong-count-reported-
    confidently failure the whole service exists to avoid, arriving through a
    typo. Names that are wrong now fail as loudly as types already did.
    """
    extra = sorted(k for k in d if k not in allowed)
    if extra:
        raise HTTPException(
            400,
            f"unknown field(s) in {where}: {', '.join(extra)} - this service "
            f"would ignore them and the count would not be the one you asked "
            f"for. Known fields: {', '.join(sorted(allowed))}",
        )


def _job_params(raw: Any) -> JobParams:
    """Validate and normalise the `params` block before anything is queued.

    `JobParams.from_dict` copies values through without looking at them, and
    JSON carries no types: `{"threshold": "0.23"}` arrives as a string and only
    explodes when something compares it against a float. Checking here is the
    whole point of validating in the handler - a job that fails on its type two
    minutes into a sortie has already cost the operator the sortie. The
    normalised values are what gets stored, so the worker re-reads clean types.
    """
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise HTTPException(400, f"params must be an object, got {type(raw).__name__}")
    for key in ("sampling", "consensus"):
        if raw.get(key) is not None and not isinstance(raw[key], dict):
            raise HTTPException(400, f"params.{key} must be an object")

    _reject_unknown(raw, _PARAM_KEYS, "params")
    _reject_unknown(raw.get("sampling") or {}, _SAMPLING_KEYS, "params.sampling")
    _reject_unknown(raw.get("consensus") or {}, _CONSENSUS_KEYS, "params.consensus")

    params = JobParams.from_dict(raw)

    target = _clean(params.target, "target")
    if not target:
        raise HTTPException(400, "target must be a non-empty string")
    params.target = target

    params.threshold = _number(params.threshold, "threshold")
    if not 0.0 < params.threshold < 1.0:
        raise HTTPException(400, "threshold must be between 0 and 1")

    params.tiling = _tiling(params.tiling)

    params.sampling.every_s = _number(params.sampling.every_s, "sampling.every_s")
    if params.sampling.every_s <= 0:
        raise HTTPException(400, "sampling.every_s must be greater than 0")

    params.sampling.max_frames = _whole(params.sampling.max_frames, "sampling.max_frames")
    if params.sampling.max_frames < 1:
        raise HTTPException(400, "sampling.max_frames must be at least 1")

    params.consensus.min_support = _whole(params.consensus.min_support, "consensus.min_support")
    if params.consensus.min_support < 1:
        raise HTTPException(400, "consensus.min_support must be at least 1")

    return params


def _kind_for(suffix: str) -> str:
    if suffix in IMAGE_EXT:
        return "image"
    if suffix in VIDEO_EXT:
        return "video"
    raise HTTPException(
        400, f"unsupported file type '{suffix or '?'}' - upload an image or a video"
    )


def _save(src: BinaryIO, dest: Path) -> int:
    with dest.open("wb") as fh:
        shutil.copyfileobj(src, fh, length=1 << 20)
    return dest.stat().st_size


def _probe(path: Path, kind: str) -> dict:
    """Dimensions and duration. Width is what turns altitude into GSD."""
    if kind == "image":
        with Image.open(path) as im:
            width, height = im.size
        return {"width": width, "height": height, "duration_s": None, "fps": None}
    info = frames_mod.probe(path)
    return {
        "width": info.width,
        "height": info.height,
        "duration_s": round(info.duration, 3),
        "fps": round(info.fps, 3),
    }


def _parse_sidecar(path: Path, source: str) -> list[dict]:
    """Flight track from a DJI `.srt` or a JSON export, via geo's parsers.

    `source` is stamped onto every point because the schema records provenance
    per point: an SRT track and a hand-dropped pin are not equally trustworthy
    and a map should be able to say which it is showing.
    """
    text = path.read_text(errors="replace")
    track = geo.parse_srt(text) if source == "srt" else geo.parse_json_sidecar(text)
    return [{**p, "source": source} for p in track]


def _median_alt(track: list[dict]) -> Optional[float]:
    """Altitude for GSD when the operator did not type one in.

    The median, not the mean: a DJI track usually includes the climb-out, and a
    handful of near-ground samples would drag a mean down and silently pick the
    wrong tile size for the whole sortie.
    """
    alts = sorted(float(p["alt"]) for p in track if p.get("alt") is not None)
    if not alts:
        return None
    mid = len(alts) // 2
    return alts[mid] if len(alts) % 2 else (alts[mid - 1] + alts[mid]) / 2.0


def _inside(base: Path, target: Path) -> bool:
    try:
        target.relative_to(base.resolve())
        return True
    except ValueError:
        return False


def _media_or_404(conn: sqlite3.Connection, media_id: str) -> dict:
    media = db.get_media(conn, media_id)
    if media is None:
        raise HTTPException(404, "media not found")
    return media


def _media_payload(media: dict, survey: Optional[dict]) -> dict:
    """The public media record. `path` stays server-side; `url` replaces it."""
    gsd = (survey or {}).get("gsd_cm_px")
    long_edge = max(media.get("width") or 0, media.get("height") or 0)
    return {
        "id": media["id"],
        "survey_id": media.get("survey_id"),
        "filename": media.get("filename"),
        "kind": media["kind"],
        "width": media.get("width"),
        "height": media.get("height"),
        "duration_s": media.get("duration_s"),
        "bytes": media.get("bytes"),
        "created_at": media.get("created_at"),
        "url": f"/media/{media['id']}/file",
        "gsd_cm_px": gsd,
        "gsd_source": (survey or {}).get("gsd_source") or ("unknown" if not gsd else "assumed_native_width"),
        "tile_px": auto_tile_px(gsd, long_edge),
    }


# --------------------------------------------------------------- job payloads

def _caveats(quality: dict, band: Optional[dict] = None) -> list[str]:
    """Reasons this band is a floor rather than a measurement.

    Every entry is read straight off a counter the pipeline recorded; nothing
    here is inferred. A tile that failed is ground nobody looked at and a frame
    that failed is a look nobody took, so both mean the count is low by an
    unknown amount. The pipeline already records them inside `quality`, but a
    run that reports `done` and a confidently wrong number is the one failure
    this service cannot afford - so the caveat rides next to the count instead
    of only in a block a caller has to know to open. Empty list = clean run.
    """
    out: list[str] = []

    tiles_failed = quality.get("tiles_failed") or 0
    if tiles_failed:
        out.append(
            f"{tiles_failed} tile(s) failed to run - animals in them were never "
            "looked at, so the count is a floor"
        )

    # `detect` distinguishes these because they mean different things to whoever
    # has to defend the number: a crash, a frame that lost tiles, and a frame the
    # detector collapsed on are not the same evidence problem.
    for key, why in (
        ("frames_failed", "failed outright"),
        ("frames_incomplete", "lost tiles and were not searched in full"),
        ("frames_empty", "detected nothing while other frames did"),
    ):
        dropped = quality.get(key) or []
        if dropped:
            out.append(
                f"{len(dropped)} of {quality.get('frames_sampled')} sampled frame(s) "
                f"{why} and were excluded from the consensus: {dropped}"
            )

    unregistered = quality.get("registration_failed") or []
    if unregistered:
        out.append(
            f"{len(unregistered)} frame(s) could not be registered onto the reference "
            f"frame: {unregistered} - agreement across them is not trustworthy"
        )

    requested = quality.get("min_support_requested")
    used = quality.get("min_support")
    if requested is not None and used is not None and used < requested:
        out.append(
            f"min_support was clamped from {requested} to {used}: only {used} frame(s) "
            "produced detections, so `best` rests on less agreement than was asked for"
        )

    # min_support=1 accepts a detection no other frame corroborated. That is a
    # union over frames, not agreement between them, and it is the LEAST
    # supported number this pipeline can produce - so it must not be handed to a
    # caller as a lead estimate without saying so. `basis` already says
    # `union_N_frames`, but a caller reading only the count and the caveats
    # would never see it.
    frames_used = len(quality.get("frames_used") or [])
    if used == 1 and frames_used > 1:
        out.append(
            f"min_support was 1: `best` counts every detection from any single one of "
            f"the {frames_used} usable frame(s), with no cross-frame agreement required - "
            "it is the permissive end of the band, not a consensus"
        )

    # Last line of defence. A run whose lead number sits outside its own bounds
    # is a service defect, and the one thing this API must never do is hand that
    # over as a result with nothing attached. This is not supposed to be
    # reachable - `detect` derives all three numbers from one cluster set - but
    # rows predating that fix are still in the database and still served.
    if band:
        low, best, high = band.get("low"), band.get("best"), band.get("high")
        if None not in (low, best, high) and not (low <= best <= high):
            out.append(
                f"band is incoherent: best ({best}) falls outside its own low-high "
                f"range ({low}-{high}). This count is not defensible - treat it as a "
                "service defect rather than a result"
            )

    return out


def _run_result(conn: sqlite3.Connection, run: dict) -> dict:
    """The `result` block of GET /v1/jobs/{id}, exactly as §3 of the plan has it.

    `per_frame` is projected out of `run.quality` rather than stored twice:
    `detect` already builds that ledger, one record per sampled frame with its
    count and whether it registered, which is precisely the per-frame report.
    """
    engine_params = run.get("engine_params") or {}
    quality = run.get("quality") or {}
    count = {
        "best": run.get("count_best"),
        "low": run.get("count_low"),
        "high": run.get("count_high"),
        "basis": run.get("basis"),
    }
    return {
        "run_id": run["id"],
        "count": count,
        # Non-empty means part of the media was never counted, or the band
        # itself cannot be trusted. A caller showing the band without showing
        # these is showing a number it cannot defend.
        "caveats": _caveats(quality, count),
        "per_frame": quality.get("frames") or [],
        "points": db.get_points(conn, run["id"]),
        "quality": quality,
        "engine": {
            "name": run.get("engine"),
            "version": engine_params.get("version"),
            "threshold": engine_params.get("threshold"),
            "tiling": engine_params.get("tiling"),
        },
        "engine_params": engine_params,
        "seconds": run.get("seconds"),
        "verified_count": db.verified_count(conn, run["id"]),
    }


# ------------------------------------------------------------- error text

# Any absolute POSIX path. Server paths are not survey evidence: the workspace
# copy of an upload is named after a uuid, so echoing it tells the operator
# nothing about the file they picked while telling everyone else the account
# name, where the service keeps its media, and where its binaries live.
_ABS_PATH = re.compile(r"/(?:[\w.+@-]+/)+[\w.+@-]+")


def _scrub_paths(text: str, shown_as: Optional[dict] = None) -> str:
    """Rewrite absolute paths into something the operator can act on.

    Known paths become the name the operator actually used; every other path
    collapses to its basename. That keeps the message diagnostic - "ffprobe
    returned non-zero exit status 1" is still the useful half - without
    publishing the filesystem layout with it.
    """
    mapping = shown_as or {}
    return _ABS_PATH.sub(lambda m: mapping.get(m.group(0)) or Path(m.group(0)).name, text)


def _client_error(error: Optional[str]) -> Optional[str]:
    """The operator-facing half of a job failure.

    `job.error` is a full traceback on purpose - it is the record that lets
    somebody say why a sortie died - and it stays intact in the database and in
    the worker log. It is not what to hand a browser: the last block is the
    failure, everything above it is this service's own source tree, and a
    field operator cannot act on a stack. Send the failure, keep the stack.
    """
    if not error:
        return error
    lines = error.rstrip().splitlines()
    # CPython prints one '  File "...", line N, in f' per frame, each followed
    # by an indented echo of the source line. Everything after the final frame
    # is the exception itself, message continuation lines included.
    last_frame = max(
        (i for i, ln in enumerate(lines) if ln.lstrip().startswith('File "')),
        default=-1,
    )
    tail = lines[last_frame + 1:] if last_frame >= 0 else lines
    while tail and tail[0].startswith("    "):
        tail.pop(0)
    return _scrub_paths("\n".join(tail).strip() or error.strip())


def _job_payload(conn: sqlite3.Connection, job: dict) -> dict:
    payload = {
        "job_id": job["id"],
        "media_id": job["media_id"],
        "status": job["status"],
        "progress": job.get("progress") or {},
        "params": job.get("params") or {},
        "error": _client_error(job.get("error")),
        "created_at": job.get("created_at"),
        "finished_at": job.get("finished_at"),
    }
    if job["status"] == "done":
        runs = db.list_runs(conn, job_id=job["id"], limit=1)
        if runs:
            payload["result"] = _run_result(conn, runs[0])
    return payload


def _job_or_404(conn: sqlite3.Connection, job_id: str) -> dict:
    job = db.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


# --------------------------------------------------------------------- routes

@app.get("/healthz")
async def healthz():
    def check() -> tuple[dict, dict]:
        with _conn() as conn:
            jobs = {
                "queued": _scalar(conn, "SELECT COUNT(*) FROM job WHERE status = 'queued'"),
                "running": _scalar(conn, "SELECT COUNT(*) FROM job WHERE status = 'running'"),
            }
        # No write probes: this endpoint is polled by the platform's health
        # check, and a health check that writes to the volume every few seconds
        # is a health check that eventually shows up in an incident.
        return jobs, preflight.summary()

    try:
        jobs, engine = await asyncio.to_thread(check)
    except Exception as exc:  # a broken database is the one thing healthz must catch
        return JSONResponse(
            {"status": "degraded", "database": f"{type(exc).__name__}: {exc}"},
            status_code=503,
        )
    # Reported, not fatal. The process only reaches here because preflight
    # already passed at startup or was explicitly downgraded, and a container
    # that is serving past runs on purpose should not be killed by its own
    # health check - but "why is every job failing" has to be answerable from
    # outside the box, not only from a startup log that has scrolled away.
    return {
        "status": "ok" if engine["ok"] else "degraded",
        "database": "ok",
        "workspace": str(WORKSPACE),
        "ffmpeg": engine["ffmpeg"],
        "engine": engine,
        "jobs": jobs,
    }


@app.post("/v1/media", status_code=201)
async def upload_media(
    file: UploadFile = File(...),
    sidecar: Optional[UploadFile] = File(None),
    survey_id: Optional[str] = Form(None),
    site_id: Optional[str] = Form(None),
    captured_at: Optional[str] = Form(None),
    altitude_m: Optional[str] = Form(None),
    # What makes GSD trustworthy: an explicit value, or altitude plus the whole
    # of the camera's geometry. `sensor_width_px` fixes only the pixel-count
    # term; `sensor_width_mm` and `focal_length_mm` are the optics, and without
    # them the conversion falls back to a DJI 1-inch airframe. That fallback is
    # a guess about someone else's camera, so it is offered but never reported
    # as measured - see `gsd_source` below.
    gsd_cm_px: Optional[str] = Form(None),
    sensor_width_px: Optional[str] = Form(None),
    sensor_width_mm: Optional[str] = Form(None),
    focal_length_mm: Optional[str] = Form(None),
    tide_state: Optional[str] = Form(None),
    sea_ice_pct: Optional[str] = Form(None),
    operator: Optional[str] = Form(None),
    notes: Optional[str] = Form(None),
):
    """Ingest one piece of media plus the metadata that makes it evidence.

    Order matters. The file is probed and the sidecar parsed before anything is
    written, because frame width plus altitude is GSD, and GSD is what the
    survey row has to carry. Doing it the other way round would mean an
    update-after-insert on every upload.
    """
    suffix = Path(file.filename or "upload").suffix.lower()
    kind = _kind_for(suffix)

    upload_dir = WORKSPACE / uuid.uuid4().hex[:12]
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = upload_dir / f"source{suffix}"
    size = await asyncio.to_thread(_save, file.file, dest)

    # The workspace copy is provisional until a media row points at it.
    # Every exit below this line but the last is a rejection - an unreadable
    # file, a sidecar this service does not parse, a survey that does not
    # exist - and each one used to leave the uploaded bytes in the workspace
    # with no row referencing them and nothing that would ever remove them.
    # Measured here after one afternoon of testing: 11 of 36 workspace
    # directories were orphans of rejected uploads.
    #
    # BaseException rather than Exception: a client that hangs up mid-upload
    # raises CancelledError, which is not an Exception and leaks identically.
    try:
        try:
            probed = await asyncio.to_thread(_probe, dest, kind)
        except frames_mod.FFmpegMissing as exc:
            raise HTTPException(500, str(exc)) from exc
        except Exception as exc:
            # The probe ran against the workspace copy, so the decoder's complaint
            # names a uuid path the operator has never seen. Point it back at the
            # file they actually chose.
            raise HTTPException(
                400,
                "could not read media: "
                + _scrub_paths(
                    f"{type(exc).__name__}: {exc}",
                    {str(dest): file.filename or dest.name},
                ),
            ) from exc

        track: list[dict] = []
        if sidecar is not None and sidecar.filename:
            side_suffix = Path(sidecar.filename).suffix.lower()
            if side_suffix not in SIDECAR_EXT:
                raise HTTPException(
                    400, f"unsupported sidecar '{side_suffix or '?'}' - use .srt or .json"
                )
            side_path = upload_dir / f"sidecar{side_suffix}"
            await asyncio.to_thread(_save, sidecar.file, side_path)
            track = await asyncio.to_thread(_parse_sidecar, side_path, side_suffix.lstrip("."))

        # The telemetry knows the altitude and the wall clock better than a form
        # does, so it fills in whatever the operator left blank.
        altitude = _as_float(altitude_m, "altitude_m") or _median_alt(track)
        when = _clean(captured_at) or next(
            (p["timestamp"] for p in track if p.get("timestamp")), None
        )
        # GSD, and how much to trust it.
        #
        # gsd_from_altitude divides by the camera's NATIVE pixel width. Hand it the
        # width of a crop, a screenshot or a downscaled frame and it silently
        # returns a value several times too coarse - which then picks the wrong tile
        # size. That is exactly what happened on the first real upload: a 1698px
        # screenshot at 120m reported 10.6 cm/px instead of ~3.1, and auto-tiling
        # chose 120px where 400px was measured correct.
        #
        # So the source is recorded alongside the number. An assumed value is still
        # offered (most uploads really are native frames) but it is never passed off
        # as measured, and callers can see when to override.
        #
        # The pixel width is only half the conversion. gsd = sensor_mm * alt /
        # (focal_mm * width_px), and sensor_mm/focal_mm default to a DJI 1-inch
        # airframe (13.2 / 8.8). Supplying `sensor_width_px` alone used to be
        # recorded as `sensor_width`, which read as "the camera's real geometry was
        # used" while two of the three optical terms were still someone else's
        # camera - a ~4% FOV error on, say, a 6.17mm/4.3mm sensor, silently, in a
        # number that drives both tiling and every projected lat/lng. Only a run
        # where the caller supplied the optics gets to be called measured.
        explicit_gsd = _as_float(gsd_cm_px, "gsd_cm_px")
        sensor_px = _as_float(sensor_width_px, "sensor_width_px")
        sensor_mm = _as_float(sensor_width_mm, "sensor_width_mm")
        focal_mm = _as_float(focal_length_mm, "focal_length_mm")
        for name, value in (("sensor_width_mm", sensor_mm), ("focal_length_mm", focal_mm)):
            if value is not None and value <= 0:
                raise HTTPException(400, f"{name} must be greater than 0, got {value}")
        optics = {}
        if sensor_mm and focal_mm:
            optics = {"sensor_width_mm": sensor_mm, "focal_mm": focal_mm}

        width_px = int(sensor_px) if sensor_px else probed["width"]
        if explicit_gsd:
            gsd, gsd_source = explicit_gsd, "explicit"
        elif altitude:
            gsd = geo.gsd_for_media(altitude, width_px, **optics)
            # Two independent assumptions, and the label names whichever is still
            # in play: the pixel width (is this an uncropped native frame?) and the
            # optics (is this really a 1-inch DJI?).
            if optics and sensor_px:
                gsd_source = "optics"
            elif optics:
                gsd_source = "assumed_native_width"
            elif sensor_px:
                gsd_source = "assumed_optics"
            else:
                gsd_source = "assumed_native_width_and_optics"
        else:
            gsd, gsd_source = 0.0, "unknown"

        def persist() -> tuple[dict, dict, int]:
            with _conn() as conn:
                if survey_id:
                    survey = db.get_survey(conn, survey_id)
                    if survey is None:
                        raise HTTPException(404, f"survey {survey_id} not found")
                else:
                    survey = db.create_survey(
                        conn,
                        site_id=_clean(site_id),
                        captured_at=when,
                        altitude_m=altitude,
                        gsd_cm_px=gsd or None,
                        gsd_source=gsd_source,
                        tide_state=_clean(tide_state),
                        sea_ice_pct=_as_float(sea_ice_pct, "sea_ice_pct"),
                        operator=_clean(operator),
                        notes=_clean(notes),
                    )
                media = db.create_media(
                    conn,
                    path=str(dest),
                    kind=kind,
                    survey_id=survey["id"],
                    filename=file.filename,
                    width=probed["width"],
                    height=probed["height"],
                    duration_s=probed["duration_s"],
                    size_bytes=size,
                )
                stored = db.insert_track_points(conn, media["id"], track) if track else 0
                return survey, media, stored

        survey, media, stored = await asyncio.to_thread(persist)

        payload = _media_payload(media, survey)
        payload["fps"] = probed.get("fps")
        payload["track_points"] = stored
        payload["survey"] = survey
        return payload
    except BaseException:
        await asyncio.to_thread(shutil.rmtree, upload_dir, ignore_errors=True)
        raise


@app.get("/v1/media/{media_id}")
async def get_media(media_id: str):
    def load() -> dict:
        with _conn() as conn:
            media = _media_or_404(conn, media_id)
            survey = (
                db.get_survey(conn, media["survey_id"]) if media.get("survey_id") else None
            )
            payload = _media_payload(media, survey)
            payload["survey"] = survey
            payload["track_points"] = _scalar(
                conn, "SELECT COUNT(*) FROM track_point WHERE media_id = ?", (media_id,)
            )
            payload["runs"] = db.list_runs(conn, media_id=media_id)
            return payload

    return await asyncio.to_thread(load)


@app.get("/v1/media/{media_id}/track")
async def get_media_track(media_id: str):
    """The flight track, for redrawing a sortie's path after a reload.

    The points were always stored (they are what georeferences a count);
    until the platform learned to rehydrate its map from the service, nothing
    outside a worker ever needed to read them back.
    """
    def load() -> dict:
        with _conn() as conn:
            _media_or_404(conn, media_id)
            points = db.get_track(conn, media_id)
        return {
            "media_id": media_id,
            "points": [
                {"t": p.get("t"), "lat": p.get("lat"), "lng": p.get("lng"),
                 "alt": p.get("alt")}
                for p in points
            ],
        }

    return await asyncio.to_thread(load)


def _media_ref(body: dict) -> tuple[str, dict]:
    """Resolve §3's `media` block to an id this service already holds.

    The plan describes media by `url`, because it was written against an object
    store. Ingest here is `POST /v1/media` (multipart), which probes the file -
    and frame width is what turns altitude into GSD, so a record this service
    never opened could not carry a trustworthy scale anyway. A caller coding to
    the plan therefore has to hear where the file actually goes, instead of the
    old bare "media_id is required" for a body that plainly identified media.
    """
    media = body.get("media")
    if media is not None and not isinstance(media, dict):
        raise HTTPException(400, f"media must be an object, got {type(media).__name__}")
    media = media or {}
    _reject_unknown(media, _MEDIA_REF_KEYS, "media")

    media_id = (
        _clean(body.get("media_id"), "media_id")
        or _clean(media.get("media_id"), "media.media_id")
        or _clean(media.get("id"), "media.id")
    )
    if media_id:
        return media_id, media
    if media.get("url"):
        raise HTTPException(
            400,
            "media.url ingest is not implemented: upload the file to "
            "POST /v1/media (multipart) and pass the media_id it returns. That "
            "route probes the file, and its native pixel width is what makes "
            "GSD - and therefore the tile size and the count - trustworthy",
        )
    raise HTTPException(400, "media_id is required - upload with POST /v1/media first")


def _check_media_claims(media: dict, claimed: dict) -> None:
    """A caller's idea of the media, checked against the file we actually hold.

    §3 lets the request restate `kind`/`width`/`height`. Restating them is only
    worth anything if a disagreement stops the job: a client that believes it is
    counting a 1698px frame while the stored file is 720px has a GSD several
    times off, which is exactly how the wrong tile size gets chosen.
    """
    for field in ("kind", "width", "height"):
        if claimed.get(field) is None:
            continue
        want: Any = (
            _clean(claimed[field], f"media.{field}")
            if field == "kind"
            else _whole(claimed[field], f"media.{field}")
        )
        got = media.get(field)
        if got is not None and want != got:
            raise HTTPException(
                400,
                f"media.{field} is {want!r} but media {media['id']} is {got!r} - "
                "refusing to count media the caller has mistaken for another",
            )


def _survey_patch(raw: Any) -> dict:
    """§3's `survey` block, validated into an update for the media's survey row.

    This block used to be accepted and thrown away. That is the worst way to
    handle it: `gsd_cm_px` picks the tile size and the tile size decides the
    count (§5), so a caller sending the plan's own example got a 202 and a
    number computed at a different scale than the one it supplied.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise HTTPException(400, f"survey must be an object, got {type(raw).__name__}")
    _reject_unknown(raw, _SURVEY_KEYS, "survey")

    patch: dict = {}
    for key in ("site_id", "captured_at", "tide_state", "operator", "notes"):
        if key in raw:
            patch[key] = _clean(raw[key], f"survey.{key}")
    for key in ("altitude_m", "gsd_cm_px", "sea_ice_pct"):
        if raw.get(key) is not None:
            patch[key] = _number(raw[key], f"survey.{key}")

    if patch.get("gsd_cm_px") is not None:
        if patch["gsd_cm_px"] <= 0:
            raise HTTPException(400, "survey.gsd_cm_px must be greater than 0")
        # Provenance travels with the number. An operator who typed a GSD is a
        # different kind of evidence from one derived off an assumed sensor
        # width, and `_media_payload` reports which it was.
        patch["gsd_source"] = "explicit"
    return patch


@app.post("/v1/jobs", status_code=202)
async def create_job(body: dict):
    """Enqueue a count. §3 of the plan is the request shape.

    Everything the body carries is either honoured or refused. Nothing is
    accepted and ignored, because a silently dropped field is a count the
    caller cannot reproduce and did not ask for.
    """
    body = body or {}
    _reject_unknown(body, _JOB_BODY_KEYS, "body")

    media_id, declared = _media_ref(body)
    # Validate here rather than in the worker: a typo'd threshold that only
    # surfaces two minutes into a sortie is a bad trade.
    params = _job_params(body.get("params"))
    patch = _survey_patch(body.get("survey"))

    def enqueue() -> tuple[str, Optional[dict]]:
        with _conn() as conn:
            media = _media_or_404(conn, media_id)
            _check_media_claims(media, declared)

            survey = None
            if patch:
                if not media.get("survey_id"):
                    raise HTTPException(
                        409,
                        f"media {media_id} has no survey row, so there is nowhere "
                        "to record the survey block",
                    )
                site_id = patch.get("site_id")
                if site_id and db.get_site(conn, site_id) is None:
                    raise HTTPException(
                        404,
                        f"site {site_id!r} not found - create it with POST /v1/sites "
                        "and use the id it returns",
                    )
                survey = db.update_survey(conn, media["survey_id"], **patch)

            job_id = db.create_job(conn, media_id, params.as_dict())
            # §3 promises `progress: {frames_done, frames_total}` from the
            # first poll, and a queued job used to answer `{}`. One still is one
            # look, so its total is known here; a video's is not known until
            # frames are extracted, and null says that rather than claiming 0.
            db.update_job(conn, job_id, progress={
                "stage": "queued",
                "frames_done": 0,
                "frames_total": 1 if media["kind"] == "image" else None,
            })
            return job_id, survey

    job_id, survey = await asyncio.to_thread(enqueue)
    return {
        "job_id": job_id,
        "status": "queued",
        "media_id": media_id,
        # Echoed so the caller can see the survey block took effect rather than
        # having to trust that it did.
        "survey": survey,
        "params": params.as_dict(),
    }


@app.get("/v1/jobs/{job_id}")
async def get_job(job_id: str):
    def load() -> dict:
        with _conn() as conn:
            return _job_payload(conn, _job_or_404(conn, job_id))

    return await asyncio.to_thread(load)


@app.get("/v1/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request):
    """Server-sent events for one job: progress*, then done or failed.

    Polling the job row beats a pub/sub channel here. The worker is a separate
    process and SQLite has no LISTEN; a half-second read of one indexed row
    costs nothing next to the inference it is reporting on.
    """

    def snapshot() -> Optional[dict]:
        with _conn() as conn:
            return db.get_job(conn, job_id)

    def finished(job: dict) -> dict:
        with _conn() as conn:
            return _job_payload(conn, job)

    if await asyncio.to_thread(snapshot) is None:
        raise HTTPException(404, "job not found")

    async def stream():
        last: Optional[tuple] = None
        quiet = 0.0
        while True:
            if await request.is_disconnected():
                return
            job = await asyncio.to_thread(snapshot)
            if job is None:
                yield _sse("failed", {"job_id": job_id, "error": "job disappeared"})
                return

            state = (job["status"], json.dumps(job.get("progress"), sort_keys=True, default=str))
            if state != last:
                last, quiet = state, 0.0
                if job["status"] == "done":
                    yield _sse("done", await asyncio.to_thread(finished, job))
                    return
                if job["status"] in ("failed", "cancelled"):
                    yield _sse(
                        "failed",
                        {
                            "job_id": job_id,
                            "status": job["status"],
                            "error": _client_error(job.get("error")),
                        },
                    )
                    return
                yield _sse(
                    "progress",
                    {
                        "job_id": job_id,
                        "status": job["status"],
                        "progress": job.get("progress") or {},
                    },
                )
            else:
                quiet += EVENT_POLL_S
                if quiet >= EVENT_HEARTBEAT_S:
                    quiet = 0.0
                    yield ": keepalive\n\n"
            await asyncio.sleep(EVENT_POLL_S)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/v1/runs/{run_id}/points")
async def run_points(run_id: str, status: Optional[str] = None):
    if status is not None and status not in db.POINT_STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(db.POINT_STATUSES)}")

    def load() -> dict:
        with _conn() as conn:
            run = db.get_run(conn, run_id)
            if run is None:
                raise HTTPException(404, "run not found")
            breakdown = {
                row["status"]: row["n"]
                for row in conn.execute(
                    "SELECT status, COUNT(*) AS n FROM point WHERE run_id = ? GROUP BY status",
                    (run_id,),
                )
            }
            return {
                "run_id": run_id,
                "media_id": run.get("media_id"),
                "status": status,
                "points": db.get_points(conn, run_id, status),
                "counts": {s: breakdown.get(s, 0) for s in db.POINT_STATUSES},
                "verified_count": db.verified_count(conn, run_id),
            }

    return await asyncio.to_thread(load)


@app.patch("/v1/runs/{run_id}/points")
async def edit_points(run_id: str, body: dict):
    """Operator correction. Appends to `edit`; never destroys a detection.

    Who changed a count and when is survey evidence, and rejections are the only
    recall data this system will ever have (§7: there is no ground truth
    anywhere in this work), so `point.status` is a view of the log, not a
    replacement for it.
    """
    body = body or {}
    op = body.get("op")
    if op not in db.EDIT_OPS:
        raise HTTPException(400, f"op must be one of {', '.join(db.EDIT_OPS)}")

    point_id = body.get("point_id")
    if point_id is not None:
        try:
            point_id = int(point_id)
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "point_id must be an integer") from exc

    def apply() -> dict:
        with _conn() as conn:
            if db.get_run(conn, run_id) is None:
                raise HTTPException(404, "run not found")
            try:
                edit = db.apply_edit(
                    conn,
                    run_id,
                    op,
                    point_id=point_id,
                    x=_as_float(body.get("x"), "x"),
                    y=_as_float(body.get("y"), "y"),
                    lat=_as_float(body.get("lat"), "lat"),
                    lng=_as_float(body.get("lng"), "lng"),
                    frame_idx=body.get("frame_idx"),
                    operator=_clean(body.get("operator"), "operator"),
                )
            except ValueError as exc:
                # db raises for a missing x/y, a missing point_id, or a point
                # that belongs to another run - all of them caller errors.
                raise HTTPException(400, str(exc)) from exc
            return {
                "run_id": run_id,
                "op": op,
                "point": edit["point"],
                "edit": edit["edit"],
                "verified_count": db.verified_count(conn, run_id),
            }

    return await asyncio.to_thread(apply)


@app.get("/v1/sites")
async def list_sites():
    def load() -> dict:
        with _conn() as conn:
            return {"sites": db.list_sites(conn)}

    return await asyncio.to_thread(load)


@app.post("/v1/sites", status_code=201)
async def create_site(body: dict):
    name = _clean((body or {}).get("name"), "name")
    if not name:
        raise HTTPException(400, "name is required")
    lat = _as_float((body or {}).get("lat"), "lat")
    lng = _as_float((body or {}).get("lng"), "lng")
    region = _clean((body or {}).get("region"), "region")

    def create() -> dict:
        with _conn() as conn:
            return db.create_site(conn, name=name, region=region, lat=lat, lng=lng)

    return await asyncio.to_thread(create)


@app.get("/v1/surveys/{survey_id}")
async def get_survey(survey_id: str):
    def load() -> dict:
        with _conn() as conn:
            survey = db.get_survey(conn, survey_id)
            if survey is None:
                raise HTTPException(404, "survey not found")
            media = db.list_media(conn, survey_id=survey_id)
            runs: list[dict] = []
            for m in media:
                runs.extend(db.list_runs(conn, media_id=m["id"]))
            runs.sort(key=lambda r: (r.get("created_at") or "", r["id"]), reverse=True)
            return {
                **survey,
                "site": db.get_site(conn, survey["site_id"]) if survey.get("site_id") else None,
                "media": [_media_payload(m, survey) for m in media],
                "runs": runs,
            }

    return await asyncio.to_thread(load)


# ---------------------------------------------------------------------- stats

# The most recent run per survey. A survey can carry several pieces of media and
# any of them can be re-run with different params; the newest run is the one
# that represents it.
_LATEST_RUN_CTE = """
WITH ranked AS (
    SELECT sv.id AS survey_id, sv.site_id, sv.captured_at, sv.tide_state,
           sv.sea_ice_pct, sv.gsd_cm_px,
           r.id AS run_id, r.engine, r.basis, r.seconds, r.created_at,
           r.count_low, r.count_best, r.count_high,
           ROW_NUMBER() OVER (
               PARTITION BY sv.id ORDER BY r.created_at DESC, r.id DESC
           ) AS rn
    FROM survey sv
    JOIN media m ON m.survey_id = sv.id
    JOIN run r ON r.media_id = m.id
),
latest AS (SELECT * FROM ranked WHERE rn = 1)
"""


@app.get("/v1/stats")
async def stats():
    """Dashboard aggregates, straight from the tables.

    Empty database, empty arrays. Nothing here is synthesised, sampled or
    smoothed: a counting product that invents a trend line is worse than one
    with no dashboard at all.

    Note what is deliberately absent - a sum of counts per site. The same colony
    counted on four dates is not four times the animals, and adding those
    numbers up is the fastest route to publishing a wrong population figure.
    Sites carry their latest band; the time series carries the rest. Tide state
    rides along with every point on it, because a haul-out count without the
    tide is a number without a unit.
    """

    def load() -> dict:
        with _conn() as conn:
            totals = dict(
                conn.execute(
                    "SELECT (SELECT COUNT(*) FROM site) AS sites,"
                    "       (SELECT COUNT(*) FROM survey) AS surveys,"
                    "       (SELECT COUNT(*) FROM media) AS media,"
                    "       (SELECT COUNT(*) FROM run) AS runs,"
                    "       (SELECT COUNT(*) FROM job WHERE status = 'queued') AS jobs_queued,"
                    "       (SELECT COUNT(*) FROM job WHERE status = 'running') AS jobs_running,"
                    "       (SELECT COUNT(*) FROM job WHERE status = 'failed') AS jobs_failed"
                ).fetchone()
            )

            per_site = [
                dict(r)
                for r in conn.execute(
                    _LATEST_RUN_CTE
                    + """
                    SELECT si.id AS site_id, si.name, si.region, si.lat, si.lng,
                           COUNT(DISTINCT sv.id) AS surveys,
                           COUNT(l.run_id) AS runs,
                           MAX(sv.captured_at) AS last_captured_at
                    FROM site si
                    LEFT JOIN survey sv ON sv.site_id = si.id
                    LEFT JOIN latest l ON l.survey_id = sv.id
                    GROUP BY si.id, si.name, si.region, si.lat, si.lng
                    ORDER BY si.name
                    """
                )
            ]

            newest = {
                r["site_id"]: dict(r)
                for r in conn.execute(
                    _LATEST_RUN_CTE
                    + """
                    , by_site AS (
                        SELECT site_id, survey_id, captured_at, run_id, basis,
                               count_low, count_best, count_high, created_at,
                               ROW_NUMBER() OVER (
                                   PARTITION BY site_id
                                   ORDER BY captured_at DESC, created_at DESC
                               ) AS rn2
                        FROM latest
                        WHERE site_id IS NOT NULL
                    )
                    SELECT * FROM by_site WHERE rn2 = 1
                    """
                )
            }
            for site in per_site:
                n = newest.get(site["site_id"])
                site["latest"] = (
                    None
                    if n is None
                    else {
                        "survey_id": n["survey_id"],
                        "run_id": n["run_id"],
                        "captured_at": n["captured_at"],
                        "low": n["count_low"],
                        "best": n["count_best"],
                        "high": n["count_high"],
                        "basis": n["basis"],
                    }
                )

            over_time = [
                dict(r)
                for r in conn.execute(
                    _LATEST_RUN_CTE
                    + """
                    SELECT l.survey_id, l.site_id, si.name AS site_name, l.captured_at,
                           l.tide_state, l.sea_ice_pct, l.gsd_cm_px, l.run_id, l.basis,
                           l.count_low AS low, l.count_best AS best, l.count_high AS high
                    FROM latest l
                    LEFT JOIN site si ON si.id = l.site_id
                    WHERE l.captured_at IS NOT NULL
                    ORDER BY l.captured_at
                    """
                )
            ]

            latest_runs = [
                dict(r)
                for r in conn.execute(
                    "SELECT r.id AS run_id, r.created_at, r.engine, r.basis, r.seconds,"
                    "       r.count_low AS low, r.count_best AS best, r.count_high AS high,"
                    "       m.id AS media_id, m.filename, m.kind,"
                    "       sv.id AS survey_id, sv.captured_at, sv.tide_state,"
                    "       si.id AS site_id, si.name AS site_name "
                    "FROM run r "
                    "JOIN media m ON m.id = r.media_id "
                    "LEFT JOIN survey sv ON sv.id = m.survey_id "
                    "LEFT JOIN site si ON si.id = sv.site_id "
                    "ORDER BY r.created_at DESC, r.id DESC LIMIT ?",
                    (MAX_LATEST_RUNS,),
                )
            ]

            return {
                "totals": totals,
                "per_site": per_site,
                "over_time": over_time,
                "latest_runs": latest_runs,
            }

    return await asyncio.to_thread(load)


# ------------------------------------------------------------- static serving

@app.get("/media/{media_id}/file")
async def media_file(media_id: str):
    def resolve() -> Path:
        with _conn() as conn:
            media = _media_or_404(conn, media_id)
        target = Path(media["path"]).resolve()
        # The path came out of our own database, but a moved workspace or a
        # hand-edited row must not turn this route into an arbitrary file read.
        if not _inside(WORKSPACE, target) or not target.is_file():
            raise HTTPException(404, "media file is not in the workspace")
        return target

    return FileResponse(await asyncio.to_thread(resolve))


def _frame_file(media_id: str, name: str, job_id: Optional[str]) -> Path:
    """The image behind one `quality.frames[].file`, for one job.

    Sampled frames are named by position, so `frame_00002.jpg` only identifies
    an image once you also say which job sampled it - two runs on the same media
    at different intervals both have a frame 2, and they are different moments
    in the clip. The worker keeps each job's frames in its own directory for
    that reason; the job id in the path is what makes a finished run's evidence
    immutable instead of whatever the most recent run happened to leave behind.

    Runs made before frames were per-job still have theirs in the flat
    directory, so that is tried second. Serving them is not an endorsement of
    the old layout - it is the difference between a historical run rendering and
    a historical run showing broken thumbnails.
    """
    with _conn() as conn:
        media = _media_or_404(conn, media_id)
    root = Path(media["path"]).resolve().parent

    candidates = []
    if job_id:
        candidates.append(root / "jobs" / job_id / "frames")
    candidates.append(root / "frames")

    for frames_dir in candidates:
        target = (frames_dir / name).resolve()
        if not _inside(frames_dir, target) or not _inside(WORKSPACE, target):
            raise HTTPException(404, "not found")
        if target.is_file():
            return target
    raise HTTPException(404, "frame not found")


@app.get("/media/{media_id}/frames/{name}")
async def media_frame(media_id: str, name: str):
    """Legacy shape: no job, so it can only serve the flat directory."""
    if not SAFE_NAME.match(name):
        raise HTTPException(400, "bad frame name")
    return FileResponse(await asyncio.to_thread(_frame_file, media_id, name, None))


@app.get("/media/{media_id}/frames/{job_id}/{name}")
async def media_job_frame(media_id: str, job_id: str, name: str):
    if not SAFE_NAME.match(name) or not SAFE_NAME.match(job_id):
        raise HTTPException(400, "bad frame name")
    return FileResponse(await asyncio.to_thread(_frame_file, media_id, name, job_id))


# ------------------------------------------------------------------ webapp

# Two frontends, one origin, so a deployment stays one process and the field
# box needs no CORS story:
#   /          the SEALv platform - static export of frontend/ (Next.js)
#   /operator  the operator webapp - single-file verify/QA tool
# The platform is a BUILD ARTIFACT (frontend/out); when it is absent - a dev
# checkout that never ran `npm run build` - the root falls back to the
# operator app rather than a 404, because a working tool beats a build lecture.
WEBAPP = Path(__file__).resolve().parent.parent / "webapp"
PLATFORM = Path(__file__).resolve().parent.parent / "frontend" / "out"


@app.get("/operator")
async def operator_index():
    index = WEBAPP / "index.html"
    if not index.is_file():
        raise HTTPException(404, "operator webapp missing")
    return FileResponse(index)


@app.get("/")
async def platform_index():
    index = PLATFORM / "index.html"
    if index.is_file():
        return FileResponse(index)
    fallback = WEBAPP / "index.html"
    if fallback.is_file():
        return FileResponse(fallback)
    raise HTTPException(404, "no frontend built")


# One error envelope, whoever raised it.
#
# `{"error": "<string>"}` used to cover only our own HTTPException. Anything
# Starlette or Pydantic raised went out untouched as `{"detail": ...}`, and for
# a 422 `detail` is an array of objects - so a client doing `d.error || d.detail`
# got an array where it expected a sentence and rendered "[object Object]".
# `error` is now always a string on every path; the structured report stays
# available under `details` for anyone who wants the per-field breakdown.

def _error(message: str, status: int, details: Any = None) -> JSONResponse:
    body: dict[str, Any] = {"error": message}
    if details is not None:
        body["details"] = details
    return JSONResponse(body, status_code=status)


@app.exception_handler(StarletteHTTPException)
async def http_error(_: Request, exc: StarletteHTTPException):
    # FastAPI's HTTPException subclasses Starlette's, so this one handler covers
    # both our own raises and the framework's own 404/405 responses.
    detail = exc.detail
    if isinstance(detail, str):
        return _error(detail, exc.status_code)
    return _error(
        f"HTTP {exc.status_code}", exc.status_code, jsonable_encoder(detail)
    )


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    errors = jsonable_encoder(exc.errors())

    def where(err: dict) -> str:
        # Drop the leading "body"/"query" bucket when there is a field under it,
        # so the summary reads `params.threshold` rather than `body.params...`.
        loc = [str(p) for p in err.get("loc") or []]
        return ".".join(loc[1:] or loc) or "request"

    summary = "; ".join(
        f"{where(e)}: {e.get('msg', 'is invalid')}" for e in errors[:3]
    ) or "request body is invalid"
    if len(errors) > 3:
        summary += f" (+{len(errors) - 3} more)"
    return _error(summary, 422, errors)


# The platform's static assets (/_next/*, /samples/*). Mounted last: declared
# routes always win over a mount, so /v1, /healthz and /operator stay routes
# while every other path resolves against the export - including client-side
# 404s, which Next ships as its own page.
from fastapi.staticfiles import StaticFiles  # noqa: E402

if PLATFORM.is_dir():
    app.mount("/", StaticFiles(directory=str(PLATFORM), html=True), name="platform")
