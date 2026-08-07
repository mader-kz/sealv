"""Detection worker: claim a job, run the pipeline, write the run.

Runs as its own process - `python -m service.worker` - because detection is
minutes of CPU and the API must stay answerable while it happens. Several of
these can run against the same database; `db.claim_job` takes the write lock
with BEGIN IMMEDIATE, so nothing here has to coordinate with its siblings.

Progress is written to the job row as it happens rather than buffered until the
end. The API's SSE stream polls that row, so an unwritten frame is a frame the
operator cannot see, and on a sortie that runs for an hour "no output yet" and
"hung" look identical from the outside.

Failures are recorded, not raised. The reason in `job.error` is the difference
between a survey team knowing that ffmpeg is missing and a job that sits in the
queue forever with nobody able to say why. That field carries the exception's
message; the full traceback goes to this process's log, where the people who
can act on stack frames are the ones reading.

Where the warm model goes
-------------------------
`la_studio.countgd_engine.detect` shells out to a second interpreter and reloads
the checkpoint on every call (~0.7s). That is a fine trade for one still and a
bad one across a sortie: ~70s of pure model loading over 100 frames, which is
what §2 of the plan means by persistent warm workers. The fix belongs here, not
in `detect`: spawn one long-lived child when this process starts, feed it image
paths over a pipe, and let `countgd_engine.detect` become a call into that
child. It is a change to the engine boundary rather than to the pipeline, so
`countgd_engine` is deliberately left alone for now.
"""

from __future__ import annotations

import argparse
import os
import signal
import socket
import sqlite3
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Optional

from . import db, detect, geo, preflight
from .contract import JobParams

# Set by SIGINT/SIGTERM, checked between jobs only. Abandoning a half-finished
# detection would throw away the expensive part and leave the row claimed.
STOP = threading.Event()

DEFAULT_IDLE_SLEEP = 2.0

# How long a claim survives without being refreshed before another worker (or
# this one, after a restart) is entitled to take the job back. It has to clear
# the worst gap between heartbeats by a wide margin, because the cost of getting
# this wrong in the impatient direction is two workers counting the same colony.
DEFAULT_LEASE_S = 300.0

# Claims allowed per job before recovery gives up and fails it. Bounded because
# a job heavy enough to OOM its worker would otherwise crash-loop the queue.
DEFAULT_MAX_ATTEMPTS = 3


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def _env(name: str, default: float, cast=float):
    """Environment override that refuses to die on a typo - a worker that will
    not start because `TULEN_JOB_LEASE_S=5m` is a survey that does not run."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return cast(raw)
    except (TypeError, ValueError):
        log(f"{name}={raw!r} is not a number - using {default}")
        return default


# ------------------------------------------------------------------- progress

class Ledger:
    """The job's progress block, flushed to the database on every change.

    `detect_video` calls this with (done, total, stage) once per frame per
    phase. Writing straight through is affordable - a handful of small UPDATEs
    against ~27s of inference per frame - and it is the only thing that makes
    the SSE stream mean anything.
    """

    def __init__(self, conn: sqlite3.Connection, job_id: str, frames_total: int = 0) -> None:
        self.conn = conn
        self.job_id = job_id
        self.state: dict = {
            "stage": "starting",
            "frames_done": 0,
            "frames_total": frames_total,
        }
        self.flush()

    def __call__(self, done: int, total: int, stage: str) -> None:
        self.state.update({"stage": stage, "frames_done": int(done), "frames_total": int(total)})
        self.flush()

    def stage(self, stage: str, **fields: Any) -> None:
        self.state.update({"stage": stage, **fields})
        self.flush()

    def flush(self) -> None:
        # Progress doubles as proof of life: every tick pushes the claim's lease
        # out, so a long video can never be mistaken for an abandoned one.
        db.heartbeat_job(self.conn, self.job_id, progress=dict(self.state))


class Lease:
    """Holds a claimed job's lease open for as long as this process is on it.

    `db.requeue_stale_jobs` recovers a job whose `claimed_at` has stopped
    moving, which is the only way a crashed worker's job ever runs again. A job
    that legitimately takes an hour must not look crashed - and the refresh
    cannot ride on progress alone, because `detect_image` reports none: a tiled
    still is one call that takes minutes, so the lease would expire mid-count
    and a second worker would start the same job. Hence a timer. What it proves
    is exactly what a lease is for: this process is still here.

    Its own connection, because sqlite3 objects belong to the thread that
    created them. The write is one row by primary key and WAL lets it land
    while the API reads, so it does not contend with the detection it guards.
    """

    def __init__(self, db_path: Optional[str], job_id: str, interval: float) -> None:
        self.db_path = db_path
        self.job_id = job_id
        self.interval = max(1.0, interval)
        self._done = threading.Event()
        self._thread = threading.Thread(
            target=self._run, name=f"lease-{job_id}", daemon=True
        )

    def _run(self) -> None:
        conn = None
        try:
            conn = db.connect(self.db_path)
            while not self._done.wait(self.interval):
                db.heartbeat_job(conn, self.job_id)
        except Exception:
            # Losing the heartbeat is not worth failing a job that is still
            # counting. The worst case is the lease expiring and the job being
            # recovered and rerun, which is the same outcome as a crash - but it
            # has to be visible, or a rerun looks spontaneous.
            log(f"job {self.job_id}: lease heartbeat stopped\n{traceback.format_exc()}")
        finally:
            if conn is not None:
                conn.close()

    def __enter__(self) -> "Lease":
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._done.set()
        self._thread.join(timeout=5.0)


# ------------------------------------------------------------------ one job

def _locate(points: list[dict], quality: dict, track: list[dict]) -> list[dict]:
    """Attach lat/lng to detections, the step that puts points on the map.

    Coordinates are projected in the pixel space the detector actually worked
    in, which for a video is the extracted frame rather than the source clip -
    hence `frame_gsd_cm_px` in preference to the survey's own GSD. Everything a
    consensus run produces sits in one reference frame, so the fix and heading
    are resolved once per timestamp rather than once per animal.
    """
    gsd = quality.get("frame_gsd_cm_px") or quality.get("gsd_cm_px")
    width, height = quality.get("width"), quality.get("height")
    if not track or not gsd or not width or not height:
        return points

    times = {f["index"]: f.get("t") for f in (quality.get("frames") or [])}
    fixes: dict[float, tuple] = {}
    out = []
    for p in points:
        t = times.get(p.get("frame_idx")) or 0.0
        if t not in fixes:
            fix = geo.track_at(track, t)
            fixes[t] = (fix, geo.estimate_heading(track, t)) if fix else (None, 0.0)
        fix, heading = fixes[t]
        if fix is None:
            out.append(p)
            continue
        pos = geo.pixel_to_latlng(
            p["x"], p["y"], width, height, fix["lat"], fix["lng"], gsd, heading
        )
        # None means the scale was unusable. The point keeps its pixels and
        # leaves lat/lng NULL rather than claiming a position nothing measured.
        out.append(p if pos is None else {**p, "lat": pos[0], "lng": pos[1]})
    return out


def job_workdir(source: Path, job_id: str) -> Path:
    """Where one job's intermediate files live. Per job, never per media.

    Frames and tile crops are named by position (`frame_00002.jpg`,
    `..._t0007.jpg`), so two jobs sharing a directory share those names - and
    `frames.extract` clears the directory before it writes. A second run on the
    same media therefore used to overwrite the first run's frames in place:
    `quality.frames[].file` still pointed at `frame_00002.jpg`, but the image
    behind that name was now a different moment in the clip, shown to the
    operator beside the first run's count. Frames sampled at a coarser interval
    left the later files deleted outright and their runs serving 404s.

    A finished run's evidence has to be immutable - it is what the count is
    defended with - and the same collision is what made two workers on one piece
    of media unsafe: `finally: crop_path.unlink()` deleting the crop the other
    worker's subprocess was about to open.
    """
    return source.parent / "jobs" / job_id


def process(
    conn: sqlite3.Connection,
    job: dict,
    db_path: Optional[str] = None,
    lease_s: float = DEFAULT_LEASE_S,
) -> bool:
    """Run one claimed job to a terminal state. Never raises.

    Returns True only when the job reached `done`. The loop ignores that - a
    failed job is normal and the queue keeps draining - but `--once` is driven
    by scripts, and a shell that gets exit 0 for a job that failed has been
    told the count succeeded.
    """
    job_id = job["id"]
    started = time.perf_counter()
    try:
        # The lease is held across everything below, including _persist: a
        # crash while writing the run is exactly as recoverable as a crash
        # while counting, and neither should look like a live job afterwards.
        with Lease(db_path, job_id, lease_s / 10.0):
            params = JobParams.from_dict(job.get("params") or {})
            media = db.get_media(conn, job["media_id"])
            if media is None:
                raise RuntimeError(f"media {job['media_id']} has gone")
            survey = db.get_survey(conn, media["survey_id"]) if media.get("survey_id") else None
            gsd = (survey or {}).get("gsd_cm_px")

            source = Path(media["path"])
            if not source.is_file():
                # Named by media id, not by server path: this message is what
                # `job.error` carries out of the API, and the filename it was
                # uploaded under is what identifies it to whoever has to
                # re-upload. The absolute path is in the log for the operator.
                raise FileNotFoundError(
                    f"media {media['id']} ({media.get('filename') or 'file'}) is no "
                    "longer in the workspace - re-upload it and queue a new job"
                )
            workdir = job_workdir(source, job_id)
            workdir.mkdir(parents=True, exist_ok=True)

            ledger = Ledger(conn, job_id, frames_total=1 if media["kind"] == "image" else 0)
            log(
                f"job {job_id}: {media['kind']} {source.name} target={params.target!r} "
                f"threshold={params.threshold} tiling={params.tiling!r} gsd={gsd}"
            )

            if media["kind"] == "image":
                ledger.stage("detect", frames_done=0, frames_total=1)
                result = detect.detect_image(
                    source, params, gsd_cm_px=gsd, scratch=workdir / "_tiles"
                )
                ledger.stage("writing", frames_done=1, frames_total=1)
            else:
                result = detect.detect_video(
                    source, workdir, params, gsd_cm_px=gsd, progress_cb=ledger
                )
                ledger.stage("writing")

            run_id = _persist(conn, job, media, result)
            band = result["band"]

            # Progress first, status second: the SSE stream stops at the status
            # change and would otherwise report a finished job as still
            # "writing". `error=None` clears the note left by a recovery: a job
            # that has now succeeded must not still be showing why it was
            # requeued.
            ledger.stage("done", run_id=run_id)
            db.update_job(conn, job_id, status="done", error=None)
            log(
                f"job {job_id}: done in {result.get('seconds', 0)}s -> run {run_id} "
                f"{band.low}/{band.best}/{band.high} ({band.basis})"
            )
            return True
    except Exception as exc:
        # Two audiences, two forms. The worker log keeps the full traceback for
        # whoever has to debug the box; `job.error` - which goes out of
        # GET /v1/jobs/{id} and the SSE `failed` event - carries the sentence
        # that tells a survey team what went wrong. Shipping stack frames and
        # absolute server paths to an API client leaked the deployment layout
        # and buried the one line that was actually actionable ("ffmpeg not
        # found") under frames nobody outside this repo can read.
        log(
            f"job {job_id}: FAILED after {time.perf_counter() - started:.1f}s\n"
            f"{traceback.format_exc()}"
        )
        error = f"{type(exc).__name__}: {exc}".strip()
        try:
            db.update_job(conn, job_id, status="failed", error=error)
        except Exception:
            # The database is the only place a failure can be recorded. If it is
            # unreachable, the second failure has to be visible too or the job
            # simply looks stuck.
            log(f"job {job_id}: could not record the failure\n{traceback.format_exc()}")
        return False


def _persist(conn: sqlite3.Connection, job: dict, media: dict, result: dict) -> str:
    """Write the run and its points. One run row per detection pass, always."""
    run_id = db.create_run(
        conn,
        job_id=job["id"],
        media_id=media["id"],
        engine=result["engine"],
        engine_params=result.get("engine_params"),
        band=result["band"],
        quality=result.get("quality"),
        seconds=result.get("seconds"),
    )
    points = _locate(
        result.get("points") or [],
        result.get("quality") or {},
        db.get_track(conn, media["id"]),
    )
    db.insert_points(conn, run_id, points)
    return run_id


# ----------------------------------------------------------------------- loop

def _install_signals() -> None:
    def handler(signum: int, _frame) -> None:
        if STOP.is_set():
            log("second signal - exiting now; the running job stays claimed")
            os._exit(130)
        STOP.set()
        log(f"signal {signum} - finishing the current job, then stopping")

    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)


def default_worker_id() -> str:
    return f"{socket.gethostname().split('.')[0]}:{os.getpid()}"


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m service.worker",
        description="Claim and run Tulen detection jobs.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="run at most one job and exit; 0 if it finished or the queue was "
             "empty, 1 if the job failed",
    )
    parser.add_argument("--worker-id", default=default_worker_id())
    parser.add_argument(
        "--idle-sleep",
        type=float,
        default=DEFAULT_IDLE_SLEEP,
        help=f"seconds to wait when the queue is empty (default {DEFAULT_IDLE_SLEEP})",
    )
    parser.add_argument(
        "--db",
        default=None,
        help="database path (defaults to db.default_db_path())",
    )
    parser.add_argument(
        "--lease",
        type=float,
        default=_env("TULEN_JOB_LEASE_S", DEFAULT_LEASE_S),
        help="seconds a claim survives unrefreshed before the job is recovered "
             f"(default {DEFAULT_LEASE_S:g}, $TULEN_JOB_LEASE_S)",
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=int(_env("TULEN_JOB_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, int)),
        help="claims allowed per job before recovery gives up and fails it "
             f"(default {DEFAULT_MAX_ATTEMPTS}, $TULEN_JOB_MAX_ATTEMPTS)",
    )
    args = parser.parse_args(argv)

    _install_signals()

    # A worker that cannot load the model is not a degraded worker, it is a job
    # shredder: it claims queued work, fails it, and the attempt counter burns
    # every job in the queue to `failed` within seconds. Refusing to start
    # leaves the queue intact for a worker that can actually count.
    try:
        preflight.require("worker", db_path=Path(args.db) if args.db else None)
    except preflight.PreflightError as exc:
        # The banner is already on stderr with the specifics and the fixes;
        # repeating the exception would only bury it. Exit code, not traceback.
        log(f"refusing to start: {exc}")
        return 1

    conn = db.init_db(db.connect(args.db))
    log(
        f"worker {args.worker_id} ready (lease {args.lease:g}s, "
        f"max {args.max_attempts} attempts/job)"
    )

    # Sweep on startup and then on a timer, not only on startup: when one worker
    # of several dies, the survivors are what recovers its job, and they are not
    # going to restart. Half the lease is often enough to be prompt and rare
    # enough to be free - it is one indexed count against `status='running'`.
    sweep_every = max(5.0, args.lease / 2.0)
    next_sweep = 0.0

    try:
        while not STOP.is_set():
            if time.monotonic() >= next_sweep:
                next_sweep = time.monotonic() + sweep_every
                try:
                    for rec in db.requeue_stale_jobs(conn, args.lease, args.max_attempts):
                        log(
                            f"job {rec['id']}: claimed by {rec['claimed_by']!r} and "
                            f"abandoned mid-run after {rec['attempts']} attempt(s) "
                            f"-> {rec['outcome']}"
                        )
                except Exception:
                    # Recovery failing must not stop the queue draining; the
                    # next sweep gets another go.
                    log(f"stale-job sweep failed\n{traceback.format_exc()}")

            try:
                job = db.claim_job(conn, args.worker_id)
            except Exception:
                # A locked database is transient often enough that dying here
                # would just mean the queue stops draining unattended.
                log(f"claim failed\n{traceback.format_exc()}")
                STOP.wait(args.idle_sleep)
                continue

            if job is None:
                if args.once:
                    log("queue is empty")
                    return 0
                STOP.wait(args.idle_sleep)
                continue

            ok = process(conn, job, db_path=args.db, lease_s=args.lease)
            if args.once:
                return 0 if ok else 1
    finally:
        conn.close()

    log(f"worker {args.worker_id} stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
