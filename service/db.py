"""SQLite persistence for the SEALv detection service.

The plan (§2) calls for Postgres, and it will be right eventually. It is not
right yet: the only hard requirement on the store is a job claim that survives
N workers racing for the same row, and SQLite gives that on a single node via
`BEGIN IMMEDIATE`. Everything in schema.sql maps 1:1 onto Postgres, so the port
is one function - `claim_job` - becoming `SELECT ... FOR UPDATE SKIP LOCKED`.
Until then a survey team gets a working service with no server to install,
which matters when the machine is a laptop on a boat in the north Caspian.

This is a pure data layer: no FastAPI, no engine, no `contract` import. Two
rules it enforces for callers:

  * plain dicts out, never `sqlite3.Row` - a Row is a read-only mapping tied to
    a cursor, and letting one escape into a request handler turns a schema
    change into a mystery `TypeError` three layers away.
  * JSON columns (`job.params`, `job.progress`, `run.engine_params`,
    `run.quality`) are dumped on write and parsed on read, so a caller never
    sees a JSON string where it expected a dict.

Counts are stored as a band (`count_low`/`count_best`/`count_high`), never a
single integer, because a single integer would be false precision - we measured
a 25% spread across four frames 1.5s apart on animals that barely moved.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional, Sequence

SCHEMA_PATH = Path(__file__).resolve().with_name("schema.sql")
DEFAULT_DB_PATH = Path.home() / ".sealv" / "sealv.db"

JOB_STATUSES = ("queued", "running", "done", "failed", "cancelled")
TERMINAL_JOB_STATUSES = ("done", "failed", "cancelled")
POINT_STATUSES = ("auto", "validated", "false_positive")
MEDIA_KINDS = ("image", "video")
EDIT_OPS = ("add", "remove", "reinstate")

# Columns held as JSON text, per table. Callers pass and receive dicts.
_JSON_COLUMNS: dict[str, tuple[str, ...]] = {
    "job": ("params", "progress"),
    "run": ("engine_params", "quality"),
}

# Whitelists for the **fields updaters. Column names cannot be parameterised in
# SQL, so anything reaching an f-string has to come from a fixed tuple.
_SURVEY_UPDATABLE = (
    "site_id", "captured_at", "altitude_m", "gsd_cm_px", "gsd_source",
    "tide_state", "sea_ice_pct", "operator", "notes",
    "lat", "lng", "location_source",
    "retired_at", "retired_reason", "retired_by",
    "from_video", "at_seconds",
)
_SITE_UPDATABLE = ("name", "region", "lat", "lng")
_JOB_UPDATABLE = (
    "status", "progress", "error", "claimed_by", "claimed_at", "finished_at", "params",
)

# RETURNING landed in SQLite 3.35 (2021). It is the unambiguous way to read back
# the row an UPDATE touched; older builds fall back to the claim stamp below.
_HAS_RETURNING = sqlite3.sqlite_version_info >= (3, 35, 0)


# --------------------------------------------------------------------------
# connection
# --------------------------------------------------------------------------

def new_id() -> str:
    """Short opaque id. 12 hex chars = 48 bits, ~16M rows before a 1-in-a-million
    collision - far past anything one survey archive will hold, and short enough
    to paste into a support ticket."""
    return uuid.uuid4().hex[:12]


def default_db_path() -> Path:
    """`$SEALV_DB` if set, else ~/.sealv/sealv.db, always absolute.

    Blank counts as unset. A declared-but-empty environment variable - which is
    what `docker run -e SEALV_DB=` and an emptied platform variable both send -
    would otherwise become `Path("")`, and `sqlite3.connect("")` quietly opens a
    private temporary database that is deleted when the connection closes. The
    API would then start, the schema would apply, uploads would succeed and
    every one of them would be gone by the next request.

    Absolute for the same reason the workspace is: the API and the worker are
    separate processes sharing one file, and a relative path means they share it
    only for as long as they happen to share a working directory.
    """
    raw = (os.environ.get("SEALV_DB") or "").strip()
    return (Path(raw).expanduser() if raw else DEFAULT_DB_PATH).resolve()


def connect(db_path: str | os.PathLike | None = None, *, timeout: float = 30.0) -> sqlite3.Connection:
    """Open the database with the pragmas this service depends on.

    `isolation_level=None` puts the driver in autocommit and hands transaction
    control back to us. That is not a performance choice: Python's implicit
    transaction management issues a plain `BEGIN`, and `claim_job` needs
    `BEGIN IMMEDIATE` specifically (see there for why deferred is unsafe here).

    WAL lets the API read while a worker writes, which is the whole access
    pattern - poll `GET /v1/jobs/{id}` while the worker streams progress into
    the same row.
    """
    path = Path(db_path) if db_path is not None else default_db_path()
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(path), timeout=timeout, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA synchronous = NORMAL")
    # The Python-level `timeout` only covers the driver's own retry; the pragma
    # is what the C busy handler reads when a second writer collides mid-claim.
    conn.execute(f"PRAGMA busy_timeout = {int(timeout * 1000)}")
    return conn


def init_db(conn: sqlite3.Connection) -> sqlite3.Connection:
    """Apply schema.sql. Idempotent - every statement in it is IF NOT EXISTS."""
    conn.executescript(SCHEMA_PATH.read_text())
    # executescript commits, and PRAGMA foreign_keys is a no-op inside a
    # transaction, so re-assert it rather than trust the script's copy.
    conn.execute("PRAGMA foreign_keys = ON")
    _widen(conn)
    _relax(conn)
    return conn


def _widen(conn: sqlite3.Connection) -> None:
    """Add columns that postdate a database's creation.

    `CREATE TABLE IF NOT EXISTS` creates a missing table and then leaves an
    existing one exactly as it found it, so a database made before a column
    existed never grows it - and the survey archive on the boat is precisely the
    database nobody is going to recreate. Each entry here is additive with a
    default, which is the only kind of change SQLite's ALTER can do online.
    """
    for table, column, ddl in (
        ("job", "attempts", "ALTER TABLE job ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0"),
        ("media", "content_hash", "ALTER TABLE media ADD COLUMN content_hash TEXT"),
        ("survey", "lat", "ALTER TABLE survey ADD COLUMN lat REAL"),
        ("survey", "lng", "ALTER TABLE survey ADD COLUMN lng REAL"),
        ("survey", "location_source", "ALTER TABLE survey ADD COLUMN location_source TEXT"),
        ("survey", "retired_at", "ALTER TABLE survey ADD COLUMN retired_at TEXT"),
        ("survey", "retired_reason", "ALTER TABLE survey ADD COLUMN retired_reason TEXT"),
        ("survey", "retired_by", "ALTER TABLE survey ADD COLUMN retired_by TEXT"),
        # A quick count is one frame cut out of a clip and ingested as a still.
        # The band it gets says `single_image`, which is true but incomplete:
        # the reader also needs to know it could have had a cross-frame band and
        # deliberately did not. Keeping the clip's name and the frame's second
        # here means that survives a reload; keeping it only in the operator's
        # note meant it survived until someone edited the note.
        ("survey", "from_video", "ALTER TABLE survey ADD COLUMN from_video TEXT"),
        ("survey", "at_seconds", "ALTER TABLE survey ADD COLUMN at_seconds REAL"),
        # Nullable with no default, which is the only shape SQLite will accept
        # for an added REFERENCES column - and the only shape that is correct:
        # every existing run reaches its survey through its media.
        ("run", "survey_id", "ALTER TABLE run ADD COLUMN survey_id TEXT REFERENCES survey(id)"),
    ):
        have = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in have:
            conn.execute(ddl)
    # The column above is worth nothing without the index: the duplicate check
    # runs on every upload, and a full scan of `media` on a season's archive is
    # exactly the kind of cost that gets a safety check switched off. CREATE
    # INDEX IF NOT EXISTS is idempotent, so it needs no guard of its own - only
    # the column, which has to exist first.
    conn.execute("CREATE INDEX IF NOT EXISTS ix_media_hash ON media(content_hash)")


def _relax(conn: sqlite3.Connection) -> None:
    """Drop the NOT NULL from `run.job_id` and `run.media_id`. Idempotent.

    This is the one migration in this schema that is not additive, and it is
    here because SQLite's ALTER cannot relax a constraint: the only way is the
    12-step table rebuild from the SQLite docs. It is needed for a single row
    shape - a ground count, which ran no job and has no media (see the comment
    on `run` in schema.sql).

    The guard is the point. `PRAGMA table_info` reports `notnull` per column, so
    a database already rebuilt returns immediately and the boat's archive is
    rewritten exactly once, on the first start after this ships.

    Three things keep the rewrite safe on real data:

      * `PRAGMA foreign_keys=OFF` OUTSIDE the transaction. It is a no-op inside
        one, and with foreign keys still on, `DROP TABLE run` would cascade -
        deleting every `point` and every `edit` in the archive. That is the
        whole survey's evidence, and it would look like a successful start.
      * one IMMEDIATE transaction, so a crash mid-rewrite rolls back to the old
        table rather than leaving neither.
      * an EXPLICIT column list on the copy. `SELECT *` would bind by position,
        so a future column added to one side and not the other would silently
        shift every value one column left - counts landing in `seconds`.

    `PRAGMA foreign_key_check` has to come back empty, and it runs INSIDE the
    transaction. Run after the commit it was still a refusal to start, but over
    a database that had already been rewritten - "we detected the damage and
    kept it" - and the recovery story on a boat is a backup nobody took. Inside,
    the raise rolls the whole rebuild back, the archive is byte-for-byte what it
    was, and the next start retries against the original.
    """
    cols = {row["name"]: row["notnull"] for row in conn.execute("PRAGMA table_info(run)")}
    if not cols:
        return  # no `run` table yet - schema.sql just created it in the new shape
    if not (cols.get("job_id") or cols.get("media_id")):
        return  # already relaxed

    # Outside the transaction: SQLite ignores this pragma while one is open.
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        with _tx(conn, "IMMEDIATE"):
            conn.execute(
                """CREATE TABLE run_new (
                       id             TEXT PRIMARY KEY,
                       job_id         TEXT REFERENCES job(id) ON DELETE CASCADE,
                       media_id       TEXT REFERENCES media(id) ON DELETE CASCADE,
                       survey_id      TEXT REFERENCES survey(id),
                       engine         TEXT NOT NULL,
                       engine_params  TEXT,
                       count_low      INTEGER,
                       count_best     INTEGER,
                       count_high     INTEGER,
                       basis          TEXT,
                       quality        TEXT,
                       seconds        REAL,
                       created_at     TEXT NOT NULL DEFAULT (datetime('now'))
                   )"""
            )
            conn.execute(
                """INSERT INTO run_new
                       (id, job_id, media_id, survey_id, engine, engine_params,
                        count_low, count_best, count_high, basis, quality,
                        seconds, created_at)
                   SELECT id, job_id, media_id, survey_id, engine, engine_params,
                          count_low, count_best, count_high, basis, quality,
                          seconds, created_at
                     FROM run"""
            )
            conn.execute("DROP TABLE run")
            conn.execute("ALTER TABLE run_new RENAME TO run")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_run_media ON run(media_id, created_at)")
            broken = conn.execute("PRAGMA foreign_key_check").fetchall()
            if broken:
                # Raising inside `with _tx(...)` rolls the rebuild back: the old
                # `run` table, its rows and every point and edit that hangs off
                # them are exactly as they were before this function ran.
                raise sqlite3.IntegrityError(
                    f"relaxing run.job_id/run.media_id left {len(broken)} dangling "
                    f"reference(s): {[tuple(r) for r in broken[:5]]}"
                )
    finally:
        # Re-asserted on every path. Leaving this connection with foreign keys
        # off would turn the next bad write in the same process into silent
        # corruption instead of an IntegrityError.
        conn.execute("PRAGMA foreign_keys = ON")


@contextmanager
def _tx(conn: sqlite3.Connection, mode: str = "DEFERRED") -> Iterator[None]:
    """Explicit transaction. Not reentrant - SQLite has no nested transactions,
    so no helper here opens one while another is open.

    COMMIT is inside the try because it can fail on its own: in WAL a writer
    that needs to wrap the log can still get SQLITE_BUSY at commit time while a
    reader holds an old snapshot, and the API polls this database twice a second
    per open SSE stream. An uncaught COMMIT failure would leave the transaction
    open, and every later `BEGIN` on that connection then dies with "cannot
    start a transaction within a transaction" - which in the worker's claim loop
    is not one failed job but a process wedged forever, still logging.

    The rollback is `conn.rollback()`, not `execute("ROLLBACK")`, and its result
    is deliberately ignored. The driver method is a no-op when no transaction is
    open, whereas the statement raises there - and raising out of the handler
    would replace the caller's real error (an IntegrityError, say) with a
    meaningless one from the cleanup.
    """
    conn.execute(f"BEGIN {mode}")
    try:
        yield
        conn.execute("COMMIT")
    except BaseException:
        try:
            conn.rollback()
        except Exception:
            pass
        raise


def _utcnow() -> str:
    """Timestamp in SQLite's `datetime('now')` format plus microseconds.

    Sharing the 'YYYY-MM-DD HH:MM:SS' prefix means these sort and compare
    against the DEFAULT-populated columns. The microseconds make a claim stamp
    unique per worker, which `claim_job` relies on when RETURNING is missing.
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")


#: Public alias. The API stamps `survey.retired_at` itself, and it has to sort
#: and compare against every other timestamp in the archive - a second copy of
#: that format string in another module is exactly how two timestamp columns
#: quietly stop being comparable.
utcnow = _utcnow


# --------------------------------------------------------------------------
# row <-> dict
# --------------------------------------------------------------------------

def _jsonable(value: Any) -> Any:
    """Last resort for json.dumps, so a write never fails on an exotic scalar.

    A numpy scalar exposes `.item()` and becomes a real int/float here; without
    it `default=str` would turn a per-frame count of 656 into the string "656"
    and the API would serve a quoted number. Anything with no `.item()` still
    degrades to its repr rather than raising - `quality` is diagnostics, and
    losing the run because one diagnostic field was odd is the worse trade.
    """
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return item()
        except Exception:
            pass  # e.g. a numpy array, where .item() needs size 1
    return str(value)


def _json_dump(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value  # already serialised; lets a caller pass raw JSON through
    if hasattr(value, "as_dict"):
        value = value.as_dict()  # contract dataclasses
    return json.dumps(value, separators=(",", ":"), default=_jsonable)


# sqlite3 binds anything supporting the buffer protocol as a BLOB, and a numpy
# scalar supports it. So `count_best=np.int64(576)` is accepted without a word
# and stored as eight raw bytes: it reads back as b'@\x02\x00...', SUM() over
# the column returns 0, and the API cannot even JSON-encode it. A wrong count
# reported as a successful run is the one failure this project cannot have, so
# every number crossing into the database is converted here - and refused
# loudly if it will not convert - rather than trusted to already be native.

def _as_int(value: Any, field: str) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except OverflowError as exc:  # int(inf) - a number, but not a whole one
        raise ValueError(f"{field} must be a finite integer, got {value!r}") from exc
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be an integer, got {value!r}") from exc


# inf and nan are refused here for the same reason numpy scalars are converted
# above: SQLite accepts them without complaint and the failure surfaces
# somewhere else entirely. An infinite `point.x` INSERTs cleanly and only
# explodes on the way out, in the JSON encoder, AFTER the transaction has
# committed - so every later read of that run 500s, `verified_count` counts a
# point at infinity as an animal, and no API call can undo it. A coordinate,
# a score and a duration are all measurements; none of them has a non-finite
# value, so the store is where that stops being representable.

def _as_float(value: Any, field: str) -> Optional[float]:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a number, got {value!r}") from exc
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError(f"{field} must be a finite number, got {value!r}")
    return number


def _json_load(value: Any) -> Any:
    if value is None or value == "":
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value  # legacy or hand-edited text - hand it back rather than crash


def _row(row: sqlite3.Row | None, table: str = "") -> Optional[dict]:
    if row is None:
        return None
    out = dict(row)
    for col in _JSON_COLUMNS.get(table, ()):
        if col in out:
            out[col] = _json_load(out[col])
    return out


def _rows(cursor: sqlite3.Cursor, table: str = "") -> list[dict]:
    return [_row(r, table) for r in cursor.fetchall()]


def _updates(fields: dict, allowed: tuple[str, ...], table: str) -> tuple[str, list]:
    unknown = set(fields) - set(allowed)
    if unknown:
        raise ValueError(f"{table}: not updatable: {sorted(unknown)}")
    json_cols = _JSON_COLUMNS.get(table, ())
    cols, vals = [], []
    for key, value in fields.items():
        cols.append(f"{key} = ?")
        vals.append(_json_dump(value) if key in json_cols else value)
    return ", ".join(cols), vals


# --------------------------------------------------------------------------
# site
# --------------------------------------------------------------------------

def create_site(
    conn: sqlite3.Connection,
    name: str,
    region: str | None = None,
    lat: float | None = None,
    lng: float | None = None,
    site_id: str | None = None,
) -> dict:
    sid = site_id or new_id()
    conn.execute(
        "INSERT INTO site (id, name, region, lat, lng) VALUES (?, ?, ?, ?, ?)",
        (sid, name, region, lat, lng),
    )
    return get_site(conn, sid)


def get_site(conn: sqlite3.Connection, site_id: str) -> Optional[dict]:
    return _row(conn.execute("SELECT * FROM site WHERE id = ?", (site_id,)).fetchone(), "site")


def list_sites(conn: sqlite3.Connection, limit: int = 500) -> list[dict]:
    return _rows(
        conn.execute("SELECT * FROM site ORDER BY name, id LIMIT ?", (limit,)), "site"
    )


def update_site(conn: sqlite3.Connection, site_id: str, **fields: Any) -> Optional[dict]:
    """Patch a site - naming a colony, mostly.

    A 2km cluster of sorties is a place, and until somebody names it the only
    thing this archive can call it is a pair of coordinates. The name is
    therefore the operator's contribution to the record, not a decoration: it
    follows the site into repeat surveys, the dynamics chart, the PDF and the
    exports, so every one of them says "Tyulenii Island" instead of 45.29/50.20.
    """
    if fields:
        setters, vals = _updates(fields, _SITE_UPDATABLE, "site")
        conn.execute(f"UPDATE site SET {setters} WHERE id = ?", (*vals, site_id))
    return get_site(conn, site_id)


# --------------------------------------------------------------------------
# survey
# --------------------------------------------------------------------------

def create_survey(
    conn: sqlite3.Connection,
    site_id: str | None = None,
    captured_at: str | None = None,
    altitude_m: float | None = None,
    gsd_cm_px: float | None = None,
    gsd_source: str | None = None,
    tide_state: str | None = None,
    sea_ice_pct: float | None = None,
    operator: str | None = None,
    notes: str | None = None,
    survey_id: str | None = None,
    lat: float | None = None,
    lng: float | None = None,
    location_source: str | None = None,
    from_video: str | None = None,
    at_seconds: float | None = None,
) -> dict:
    """Create a survey. `tide_state` and `sea_ice_pct` are worth capturing even
    when nothing reads them yet - haul-out counts swing enormously with both,
    and a trend line built without them looks meaningful and is wrong.

    `location_source` is stored beside `lat`/`lng` rather than inferred from
    which of them is set: telemetry, a dropped pin and a typed-in ground count
    all produce a coordinate, and only the label says which one this is.

    `from_video`/`at_seconds` are set only by a quick count - a single frame cut
    out of a clip and ingested as a still. They are the difference between "a
    photo" and "one second of a video someone chose not to analyse whole", and
    the second reading is the one a report has to be able to make."""
    sid = survey_id or new_id()
    conn.execute(
        """INSERT INTO survey
               (id, site_id, captured_at, altitude_m, gsd_cm_px, gsd_source,
                tide_state, sea_ice_pct, operator, notes,
                lat, lng, location_source, from_video, at_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (sid, site_id, captured_at, altitude_m, gsd_cm_px, gsd_source,
         tide_state, sea_ice_pct, operator, notes,
         _as_float(lat, "survey.lat"), _as_float(lng, "survey.lng"), location_source,
         from_video, _as_float(at_seconds, "survey.at_seconds")),
    )
    return get_survey(conn, sid)


def get_survey(conn: sqlite3.Connection, survey_id: str) -> Optional[dict]:
    return _row(
        conn.execute("SELECT * FROM survey WHERE id = ?", (survey_id,)).fetchone(), "survey"
    )


def update_survey(conn: sqlite3.Connection, survey_id: str, **fields: Any) -> Optional[dict]:
    """Patch a survey. Typically used to backfill `gsd_cm_px` once altitude is
    parsed out of the DJI track, which is what decides tiling."""
    if fields:
        setters, vals = _updates(fields, _SURVEY_UPDATABLE, "survey")
        conn.execute(f"UPDATE survey SET {setters} WHERE id = ?", (*vals, survey_id))
    return get_survey(conn, survey_id)


# --------------------------------------------------------------------------
# media
# --------------------------------------------------------------------------

def create_media(
    conn: sqlite3.Connection,
    path: str | os.PathLike,
    kind: str,
    survey_id: str | None = None,
    filename: str | None = None,
    width: int | None = None,
    height: int | None = None,
    duration_s: float | None = None,
    size_bytes: int | None = None,
    media_id: str | None = None,
    content_hash: str | None = None,
) -> dict:
    """Register a file. `kind` is validated because a video registered as an
    image silently takes the single-frame path and reports one frame's count as
    the whole sortie.

    `content_hash` is the SHA-256 of the bytes, and it is only ever a fact about
    them - nothing here rejects a repeat. Whether the same footage arriving
    twice is a mistake or a deliberate re-count is the operator's call, and this
    layer's job is to make the question answerable, not to answer it.

    `created_at` is stamped here with microseconds rather than left to the
    column default, for the reason `create_job` spells out: the default has
    one-second resolution, and the duplicate check orders by (created_at, id) to
    name the NEWEST copy already held. Three uploads of one file land inside the
    same second, so the tie would fall to `id` - random hex - and the operator
    would be shown an arbitrary one of the earlier copies while being told it
    was the last."""
    if kind not in MEDIA_KINDS:
        raise ValueError(f"media kind must be one of {MEDIA_KINDS}, got {kind!r}")
    mid = media_id or new_id()
    conn.execute(
        """INSERT INTO media
               (id, survey_id, path, filename, kind, width, height, duration_s,
                bytes, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (mid, survey_id, str(path), filename or Path(path).name, kind,
         width, height, duration_s, size_bytes, content_hash, _utcnow()),
    )
    return get_media(conn, mid)


def get_media(conn: sqlite3.Connection, media_id: str) -> Optional[dict]:
    return _row(
        conn.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone(), "media"
    )


def list_media(conn: sqlite3.Connection, survey_id: str | None = None, limit: int = 500) -> list[dict]:
    if survey_id is None:
        cur = conn.execute("SELECT * FROM media ORDER BY created_at, id LIMIT ?", (limit,))
    else:
        cur = conn.execute(
            "SELECT * FROM media WHERE survey_id = ? ORDER BY created_at, id LIMIT ?",
            (survey_id, limit),
        )
    return _rows(cur, "media")


# --------------------------------------------------------------------------
# track
# --------------------------------------------------------------------------

def insert_track_points(
    conn: sqlite3.Connection, media_id: str, points: Iterable[dict]
) -> int:
    """Bulk-insert a flight track in one transaction.

    A DJI SRT sidecar is one sample per frame - tens of thousands of rows for a
    sortie. One transaction rather than one per row is the difference between
    a second and several minutes, because every autocommit is an fsync.
    """
    rows = [
        (media_id, float(p["t"]), float(p["lat"]), float(p["lng"]),
         p.get("alt"), p.get("source"))
        for p in points
    ]
    if not rows:
        return 0
    with _tx(conn, "IMMEDIATE"):
        conn.executemany(
            "INSERT INTO track_point (media_id, t, lat, lng, alt, source) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
    return len(rows)


def get_track(conn: sqlite3.Connection, media_id: str) -> list[dict]:
    """Track points ordered by time, so a caller can bisect for a frame's t."""
    return _rows(
        conn.execute(
            "SELECT * FROM track_point WHERE media_id = ? ORDER BY t, id", (media_id,)
        ),
        "track_point",
    )


# --------------------------------------------------------------------------
# job
# --------------------------------------------------------------------------

def create_job(conn: sqlite3.Connection, media_id: str, params: Any = None,
               job_id: str | None = None) -> str:
    """Enqueue a job. `params` is a JobParams, a dict, or None.

    Returns the id rather than the row: the caller is answering
    `202 {"job_id": ...}` and does not need the rest.

    `created_at` is stamped here instead of by the column default because the
    default is `datetime('now')` - whole seconds. `claim_job` orders by
    (created_at, id) to take the oldest job, and a sortie is enqueued as a
    burst, so every job in it would share one timestamp and the tie would fall
    to `id`, which is random hex. The queue would drain in random order and
    `claim_job`'s promise of "the oldest queued job" would not hold. The
    microsecond stamp still sorts against any default-populated row, since it
    only appends to the same 'YYYY-MM-DD HH:MM:SS' prefix.
    """
    jid = job_id or new_id()
    conn.execute(
        "INSERT INTO job (id, media_id, params, status, created_at) "
        "VALUES (?, ?, ?, 'queued', ?)",
        (jid, media_id, _json_dump(params if params is not None else {}), _utcnow()),
    )
    return jid


def get_job(conn: sqlite3.Connection, job_id: str) -> Optional[dict]:
    return _row(conn.execute("SELECT * FROM job WHERE id = ?", (job_id,)).fetchone(), "job")


def update_job(conn: sqlite3.Connection, job_id: str, **fields: Any) -> Optional[dict]:
    """Patch a job. Reaching a terminal status stamps `finished_at` unless the
    caller supplied one, so nothing can report `done` with no completion time."""
    if fields:
        status = fields.get("status")
        if status is not None and status not in JOB_STATUSES:
            raise ValueError(f"job status must be one of {JOB_STATUSES}, got {status!r}")
        if status in TERMINAL_JOB_STATUSES and "finished_at" not in fields:
            fields = {**fields, "finished_at": _utcnow()}
        setters, vals = _updates(fields, _JOB_UPDATABLE, "job")
        conn.execute(f"UPDATE job SET {setters} WHERE id = ?", (*vals, job_id))
    return get_job(conn, job_id)


def list_jobs(
    conn: sqlite3.Connection,
    status: str | None = None,
    media_id: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    """Newest first. `offset` pages past the window `limit` cuts, so a caller
    watching a busy queue can walk the whole backlog instead of being told the
    first 200 jobs are all there are."""
    where, args = [], []
    if status is not None:
        where.append("status = ?")
        args.append(status)
    if media_id is not None:
        where.append("media_id = ?")
        args.append(media_id)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    return _rows(
        conn.execute(
            f"SELECT * FROM job {clause} ORDER BY created_at DESC, id DESC "
            "LIMIT ? OFFSET ?",
            (*args, limit, max(0, int(offset))),
        ),
        "job",
    )


_CLAIM_SQL = """
UPDATE job
   SET status = 'running', claimed_by = ?, claimed_at = ?, attempts = attempts + 1
 WHERE id = (SELECT id FROM job
              WHERE status = 'queued'
           ORDER BY created_at, id
              LIMIT 1)
"""


def claim_job(conn: sqlite3.Connection, worker_id: str) -> Optional[dict]:
    """Atomically take the oldest queued job. None when the queue is empty.

    Two things make this safe with N workers on the same file.

    `BEGIN IMMEDIATE` takes the write lock up front. A default deferred
    transaction starts as a reader and tries to upgrade on its first write; if
    another connection wrote in between, SQLite raises SQLITE_BUSY *without*
    consulting the busy handler, because waiting there could deadlock. So a
    deferred claim does not merely contend under load - it fails outright, and
    the busy_timeout never gets a chance to help. IMMEDIATE serialises claims
    and lets the timeout do its job.

    `UPDATE ... WHERE id = (SELECT ... LIMIT 1)` picks and takes the row in a
    single statement. Selecting the id and then updating it would be equally
    safe *here*, since we hold the write lock either way - but this is the form
    that survives the Postgres port, where the subselect grows FOR UPDATE SKIP
    LOCKED and there is no global write lock to hide a check-then-act race
    behind. Writing it the portable way now means the port is a string edit.

    The stamp is generated in Python, not by `datetime('now')`, so the claimed
    row is identifiable on SQLite builds without RETURNING: (worker_id, stamp)
    is unique because a worker cannot issue two claims in the same microsecond.
    """
    stamp = _utcnow()
    with _tx(conn, "IMMEDIATE"):
        if _HAS_RETURNING:
            # fetchall, not fetchone - the statement must be stepped to
            # completion before COMMIT or sqlite3 refuses the commit.
            found = conn.execute(_CLAIM_SQL + " RETURNING *", (worker_id, stamp)).fetchall()
            row = found[0] if found else None
        else:
            cur = conn.execute(_CLAIM_SQL, (worker_id, stamp))
            row = None
            if cur.rowcount:
                row = conn.execute(
                    "SELECT * FROM job WHERE claimed_by = ? AND claimed_at = ?",
                    (worker_id, stamp),
                ).fetchone()
    return _row(row, "job")


def heartbeat_job(
    conn: sqlite3.Connection, job_id: str, progress: Any = None
) -> Optional[dict]:
    """Refresh a claim's lease, optionally carrying new progress with it.

    A claim is a lease. `requeue_stale_jobs` decides a worker is dead by how
    long its `claimed_at` has stood still, so the process actually holding the
    job has to keep saying it is there - otherwise the only two ways to read
    `status='running'`, "working" and "died an hour ago", stay indistinguishable
    forever. One UPDATE of one row by primary key, next to minutes of inference.
    """
    fields: dict[str, Any] = {"claimed_at": _utcnow()}
    if progress is not None:
        fields["progress"] = progress
    return update_job(conn, job_id, **fields)


def requeue_stale_jobs(
    conn: sqlite3.Connection, lease_s: float, max_attempts: int = 3
) -> list[dict]:
    """Recover jobs whose worker died holding the claim. Returns what it did.

    A worker that is SIGKILLed, OOM-killed or unplugged never reaches the
    `except` that records a failure, so its row stays `running` with no process
    behind it: the queue skips it (it is not `queued`), `GET /jobs/{id}/events`
    keepalives at the operator forever with no terminal event, and `healthz`
    counts a worker that does not exist. Nothing in the system recovers from
    that on its own - a lease plus this sweep is what does.

    Recovery is bounded by `max_attempts`. Detection is a subprocess and a job
    heavy enough to OOM the box would otherwise be requeued, kill its worker,
    and be requeued again - a crash loop that jams the queue behind it. Out of
    attempts, the job is failed with that written in `error`, which is a survey
    team being told the truth rather than a spinner that never resolves.

    Each returned dict is {id, claimed_by, attempts, outcome} with outcome
    "queued" (will run again) or "failed" (gave up). Empty list = nothing stale,
    which is the normal case and is why this is cheap enough to run on a timer.
    """
    cutoff = (
        datetime.now(timezone.utc) - timedelta(seconds=max(0.0, float(lease_s)))
    ).strftime("%Y-%m-%d %H:%M:%S.%f")

    recovered: list[dict] = []
    # IMMEDIATE for the same reason as claim_job: this reads rows and then
    # writes them, and a claim landing in between would have this sweep hand a
    # live job back to the queue.
    with _tx(conn, "IMMEDIATE"):
        stale = conn.execute(
            "SELECT id, claimed_by, attempts FROM job "
            " WHERE status = 'running' AND (claimed_at IS NULL OR claimed_at < ?)",
            (cutoff,),
        ).fetchall()
        for row in stale:
            job_id, worker, attempts = row["id"], row["claimed_by"], row["attempts"] or 0
            gone = (
                f"worker {worker or '?'} stopped refreshing its claim for over "
                f"{int(lease_s)}s while running this job"
            )
            if attempts >= max_attempts:
                conn.execute(
                    "UPDATE job SET status = 'failed', error = ?, finished_at = ?, "
                    "claimed_by = NULL, claimed_at = NULL WHERE id = ?",
                    (f"{gone}; abandoned after {attempts} attempt(s)", _utcnow(), job_id),
                )
                outcome = "failed"
            else:
                conn.execute(
                    "UPDATE job SET status = 'queued', claimed_by = NULL, "
                    "claimed_at = NULL, error = ? WHERE id = ?",
                    (f"{gone}; requeued (attempt {attempts + 1})", job_id),
                )
                outcome = "queued"
            recovered.append(
                {"id": job_id, "claimed_by": worker, "attempts": attempts, "outcome": outcome}
            )
    return recovered


# --------------------------------------------------------------------------
# run + points
# --------------------------------------------------------------------------

def create_run(
    conn: sqlite3.Connection,
    job_id: str | None,
    media_id: str | None,
    engine: str,
    engine_params: Any = None,
    band: Any = None,
    quality: Any = None,
    seconds: float | None = None,
    run_id: str | None = None,
    survey_id: str | None = None,
) -> str:
    """Record one detection pass - or one person's count.

    `job_id` and `media_id` are both optional, and only a ground count leaves
    them out: nobody queued it and there is no footage. Every engine run fills
    both. Nothing is asserted about them here because the column constraints
    say it better - a run pointing at a job that does not exist is refused by
    the foreign key, and a run pointing at nothing is a manual observation.

    `band` is a CountBand, a dict with low/best/high/basis, or None (a run that
    failed before producing a count). It is duck-typed rather than imported so
    this module stays free of `contract` and can be used from a worker that
    only has the DB on its path. Duck-typing is why the three counts go through
    `_as_int`: nothing upstream guarantees they are native ints.

    `created_at` is stamped here with microseconds rather than left to the
    column default, which has one-second resolution. `list_runs` orders on it,
    and a job re-run inside the same second would otherwise be ordered by a
    random uuid - so `GET /v1/jobs/{id}`, which takes the first row, could serve
    the superseded count.
    """
    rid = run_id or new_id()
    low = best = high = basis = None
    if band is not None:
        b = band.as_dict() if hasattr(band, "as_dict") else dict(band)
        low = _as_int(b.get("low"), "band.low")
        best = _as_int(b.get("best"), "band.best")
        high = _as_int(b.get("high"), "band.high")
        basis = b.get("basis")
    conn.execute(
        """INSERT INTO run
               (id, job_id, media_id, survey_id, engine, engine_params,
                count_low, count_best, count_high, basis, quality, seconds,
                created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (rid, job_id, media_id, survey_id, engine, _json_dump(engine_params),
         low, best, high, basis, _json_dump(quality),
         _as_float(seconds, "seconds"), _utcnow()),
    )
    return rid


def get_run(conn: sqlite3.Connection, run_id: str) -> Optional[dict]:
    return _row(conn.execute("SELECT * FROM run WHERE id = ?", (run_id,)).fetchone(), "run")


def list_runs(
    conn: sqlite3.Connection,
    media_id: str | None = None,
    job_id: str | None = None,
    limit: int = 200,
) -> list[dict]:
    where, args = [], []
    if media_id is not None:
        where.append("media_id = ?")
        args.append(media_id)
    if job_id is not None:
        where.append("job_id = ?")
        args.append(job_id)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    return _rows(
        conn.execute(
            f"SELECT * FROM run {clause} ORDER BY created_at DESC, id DESC LIMIT ?",
            (*args, limit),
        ),
        "run",
    )


def create_observation(
    conn: sqlite3.Connection,
    count: int,
    captured_at: str,
    lat: float | None = None,
    lng: float | None = None,
    site_id: str | None = None,
    operator: str | None = None,
    notes: str | None = None,
    method: str | None = None,
) -> dict:
    """A ground count: one person, one place, one date, one number.

    Returns {"survey", "run"}, both written in a single transaction so the
    archive can never hold a survey whose count went missing.

    The count is stored as low = best = high, with `basis` = 'manual'. That is
    not a band pretending to be narrow - it is the honest shape of a human
    count, which has no cross-frame spread to measure because there were no
    frames. Every surface that renders a band has to read `basis` and say
    "counted by hand" rather than draw whiskers of width zero and imply a
    precision nobody claimed.

    `engine` is 'manual' for the same reason: the field that answers "what
    produced this number" must never answer "countgd" for a number CountGD
    never saw. `method` (binoculars, boat transect, ...) rides in `quality`
    where it can grow without a schema change; it is free text from the
    operator and nothing branches on it.
    """
    # Whole, non-negative, and actually a number. `_as_int` alone would round
    # 4.5 down to 4 and store a count nobody made; a count is the one value in
    # this archive that must never be silently adjusted.
    n = None if isinstance(count, bool) else _as_int(count, "observation.count")
    if n is None or n < 0 or n != count:
        raise ValueError(f"observation count must be a whole number >= 0, got {count!r}")
    with _tx(conn, "IMMEDIATE"):
        survey = create_survey(
            conn,
            site_id=site_id,
            captured_at=captured_at,
            operator=operator,
            notes=notes,
            lat=lat,
            lng=lng,
            location_source="manual",
        )
        run_id = create_run(
            conn,
            job_id=None,
            media_id=None,
            # The direct link. An engine run reaches its survey through its
            # media; with no media, this is the only thread back to the date,
            # the position and the site this count belongs to.
            survey_id=survey["id"],
            engine="manual",
            band={"low": n, "best": n, "high": n, "basis": "manual"},
            quality={"manual": True, "method": method},
            seconds=None,
        )
        run = get_run(conn, run_id)
    return {"survey": survey, "run": run}


def _point_values(run_id: str, point: Any) -> tuple:
    """Normalise one point into an INSERT tuple.

    Accepts a contract.Point, a plain dict, or a detection dict straight out of
    consensus.build()/tiling.nms(), which carry x1/y1 (equal to x2/y2 for
    points). Accepting that shape here means the worker hands its detector
    output over untouched instead of re-mapping keys and getting it wrong.
    """
    d = point.as_dict() if hasattr(point, "as_dict") else dict(point)
    x = d.get("x", d.get("x1"))
    y = d.get("y", d.get("y1"))
    if x is None or y is None:
        raise ValueError(f"point needs x/y (or x1/y1), got keys {sorted(d)}")
    status = d.get("status") or "auto"
    if status not in POINT_STATUSES:
        raise ValueError(f"point status must be one of {POINT_STATUSES}, got {status!r}")
    # Every numeric is converted, not just x/y: a numpy float32 score would
    # otherwise be stored as a 4-byte BLOB that no consumer can read back.
    return (
        run_id, _as_int(d.get("frame_idx"), "point.frame_idx"),
        _as_float(x, "point.x"), _as_float(y, "point.y"),
        _as_float(d.get("lat"), "point.lat"), _as_float(d.get("lng"), "point.lng"),
        _as_float(d.get("score"), "point.score"),
        _as_int(d.get("support"), "point.support"), status,
    )


def insert_points(conn: sqlite3.Connection, run_id: str, points: Iterable[Any]) -> int:
    """Bulk-insert detections in one transaction. Returns the number written."""
    rows = [_point_values(run_id, p) for p in points]
    if not rows:
        return 0
    with _tx(conn, "IMMEDIATE"):
        conn.executemany(
            """INSERT INTO point
                   (run_id, frame_idx, x, y, lat, lng, score, support, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
    return len(rows)


def get_points(conn: sqlite3.Connection, run_id: str, status: str | None = None) -> list[dict]:
    if status is None:
        cur = conn.execute("SELECT * FROM point WHERE run_id = ? ORDER BY id", (run_id,))
    else:
        cur = conn.execute(
            "SELECT * FROM point WHERE run_id = ? AND status = ? ORDER BY id",
            (run_id, status),
        )
    return _rows(cur, "point")


def get_point(conn: sqlite3.Connection, point_id: int) -> Optional[dict]:
    return _row(
        conn.execute("SELECT * FROM point WHERE id = ?", (point_id,)).fetchone(), "point"
    )


# --------------------------------------------------------------------------
# edits
# --------------------------------------------------------------------------

def add_edit(
    conn: sqlite3.Connection,
    run_id: str,
    op: str,
    point_id: int | None = None,
    x: float | None = None,
    y: float | None = None,
    operator: str | None = None,
) -> dict:
    """Append to the audit log. Deliberately no explicit transaction: a lone
    INSERT is atomic on its own, and leaving it unwrapped lets `apply_edit`
    call it inside its own transaction (SQLite has no nested transactions)."""
    if op not in EDIT_OPS:
        raise ValueError(f"edit op must be one of {EDIT_OPS}, got {op!r}")
    cur = conn.execute(
        "INSERT INTO edit (run_id, op, point_id, x, y, operator) VALUES (?, ?, ?, ?, ?, ?)",
        (run_id, op, _as_int(point_id, "edit.point_id"),
         _as_float(x, "edit.x"), _as_float(y, "edit.y"), operator),
    )
    return _row(
        conn.execute("SELECT * FROM edit WHERE id = ?", (cur.lastrowid,)).fetchone(), "edit"
    )


def list_edits(conn: sqlite3.Connection, run_id: str, limit: int = 1000) -> list[dict]:
    return _rows(
        conn.execute(
            "SELECT * FROM edit WHERE run_id = ? ORDER BY created_at, id LIMIT ?",
            (run_id, limit),
        ),
        "edit",
    )


#: What a verdict does to a point. One definition, because the single-point
#: and the batch path must never disagree about what "remove" means - the API
#: layer used to carry its own copy of this ternary.
STATUS_FOR_EDIT_OP: dict[str, str] = {
    "remove": "false_positive",
    "reinstate": "validated",
}

#: Ids per SQL statement. SQLite caps host parameters per statement (999 on
#: older builds, 32766 since 3.32); chunking keeps one IN-list from ever
#: hitting it, whatever interpreter the service is running under.
_ID_CHUNK = 900


def _chunks(items: list[int], n: int = _ID_CHUNK):
    for i in range(0, len(items), n):
        yield items[i:i + n]


def apply_edits_batch(
    conn: sqlite3.Connection,
    run_id: str,
    op: str,
    point_ids: Sequence[int],
    operator: str | None = None,
) -> dict:
    """One reviewer gesture over many points: one transaction, all or nothing.

    Returns {"updated", "point_ids", "verified_count"}.

    'Mark 400 selected rows as false positives' was 400 separate PATCHes, each
    opening its own IMMEDIATE transaction - 400 chances to lose SQLite's single
    writer lock to the counting worker, and 400 chances for the browser to give
    up halfway and leave the run half-edited.

    Every id is READ AND VALIDATED BEFORE the write transaction opens. The old
    batch did its membership SELECT per point inside IMMEDIATE, so at the API's
    5000-id cap it held the writer lock across 5000 statements while a caller
    typo was still able to roll the whole thing back. Points are append-only -
    nothing deletes a row or moves it between runs - so a membership fact
    established a moment earlier is still true inside the transaction.

    The `edit` log still gets one append-only row per point: that is the part
    that is evidence, and collapsing it into one row would lose which animals
    a reviewer actually ruled on.
    """
    if op not in STATUS_FOR_EDIT_OP:
        raise ValueError(
            f"batch edit op must be one of {sorted(STATUS_FOR_EDIT_OP)}, got {op!r}"
        )
    # A duplicated id is one verdict, not two log entries.
    ids = list(dict.fromkeys(int(p) for p in point_ids))
    if not ids:
        return {"updated": 0, "point_ids": [], "verified_count": verified_count(conn, run_id)}

    coords: dict[int, tuple[float, float]] = {}
    for chunk in _chunks(ids):
        marks = ",".join("?" * len(chunk))
        for row in conn.execute(
            f"SELECT id, x, y FROM point WHERE run_id = ? AND id IN ({marks})",
            (run_id, *chunk),
        ):
            coords[int(row["id"])] = (float(row["x"]), float(row["y"]))
    missing = [p for p in ids if p not in coords]
    if missing:
        raise ValueError(f"point {missing[0]} does not belong to run {run_id}")

    status = STATUS_FOR_EDIT_OP[op]
    with _tx(conn, "IMMEDIATE"):
        for chunk in _chunks(ids):
            marks = ",".join("?" * len(chunk))
            conn.execute(
                f"UPDATE point SET status = ? WHERE run_id = ? AND id IN ({marks})",
                (status, run_id, *chunk),
            )
        for pid in ids:
            px, py = coords[pid]
            add_edit(conn, run_id, op, point_id=pid, x=px, y=py, operator=operator)

    return {
        "updated": len(ids),
        "point_ids": ids,
        "verified_count": verified_count(conn, run_id),
    }


def apply_edit(
    conn: sqlite3.Connection,
    run_id: str,
    op: str,
    point_id: int | None = None,
    x: float | None = None,
    y: float | None = None,
    operator: str | None = None,
    frame_idx: int | None = None,
    lat: float | None = None,
    lng: float | None = None,
) -> dict:
    """Apply an operator correction and log it, atomically.

    Returns {"op", "edit", "point"}.

      add        - operator marked an animal the detector missed. The new point
                   is born `validated`, not `auto`: a human put it there, which
                   is a stronger signal than anything the model asserts.
      remove     - the point becomes `false_positive`. Never a DELETE. Which
                   detections an operator rejected is survey evidence, and it is
                   also the only recall/precision data this system will ever
                   have (§7: there is no ground truth anywhere in this work).
      reinstate  - back to `validated`, for undo.

    The `edit` row and the `point` mutation go in one transaction, so the log
    can never disagree with the state it describes.
    """
    if op not in EDIT_OPS:
        raise ValueError(f"edit op must be one of {EDIT_OPS}, got {op!r}")

    with _tx(conn, "IMMEDIATE"):
        if op == "add":
            if x is None or y is None:
                raise ValueError("edit op 'add' needs x and y")
            px, py = _as_float(x, "x"), _as_float(y, "y")
            cur = conn.execute(
                """INSERT INTO point
                       (run_id, frame_idx, x, y, lat, lng, score, support, status)
                   VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'validated')""",
                (run_id, _as_int(frame_idx, "frame_idx"), px, py,
                 _as_float(lat, "lat"), _as_float(lng, "lng")),
            )
            point_id = int(cur.lastrowid)
        else:
            if point_id is None:
                raise ValueError(f"edit op {op!r} needs point_id")
            existing = conn.execute(
                "SELECT * FROM point WHERE id = ? AND run_id = ?", (point_id, run_id)
            ).fetchone()
            if existing is None:
                raise ValueError(f"point {point_id} does not belong to run {run_id}")
            conn.execute(
                "UPDATE point SET status = ? WHERE id = ?",
                (STATUS_FOR_EDIT_OP[op], point_id),
            )
            px = float(existing["x"]) if x is None else float(x)
            py = float(existing["y"]) if y is None else float(y)

        edit = add_edit(conn, run_id, op, point_id=point_id, x=px, y=py, operator=operator)
        point = _row(
            conn.execute("SELECT * FROM point WHERE id = ?", (point_id,)).fetchone(), "point"
        )

    return {"op": op, "edit": edit, "point": point}


def verified_count(conn: sqlite3.Connection, run_id: str) -> int:
    """Points an operator has not rejected - the number to export.

    `auto` counts: the operator confirming every one of 656 detections is not a
    workflow anyone will complete, so unreviewed means still counted, and
    rejection is the explicit act.
    """
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM point WHERE run_id = ? AND status != 'false_positive'",
        (run_id,),
    ).fetchone()
    return int(row["n"])


# --------------------------------------------------------------------------
# self-test
# --------------------------------------------------------------------------

if __name__ == "__main__":
    import shutil
    import sys
    import tempfile
    import threading
    import time

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from contract import CountBand, JobParams, Point, auto_tile_px, gsd_from_altitude

    PASSED, FAILED = [], []

    def check(name: str, ok: bool, detail: Any = "") -> bool:
        (PASSED if ok else FAILED).append(name)
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))
        return ok

    def raises(name: str, exc: type, fn, *a, **kw) -> None:
        try:
            fn(*a, **kw)
        except exc as e:
            check(name, True, type(e).__name__)
        except Exception as e:  # noqa: BLE001 - wrong exception type is the failure
            check(name, False, f"expected {exc.__name__}, got {type(e).__name__}: {e}")
        else:
            check(name, False, f"expected {exc.__name__}, nothing raised")

    tmp = Path(tempfile.mkdtemp(prefix="sealv-db-selftest-"))
    db_file = tmp / "sealv.db"
    try:
        # --- connection ------------------------------------------------
        os.environ["SEALV_DB"] = str(db_file)
        # Compared resolved: default_db_path resolves, and macOS hands
        # tempfile a /var path that is a symlink to /private/var.
        check("default_db_path honours $SEALV_DB", default_db_path() == db_file.resolve())

        os.environ["SEALV_DB"] = ""
        check(
            "default_db_path treats a blank $SEALV_DB as unset",
            default_db_path() == DEFAULT_DB_PATH.resolve(),
            # Blank would otherwise be Path("") -> sqlite's private temporary
            # database, which discards every write when the connection closes.
        )
        os.environ["SEALV_DB"] = str(db_file)

        conn = connect()
        init_db(conn)
        init_db(conn)  # idempotent
        check("connect uses WAL",
              conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal")
        check("connect enables foreign_keys",
              conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1)
        check("init_db is idempotent",
              conn.execute(
                  "SELECT COUNT(*) FROM sqlite_master WHERE type='table'"
              ).fetchone()[0] >= 8)

        ids = {new_id() for _ in range(2000)}
        check("new_id is 12 hex chars and unique", len(ids) == 2000 and all(len(i) == 12 for i in ids))

        # --- site ------------------------------------------------------
        site = create_site(conn, "Tyulenii Island", region="KZ-North", lat=45.29, lng=50.20)
        check("create_site returns a plain dict",
              isinstance(site, dict) and not isinstance(site, sqlite3.Row))
        check("get_site round-trips", get_site(conn, site["id"])["name"] == "Tyulenii Island")
        check("get_site on a missing id is None", get_site(conn, "nope") is None)
        create_site(conn, "Kendirli")
        check("list_sites returns both", len(list_sites(conn)) == 2)

        renamed = update_site(conn, site["id"], name="Tyuleniy (north spit)")
        check("update_site renames a colony", renamed["name"] == "Tyuleniy (north spit)")
        check("update_site leaves the rest of the row alone",
              renamed["region"] == "KZ-North" and abs(renamed["lat"] - 45.29) < 1e-9)
        raises("update_site rejects unknown columns", ValueError,
               update_site, conn, site["id"], population=4000)
        check("update_site on a missing id is None", update_site(conn, "nope") is None)
        update_site(conn, site["id"], name="Tyulenii Island")  # back, later checks read it

        # --- survey ----------------------------------------------------
        # Full-frame width, not the 1698px crop the engine benchmarks used:
        # gsd_from_altitude divides by the sensor's pixel count, so feeding it a
        # crop width reports a GSD several times too coarse and auto_tile_px
        # then floors at its 120px minimum. That is the plan's §5 assumption.
        FULL_FRAME_PX = 5472
        gsd = gsd_from_altitude(120.0, FULL_FRAME_PX)
        survey = create_survey(
            conn, site_id=site["id"], captured_at="2026-08-06T07:14:00Z",
            altitude_m=120.0, gsd_cm_px=gsd, tide_state="low",
            sea_ice_pct=0.0, operator="a.n", notes="morning sortie",
        )
        check("create_survey stores gsd", abs(survey["gsd_cm_px"] - gsd) < 1e-9, f"{gsd:.2f} cm/px")
        check("get_survey round-trips", get_survey(conn, survey["id"])["tide_state"] == "low")
        # The plan's §5 table, on the GSDs it quotes.
        check("auto_tile_px: 3.1 cm/px (target ~42px) is whole frame", auto_tile_px(3.1) == 0)
        check("auto_tile_px: 5.2 cm/px (target ~25px) tiles at 250px", auto_tile_px(5.2) == 250)

        survey = update_survey(conn, survey["id"], altitude_m=200.0,
                               gsd_cm_px=gsd_from_altitude(200.0, FULL_FRAME_PX),
                               tide_state="falling")
        check("update_survey patches fields", survey["tide_state"] == "falling")
        check("stored gsd survives the round-trip into auto_tile_px",
              auto_tile_px(survey["gsd_cm_px"]) > 0,
              f"{survey['gsd_cm_px']:.2f} cm/px -> {auto_tile_px(survey['gsd_cm_px'])}px tiles")
        raises("update_survey rejects unknown columns", ValueError,
               update_survey, conn, survey["id"], bogus=1)
        check("get_survey on a missing id is None", get_survey(conn, "nope") is None)

        # --- media -----------------------------------------------------
        video = create_media(conn, tmp / "DJI_0100.MP4", "video", survey_id=survey["id"],
                             width=720, height=1280, duration_s=12.5, size_bytes=4_200_000)
        still = create_media(conn, tmp / "haulout.jpg", "image", survey_id=survey["id"],
                             width=1698, height=1082, size_bytes=910_000)
        orphan = create_media(conn, tmp / "loose.jpg", "image", width=100, height=100)
        check("create_media derives filename", video["filename"] == "DJI_0100.MP4")
        check("get_media round-trips", get_media(conn, still["id"])["width"] == 1698)
        check("list_media filters by survey", len(list_media(conn, survey_id=survey["id"])) == 2)
        check("list_media unfiltered returns all", len(list_media(conn)) == 3, orphan["id"])
        raises("create_media rejects a bad kind", ValueError,
               create_media, conn, tmp / "x.tif", "raster")
        check("get_media on a missing id is None", get_media(conn, "nope") is None)
        digest = "a" * 64
        hashed = create_media(conn, tmp / "again.jpg", "image", width=10, height=10,
                              content_hash=digest)
        check("create_media stores the content hash", hashed["content_hash"] == digest)
        check("content_hash is a fact, not a constraint - a repeat still lands",
              create_media(conn, tmp / "again2.jpg", "image",
                           content_hash=digest)["content_hash"] == digest)
        check("media with no hash records NULL, not a fake one",
              still["content_hash"] is None)
        check("create_media stamps created_at to the microsecond",
              len({m["created_at"] for m in list_media(conn)}) == len(list_media(conn)),
              # Three uploads of one file land in the same second; without this
              # "the newest copy already held" ties on random hex and the
              # duplicate warning names an arbitrary earlier one.
              )
        check("the hash lookup is indexed",
              "SEARCH" in " ".join(
                  r["detail"] for r in conn.execute(
                      "EXPLAIN QUERY PLAN SELECT id FROM media WHERE content_hash = ?",
                      (digest,))),
              # A full scan of a season's media on every upload is how a
              # duplicate check gets switched off.
              )

        # --- track -----------------------------------------------------
        n = insert_track_points(conn, video["id"], [
            {"t": 3.0, "lat": 45.291, "lng": 50.202, "alt": 120.0, "source": "srt"},
            {"t": 0.0, "lat": 45.290, "lng": 50.200, "alt": 120.0, "source": "srt"},
            {"t": 1.5, "lat": 45.2905, "lng": 50.201, "alt": 121.0, "source": "srt"},
        ])
        track = get_track(conn, video["id"])
        check("insert_track_points bulk-inserts", n == 3 and len(track) == 3)
        check("get_track is ordered by t", [p["t"] for p in track] == [0.0, 1.5, 3.0])
        check("insert_track_points on empty is a no-op",
              insert_track_points(conn, video["id"], []) == 0)
        check("get_track on media with no track is empty", get_track(conn, still["id"]) == [])

        # --- job -------------------------------------------------------
        params = JobParams(target="seal", threshold=0.23, tiling="auto")
        job_id = create_job(conn, video["id"], params)
        job = get_job(conn, job_id)
        check("create_job returns an id", isinstance(job_id, str) and len(job_id) == 12)
        check("job.params round-trips as a dict",
              isinstance(job["params"], dict) and job["params"]["sampling"]["every_s"] == 1.5)
        check("new job is queued", job["status"] == "queued")

        job = update_job(conn, job_id, status="running",
                         progress={"frames_done": 3, "frames_total": 8, "stage": "detect"})
        check("update_job stores progress as a dict",
              isinstance(job["progress"], dict) and job["progress"]["frames_done"] == 3)
        check("running job has no finished_at", job["finished_at"] is None)
        job = update_job(conn, job_id, status="done")
        check("terminal status stamps finished_at", job["finished_at"] is not None,
              job["finished_at"])
        raises("update_job rejects a bad status", ValueError,
               update_job, conn, job_id, status="finished")
        raises("update_job rejects unknown columns", ValueError,
               update_job, conn, job_id, nonsense=1)
        check("get_job on a missing id is None", get_job(conn, "nope") is None)

        create_job(conn, still["id"], {"target": "seal"})
        check("list_jobs filters by status", len(list_jobs(conn, status="queued")) == 1)
        check("list_jobs filters by media", len(list_jobs(conn, media_id=video["id"])) == 1)
        check("list_jobs unfiltered returns all", len(list_jobs(conn)) == 2)

        raises("foreign keys are enforced", sqlite3.IntegrityError,
               create_job, conn, "no-such-media", {})

        # The queue must be FIFO within one second, which the column default
        # (whole seconds, tie broken by random hex id) cannot deliver.
        fifo_conn = connect(tmp / "fifo.db")
        init_db(fifo_conn)
        fifo_media = create_media(fifo_conn, tmp / "f.jpg", "image")["id"]
        enqueued = [create_job(fifo_conn, fifo_media, {"i": i}) for i in range(15)]
        drained = []
        while (j := claim_job(fifo_conn, "w")) is not None:
            drained.append(j["id"])
        check("create_job stamps created_at to the microsecond",
              len({r["created_at"] for r in
                   _rows(fifo_conn.execute("SELECT created_at FROM job"))}) == 15)
        check("claim_job drains in enqueue order inside one second",
              drained == enqueued, f"{len(drained)} jobs")
        fifo_conn.close()

        # --- claim_job, single worker ----------------------------------
        claimed = claim_job(conn, "worker-solo")
        check("claim_job takes the queued job",
              claimed is not None and claimed["status"] == "running"
              and claimed["claimed_by"] == "worker-solo" and claimed["claimed_at"] is not None)
        check("claim_job returns a plain dict",
              isinstance(claimed, dict) and isinstance(claimed["params"], dict))
        check("claim_job on an empty queue returns None", claim_job(conn, "worker-solo") is None)

        # --- the claim is a lease --------------------------------------
        # Its own database: these sweeps are global over `status='running'`,
        # and running them against `conn` would recover jobs the checks below
        # are still using.
        lease_conn = init_db(connect(tmp / "lease.db"))
        lease_media = create_media(lease_conn, tmp / "l.jpg", "image")["id"]
        lease_job = create_job(lease_conn, lease_media, {"target": "seal"})
        taken = claim_job(lease_conn, "worker-doomed")
        check("claim_job counts the attempt", taken["attempts"] == 1)
        check("a claim that is still being refreshed is not stale",
              requeue_stale_jobs(lease_conn, 3600, 3) == [])

        # lease_s=0 makes every live claim older than the cutoff, which is what
        # a claim looks like once the worker holding it has stopped saying so.
        recovered = requeue_stale_jobs(lease_conn, 0, 3)
        check("an expired lease is recovered",
              [r["id"] for r in recovered] == [lease_job]
              and recovered[0]["outcome"] == "queued", recovered)
        back = get_job(lease_conn, lease_job)
        check("a recovered job is queued again with the claim cleared",
              back["status"] == "queued" and back["claimed_by"] is None
              and back["claimed_at"] is None)
        check("a recovered job records why it was requeued",
              "stopped refreshing" in (back["error"] or ""), back["error"])
        check("a recovered job is claimable again, not duplicated",
              claim_job(lease_conn, "worker-live")["id"] == lease_job)
        check("the second claim is counted too",
              get_job(lease_conn, lease_job)["attempts"] == 2)

        heartbeat_job(lease_conn, lease_job, progress={"stage": "detect"})
        check("heartbeat_job keeps a live job out of the sweep",
              requeue_stale_jobs(lease_conn, 3600, 3) == [])
        check("heartbeat_job carries progress with it",
              get_job(lease_conn, lease_job)["progress"]["stage"] == "detect")

        # Bounded, or a job that kills its worker is requeued forever.
        gave_up = requeue_stale_jobs(lease_conn, 0, max_attempts=2)
        dead = get_job(lease_conn, lease_job)
        check("recovery gives up at max_attempts",
              gave_up and gave_up[0]["outcome"] == "failed"
              and dead["status"] == "failed" and dead["finished_at"] is not None,
              dead["status"])
        check("the job recovery gave up on says so", "abandoned" in (dead["error"] or ""))
        check("a job already failed is not swept again",
              requeue_stale_jobs(lease_conn, 0, 2) == [])

        # A running row with no stamp at all cannot be dated. Treating it as
        # fresh would mean it is never recovered, which is the bug this exists
        # to close.
        unstamped = create_job(lease_conn, lease_media, {})
        update_job(lease_conn, unstamped, status="running",
                   claimed_by="ghost", claimed_at=None)
        check("a running job with no claim stamp is stale",
              [r["id"] for r in requeue_stale_jobs(lease_conn, 3600, 3)] == [unstamped])
        lease_conn.close()

        # A database made before `attempts` existed has to grow the column:
        # CREATE TABLE IF NOT EXISTS creates a missing table and then leaves an
        # existing one exactly as it found it.
        older = connect(tmp / "older.db")
        older.executescript(
            "CREATE TABLE job (id TEXT PRIMARY KEY, media_id TEXT, params TEXT, "
            "status TEXT, progress TEXT, error TEXT, claimed_by TEXT, "
            "claimed_at TEXT, created_at TEXT, finished_at TEXT)"
        )
        init_db(older)
        check("init_db widens a job table that predates `attempts`",
              "attempts" in {r["name"] for r in older.execute("PRAGMA table_info(job)")})
        check("widening is idempotent", init_db(older) is older)
        older.close()

        # --- the run rebuild, against a database in the OLD shape ------------
        # The only non-additive migration in this schema, and the one that runs
        # against the boat's archive on the next start. Everything below is what
        # "it worked" has to mean: the constraint is gone, and NOTHING ELSE
        # moved - the points and edits hanging off those runs above all, since
        # a DROP TABLE with foreign keys still on would cascade them away and
        # the service would come up looking healthy with the evidence deleted.
        legacy = connect(tmp / "legacy.db")
        legacy.executescript(
            """
            CREATE TABLE media (id TEXT PRIMARY KEY, survey_id TEXT, path TEXT NOT NULL,
                filename TEXT, kind TEXT NOT NULL, width INTEGER, height INTEGER,
                duration_s REAL, bytes INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE TABLE job (id TEXT PRIMARY KEY,
                media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                params TEXT NOT NULL, status TEXT NOT NULL, progress TEXT, error TEXT,
                claimed_by TEXT, claimed_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT);
            -- the old shape: both columns NOT NULL
            CREATE TABLE run (id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
                media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                engine TEXT NOT NULL, engine_params TEXT, count_low INTEGER,
                count_best INTEGER, count_high INTEGER, basis TEXT, quality TEXT,
                seconds REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE INDEX ix_run_media ON run(media_id, created_at);
            CREATE TABLE point (id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
                frame_idx INTEGER, x REAL NOT NULL, y REAL NOT NULL, lat REAL, lng REAL,
                score REAL, support INTEGER, status TEXT NOT NULL DEFAULT 'auto');
            CREATE TABLE edit (id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
                op TEXT NOT NULL, point_id INTEGER, x REAL, y REAL, operator TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')));
            INSERT INTO media (id, path, kind) VALUES ('m-old', '/tmp/a.jpg', 'image');
            INSERT INTO job (id, media_id, params, status)
                 VALUES ('j-old', 'm-old', '{}', 'done');
            INSERT INTO run (id, job_id, media_id, engine, count_low, count_best,
                             count_high, basis, seconds, created_at)
                 VALUES ('r-old', 'j-old', 'm-old', 'countgd', 401, 576, 656,
                         'consensus_4_frames', 214.6, '2026-01-02 03:04:05.000001');
            INSERT INTO point (run_id, x, y, status) VALUES ('r-old', 1.0, 2.0, 'auto');
            INSERT INTO point (run_id, x, y, status)
                 VALUES ('r-old', 3.0, 4.0, 'false_positive');
            INSERT INTO edit (run_id, op, point_id) VALUES ('r-old', 'remove', 2);
            """
        )
        check("the legacy fixture really is the old shape",
              all(r["notnull"] == 1 for r in legacy.execute("PRAGMA table_info(run)")
                  if r["name"] in ("job_id", "media_id")))
        init_db(legacy)

        relaxed = {r["name"]: r["notnull"] for r in legacy.execute("PRAGMA table_info(run)")}
        check("init_db relaxes run.job_id and run.media_id to NULLable",
              relaxed.get("job_id") == 0 and relaxed.get("media_id") == 0, relaxed)
        old_run = get_run(legacy, "r-old")
        check("the rebuilt run kept every value, in the right column",
              old_run is not None
              and (old_run["job_id"], old_run["media_id"], old_run["engine"]) ==
                  ("j-old", "m-old", "countgd")
              and (old_run["count_low"], old_run["count_best"], old_run["count_high"]) ==
                  (401, 576, 656)
              and old_run["basis"] == "consensus_4_frames"
              and abs(old_run["seconds"] - 214.6) < 1e-9
              and old_run["created_at"] == "2026-01-02 03:04:05.000001",
              old_run)
        check("the rebuild did not cascade the run's points away",
              legacy.execute("SELECT COUNT(*) FROM point").fetchone()[0] == 2)
        check("the rebuild did not cascade the run's edits away",
              legacy.execute("SELECT COUNT(*) FROM edit").fetchone()[0] == 1)
        check("the rebuilt run leaves no dangling reference",
              legacy.execute("PRAGMA foreign_key_check").fetchall() == [])
        check("foreign keys are back ON after the rebuild",
              legacy.execute("PRAGMA foreign_keys").fetchone()[0] == 1)
        check("ix_run_media survived the rebuild",
              legacy.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='index' "
                             "AND name='ix_run_media'").fetchone()[0] == 1)

        ddl_after_first = legacy.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'run'"
        ).fetchone()[0]
        init_db(legacy)  # the guard has to make the second pass a no-op
        check("relaxing twice rebuilds nothing",
              legacy.execute("SELECT sql FROM sqlite_master WHERE name='run'").fetchone()[0]
              == ddl_after_first
              and legacy.execute("SELECT COUNT(*) FROM run").fetchone()[0] == 1
              and legacy.execute("SELECT COUNT(*) FROM point").fetchone()[0] == 2)
        check("the rebuilt run carries the survey link _widen added before it",
              "survey_id" in {r["name"] for r in legacy.execute("PRAGMA table_info(run)")}
              and get_run(legacy, "r-old")["survey_id"] is None)
        check("a legacy database also grows the new survey/media columns",
              {"lat", "lng", "location_source", "retired_at", "retired_reason",
               "retired_by", "from_video",
               "at_seconds"} <= {r["name"] for r in legacy.execute("PRAGMA table_info(survey)")}
              and "content_hash" in
                  {r["name"] for r in legacy.execute("PRAGMA table_info(media)")})
        # The point of the whole rebuild.
        manual = create_run(legacy, job_id=None, media_id=None, engine="manual",
                            band={"low": 12, "best": 12, "high": 12, "basis": "manual"})
        check("a run with no job and no media is now storable",
              get_run(legacy, manual)["count_best"] == 12)
        raises("a run still cannot point at a job that does not exist",
               sqlite3.IntegrityError, create_run, legacy, "no-such-job", None, "countgd")
        legacy.close()

        # --- the rebuild refuses over an UNTOUCHED archive -------------------
        # The integrity check has to fail the start AND leave the database
        # exactly as it found it. Run after the commit it did the first half
        # only: "we detected the damage and kept it", with the original gone and
        # the recovery story a backup nobody took. Seeded here with a point
        # whose run does not exist - written with foreign keys off, which is the
        # state a damaged archive actually arrives in.
        broken_path = tmp / "broken.db"
        broken = connect(broken_path)
        broken.executescript(
            """
            CREATE TABLE survey (id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE TABLE media (id TEXT PRIMARY KEY, survey_id TEXT, path TEXT NOT NULL,
                filename TEXT, kind TEXT NOT NULL, width INTEGER, height INTEGER,
                duration_s REAL, bytes INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE TABLE job (id TEXT PRIMARY KEY,
                media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                params TEXT NOT NULL, status TEXT NOT NULL, progress TEXT, error TEXT,
                claimed_by TEXT, claimed_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT);
            CREATE TABLE run (id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
                media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                survey_id TEXT REFERENCES survey(id),
                engine TEXT NOT NULL, engine_params TEXT, count_low INTEGER,
                count_best INTEGER, count_high INTEGER, basis TEXT, quality TEXT,
                seconds REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE TABLE point (id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
                frame_idx INTEGER, x REAL NOT NULL, y REAL NOT NULL, lat REAL, lng REAL,
                score REAL, support INTEGER, status TEXT NOT NULL DEFAULT 'auto');
            INSERT INTO media (id, path, kind) VALUES ('m-b', '/tmp/b.jpg', 'image');
            INSERT INTO job (id, media_id, params, status) VALUES ('j-b','m-b','{}','done');
            INSERT INTO run (id, job_id, media_id, engine) VALUES ('r-b','j-b','m-b','countgd');
            """
        )
        broken.execute("PRAGMA foreign_keys = OFF")
        broken.execute("INSERT INTO point (run_id, x, y) VALUES ('r-gone', 1.0, 2.0)")
        broken.commit()
        broken.execute("PRAGMA foreign_keys = ON")
        ddl_before = broken.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'run'"
        ).fetchone()[0]
        raises("a dangling reference fails the rebuild",
               sqlite3.IntegrityError, _relax, broken)
        check("the failed rebuild left the run table exactly as it was",
              broken.execute("SELECT sql FROM sqlite_master WHERE name='run'").fetchone()[0]
              == ddl_before
              and broken.execute("SELECT COUNT(*) FROM sqlite_master WHERE "
                                 "name='run_new'").fetchone()[0] == 0
              and broken.execute("SELECT COUNT(*) FROM run").fetchone()[0] == 1)
        check("foreign keys are back ON after the refused rebuild",
              broken.execute("PRAGMA foreign_keys").fetchone()[0] == 1)
        broken.close()

        # --- claim_job, two workers racing -----------------------------
        N_JOBS = 60
        for _ in range(N_JOBS):
            create_job(conn, still["id"], {"target": "seal"})

        results: dict[str, list[str]] = {}
        errors: list[str] = []
        start = threading.Barrier(2)

        def drain(worker: str) -> None:
            got: list[str] = []
            # Each thread needs its own connection: sqlite3 objects are not
            # shareable across threads, and a shared one would serialise the
            # very contention this is meant to exercise.
            c = connect(db_file)
            try:
                start.wait(timeout=10)
                while True:
                    j = claim_job(c, worker)
                    if j is None:
                        break
                    got.append(j["id"])
                    # Hold the job briefly and write to it, the way a real
                    # worker does while CountGD runs. Without this the claim is
                    # a few microseconds and whichever thread the scheduler
                    # happens to run first drains the whole queue alone - the
                    # invariants would still hold, but nothing would have raced.
                    update_job(c, j["id"], progress={"stage": "detect"})
                    time.sleep(0.001)
                    update_job(c, j["id"], status="done")
            except Exception as e:  # noqa: BLE001 - report, do not kill the run
                errors.append(f"{worker}: {type(e).__name__}: {e}")
            finally:
                c.close()
                results[worker] = got

        threads = [threading.Thread(target=drain, args=(w,)) for w in ("worker-a", "worker-b")]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)

        a, b = results.get("worker-a", []), results.get("worker-b", [])
        check("concurrent claim: no worker errored", not errors, "; ".join(errors))
        check("concurrent claim: every job claimed", len(a) + len(b) == N_JOBS,
              f"a={len(a)} b={len(b)} of {N_JOBS}")
        check("concurrent claim: no job claimed twice",
              len(set(a) | set(b)) == len(a) + len(b) == N_JOBS)
        check("concurrent claim: both workers got work", len(a) > 0 and len(b) > 0,
              f"a={len(a)} b={len(b)}")
        check("concurrent claim: queue is drained",
              conn.execute("SELECT COUNT(*) FROM job WHERE status='queued'").fetchone()[0] == 0)
        check("concurrent claim: claimed_by matches who claimed it",
              all(get_job(conn, j)["claimed_by"] == "worker-a" for j in a[:5])
              and all(get_job(conn, j)["claimed_by"] == "worker-b" for j in b[:5]))
        check("concurrent update_job: every claimed job finished",
              all(get_job(conn, j)["status"] == "done"
                  and get_job(conn, j)["finished_at"] is not None for j in a + b))

        # --- run + points ----------------------------------------------
        band = CountBand(low=401, best=576, high=656, basis="consensus_4_frames")
        run_id = create_run(
            conn, job_id, video["id"], "countgd",
            engine_params={"threshold": 0.23, "tiling": 250, "version": "vendored"},
            band=band,
            quality={"tiles_rejected": 0, "malformed_dropped": 0,
                     "registration": {"1": "affine 1311/1390"}},
            seconds=214.6,
        )
        run = get_run(conn, run_id)
        check("create_run stores the band, not one integer",
              (run["count_low"], run["count_best"], run["count_high"]) == (401, 576, 656))
        check("run.basis records how the band was derived", run["basis"] == "consensus_4_frames")
        check("run JSON columns round-trip as dicts",
              isinstance(run["engine_params"], dict) and isinstance(run["quality"], dict)
              and run["quality"]["registration"]["1"] == "affine 1311/1390")
        check("create_run tolerates band=None",
              get_run(conn, create_run(conn, job_id, video["id"], "countgd"))["count_best"] is None)
        check("get_run on a missing id is None", get_run(conn, "nope") is None)
        check("list_runs filters by media", len(list_runs(conn, media_id=video["id"])) == 2)
        check("list_runs filters by job", len(list_runs(conn, job_id=job_id)) == 2)

        # contract.Point objects and raw consensus/tiling detection dicts both
        # have to land, since the worker produces the latter.
        written = insert_points(conn, run_id, [
            Point(x=253.3, y=272.3, lat=45.2901, lng=50.2003, score=0.81, support=4),
            Point(x=310.0, y=140.5, score=0.44, support=3, frame_idx=0),
            {"label": "seal", "kind": "point", "x1": 12.0, "y1": 18.0,
             "x2": 12.0, "y2": 18.0, "support": 4},
            {"x": 400.0, "y": 500.0, "score": 0.3, "status": "auto"},
        ])
        pts = get_points(conn, run_id)
        check("insert_points bulk-inserts mixed shapes", written == 4 and len(pts) == 4)
        check("insert_points accepts consensus x1/y1 dicts",
              any(abs(p["x"] - 12.0) < 1e-9 and p["support"] == 4 for p in pts))
        check("insert_points defaults status to auto", all(p["status"] == "auto" for p in pts))
        check("get_points filters by status",
              len(get_points(conn, run_id, status="validated")) == 0
              and len(get_points(conn, run_id, status="auto")) == 4)
        check("insert_points on empty is a no-op", insert_points(conn, run_id, []) == 0)
        raises("insert_points rejects a point with no coords", ValueError,
               insert_points, conn, run_id, [{"score": 0.5}])
        raises("insert_points rejects a bad status", ValueError,
               insert_points, conn, run_id, [{"x": 1, "y": 2, "status": "maybe"}])
        check("get_point round-trips", get_point(conn, pts[0]["id"])["id"] == pts[0]["id"])
        check("get_point on a missing id is None", get_point(conn, 10_000_000) is None)

        # --- numbers stay numbers ---------------------------------------
        # A numpy scalar supports the buffer protocol, so sqlite3 binds it as a
        # BLOB without complaint. Before the coercion below, a band of
        # np.int64 stored b'@\x02\x00...' as count_best, SUM() over the column
        # returned 0, and the API could not JSON-encode the result - a wrong
        # count reported as a successful run. Faked with a stand-in rather than
        # numpy so this stays a stdlib self-test.
        class BufferInt(int):
            """int that sqlite3 would rather bind as a BLOB, like np.int64."""
            def __buffer__(self, flags: int) -> memoryview:  # py3.12
                return memoryview(int(self).to_bytes(8, "little"))

        num_run = create_run(
            conn, job_id, video["id"], "countgd",
            band={"low": BufferInt(401), "best": BufferInt(576),
                  "high": BufferInt(656), "basis": "consensus_4_frames"},
            seconds=BufferInt(214),
        )
        nr = get_run(conn, num_run)
        check("create_run coerces the band to native ints",
              (nr["count_low"], nr["count_best"], nr["count_high"]) == (401, 576, 656)
              and all(isinstance(nr[c], int) for c in
                      ("count_low", "count_best", "count_high")),
              f"{nr['count_best']!r}")
        check("a stored band still aggregates in SQL",
              conn.execute("SELECT SUM(count_best) FROM run WHERE id = ?",
                           (num_run,)).fetchone()[0] == 576)
        check("a stored band is JSON-serialisable", json.dumps(nr, default=str))

        insert_points(conn, num_run, [{"x": BufferInt(12), "y": BufferInt(18),
                                       "score": 0.8, "support": BufferInt(4)}])
        np_pt = get_points(conn, num_run)[0]
        check("insert_points coerces score/support to native numbers",
              isinstance(np_pt["support"], int) and np_pt["support"] == 4
              and np_pt["x"] == 12.0, f"{np_pt['support']!r}")
        raises("insert_points refuses a non-numeric score", ValueError,
               insert_points, conn, num_run, [{"x": 1, "y": 2, "score": "high"}])

        # --- a failed COMMIT must not poison the connection --------------
        # WAL can return SQLITE_BUSY at commit while a reader holds an old
        # snapshot, and the API polls twice a second per SSE stream. If the
        # transaction were left open, every later BEGIN would fail and the
        # worker's claim loop would spin forever rather than fail one job.
        class CommitFails:
            def __init__(self, real): self._r = real
            def execute(self, sql, *a, **kw):
                if sql.strip().upper().startswith("COMMIT"):
                    raise sqlite3.OperationalError("simulated: busy at COMMIT")
                return self._r.execute(sql, *a, **kw)
            def __getattr__(self, k): return getattr(self._r, k)

        raises("a failed COMMIT propagates", sqlite3.OperationalError,
               insert_points, CommitFails(conn), num_run, [{"x": 1.0, "y": 2.0}])
        check("a failed COMMIT leaves no open transaction", not conn.in_transaction)
        check("the connection still works after a failed COMMIT",
              insert_points(conn, num_run, [{"x": 3.0, "y": 4.0}]) == 1)
        check("the rolled-back write did not land",
              not any(p["x"] == 1.0 for p in get_points(conn, num_run)))

        # A rollback that fails must not replace the caller's real error.
        class RollbackFails:
            def __init__(self, real): self._r = real
            def execute(self, sql, *a, **kw): return self._r.execute(sql, *a, **kw)
            def rollback(self): raise sqlite3.OperationalError("simulated: no rollback")
            def __getattr__(self, k): return getattr(self._r, k)

        raises("a failing rollback does not mask the real error",
               sqlite3.IntegrityError,
               insert_points, RollbackFails(conn), "no-such-run", [{"x": 1.0, "y": 2.0}])
        conn.rollback()

        # --- edits ------------------------------------------------------
        check("verified_count starts at every point", verified_count(conn, run_id) == 4)

        raw = add_edit(conn, run_id, "remove", point_id=pts[0]["id"], operator="a.n")
        check("add_edit appends to the log", raw["op"] == "remove" and raw["created_at"])
        check("add_edit alone does not mutate the point",
              get_point(conn, pts[0]["id"])["status"] == "auto")
        raises("add_edit rejects an unknown op", ValueError, add_edit, conn, run_id, "nuke")

        added = apply_edit(conn, run_id, "add", x=99.0, y=88.0, operator="a.n",
                           frame_idx=2, lat=45.2, lng=50.1)
        check("apply_edit add creates a validated point",
              added["point"]["status"] == "validated" and added["point"]["x"] == 99.0)
        check("apply_edit add logs the coords",
              added["edit"]["op"] == "add" and added["edit"]["x"] == 99.0
              and added["edit"]["point_id"] == added["point"]["id"])
        check("apply_edit add raises the verified count", verified_count(conn, run_id) == 5)
        raises("apply_edit add needs coords", ValueError, apply_edit, conn, run_id, "add")

        removed = apply_edit(conn, run_id, "remove", point_id=pts[1]["id"], operator="a.n")
        check("apply_edit remove marks false_positive",
              removed["point"]["status"] == "false_positive")
        check("apply_edit remove does not delete the row",
              get_point(conn, pts[1]["id"]) is not None)
        check("apply_edit remove lowers the verified count", verified_count(conn, run_id) == 4)

        back = apply_edit(conn, run_id, "reinstate", point_id=pts[1]["id"], operator="a.n")
        check("apply_edit reinstate restores validated", back["point"]["status"] == "validated")
        check("apply_edit reinstate restores the count", verified_count(conn, run_id) == 5)

        raises("apply_edit rejects an unknown op", ValueError,
               apply_edit, conn, run_id, "delete", point_id=pts[1]["id"])
        raises("apply_edit needs a point_id to remove", ValueError,
               apply_edit, conn, run_id, "remove")

        other_run = create_run(conn, job_id, still["id"], "countgd")
        raises("apply_edit refuses a point from another run", ValueError,
               apply_edit, conn, other_run, "remove", point_id=pts[1]["id"])
        check("failed apply_edit left no edit row", len(list_edits(conn, other_run)) == 0)

        # --- batch verdicts: one transaction, all or nothing ------------
        batch_ids = [pts[0]["id"], pts[2]["id"], pts[0]["id"]]  # duplicate on purpose
        res = apply_edits_batch(conn, run_id, "remove", batch_ids, operator="a.n")
        check("batch dedupes a repeated id", res["updated"] == 2, res["point_ids"])
        check("batch marks every point", all(
            get_point(conn, p)["status"] == "false_positive" for p in res["point_ids"]))
        check("batch lowers the verified count", res["verified_count"] == 3)
        check("batch logs one edit per point", len(list_edits(conn, run_id)) == 6)

        raises("batch refuses a point from another run", ValueError,
               apply_edits_batch, conn, run_id, "remove", [pts[1]["id"], 999999])
        check("a rejected batch wrote nothing", verified_count(conn, run_id) == 3
              and len(list_edits(conn, run_id)) == 6)
        raises("batch rejects 'add'", ValueError,
               apply_edits_batch, conn, run_id, "add", [pts[1]["id"]])

        reinstated = apply_edits_batch(conn, run_id, "reinstate", res["point_ids"])
        check("batch reinstate restores the count", reinstated["verified_count"] == 5)

        log = list_edits(conn, run_id)
        check("edit log is append-only and complete", len(log) == 8,
              [e["op"] for e in log])
        check("verified_count on an empty run is 0", verified_count(conn, other_run) == 0)

        # --- a ground count ---------------------------------------------
        obs = create_observation(
            conn, count=42, captured_at="2026-08-01T09:00:00Z",
            lat=44.81, lng=50.33, site_id=site["id"], operator="a.n",
            notes="counted from the shore, 8x binoculars", method="binoculars",
        )
        check("create_observation writes a survey and a run",
              obs["survey"]["id"] and obs["run"]["id"])
        check("a ground count has no job and no media",
              obs["run"]["job_id"] is None and obs["run"]["media_id"] is None)
        check("a ground count still reaches its survey directly",
              obs["run"]["survey_id"] == obs["survey"]["id"])
        check("an engine run reaches its survey through its media, not this column",
              get_run(conn, run_id)["survey_id"] is None)
        check("a ground count says a human made it",
              obs["run"]["engine"] == "manual" and obs["run"]["basis"] == "manual")
        check("a ground count is one number, not a band",
              (obs["run"]["count_low"], obs["run"]["count_best"],
               obs["run"]["count_high"]) == (42, 42, 42))
        check("a ground count claims no duration", obs["run"]["seconds"] is None)
        check("the method rides in quality as a dict",
              obs["run"]["quality"] == {"manual": True, "method": "binoculars"})
        check("a ground count's survey records where the position came from",
              obs["survey"]["location_source"] == "manual"
              and abs(obs["survey"]["lat"] - 44.81) < 1e-9
              and obs["survey"]["site_id"] == site["id"])
        check("a ground count derives no scale it did not measure",
              obs["survey"]["gsd_cm_px"] is None and obs["survey"]["altitude_m"] is None)
        check("a ground count of zero animals is a result, not a missing one",
              create_observation(conn, count=0,
                                 captured_at="2026-08-02T09:00:00Z")["run"]["count_best"] == 0)
        raises("create_observation refuses a negative count", ValueError,
               create_observation, conn, -1, "2026-08-01T09:00:00Z")
        raises("create_observation refuses a fractional count", ValueError,
               create_observation, conn, 4.5, "2026-08-01T09:00:00Z")
        before = conn.execute("SELECT COUNT(*) FROM survey").fetchone()[0]
        raises("a ground count at a site that does not exist is refused",
               sqlite3.IntegrityError, create_observation, conn, 5,
               "2026-08-01T09:00:00Z", None, None, "no-such-site")
        check("a refused ground count leaves no orphan survey behind",
              conn.execute("SELECT COUNT(*) FROM survey").fetchone()[0] == before)

        conn.close()

        # --- durability ------------------------------------------------
        reopened = connect(db_file)
        check("edits survive a reconnect", verified_count(reopened, run_id) == 5)
        check("job rows survive a reconnect", get_job(reopened, job_id)["status"] == "done")
        reopened.close()

    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        os.environ.pop("SEALV_DB", None)

    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        for name in FAILED:
            print(f"  FAILED: {name}")
        sys.exit(1)
