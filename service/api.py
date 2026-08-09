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
import hashlib
import json
import math
import re
import shutil
import sqlite3
import uuid
from contextlib import asynccontextmanager, contextmanager
from dataclasses import fields as dc_fields
from datetime import datetime, timezone
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
# `lat`/`lng`/`location_source` are additive: a sortie whose position came from
# a dropped pin rather than a track needs somewhere to say both the coordinate
# and which of those two it was.
_SURVEY_KEYS = {
    "site_id", "captured_at", "altitude_m", "gsd_cm_px",
    "tide_state", "sea_ice_pct", "operator", "notes",
    "lat", "lng", "location_source",
}
# Where a survey's coordinate came from. Not a free-text column: the UI renders
# a pin differently from a GPS fix, and an unknown fourth value would render as
# whichever branch happened to be the else.
_LOCATION_SOURCES = ("telemetry", "pinned", "manual")

# Length caps on operator-entered text. These are storage limits, not editorial
# ones - 4000 characters is several screens of field notes, and the point is
# that a runaway paste cannot turn one survey row into a megabyte the archive
# has to carry through every listing. Kept in one place because the client
# enforces the same numbers (frontend/lib/api.ts) and a disagreement means a
# note that types fine and then 400s on save.
NOTES_MAX = 4000
OPERATOR_MAX = 120
REASON_MAX = 500

# SHA-256, lowercase hex. Anything else in the path is a caller error, not a
# lookup that happens to miss - and saying so beats an empty list that reads
# like "this file is new".
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")

# What a duplicate-hash lookup answers with: the media, and the newest count
# anybody got out of it. `latest_runs`-shaped on purpose - the client renders
# "you already counted this: 300 on 6 Aug" from one row.
_HASH_MATCH_SQL = """
SELECT m.id AS media_id, m.survey_id, m.filename, m.kind, m.created_at,
       r.id AS run_id, r.count_low AS low, r.count_best AS best,
       r.count_high AS high, r.basis
  FROM media m
  LEFT JOIN run r ON r.id = (SELECT id FROM run WHERE media_id = m.id
                              ORDER BY created_at DESC, id DESC LIMIT 1)
 WHERE m.content_hash = ?
"""
MAX_HASH_MATCHES = 10

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
# The ceiling a caller may page up to in one /v1/stats request. The default
# stays 20 so every existing caller sees exactly what it saw before; a client
# that wants the rest asks for it, page by page, and is told the true total.
MAX_LATEST_RUNS_CEILING = 200

# Columns a caller may ask /v1/runs/{id}/points to project. Column names cannot
# be parameterised in SQL, so nothing outside this tuple ever reaches a query.
# Kept in the order of the table so a projected row reads like a row.
POINT_FIELDS = ("id", "run_id", "frame_idx", "x", "y", "lat", "lng", "score", "support", "status")

# How many points one PATCH may carry. A whole run is ~2000 detections, so this
# is "the largest honest bulk verdict", not a throttle: past it the caller is
# almost certainly looping over the archive rather than reviewing a sortie.
MAX_BATCH_POINT_EDITS = 5000


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


def _save(src: BinaryIO, dest: Path) -> tuple[int, str]:
    """Stream an upload to disk, returning (bytes, sha256-hex).

    The digest is taken from the same buffers on the way past rather than by
    re-reading the file afterwards. A sortie is gigabytes; reading it twice
    would double the ingest's disk time for a value that was in memory a moment
    earlier - and on the field box, disk time is the ingest.
    """
    digest = hashlib.sha256()
    size = 0
    with dest.open("wb") as fh:
        while chunk := src.read(1 << 20):
            digest.update(chunk)
            fh.write(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def _hash_matches(
    conn: sqlite3.Connection,
    sha256: str,
    limit: int = MAX_HASH_MATCHES,
    exclude_media_id: Optional[str] = None,
) -> list[dict]:
    """Media already in the archive with these exact bytes, newest first."""
    sql, args = _HASH_MATCH_SQL, [sha256]
    if exclude_media_id:
        sql += " AND m.id != ?"
        args.append(exclude_media_id)
    sql += " ORDER BY m.created_at DESC, m.id DESC LIMIT ?"
    args.append(limit)
    return [dict(r) for r in conn.execute(sql, tuple(args))]


def _iso_or_400(value: Any, field: str) -> Optional[str]:
    """An ISO8601 instant, checked - and refused if it has not happened yet.

    A survey date is the axis every trend line in this product is drawn on, so
    a typo'd year does not produce a wrong-looking row, it produces a chart with
    a point in 2099 and a season that appears to span 73 years. A trailing `Z`
    is accepted because that is what telemetry and every JS `toISOString()`
    emit; `fromisoformat` handles it from 3.11, and the replace keeps this
    honest on older builds too.

    The stored value is the caller's own string, not a re-formatted one: this
    validates a date, it does not own its representation.
    """
    text = _clean(value, field)
    if text is None:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(
            400, f"{field} must be an ISO8601 date or datetime, got {text!r}"
        ) from exc
    # A naive stamp is read as UTC, which is what every writer in this service
    # produces. Comparing naive against aware would raise instead of judging.
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if parsed > datetime.now(timezone.utc):
        raise HTTPException(
            400,
            f"{field} is in the future ({text}) - a survey cannot have been "
            "flown or counted on a date that has not arrived",
        )
    return text


def _capped(value: Any, field: str, limit: int) -> Optional[str]:
    """Trimmed text, refused past `limit` characters.

    Truncating instead would be worse than refusing: field notes silently cut
    off mid-sentence still read as complete, and the operator has no way to know
    the archive is holding less than they wrote.
    """
    text = _clean(value, field)
    if text is not None and len(text) > limit:
        raise HTTPException(400, f"{field} may not exceed {limit} characters")
    return text


def _latlng(patch: dict, prefix: str = "") -> None:
    """Range-check a coordinate pair in place. A lat of 450 is not a place."""
    for key, span in (("lat", 90.0), ("lng", 180.0)):
        value = patch.get(key)
        if value is not None and not -span <= value <= span:
            raise HTTPException(
                400, f"{prefix}{key} must be between {-span:g} and {span:g}, got {value}"
            )


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
        # NULL on media ingested before the digest was recorded. Null is not
        # "unique" - a caller must not report an unhashed upload as first-seen.
        "content_hash": media.get("content_hash"),
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

    if quality.get("tile_default_unknown_scale"):
        out.append(
            f"scale unknown - counted with default {quality.get('tile_px')}px tiles "
            "rather than a size derived from a measured GSD; set the flight altitude "
            "and re-count to tile to the animals' true pixel size"
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


_LEDGER_MISSING = (
    "this run's quality ledger is missing or unreadable, so the completeness "
    "checks never ran - the absence of caveats here is unknown, not clean"
)


def _quality_ledger(raw: Any) -> Optional[dict]:
    """The run's quality ledger as a dict, or None when it was never written or
    cannot be parsed. NULL and `{}` are different claims and must stay apart:
    an empty ledger is a run whose counters all came back clean, a missing one
    is a run nobody measured. Raw SQL hands the column over as text, db.py
    hands it over already parsed, so both shapes are accepted here.
    """
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _caveats_for(quality: Optional[dict], band: Optional[dict]) -> list[str]:
    """`_caveats`, plus the one caveat a missing ledger is itself.

    Every endpoint that hands a band to a caller goes through here, so a fresh
    run and the same run rebuilt from /v1/stats after a reload can never make
    two different claims about the same numbers.
    """
    out = _caveats(quality or {}, band)
    if quality is None:
        out.append(_LEDGER_MISSING)
    return out


def _frames_counted(quality: Optional[dict], kind: Optional[str]) -> Optional[int]:
    """How many frames the count was actually assembled from.

    A still is one look, so one frame. A video's ledger lists the frames that
    survived into the consensus. None means the run never said - and a sortie
    whose frame count is unknown has an unknown surveyed area, not a
    one-frame one.
    """
    if kind == "image":
        return 1
    used = (quality or {}).get("frames_used")
    if isinstance(used, list):
        return len(used)
    if isinstance(used, int) and used >= 1:
        return used
    return None


def _run_result(conn: sqlite3.Connection, run: dict) -> dict:
    """The `result` block of GET /v1/jobs/{id}, exactly as §3 of the plan has it.

    `per_frame` is projected out of `run.quality` rather than stored twice:
    `detect` already builds that ledger, one record per sampled frame with its
    count and whether it registered, which is precisely the per-frame report.
    """
    engine_params = run.get("engine_params") or {}
    quality = _quality_ledger(run.get("quality"))
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
        "caveats": _caveats_for(quality, count),
        "per_frame": (quality or {}).get("frames") or [],
        "points": db.get_points(conn, run["id"]),
        "quality": quality or {},
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
    # Where this sortie happened, and how that was arrived at. A pin dropped on
    # the map is the ONLY position a photo without telemetry will ever have, and
    # until these three were declared here FastAPI dropped them silently: the
    # client posted `location_source=pinned`, the archive stored NULL, and after
    # a reload every uploaded sortie reported that its provenance was never
    # recorded. An unknown form field is not an error in multipart, which is
    # exactly why this had to be found by reading the row back rather than by a
    # failing request.
    lat: Optional[str] = Form(None),
    lng: Optional[str] = Form(None),
    location_source: Optional[str] = Form(None),
    # Provenance of a quick count: the clip a still was cut out of, and the
    # second it was taken at. Stored so that "one frame of a video" survives a
    # reload - the trade it makes (no cross-frame band) is precisely the kind of
    # thing a report has to state, and a free-text note the operator can edit is
    # not a place to keep it.
    from_video: Optional[str] = Form(None),
    at_seconds: Optional[str] = Form(None),
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
    size, content_hash = await asyncio.to_thread(_save, file.file, dest)

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

        # Position and its provenance, held to the same rules as the PATCH
        # route: a lat of 450 is not a place, and `location_source` is a closed
        # set because the UI draws a GPS fix differently from a dropped pin and
        # an unrecognised fourth value would render as whichever branch happened
        # to be the else.
        pin = {"lat": _as_float(lat, "lat"), "lng": _as_float(lng, "lng")}
        _latlng(pin)
        loc_source = _clean(location_source, "location_source")
        if loc_source is not None and loc_source not in _LOCATION_SOURCES:
            raise HTTPException(
                400,
                f"location_source must be one of {', '.join(_LOCATION_SOURCES)}, "
                f"got {loc_source!r}",
            )
        clip = _capped(from_video, "from_video", OPERATOR_MAX)
        frame_at = _as_float(at_seconds, "at_seconds")
        if frame_at is not None and frame_at < 0:
            raise HTTPException(400, f"at_seconds cannot be negative, got {frame_at}")

        def persist() -> tuple[dict, dict, int, Optional[dict]]:
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
                        # Capped here as well as on PATCH. The client caps too,
                        # but the boundary that STORES the text is the one that
                        # has to hold the limit - a buggy or hostile caller must
                        # not be able to turn one survey row into a megabyte the
                        # archive carries through every listing.
                        operator=_capped(operator, "operator", OPERATOR_MAX),
                        notes=_capped(notes, "notes", NOTES_MAX),
                        lat=pin["lat"],
                        lng=pin["lng"],
                        location_source=loc_source,
                        from_video=clip,
                        at_seconds=frame_at,
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
                    content_hash=content_hash,
                )
                stored = db.insert_track_points(conn, media["id"], track) if track else 0
                # Reported, never enforced. The same footage uploaded twice is
                # usually a mistake that would add a whole colony to a season's
                # total - and occasionally a deliberate re-count with different
                # params. This service cannot tell those apart, so it says what
                # it already holds and leaves the decision where it belongs.
                # Rejecting here would mean an operator whose upload was
                # interrupted could never retry it.
                prior = _hash_matches(conn, content_hash, 1, exclude_media_id=media["id"])
                return survey, media, stored, (prior[0] if prior else None)

        survey, media, stored, duplicate_of = await asyncio.to_thread(persist)

        payload = _media_payload(media, survey)
        payload["fps"] = probed.get("fps")
        payload["track_points"] = stored
        payload["survey"] = survey
        payload["duplicate_of"] = duplicate_of
        return payload
    except BaseException:
        await asyncio.to_thread(shutil.rmtree, upload_dir, ignore_errors=True)
        raise


@app.get("/v1/media/by-hash/{sha256}")
async def media_by_hash(sha256: str):
    """Has this file been counted before? The pre-upload half of `duplicate_of`.

    A client that can hash locally asks first and never sends the gigabytes at
    all. One that cannot - `crypto.subtle` is unavailable on plain http, which
    is exactly the LAN a boat runs on - uploads and reads `duplicate_of` off the
    response instead. Both answer the same question from the same column.

    Two path segments, so this can never be mistaken for `/v1/media/{media_id}`.
    """
    key = (sha256 or "").strip().lower()
    if not SHA256_HEX.match(key):
        raise HTTPException(400, "hash must be a 64-character hex SHA-256 digest")

    def load() -> dict:
        with _conn() as conn:
            return {"matches": _hash_matches(conn, key)}

    return await asyncio.to_thread(load)


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
    for key in ("site_id", "captured_at", "tide_state", "operator", "notes",
                "location_source"):
        if key in raw:
            patch[key] = _clean(raw[key], f"survey.{key}")
    for key in ("altitude_m", "gsd_cm_px", "sea_ice_pct", "lat", "lng"):
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


def _checked_survey_patch(raw: Any) -> dict:
    """`_survey_patch` plus the checks a metadata correction has to survive.

    Deliberately NOT folded into `_survey_patch` itself. That function is also
    the `survey` block of `POST /v1/jobs`, which the operator webapp and every
    existing integration already post to; adding refusals there would turn
    bodies that queue a count today into 400s tomorrow. A correction typed into
    an inspector is a different act with a different risk - it rewrites what a
    finished survey claims - so it is the one that gets checked hard.
    """
    patch = _survey_patch(raw)
    if not patch:
        raise HTTPException(
            400,
            "nothing to change - send at least one of: "
            + ", ".join(sorted(_SURVEY_KEYS)),
        )

    for key, limit in (("notes", NOTES_MAX), ("operator", OPERATOR_MAX)):
        if patch.get(key) is not None:
            _capped(patch[key], f"survey.{key}", limit)

    if patch.get("captured_at") is not None:
        _iso_or_400(patch["captured_at"], "survey.captured_at")

    source = patch.get("location_source")
    if source is not None and source not in _LOCATION_SOURCES:
        raise HTTPException(
            400,
            f"survey.location_source must be one of {', '.join(_LOCATION_SOURCES)}, "
            f"got {source!r}",
        )

    _latlng(patch, "survey.")
    return patch


def _rescale_for_altitude(conn: sqlite3.Connection, survey_id: str, patch: dict) -> None:
    """A new altitude means a new scale. Derive it, or leave the old one alone.

    The UI's promise when an operator corrects the altitude is that the surveyed
    AREA recomputes and the COUNT does not - area is width x height x GSD^2, and
    GSD comes from altitude. Storing the new altitude without redoing that leaves
    every area on the dashboard computed at the old height while the panel says
    the flight was flown at the new one: the number moves in the sentence and
    not in the arithmetic, which is the exact failure this product exists to
    avoid.

    Two ways out, both honest. If the caller supplied `gsd_cm_px` in the same
    body, that wins - it is measured and this is a guess. If there is no media
    or no recorded frame width, nothing is touched: without a pixel count there
    is no conversion, and inventing one would put a fabricated denominator under
    every density figure downstream.

    The label is the same one the upload path would have chosen for the same
    evidence - the PATCH body carries no optics, so the sensor geometry is still
    a DJI 1-inch assumption and the source has to keep saying so.
    """
    altitude = patch.get("altitude_m")
    if altitude is None or patch.get("gsd_cm_px") is not None:
        return
    width = next(
        (m["width"] for m in db.list_media(conn, survey_id=survey_id) if m.get("width")),
        None,
    )
    if not width:
        return
    gsd = geo.gsd_for_media(altitude, int(width))
    if gsd > 0:
        patch["gsd_cm_px"] = gsd
        patch["gsd_source"] = "assumed_native_width_and_optics"


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


MAX_JOB_LIST = 500


@app.get("/v1/jobs")
async def list_jobs(status: Optional[str] = None, limit: int = 200, offset: int = 0):
    """The queue, newest first. What is waiting, what is running, what died.

    `error` goes through `_client_error`, the same as every other job payload:
    `job.error` is a full traceback on purpose and it stays in the database and
    the worker log, but a list of jobs is a screen a field operator reads, and
    a stack trace there is noise that hides the one line they can act on.
    """
    if status is not None and status not in db.JOB_STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(db.JOB_STATUSES)}")
    limit = max(1, min(limit, MAX_JOB_LIST))
    offset = max(0, offset)

    def load() -> dict:
        with _conn() as conn:
            jobs = db.list_jobs(conn, status=status, limit=limit, offset=offset)
            # One lookup for the whole page rather than one per row: a filename
            # is the only thing an operator recognises a job by, and fetching it
            # per job would make the queue screen cost N+1 reads.
            ids = sorted({j["media_id"] for j in jobs if j.get("media_id")})
            names: dict[str, Optional[str]] = {}
            if ids:
                marks = ",".join("?" * len(ids))
                names = {
                    row["id"]: row["filename"]
                    for row in conn.execute(
                        f"SELECT id, filename FROM media WHERE id IN ({marks})", tuple(ids)
                    )
                }
            total_where, total_args = ("WHERE status = ?", (status,)) if status else ("", ())
            total = int(
                _scalar(conn, f"SELECT COUNT(*) FROM job {total_where}", total_args) or 0
            )
            return {
                "jobs": [
                    {
                        "job_id": j["id"],
                        "media_id": j.get("media_id"),
                        "filename": names.get(j.get("media_id")),
                        "status": j["status"],
                        "error": _client_error(j.get("error")),
                        "attempts": j.get("attempts") or 0,
                        "created_at": j.get("created_at"),
                        "finished_at": j.get("finished_at"),
                    }
                    for j in jobs
                ],
                "total": total,
                "limit": limit,
                "offset": offset,
            }

    return await asyncio.to_thread(load)


@app.post("/v1/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    """Drop a job that has not started yet.

    Only `queued`. A running job is inside a subprocess doing inference, and
    this service has no way to interrupt it - marking the row cancelled while
    the worker carried on would produce a run attached to a job that claims it
    never happened, which is worse than not offering cancellation at all.
    Per-job cooperative cancellation is a worker change (wave 2); until then
    the honest answer to "stop it" is that it cannot be stopped yet.
    """
    def apply() -> dict:
        with _conn() as conn:
            job = _job_or_404(conn, job_id)
            if job["status"] == "running":
                raise HTTPException(
                    409,
                    "a count that has already started cannot be stopped yet - it "
                    "is running in a worker process this service cannot interrupt",
                )
            if job["status"] != "queued":
                raise HTTPException(409, f"job {job_id} is already {job['status']}")
            db.update_job(
                conn, job_id, status="cancelled", finished_at=db.utcnow(),
                error="cancelled by the operator before it started",
            )
            return _job_payload(conn, _job_or_404(conn, job_id))

    return await asyncio.to_thread(apply)


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


def _point_projection(fields: Optional[str]) -> Optional[tuple[str, ...]]:
    """Parse `?fields=` into a validated column tuple. None = the whole row.

    Opt-in, because the full row is what every existing caller already gets. A
    sortie is up to ~2000 points and three of the ten columns (`run_id`,
    `frame_idx`, `support`) have no consumer in the platform client, so a client
    that names what it needs stops paying for them on every hydrate.
    """
    if fields is None:
        return None
    wanted = tuple(dict.fromkeys(f.strip() for f in fields.split(",") if f.strip()))
    if not wanted:
        raise HTTPException(400, "fields must name at least one column")
    unknown = [f for f in wanted if f not in POINT_FIELDS]
    if unknown:
        raise HTTPException(
            400, f"unknown point field(s) {', '.join(unknown)}; allowed: {', '.join(POINT_FIELDS)}"
        )
    return wanted


@app.get("/v1/runs/{run_id}")
async def get_run(run_id: str):
    """One run, by its own id — the same `result` block GET /v1/jobs/{id} carries,
    plus the two ids that block deliberately omits because the job route already
    knows them: `media_id` and `job_id`.

    The platform's replay view is why this exists. A hydrated client knows a
    sortie only by `run_id` (off /v1/stats), and for a video run the frame the
    points are pinned to is served at /media/{media_id}/frames/{job_id}/{name}
    with the name recorded in `quality.frames[]` — three values reachable, until
    this route, only by walking every job. The payload is assembled by the same
    `_run_result` the job route uses, so the two can never disagree about what
    a run said.
    """
    def load() -> dict:
        with _conn() as conn:
            run = db.get_run(conn, run_id)
            if run is None:
                raise HTTPException(404, "run not found")
            out = _run_result(conn, run)
            out["media_id"] = run.get("media_id")
            out["job_id"] = run.get("job_id")
            return out

    return await asyncio.to_thread(load)


@app.get("/v1/runs/{run_id}/points")
async def run_points(run_id: str, status: Optional[str] = None, fields: Optional[str] = None):
    if status is not None and status not in db.POINT_STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(db.POINT_STATUSES)}")
    projection = _point_projection(fields)

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
            if projection is None:
                points = db.get_points(conn, run_id, status)
            else:
                # `point` carries no JSON columns, so a projected row needs no
                # decoding pass - plain dicts are the same shape db.get_points
                # would have returned, minus the columns nobody asked for.
                sql = f"SELECT {', '.join(projection)} FROM point WHERE run_id = ?"
                params: tuple = (run_id,)
                if status is not None:
                    sql += " AND status = ?"
                    params = (run_id, status)
                points = [dict(r) for r in conn.execute(sql + " ORDER BY id", params)]
            return {
                "run_id": run_id,
                "media_id": run.get("media_id"),
                "status": status,
                "points": points,
                "counts": {s: breakdown.get(s, 0) for s in db.POINT_STATUSES},
                "verified_count": db.verified_count(conn, run_id),
            }

    return await asyncio.to_thread(load)


def _batch_ids(raw: Any) -> list[int]:
    """Validate `point_ids` before a single row is touched.

    Every id is checked up front so the transaction below is opened knowing it
    can finish: a caller error must never leave half a reviewer's verdict
    written and the other half rejected.
    """
    if not isinstance(raw, (list, tuple)):
        raise HTTPException(400, "point_ids must be a list of integers")
    if not raw:
        raise HTTPException(400, "point_ids must not be empty")
    if len(raw) > MAX_BATCH_POINT_EDITS:
        raise HTTPException(400, f"point_ids may not exceed {MAX_BATCH_POINT_EDITS} entries")
    ids: list[int] = []
    for value in raw:
        if isinstance(value, bool) or not isinstance(value, (int, str)):
            raise HTTPException(400, "point_ids must be a list of integers")
        try:
            ids.append(int(value))
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "point_ids must be a list of integers") from exc
    # A duplicated id is one verdict, not two log entries.
    return list(dict.fromkeys(ids))


def _apply_batch(run_id: str, op: str, raw_ids: Any, operator: Optional[str]) -> dict:
    """One reviewer gesture over many detections: ONE write transaction.

    'Mark 400 selected rows as false positives' used to be 400 PATCHes, each
    opening its own IMMEDIATE transaction on its own connection - 400 chances to
    lose the SQLite writer lock to the worker, and 400 chances for the browser
    to give up halfway and leave the run half-edited. Here the whole gesture
    commits or none of it does.

    The transaction and the remove/reinstate semantics live in
    `db.apply_edits_batch`, next to the single-point `db.apply_edit` they have
    to agree with. This function used to reproduce that branch inline against
    `db._tx` - a private helper - which meant the batch path and the single
    path each had their own idea of what a verdict does to a point, and the
    first edit to one would have silently diverged them.
    """
    ids = _batch_ids(raw_ids)
    if op == "add":
        # 'add' invents a point from x/y; there is nothing for a list of
        # existing ids to mean. Say so rather than silently ignoring them.
        raise HTTPException(400, "point_ids applies to 'remove' and 'reinstate', not 'add'")

    with _conn() as conn:
        if db.get_run(conn, run_id) is None:
            raise HTTPException(404, "run not found")
        try:
            result = db.apply_edits_batch(conn, run_id, op, ids, operator=operator)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"run_id": run_id, "op": op, **result}


@app.patch("/v1/runs/{run_id}/points")
async def edit_points(run_id: str, body: dict):
    """Operator correction. Appends to `edit`; never destroys a detection.

    Who changed a count and when is survey evidence, and rejections are the only
    recall data this system will ever have (§7: there is no ground truth
    anywhere in this work), so `point.status` is a view of the log, not a
    replacement for it.

    `point_id` edits one detection and answers with it. `point_ids` (additive -
    old bodies are untouched) applies one op to many in a single transaction and
    answers `{updated, point_ids, verified_count}`.
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

    point_ids = body.get("point_ids")
    if point_ids is not None:
        return await asyncio.to_thread(
            _apply_batch, run_id, op, point_ids, _clean(body.get("operator"), "operator")
        )

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


MAX_EDIT_LOG = 1000


@app.get("/v1/runs/{run_id}/edits")
async def run_edits(run_id: str, limit: int = 200):
    """The append-only correction log for one run: who ruled on what, and when.

    `point.status` is a view of this log, not a replacement for it. The log is
    what lets somebody defend a published figure a year later - "these 43
    detections were rejected by a.n on 6 August" - and it is also the only
    recall data this project will ever have (§7: there is no ground truth
    anywhere in this work).
    """
    limit = max(1, min(limit, MAX_EDIT_LOG))

    def load() -> dict:
        with _conn() as conn:
            if db.get_run(conn, run_id) is None:
                raise HTTPException(404, "run not found")
            edits = db.list_edits(conn, run_id, limit=limit)
            # The true size of what the window above was cut from. A truncated
            # audit log that does not admit it is truncated is worse than none.
            total = int(
                _scalar(conn, "SELECT COUNT(*) FROM edit WHERE run_id = ?", (run_id,)) or 0
            )
            return {"run_id": run_id, "edits": edits, "total": total}

    return await asyncio.to_thread(load)


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


@app.patch("/v1/sites/{site_id}")
async def patch_site(site_id: str, body: dict):
    """Name a colony, or move its marker.

    A 2km cluster of sorties is a place long before anybody names it, and until
    then the only thing the archive can call it is a coordinate pair. The name
    is what then follows into repeat surveys, the dynamics chart, the PDF and
    every export - so it is stored once, here, rather than retyped per report.
    """
    body = body or {}
    _reject_unknown(body, {"name", "region", "lat", "lng"}, "body")

    patch: dict = {}
    if "name" in body:
        name = _clean(body["name"], "name")
        if not name:
            raise HTTPException(
                400,
                "name may not be empty - a site with a blank name is harder to "
                "read than one still shown by its coordinates",
            )
        patch["name"] = name
    if "region" in body:
        patch["region"] = _clean(body["region"], "region")
    for key in ("lat", "lng"):
        if body.get(key) is not None:
            patch[key] = _number(body[key], key)
    _latlng(patch)
    if not patch:
        raise HTTPException(400, "nothing to change - send name, region, lat or lng")

    def apply() -> dict:
        with _conn() as conn:
            if db.get_site(conn, site_id) is None:
                raise HTTPException(404, f"site {site_id!r} not found")
            return db.update_site(conn, site_id, **patch)

    return await asyncio.to_thread(apply)


@app.post("/v1/observations", status_code=201)
async def create_observation(body: dict):
    """A ground count: somebody stood there and counted.

    This is the one number in the archive no engine produced, and it is stored
    as such - `engine` and `basis` both say 'manual', low = best = high, and
    there is no quality ledger to mine for caveats because nothing was measured
    about it except the count itself. Rendering it as a band of width zero would
    claim a precision nobody offered; every surface reads `basis` and labels it.

    It is a sortie like any other: its own survey row, its own date, its own
    position, and it joins its site's estimate on equal terms. A count from a
    person on the shore is not weaker evidence than a count from a model.
    """
    body = body or {}
    _reject_unknown(
        body,
        {"count", "captured_at", "lat", "lng", "site_id", "operator", "notes", "method"},
        "body",
    )

    if body.get("count") is None:
        raise HTTPException(400, "count is required")
    count = _whole(body["count"], "count")
    if count < 0:
        raise HTTPException(400, "count may not be negative")

    if _clean(body.get("captured_at"), "captured_at") is None:
        raise HTTPException(
            400,
            "captured_at is required - a count with no date cannot go on a "
            "timeline, and a colony's numbers only mean anything in order",
        )
    captured_at = _iso_or_400(body["captured_at"], "captured_at")

    coords = {}
    for key in ("lat", "lng"):
        if body.get(key) is not None:
            coords[key] = _number(body[key], key)
    _latlng(coords)

    site_id = _clean(body.get("site_id"), "site_id")
    operator = _capped(body.get("operator"), "operator", OPERATOR_MAX)
    notes = _capped(body.get("notes"), "notes", NOTES_MAX)
    method = _capped(body.get("method"), "method", OPERATOR_MAX)

    def create() -> dict:
        with _conn() as conn:
            if site_id and db.get_site(conn, site_id) is None:
                raise HTTPException(
                    404,
                    f"site {site_id!r} not found - create it with POST /v1/sites "
                    "and use the id it returns",
                )
            try:
                return db.create_observation(
                    conn,
                    count=count,
                    captured_at=captured_at,
                    lat=coords.get("lat"),
                    lng=coords.get("lng"),
                    site_id=site_id,
                    operator=operator,
                    notes=notes,
                    method=method,
                )
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc

    return await asyncio.to_thread(create)


@app.get("/v1/surveys/{survey_id}")
async def get_survey(survey_id: str):
    def load() -> dict:
        with _conn() as conn:
            survey = db.get_survey(conn, survey_id)
            if survey is None:
                raise HTTPException(404, "survey not found")
            media = db.list_media(conn, survey_id=survey_id)
            # Through `db.list_survey_runs`, which resolves a run's survey the
            # way every other reader does: media.survey_id OR run.survey_id.
            # Walking media alone - what this did - omitted every count with no
            # footage behind it, so a ground count and a manual correction both
            # reported that this survey had no runs at all.
            runs = db.list_survey_runs(conn, survey_id)
            return {
                **survey,
                "site": db.get_site(conn, survey["site_id"]) if survey.get("site_id") else None,
                "media": [_media_payload(m, survey) for m in media],
                "runs": runs,
            }

    return await asyncio.to_thread(load)


@app.patch("/v1/surveys/{survey_id}")
async def patch_survey(survey_id: str, body: dict):
    """Correct a sortie's metadata after the fact.

    Everything here is metadata ABOUT a count, never the count: altitude, tide,
    the flight date, who flew it, what they wrote down. Correcting the altitude
    re-derives the scale (see `_rescale_for_altitude`), which moves the surveyed
    AREA - the number of animals is what the engine found and no edit on this
    route touches it.

    Retirement is not settable here. Withdrawing a sortie from the estimate is a
    different act from fixing a typo in it, it needs a reason, and it has its
    own route - so `retired_at` is not in `_SURVEY_KEYS` and arrives as a 400.
    """
    patch = _checked_survey_patch(body or {})

    def apply() -> dict:
        with _conn() as conn:
            if db.get_survey(conn, survey_id) is None:
                raise HTTPException(404, "survey not found")
            site_id = patch.get("site_id")
            if site_id and db.get_site(conn, site_id) is None:
                raise HTTPException(
                    404,
                    f"site {site_id!r} not found - create it with POST /v1/sites "
                    "and use the id it returns",
                )
            _rescale_for_altitude(conn, survey_id, patch)
            return db.update_survey(conn, survey_id, **patch)

    return await asyncio.to_thread(apply)


@app.post("/v1/surveys/{survey_id}/retire")
async def retire_survey(survey_id: str, body: dict):
    """Withdraw a sortie from the estimate without deleting a thing.

    Wrong site, a duplicate upload, footage that turned out to be of the boat -
    all real, and none of them a reason to destroy evidence. A retired survey
    keeps every row it had; it stops being counted by default and comes back
    with `?include_retired=1`. The reason is mandatory because a number that
    silently left a season's total is the same problem as one that silently
    joined it: six months on, nobody can say why the figures moved.
    """
    body = body or {}
    _reject_unknown(body, {"reason", "by"}, "body")
    reason = _capped(body.get("reason"), "reason", REASON_MAX)
    if not reason:
        raise HTTPException(
            400,
            "reason is required - a sortie dropped from the estimate with no "
            "reason recorded cannot be defended or reversed later",
        )
    by = _capped(body.get("by"), "by", OPERATOR_MAX)

    def apply() -> dict:
        with _conn() as conn:
            survey = db.get_survey(conn, survey_id)
            if survey is None:
                raise HTTPException(404, "survey not found")
            if survey.get("retired_at"):
                raise HTTPException(
                    409,
                    f"survey {survey_id} was already retired at "
                    f"{survey['retired_at']}: {survey.get('retired_reason') or '-'}",
                )
            return db.update_survey(
                conn, survey_id,
                retired_at=db.utcnow(), retired_reason=reason, retired_by=by,
            )

    return await asyncio.to_thread(apply)


@app.post("/v1/surveys/{survey_id}/unretire")
async def unretire_survey(survey_id: str):
    """Put a withdrawn sortie back in the estimate.

    Clears all three retirement fields. The `edit`-style history of who
    retired it is lost with them - retirement is a state, not a log - which is
    why the reason had to be recorded while it was true.
    """
    def apply() -> dict:
        with _conn() as conn:
            survey = db.get_survey(conn, survey_id)
            if survey is None:
                raise HTTPException(404, "survey not found")
            if not survey.get("retired_at"):
                raise HTTPException(409, f"survey {survey_id} is not retired")
            return db.update_survey(
                conn, survey_id,
                retired_at=None, retired_reason=None, retired_by=None,
            )

    return await asyncio.to_thread(apply)


# ------------------------------------------------------- counts of a survey

def _count_payload(run: dict, standing: bool) -> dict:
    """One line of a survey's count history.

    The provenance of a correction lives in the run's `quality` ledger, so it
    is lifted out here rather than handed over as a raw JSON blob: a client
    that has to know the ledger's internal shape is a client that will read it
    wrong the first time the ledger grows a key.
    """
    q = run.get("quality")
    q = q if isinstance(q, dict) else {}
    prev = q.get("previous")
    return {
        "run_id": run["id"],
        "engine": run.get("engine"),
        "basis": run.get("basis"),
        "low": run.get("count_low"),
        "best": run.get("count_best"),
        "high": run.get("count_high"),
        "created_at": run.get("created_at"),
        "media_id": run.get("media_id"),
        # The one that currently represents this survey. Derived from the
        # ordering, never stored: a flag on a row is a second source of truth
        # about which number is standing, and the two would drift.
        "standing": bool(standing),
        "correction": bool(q.get("correction")),
        "corrects_run": q.get("corrects_run"),
        "evidence_run": q.get("evidence_run"),
        # Who entered this number and why. Null on an engine run, which nobody
        # signed and which needs no reason.
        "operator": q.get("operator"),
        "reason": q.get("reason"),
        # How a ground count was arrived at (binoculars, boat transect...).
        "method": q.get("method"),
        "previous": prev if isinstance(prev, dict) else None,
    }


@app.get("/v1/surveys/{survey_id}/counts")
async def survey_counts(survey_id: str, limit: int = 100):
    """Every count ever recorded for one sortie, newest first.

    This is the log that makes a corrected number defensible: the engine's run
    is still here with what it said, and the human correction standing above it
    says who changed it, to what, and why. A product that let an operator edit
    a count without leaving both numbers visible would be a product where a
    published figure cannot be traced to anything.
    """
    limit = max(1, min(limit, 500))

    def load() -> dict:
        with _conn() as conn:
            if db.get_survey(conn, survey_id) is None:
                raise HTTPException(404, "survey not found")
            runs = db.list_survey_runs(conn, survey_id, limit=limit)
            return {
                "survey_id": survey_id,
                "counts": [_count_payload(r, i == 0) for i, r in enumerate(runs)],
            }

    return await asyncio.to_thread(load)


@app.post("/v1/surveys/{survey_id}/counts", status_code=201)
async def correct_survey_count(survey_id: str, body: dict):
    """Correct the standing count of a sortie that already exists.

    Deliberately NOT a PATCH of the number. A correction is recorded as a new
    run with `basis` = 'manual' against the same survey, and latest-per-survey
    - the rule the whole archive already reads by - makes it the standing
    figure. The engine's run keeps its count, its animals and its edit log, so
    both numbers stay quotable and `GET /v1/surveys/{id}/counts` shows the two
    side by side.

    A sibling of `POST /v1/observations` rather than a mode of it: that route
    mints a NEW sortie from a count, this one attaches a count to a sortie that
    already happened. Sharing one endpoint would mean a caller who mistyped a
    survey id silently created a phantom survey instead of being told.
    """
    body = body or {}
    _reject_unknown(body, {"count", "reason", "operator"}, "body")

    if body.get("count") is None:
        raise HTTPException(400, "count is required")
    count = _whole(body["count"], "count")
    if count < 0:
        raise HTTPException(400, "count may not be negative")
    reason = _capped(body.get("reason"), "reason", REASON_MAX)
    operator = _capped(body.get("operator"), "operator", OPERATOR_MAX)

    def apply() -> dict:
        with _conn() as conn:
            try:
                result = db.create_correction(
                    conn, survey_id, count=count, reason=reason, operator=operator,
                )
            except LookupError as exc:
                raise HTTPException(404, str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            runs = db.list_survey_runs(conn, survey_id)
            return {
                "run": result["run"],
                "supersedes": result["supersedes"],
                "counts": [_count_payload(r, i == 0) for i, r in enumerate(runs)],
            }

    return await asyncio.to_thread(apply)


# --------------------------------------------------------------- hard delete

def _remove_media_files(paths: list[str]) -> dict:
    """Unlink the bytes of a purged survey. Called only AFTER the commit.

    Two containment rules, both the same one `media_file` serves under: the
    path came out of our own database, and a moved workspace or a hand-edited
    row must not turn a delete into an arbitrary file removal. Anything outside
    the workspace is REPORTED, never removed - the operator asked to destroy a
    survey, not to have this service guess at files it does not own.

    A whole per-upload directory goes when the media sits in one, because the
    worker writes each job's frames and tile crops next to the source file:
    unlinking the source alone would leave a directory of derived evidence
    behind with nothing in the archive referencing it, which is the orphan
    problem the ingest path already had to fix once.
    """
    root = WORKSPACE.resolve()
    removed: list[str] = []
    failed: list[str] = []
    for raw in paths:
        if not raw:
            continue
        try:
            target = Path(raw).resolve()
        except (OSError, ValueError):
            failed.append(raw)
            continue
        if not _inside(root, target):
            failed.append(raw)
            continue
        parent = target.parent
        try:
            if parent != root and parent.parent == root:
                shutil.rmtree(parent)
            else:
                target.unlink(missing_ok=True)
            removed.append(raw)
        except OSError:
            failed.append(raw)
    if failed:
        # Server-side, where the paths belong. A file the archive no longer
        # references and this process could not remove is an orphan somebody
        # has to go and find, so it is named somewhere - just not over HTTP.
        print(f"purge: {len(failed)} file(s) not removed: {failed[:5]}", flush=True)
    # Counts, not paths. A workspace path is a server detail (the same reason
    # `_media_payload` withholds `path` and `_scrub_paths` cleans error text),
    # and the operator's question is "did the footage go" - which a number
    # answers, including when the answer is "one of them did not".
    return {"files_removed": len(removed), "files_failed": len(failed)}


def _purge_payload(receipt: dict) -> dict:
    """The receipt, minus the workspace paths.

    `files` is what the unlink step consumes and it is absolute server paths;
    handing them to a browser would publish the layout of the box this runs on
    for no gain. The operator gets the FILENAMES they uploaded and a count,
    which is what a confirmation dialog can actually say.
    """
    out = {k: v for k, v in receipt.items() if k != "files"}
    out["files"] = len(receipt.get("files") or [])
    return out


@app.get("/v1/surveys/{survey_id}/purge")
async def purge_preview(survey_id: str):
    """What `DELETE /v1/surveys/{id}` would destroy, without destroying it.

    The confirmation an operator reads has to name real numbers - "1 file, 2431
    animals, 18 log entries" - and the only way for those to be true is for the
    same function that does the deleting to count them. A second implementation
    in the client would be a guess, and a guess under a button marked "delete
    for ever" is worse than no number at all.

    Answers on a survey that is not retired too, and says so with
    `deletable: false`: the preview is how a caller finds out the retire step
    is still owed, and a confirmation that cannot state what is at stake until
    the sortie is already withdrawn is a confirmation nobody can read in time.
    """
    def load() -> dict:
        with _conn() as conn:
            if db.get_survey(conn, survey_id) is None:
                raise HTTPException(404, "survey not found")
            receipt = db.purge_survey(conn, survey_id, dry_run=True)
            return {**_purge_payload(receipt), "deletable": bool(receipt.get("retired"))}

    return await asyncio.to_thread(load)


@app.delete("/v1/surveys/{survey_id}")
async def delete_survey(survey_id: str):
    """Destroy a retired sortie and everything hanging off it. No undo.

    Two steps by design. Retirement is the reversible act - it takes a reason,
    keeps every row, and can be undone; this is the irreversible one, and it is
    only reachable from there. A season cannot be destroyed by one click, and
    test junk can still be removed completely rather than left cluttering an
    archive for ever.

    Rows go in one IMMEDIATE transaction; the files go after it commits, never
    before - bytes unlinked ahead of a rollback would leave footage destroyed
    for a survey that still exists. The response says exactly what went, files
    included, and names any file this service would not touch.
    """
    def apply() -> dict:
        with _conn() as conn:
            survey = db.get_survey(conn, survey_id)
            if survey is None:
                raise HTTPException(404, "survey not found")
            if not survey.get("retired_at"):
                raise HTTPException(
                    409,
                    f"survey {survey_id} is still in the estimate - withdraw it first "
                    f"(POST /v1/surveys/{survey_id}/retire, with a reason), then delete "
                    "it. Deleting a sortie destroys its footage, its animals and its "
                    "correction log, and nothing here can bring them back",
                )
            try:
                receipt = db.purge_survey(conn, survey_id)
            except db.NotRetired as exc:
                # Lost the race with an unretire between the read above and the
                # transaction. The refusal still stands, and it is the same 409.
                raise HTTPException(409, str(exc)) from exc
            except LookupError as exc:
                raise HTTPException(404, str(exc)) from exc
        # Outside `_conn`, after the commit.
        return {
            **_purge_payload(receipt),
            **_remove_media_files(receipt.get("files") or []),
        }

    return await asyncio.to_thread(apply)


# ---------------------------------------------------------------------- stats

# The most recent run per survey. A survey can carry several pieces of media and
# any of them can be re-run with different params; the newest run is the one
# that represents it.
def _latest_run_cte(include_retired: bool) -> str:
    """The CTE, honouring the same retirement filter as the archive listing.

    It used to be a constant with no filter at all, and the result was a
    /v1/stats that reported two different seasons depending on which key you
    read: `latest_runs` dropped a withdrawn sortie while `over_time`, `per_site`
    and `totals.surveys` went on charting and counting it. A payload that
    silently describes two populations is the one option that cannot be
    defended, so the filter is applied here too and `totals.surveys_retired`
    states out loud how many rows the default answer leaves out.

    Inside the ranked SELECT rather than after it, for the reason the listing
    already documents: filtering after the window function would rank a retired
    run into a survey's first place and then drop it, hiding a newer run that is
    still counted.
    """
    live = "" if include_retired else "\n    WHERE sv.retired_at IS NULL"
    return f"""
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
    JOIN run r ON r.media_id = m.id{live}
),
latest AS (SELECT * FROM ranked WHERE rn = 1)
"""

# The archive listing `latest_runs` is built from. Kept as one string so the
# paged listing and the total it is measured against can never disagree about
# which runs exist.
_LATEST_RUNS_COLUMNS = """
       r.id AS run_id, r.created_at, r.engine, r.basis, r.seconds,
       r.count_low AS low, r.count_best AS best, r.count_high AS high,
       r.quality,
       m.id AS media_id, m.filename, m.kind, m.width, m.height,
       sv.id AS survey_id, sv.captured_at, sv.tide_state,
       sv.gsd_cm_px, sv.gsd_source,
       sv.notes, sv.operator, sv.altitude_m,
       sv.lat AS survey_lat, sv.lng AS survey_lng, sv.location_source,
       sv.from_video, sv.at_seconds,
       -- Who withdrew this sortie and why, not just that somebody did. The
       -- client held both in a session-only map, so after a reload the banner
       -- could say a sortie was retired and nothing about the decision - which
       -- is the half that makes a withdrawal defensible a season later.
       sv.retired_at, sv.retired_reason, sv.retired_by,
       si.id AS site_id, si.name AS site_name,
       si.lat AS site_lat, si.lng AS site_lng
"""
# LEFT JOIN on media, not JOIN. Every run in the archive today has media and
# this is byte-identical for all of them - but a ground count has none, and an
# inner join would silently drop a human's count out of the archive it belongs
# in. The bucket below falls through to the run's own id for the same reason.
_LATEST_RUNS_FROM = """
FROM run r
LEFT JOIN media m ON m.id = r.media_id
LEFT JOIN survey sv ON sv.id = COALESCE(m.survey_id, r.survey_id)
LEFT JOIN site si ON si.id = sv.site_id
"""
# One bucket per survey, and per media for the media a survey never claimed -
# an unattached upload is still its own sortie, and the inner joins of
# `_latest_run_cte` would drop it out of the archive entirely. A run with
# neither (a ground count) is its own bucket: it is one observation and must
# never be collapsed with another.
_RUN_BUCKET = "COALESCE(sv.id, 'media:' || m.id, 'run:' || r.id)"


@app.get("/v1/stats")
async def stats(
    latest_per_survey: bool = False,
    runs_limit: int = MAX_LATEST_RUNS,
    runs_offset: int = 0,
    include_retired: bool = False,
):
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

    `latest_runs` is a window, and `latest_runs_total` is always the size of the
    thing it is a window onto. A truncated archive that does not admit it is
    truncated is how a season's total gets published short.

    Query params, all additive - the defaults reproduce the previous response
    byte for byte:
      latest_per_survey  one run per survey (the newest), instead of every run.
                         A re-run of the same footage is a correction, not a
                         second sortie, and counting both double-counts a colony.
      runs_limit         page size, default 20, clamped to MAX_LATEST_RUNS_CEILING
      runs_offset        page offset
      include_retired    show sorties withdrawn from the estimate. Off by
                         default; a LEFT-JOIN miss yields NULL, which passes
                         the filter, so a run with no survey at all is never
                         hidden by it. No survey can be retired on a database
                         that predates the column, so today the two answers are
                         identical - which is the point: the filter is inert
                         until somebody actually retires something. It reaches
                         every branch of this payload, not only `latest_runs`:
                         `over_time`, `per_site` and `totals.surveys` describe
                         the same population as the archive, and
                         `totals.surveys_retired` says how many rows that
                         leaves out.
    """
    # Clamped rather than rejected: a caller asking for 10_000 runs wants "all
    # of them", and the honest answer to that is a page plus the real total.
    # No int() guard here - FastAPI has already coerced both from the signature
    # and answered 422 for anything that is not an integer, so the try/except
    # that used to wrap this could never fire and only read as a live check.
    runs_limit = max(1, min(runs_limit, MAX_LATEST_RUNS_CEILING))
    runs_offset = max(0, runs_offset)

    cte = _latest_run_cte(include_retired)
    # `surveys` counts the population every other key in this payload describes;
    # `surveys_retired` is always the whole withdrawn set, whichever way the
    # flag is set, so a reader can tell "6 of 7, one withdrawn" from "6 of 6".
    surveys_count = (
        "(SELECT COUNT(*) FROM survey)"
        if include_retired
        else "(SELECT COUNT(*) FROM survey WHERE retired_at IS NULL)"
    )

    def load() -> dict:
        with _conn() as conn:
            totals = dict(
                conn.execute(
                    "SELECT (SELECT COUNT(*) FROM site) AS sites,"
                    f"       {surveys_count} AS surveys,"
                    "       (SELECT COUNT(*) FROM survey WHERE retired_at IS NOT NULL)"
                    "           AS surveys_retired,"
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
                    cte
                    + """
                    SELECT si.id AS site_id, si.name, si.region, si.lat, si.lng,
                           COUNT(DISTINCT sv.id) AS surveys,
                           COUNT(l.run_id) AS runs,
                           MAX(sv.captured_at) AS last_captured_at
                    FROM site si
                    -- The retirement filter belongs in the JOIN, not a WHERE:
                    -- moved outside it would turn the LEFT JOIN into an inner
                    -- one and drop every site that has no surveys at all.
                    LEFT JOIN survey sv ON sv.site_id = si.id
                         AND (:all_rows OR sv.retired_at IS NULL)
                    LEFT JOIN latest l ON l.survey_id = sv.id
                    GROUP BY si.id, si.name, si.region, si.lat, si.lng
                    ORDER BY si.name
                    """,
                    {"all_rows": 1 if include_retired else 0},
                )
            ]

            newest = {
                r["site_id"]: dict(r)
                for r in conn.execute(
                    cte
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
                    cte
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

            # Frame size and scale ride along because a count without the ground
            # it covers is not a survey figure, and `gsd_source` is what says
            # whether that scale was measured or assumed. `quality` is fetched
            # only to derive the caveats: a caller rebuilding the archive must
            # see the same reasons-to-doubt a fresh run carries, or reloading
            # the page quietly launders a floor into a measurement.
            # Inside the CTE, not outside it: filtering after the window
            # function would rank a retired run into a bucket's first place and
            # then drop it, hiding the newest run that is still counted.
            live = "" if include_retired else " WHERE sv.retired_at IS NULL"
            if latest_per_survey:
                runs_sql = (
                    "WITH ranked AS (SELECT " + _LATEST_RUNS_COLUMNS
                    + f", ROW_NUMBER() OVER (PARTITION BY {_RUN_BUCKET}"
                    "   ORDER BY r.created_at DESC, r.id DESC) AS rn "
                    + _LATEST_RUNS_FROM + live
                    + ") SELECT * FROM ranked WHERE rn = 1"
                    " ORDER BY created_at DESC, run_id DESC LIMIT ? OFFSET ?"
                )
                total_sql = (
                    f"SELECT COUNT(DISTINCT {_RUN_BUCKET}) AS n "
                    + _LATEST_RUNS_FROM + live
                )
            else:
                runs_sql = (
                    "SELECT " + _LATEST_RUNS_COLUMNS + _LATEST_RUNS_FROM + live
                    + " ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?"
                )
                total_sql = "SELECT COUNT(*) AS n " + _LATEST_RUNS_FROM + live

            latest_runs_total = int(_scalar(conn, total_sql) or 0)

            # One row per evidence run, fetched at most once. Only a corrected
            # survey reaches it, and a page holds at most `runs_limit` of those.
            # Two different questions are asked of the same row - what the
            # engine recorded about the footage, and WHICH engine that was - so
            # it is read once and both answers come out of the same fetch.
            evidence_rows: dict[str, Optional[dict]] = {}

            def _evidence_row(run_id: str) -> Optional[dict]:
                if run_id not in evidence_rows:
                    row = conn.execute(
                        "SELECT quality, engine, basis FROM run WHERE id = ?",
                        (run_id,),
                    ).fetchone()
                    evidence_rows[run_id] = (
                        {
                            "quality": _quality_ledger(row["quality"]),
                            "engine": row["engine"],
                            "basis": row["basis"],
                        }
                        if row is not None
                        else None
                    )
                return evidence_rows[run_id]

            latest_runs = []
            for row in conn.execute(runs_sql, (runs_limit, runs_offset)):
                run = dict(row)
                # `rn` is the dedupe machinery, not part of the run.
                run.pop("rn", None)
                # Raw SQL bypasses db.py's JSON column handling, so the ledger
                # arrives as text and is parsed here. A malformed one costs this
                # row its caveats, never the whole dashboard. The same helper
                # the job endpoint uses, so the two can never drift into telling
                # a caller two different things about one run.
                quality = _quality_ledger(run.pop("quality", None))
                correction = (
                    {
                        "corrects_run": (quality or {}).get("corrects_run"),
                        "evidence_run": (quality or {}).get("evidence_run"),
                        "operator": (quality or {}).get("operator"),
                        "reason": (quality or {}).get("reason"),
                        "previous": (quality or {}).get("previous")
                        if isinstance((quality or {}).get("previous"), dict) else None,
                    }
                    if (quality or {}).get("correction")
                    else None
                )
                if correction and correction["evidence_run"]:
                    # Everything derived below - the caveats, the frames the
                    # count was assembled from, the false-positive risk -
                    # describes the FOOTAGE and the engine's pass over it. A
                    # correction repeated neither: it changed the number. Read
                    # off the correction's own ledger these would all come back
                    # empty, and an empty caveat list does not read as "not
                    # recorded", it reads as "clean run" - so correcting a count
                    # would quietly launder away every reason the engine gave to
                    # doubt the footage. The band check still runs against the
                    # STANDING band, which is the corrected one.
                    evidence = _evidence_row(correction["evidence_run"])
                    # WHAT PRODUCED THE ANIMALS, resolved through the correction
                    # chain. `previous` is the run this one replaced and stays
                    # verbatim - but after a SECOND correction that run is
                    # itself manual, so a client reading the engine off it
                    # titles a drone sortie "ground count" and hides its
                    # filename. The evidence run is the one that actually holds
                    # the points, so it is the only one that can answer "what
                    # counted these". Reported separately from `previous`
                    # because they answer different questions and only
                    # coincide on a first correction.
                    correction["evidence"] = (
                        {
                            "run_id": correction["evidence_run"],
                            "engine": evidence["engine"],
                            "basis": evidence["basis"],
                        }
                        if evidence is not None
                        else None
                    )
                    quality = (evidence or {}).get("quality") or quality

                # The band check inside `_caveats` reads no counters, so it still
                # runs on a ledgerless row - an incoherent band is a service
                # defect and must surface wherever the number does. A NULL or
                # unreadable ledger adds its own caveat: rendering [] would read
                # downstream as "clean run", a claim this row cannot support.
                caveats = _caveats_for(
                    quality,
                    {
                        "low": run["low"],
                        "best": run["best"],
                        "high": run["high"],
                        "basis": run["basis"],
                    },
                )
                # How much ground this sortie covers is width x height x GSD per
                # FRAME, and a video is many frames. Without this the archive
                # would print one frame's footprint as a whole transect's
                # surveyed area - off by the length of the flight.
                run["frames_used"] = _frames_counted(quality, run.get("kind"))
                run["caveats"] = caveats
                # How far this run's conditions sat from the ones where false
                # positives were actually measured, and the measurements that
                # back the label. Lifted out of the ledger and onto the row so a
                # client can quote the BASIS rather than render the adjective
                # alone: "low risk" with nothing behind it is the kind of
                # reassurance this product refuses to hand out. Both null on a
                # run whose ledger never recorded them - unknown, not clean.
                run["false_positive_risk"] = (quality or {}).get("false_positive_risk")
                basis = (quality or {}).get("false_positive_basis")
                run["false_positive_basis"] = (
                    [str(b) for b in basis] if isinstance(basis, list) else None
                )
                # A standing number a PERSON corrected, and everything needed to
                # say so without a second request: which run it replaced, which
                # run still holds the animals (so a client fetches evidence from
                # the row that has it rather than from this empty one), who
                # changed it, why, and the band that was standing before. Null
                # on every run nobody corrected, which is almost all of them.
                run["correction"] = correction
                latest_runs.append(run)

            return {
                "totals": totals,
                "per_site": per_site,
                "over_time": over_time,
                "latest_runs": latest_runs,
                # How many rows the window above was cut from, plus where the
                # window sits. Without these a client cannot tell "20 sorties
                # this season" from "the first 20 of 340".
                "latest_runs_total": latest_runs_total,
                "latest_runs_limit": runs_limit,
                "latest_runs_offset": runs_offset,
                "latest_per_survey": bool(latest_per_survey),
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
