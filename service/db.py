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
import math
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

# Every measurable `env_sample` can hold, in the order the table declares them.
# Duplicated deliberately from `env.VALUE_COLUMNS` rather than imported: this
# module is a pure data layer with no knowledge of HTTP, and importing the
# source clients to learn a column list would drag urllib and a live-request
# module into the worker's import path. The selftest asserts the two lists are
# identical, so the duplication cannot drift silently.
ENV_VALUE_COLUMNS = (
    "wind_ms", "wind_dir", "gust_ms", "air_t", "pressure", "cloud",
    "wave_m", "wave_period_s",
    "sst_c", "sst_anomaly_c",
    "ice_class", "ice_conc", "ice_thickness_m",
    "chl_a", "sea_level_m",
)

# Provenance columns that travel with the measurement.
ENV_META_COLUMNS = ("dataset", "resolution_m", "resolution", "scope", "latency_note")

# Coordinates are rounded to this many places before they are written, and the
# same rounding is applied to anything looked up. The unique key is
# (source, measured_at, lat, lng) over REAL columns, so two spellings of the
# same cell centre - 44.85 from one response and 44.849999999 from another -
# would be two rows for one measurement and would draw the same cell twice.
# Four places is ~11 m, finer than the finest product here (1 km) by two orders
# of magnitude, so it can never merge two genuinely different cells.
ENV_COORD_PLACES = 4

# Columns held as JSON text, per table. Callers pass and receive dicts.
_JSON_COLUMNS: dict[str, tuple[str, ...]] = {
    "job": ("params", "progress"),
    "run": ("engine_params", "quality"),
    "population_observation": ("member_ids",),
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
        ("pollution_source_health", "consecutive_failures", "ALTER TABLE pollution_source_health ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0"),
        ("pollution_source_health", "total_inserted", "ALTER TABLE pollution_source_health ADD COLUMN total_inserted INTEGER NOT NULL DEFAULT 0"),
        ("pollution_source_health", "total_updated", "ALTER TABLE pollution_source_health ADD COLUMN total_updated INTEGER NOT NULL DEFAULT 0"),
        ("pollution_source_health", "total_unchanged", "ALTER TABLE pollution_source_health ADD COLUMN total_unchanged INTEGER NOT NULL DEFAULT 0"),
        ("pollution_source_health", "last_inserted_count", "ALTER TABLE pollution_source_health ADD COLUMN last_inserted_count INTEGER"),
        ("pollution_source_health", "last_updated_count", "ALTER TABLE pollution_source_health ADD COLUMN last_updated_count INTEGER"),
        ("pollution_source_health", "last_unchanged_count", "ALTER TABLE pollution_source_health ADD COLUMN last_unchanged_count INTEGER"),
    ) + tuple(
        # Every measurable of `env_sample`, ensured one by one rather than
        # trusted to the CREATE TABLE. A new environmental variable is exactly
        # the kind of additive change this table will keep taking - a second
        # wave parameter, an ice stage, a dust load - and the archive that must
        # not need recreating for it is the one on the boat. Keeping the list
        # here means adding a column is one line in two places, and a database
        # made against any earlier version grows into the current shape on the
        # next start rather than failing a query nobody can explain.
        ("env_sample", column, f"ALTER TABLE env_sample ADD COLUMN {column} {kind}")
        for column, kind in (
            ("dataset", "TEXT"),
            *((name, "REAL") for name in ENV_VALUE_COLUMNS),
            ("resolution_m", "REAL"),
            ("resolution", "TEXT"),
            ("scope", "TEXT"),
            ("latency_note", "TEXT"),
        )
    ):
        have = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if not have:
            continue  # the table itself is not there yet - schema.sql makes it
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


# Every count that belongs to one survey, newest first.
#
# The join is the whole point: a run reaches its survey through its media
# (every engine run) OR through `run.survey_id` (a ground count, and a manual
# correction). Walking media alone - which is what the survey endpoint did -
# silently omits every count a person entered, so the "history of this number"
# would show the engine's run and not the human correction standing above it.
_SURVEY_RUNS_SQL = """
SELECT r.* FROM run r
LEFT JOIN media m ON m.id = r.media_id
WHERE COALESCE(m.survey_id, r.survey_id) = ?
ORDER BY r.created_at DESC, r.id DESC
LIMIT ?
"""


def list_survey_runs(conn: sqlite3.Connection, survey_id: str, limit: int = 200) -> list[dict]:
    """Every count recorded against one survey, newest first.

    The first row is the STANDING count - the same run `/v1/stats` picks with
    `latest_per_survey`, ordered by the identical key, so the archive listing
    and this history can never disagree about which number is current.
    """
    return _rows(conn.execute(_SURVEY_RUNS_SQL, (survey_id, limit)), "run")


def standing_run(conn: sqlite3.Connection, survey_id: str) -> Optional[dict]:
    """The count that currently represents a survey, or None if it has none."""
    rows = _rows(conn.execute(_SURVEY_RUNS_SQL, (survey_id, 1)), "run")
    return rows[0] if rows else None


def create_correction(
    conn: sqlite3.Connection,
    survey_id: str,
    count: int,
    reason: str | None = None,
    operator: str | None = None,
) -> dict:
    """A person corrects the standing count of a sortie that already exists.

    NOT an update. Nothing is overwritten: the engine's run keeps its number,
    its points and its edit log, and this adds a second run against the SAME
    survey saying "a human counted N here instead". Latest-per-survey then makes
    it the standing figure everywhere, without a single reader needing to learn
    a new rule - the archive listing, the dashboard, the site estimate and the
    PDF all already take the newest run of a survey.

    Overwriting `count_best` would have been three lines and would have deleted
    the measurement the correction is a correction OF. A number nobody can
    compare against what the engine actually said is not a corrected count, it
    is an unsourced one.

    Three fields are carried deliberately:

      media_id  inherited from the run being superseded, so the corrected
                survey keeps its footage identity - filename, frame size,
                scale, the video the operator can still open. Left NULL this
                row would reload as a nameless ground count and the sortie
                would appear to have lost its footage. With no previous run at
                all it falls back to the survey's own media, but only when
                there is exactly one - see below.
      quality   the whole provenance of the correction: which run it replaces,
                which run still holds the evidence (`evidence_run` - the chain
                is followed, so a correction of a correction still points at
                the engine run with the points), who made it, why, and the band
                it superseded, verbatim.
      basis     'manual', exactly as a ground count. The standing number IS a
                human's, and every surface that draws a band has to say so.

    Returns {"run", "supersedes"}; `supersedes` is None on a survey that had no
    count at all, which is a first count rather than a correction and is
    recorded as such (`corrects_run` NULL).
    """
    # Whole, non-negative, and actually a number - the same rule
    # `create_observation` applies, and for the same reason: a count is the one
    # value in this archive that must never be silently adjusted.
    n = None if isinstance(count, bool) else _as_int(count, "correction.count")
    if n is None or n < 0 or n != count:
        raise ValueError(f"corrected count must be a whole number >= 0, got {count!r}")

    with _tx(conn, "IMMEDIATE"):
        survey = get_survey(conn, survey_id)
        if survey is None:
            raise LookupError(f"survey {survey_id!r} not found")
        prev = standing_run(conn, survey_id)
        prev_quality = (prev or {}).get("quality")
        prev_quality = prev_quality if isinstance(prev_quality, dict) else {}
        # Follow the chain rather than pointing at the run just superseded: a
        # correction of a correction would otherwise name a run that holds no
        # points, and the client would fetch an empty evidence set for a sortie
        # whose animals are all still in the archive.
        evidence = prev_quality.get("evidence_run") or (prev or {}).get("id")
        media_id = (prev or {}).get("media_id")
        if prev is None:
            # A first count, entered by hand over footage no engine ever ran
            # on. Attach it to that footage so the sortie keeps its filename
            # and its frame size instead of reloading as a nameless ground
            # count over a file that is still sitting in the archive. Only
            # where there is exactly ONE piece of media: with several, picking
            # any of them would be asserting which frame was counted, and the
            # survey link already says everything that is actually known.
            rows = conn.execute(
                "SELECT id FROM media WHERE survey_id = ? LIMIT 2", (survey_id,)
            ).fetchall()
            if len(rows) == 1:
                media_id = rows[0][0]
        run_id = create_run(
            conn,
            job_id=None,
            media_id=media_id,
            survey_id=survey_id,
            engine="manual",
            band={"low": n, "best": n, "high": n, "basis": "manual"},
            quality={
                "manual": True,
                "correction": True,
                "corrects_run": (prev or {}).get("id"),
                "evidence_run": evidence,
                "reason": reason,
                "operator": operator,
                "previous": None if prev is None else {
                    "low": prev.get("count_low"),
                    "best": prev.get("count_best"),
                    "high": prev.get("count_high"),
                    "basis": prev.get("basis"),
                    "engine": prev.get("engine"),
                    "run_id": prev.get("id"),
                },
            },
            seconds=None,
        )
        run = get_run(conn, run_id)
    return {"run": run, "supersedes": prev}


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
# environment
# --------------------------------------------------------------------------

_ENV_INSERT = f"""
INSERT INTO env_sample
       (source, dataset, measured_at, lat, lng, {', '.join(ENV_VALUE_COLUMNS)},
        resolution_m, resolution, scope, latency_note, fetched_at)
VALUES ({', '.join(['?'] * (5 + len(ENV_VALUE_COLUMNS) + 5))})
ON CONFLICT(source, measured_at, lat, lng) DO UPDATE SET
       dataset      = excluded.dataset,
       {', '.join(f'{c} = COALESCE(excluded.{c}, {c})' for c in ENV_VALUE_COLUMNS)},
       resolution_m = excluded.resolution_m,
       resolution   = excluded.resolution,
       scope        = excluded.scope,
       latency_note = excluded.latency_note,
       fetched_at   = excluded.fetched_at
"""


def _env_row(sample: Any) -> tuple:
    """One normalised sample -> the INSERT tuple. Raises on anything unusable.

    `values` is filtered, not defaulted. A key this table has no column for is
    refused rather than dropped, because silently discarding a measurement is
    the failure this whole layer exists to prevent; a key whose value is None
    is left NULL, which is the honest spelling of "this source did not measure
    that here".
    """
    d = dict(sample)
    source = (d.get("source") or "").strip()
    if not source:
        raise ValueError("env sample needs a source")
    measured_at = (d.get("measured_at") or "").strip()
    if not measured_at:
        # Without it the row is "some temperature, some time" - which is
        # precisely what the product promises never to show anyone.
        raise ValueError(f"env sample from {source!r} has no measured_at")
    lat = _as_float(d.get("lat"), "env.lat")
    lng = _as_float(d.get("lng"), "env.lng")
    if lat is None or lng is None:
        raise ValueError(f"env sample from {source!r} has no coordinate")

    values = dict(d.get("values") or {})
    unknown = set(values) - set(ENV_VALUE_COLUMNS)
    if unknown:
        raise ValueError(
            f"env sample from {source!r} carries {sorted(unknown)}, which "
            f"env_sample has no column for - add the column rather than dropping it"
        )
    measured = [_as_float(values.get(c), f"env.{c}") for c in ENV_VALUE_COLUMNS]
    if all(v is None for v in measured):
        # A row whose only content is a source name and a time reads on a chart
        # exactly like a zero. env.py already refuses to build one; this is the
        # store refusing to hold one.
        raise ValueError(f"env sample from {source!r} measured nothing")

    return (
        source, d.get("dataset"), measured_at,
        round(lat, ENV_COORD_PLACES), round(lng, ENV_COORD_PLACES),
        *measured,
        _as_float(d.get("resolution_m"), "env.resolution_m"),
        d.get("resolution"), d.get("scope"), d.get("latency_note"),
        _utcnow(),
    )


def insert_env_samples(conn: sqlite3.Connection, samples: Iterable[Any]) -> dict:
    """Store normalised samples, deduping on (source, measured_at, lat, lng).

    Returns {"written": n, "new": k, "skipped": [reasons]}. `new` is how many
    rows the table did not already hold - a backfill rerun therefore reports
    `written` equal to the input and `new` zero, which is the difference
    between "it worked twice" and "it collected twice as much".

    A repeat of the same slice UPDATEs rather than replaces: values are merged
    with COALESCE so a second source-run that measured only concentration
    cannot blank a thickness the first one already stored. `fetched_at` moves,
    because it is the answer to "when did we last ask", not to "when was this
    measured".

    Bad samples are skipped with a reason rather than aborting the batch: one
    malformed chlorophyll response must not cost the wind that came with it.
    """
    rows, skipped = [], []
    for sample in samples:
        try:
            rows.append(_env_row(sample))
        except (ValueError, TypeError) as exc:
            skipped.append(str(exc))
    if not rows:
        return {"written": 0, "new": 0, "skipped": skipped}

    keys = {(r[0], r[2], r[3], r[4]) for r in rows}
    with _tx(conn, "IMMEDIATE"):
        before = _env_have(conn, keys)
        conn.executemany(_ENV_INSERT, rows)
    return {"written": len(rows), "new": len(keys) - before, "skipped": skipped}


def _env_have(conn: sqlite3.Connection, keys: set[tuple]) -> int:
    """How many of these (source, measured_at, lat, lng) the table already holds.

    Counted rather than inferred from `cursor.rowcount`, which an upsert
    reports as one for both an insert and an update and so cannot tell the two
    apart - and "how much of this is new" is the only number that says whether
    a collection cycle is actually accumulating a series.
    """
    found = 0
    for source, measured_at, lat, lng in keys:
        found += bool(conn.execute(
            "SELECT 1 FROM env_sample WHERE source = ? AND measured_at = ? "
            "AND lat = ? AND lng = ? LIMIT 1",
            (source, measured_at, lat, lng),
        ).fetchone())
    return found


def _env_payload(row: dict) -> dict:
    """A stored row back in the sample shape the clients produce.

    Same keys in, same keys out, so a value read from the archive and a value
    just fetched are indistinguishable to a caller - and `values` holds only
    what was actually measured, never a NULL column padded to zero.
    """
    return {
        "source": row["source"],
        "dataset": row.get("dataset"),
        "measured_at": row["measured_at"],
        "lat": row["lat"],
        "lng": row["lng"],
        "values": {c: row[c] for c in ENV_VALUE_COLUMNS if row.get(c) is not None},
        "resolution_m": row.get("resolution_m"),
        "resolution": row.get("resolution"),
        "scope": row.get("scope"),
        "latency_note": row.get("latency_note"),
        "fetched_at": row.get("fetched_at"),
    }


#: Degrees of latitude per kilometre. Longitude is narrower away from the
#: equator, and at 45 N - the whole survey area - a degree of longitude is
#: cos(45) = 0.707 of a degree of latitude. The searches below use a box in
#: degrees scaled that way rather than a true great-circle distance: at basin
#: scale the error is under a percent, and it keeps the filter something the
#: (lat, lng, measured_at) index can actually use.
_DEG_PER_KM = 1.0 / 111.32


def _env_box(lat: float, lng: float, radius_km: float) -> tuple[float, float, float, float]:
    dlat = radius_km * _DEG_PER_KM
    dlng = dlat / max(0.2, math.cos(math.radians(lat)))
    return lat - dlat, lat + dlat, lng - dlng, lng + dlng


# Nearest in TIME first, then nearest in space. That order is deliberate: a
# temperature from the right day two cells away describes a survey far better
# than the right cell from a fortnight later, and a reader shown the second
# would have no way to tell.
#
# `scope = 'basin'` escapes the box, and that is not a loophole - it is the
# difference between a measurement OF a cell and a measurement of the whole
# sea. Sea level is one altimetric figure for the entire Caspian, stored
# against the crossing where the pass is taken (41.97/50.385) because a value
# has to live somewhere; it describes Tyuleniy, 320 km away, exactly as well
# as it describes its own coordinate. Filtering it by distance would silently
# drop the one variable the research doc says must join to every survey from
# the first day (§7.4: the sea is falling 1.63 m per decade over water 2-5 m
# deep, so the geography of the haul-outs is being rewritten, not drifting).
_ENV_NEAREST_SQL = """
SELECT *, ABS(julianday(measured_at) - julianday(?)) * 24.0 AS gap_hours
  FROM env_sample
 WHERE source = ?
   AND (scope = 'basin'
        OR (lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?))
 ORDER BY gap_hours,
          (lat - ?) * (lat - ?) + (lng - ?) * (lng - ?)
 LIMIT 1
"""


def env_sources(conn: sqlite3.Connection) -> list[str]:
    """Every source the archive holds a sample from, in a stable order."""
    return [r[0] for r in conn.execute(
        "SELECT DISTINCT source FROM env_sample ORDER BY source")]


def env_at(
    conn: sqlite3.Connection,
    lat: float,
    lng: float,
    when: str,
    radius_km: float = 60.0,
    max_gap_h: float | None = 72.0,
    sources: Sequence[str] | None = None,
    max_gap_basin_h: float | None = 15 * 24.0,
) -> list[dict]:
    """The nearest stored sample to one point and time, from EVERY source.

    One row per source, never a merge. Six feeds describing the same moment is
    not an inconsistency to be resolved - the reader is entitled to see that
    MUR says 27.4 from two days ago at 1 km while CoralTemp says 27.7 from the
    same day at 5 km, and any code that picks one of them has made a scientific
    judgement in a display layer.

    Each result carries `gap_hours` (how far the slice is from the moment
    asked about) and `distance_km` (how far the cell centre is from the point),
    because "26.8 °C" without those two is a number the operator cannot check.

    `max_gap_h` is the honesty bound: past it, the source has nothing to say
    about this moment and is left out entirely rather than answering with the
    nearest thing it happens to have. None disables it, which is what a series
    view wants and a survey card does not.

    `max_gap_basin_h` is the same bound for a basin-scale figure, and it is
    separate because the products publish on different clocks: three days is
    generous for a daily satellite pass and absurd for altimetry that produces
    one number every ten days. Judging sea level by the satellite bound would
    hide it from most surveys - not because it is unknown, but because the
    wrong ruler was used.
    """
    lat, lng = float(lat), float(lng)
    lat0, lat1, lng0, lng1 = _env_box(lat, lng, radius_km)
    out = []
    for source in (sources if sources is not None else env_sources(conn)):
        row = _row(
            conn.execute(
                _ENV_NEAREST_SQL,
                (when, source, lat0, lat1, lng0, lng1, lat, lat, lng, lng),
            ).fetchone(),
            "env_sample",
        )
        if row is None:
            continue
        gap = row.pop("gap_hours", None)
        bound = max_gap_basin_h if row.get("scope") == "basin" else max_gap_h
        if bound is not None and gap is not None and gap > bound:
            continue
        payload = _env_payload(row)
        payload["gap_hours"] = None if gap is None else round(gap, 2)
        payload["distance_km"] = round(
            math.hypot(row["lat"] - lat,
                       (row["lng"] - lng) * math.cos(math.radians(lat))) / _DEG_PER_KM,
            2,
        )
        out.append(payload)
    out.sort(key=lambda s: (s["source"],))
    return out


def env_series(
    conn: sqlite3.Connection,
    lat: float,
    lng: float,
    start: str,
    end: str,
    radius_km: float = 60.0,
    sources: Sequence[str] | None = None,
    limit: int = 5000,
) -> list[dict]:
    """Every stored sample near one point between two times, oldest first.

    Grouped by source by the caller, not here - this returns flat rows so the
    API can shape them once. The window is inclusive at both ends and ordered
    by `measured_at`, which is the axis a chart of conditions is drawn on;
    `fetched_at` would order the same measurements by when we happened to ask.
    """
    lat0, lat1, lng0, lng1 = _env_box(float(lat), float(lng), radius_km)
    # Basin-scale rows escape the box for the reason spelled out on
    # _ENV_NEAREST_SQL: they describe the whole sea, so a site's history of
    # conditions includes the sea level whatever the site's coordinate is.
    where = ["(scope = 'basin' OR (lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?))",
             "measured_at >= ?", "measured_at <= ?"]
    args: list[Any] = [lat0, lat1, lng0, lng1, start, end]
    if sources:
        where.append(f"source IN ({', '.join('?' * len(sources))})")
        args.extend(sources)
    rows = _rows(
        conn.execute(
            f"SELECT * FROM env_sample WHERE {' AND '.join(where)} "
            "ORDER BY measured_at, source, id LIMIT ?",
            (*args, max(1, int(limit))),
        ),
        "env_sample",
    )
    return [_env_payload(r) for r in rows]


def env_grid(
    conn: sqlite3.Connection,
    when: str,
    columns: Sequence[str] | None = None,
    max_gap_h: float | None = 240.0,
    limit_per_layer: int = 4000,
) -> list[dict]:
    """The map layer: for each (source, variable), ONE slice and all its cells.

    A slice, not a window. Every cell in a returned layer shares one
    `measured_at`, because a "grid at time T" assembled from two days of
    passes would draw a seam down the basin that nothing measured - and the
    seam would look exactly like a front.

    Each layer reports its own `resolution_m` and the `spacing_deg` the cells
    were actually sampled at, which are two different facts and both are
    needed: the first is how wide the measurement is, the second is how far
    apart the ones we hold are. A 9 km chlorophyll cell and a 1 km SST cell
    must be drawn at their own sizes, never blurred into one field, so the
    numbers that make that possible travel with the data.
    """
    wanted = tuple(columns) if columns else ENV_VALUE_COLUMNS
    unknown = set(wanted) - set(ENV_VALUE_COLUMNS)
    if unknown:
        raise ValueError(f"no such environmental variable(s): {sorted(unknown)}")

    layers = []
    for column in wanted:
        # The ice chart classifies land too (2 = land, 4 = snow-covered land),
        # and those cells are true but belong to the point probe, not to a
        # basin layer about sea ice - drawn on the map they put sample markers
        # over Iran and the Kazakh steppe. The collector no longer stores them;
        # this keeps the ones already in the archive off the map without
        # deleting a measurement that was honestly recorded.
        keep = f"{column} IS NOT NULL"
        if column == "ice_class":
            keep += f" AND CAST({column} AS INTEGER) NOT IN (2, 4)"
        pairs = conn.execute(
            f"""SELECT source, measured_at,
                       ABS(julianday(measured_at) - julianday(?)) * 24.0 AS gap_hours
                  FROM env_sample
                 WHERE {keep}
              GROUP BY source, measured_at""",
            (when,),
        ).fetchall()
        best: dict[str, tuple[str, float]] = {}
        for source, measured_at, gap in pairs:
            gap = float(gap if gap is not None else 1e9)
            if max_gap_h is not None and gap > max_gap_h:
                continue
            if source not in best or gap < best[source][1]:
                best[source] = (measured_at, gap)

        for source, (measured_at, gap) in sorted(best.items()):
            cells = _rows(
                conn.execute(
                    f"""SELECT lat, lng, {column} AS value, dataset, resolution_m,
                               resolution, scope, latency_note
                          FROM env_sample
                         WHERE source = ? AND measured_at = ? AND {keep}
                      ORDER BY lat, lng LIMIT ?""",
                    (source, measured_at, max(1, int(limit_per_layer))),
                )
            )
            if not cells:
                continue
            head = cells[0]
            layers.append({
                "source": source,
                "dataset": head.get("dataset"),
                "var": column,
                "measured_at": measured_at,
                "gap_hours": round(gap, 2),
                "resolution_m": head.get("resolution_m"),
                "resolution": head.get("resolution"),
                "scope": head.get("scope"),
                "latency_note": head.get("latency_note"),
                "spacing_deg": _env_spacing([c["lat"] for c in cells]),
                "count": len(cells),
                "cells": [
                    {"lat": c["lat"], "lng": c["lng"], "value": c["value"]} for c in cells
                ],
            })
    return layers


def _env_spacing(lats: Sequence[float]) -> Optional[float]:
    """Median gap between consecutive distinct rows of a grid, in degrees.

    What a renderer needs to know how far apart the cells it has been given
    actually are - which is NOT the product's cell size. The basin grid samples
    a 1 km product every half a degree; drawing those cells 1 km wide would
    show a nearly empty map, and drawing them half a degree wide would claim a
    50 km measurement. The layer carries both numbers so the map can draw the
    real cell and say what the spacing between them is.

    None for a single row, where there is no spacing to measure.
    """
    uniq = sorted({round(float(v), 6) for v in lats})
    if len(uniq) < 2:
        return None
    gaps = sorted(b - a for a, b in zip(uniq, uniq[1:]))
    return round(gaps[len(gaps) // 2], 6)


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
# purge
# --------------------------------------------------------------------------

class NotRetired(Exception):
    """A survey was asked to be destroyed while it is still in the estimate.

    Its own class rather than ValueError: the API answers 409 for this and 400
    for a malformed request, and folding the two together would tell a caller
    who forgot the retire step that their JSON was wrong.
    """


def _in_clause(ids: Sequence[str]) -> tuple[str, list]:
    """`IN (?, ?, ?)` for a list that may be empty.

    `IN ()` is a syntax error in SQLite, and the alternative - skipping the
    statement when the list is empty - is how a delete pass grows a branch that
    is never exercised. `IN (NULL)` matches nothing, which is the right answer.
    """
    if not ids:
        return "(NULL)", []
    return "(" + ",".join("?" * len(ids)) + ")", list(ids)


def purge_survey(conn: sqlite3.Connection, survey_id: str, *, dry_run: bool = False) -> dict:
    """Destroy a retired survey and everything hanging off it. No undo.

    This is the only destructive call in this module and it is deliberately
    hard to reach: a survey must ALREADY be retired, which means somebody
    withdrew it from the estimate, gave a reason, and had it recorded. Two
    steps, two decisions - a season cannot be destroyed by one click, and test
    junk can still be removed completely.

    What goes, in dependency order inside ONE `BEGIN IMMEDIATE`: every edit and
    point of every run of this survey, those runs, the track points and jobs of
    its media, the media rows, and the survey. Ordered explicitly rather than
    left to ON DELETE CASCADE for two reasons - `run.survey_id` has no cascade
    at all (a ground count would abort the delete on a foreign key), and a
    cascade reports nothing, whereas the receipt below is what the caller shows
    the operator afterwards.

    Files are NOT touched here. This module knows nothing about the workspace,
    and unlinking bytes before the transaction commits would destroy footage
    that a rollback then leaves referenced. The paths come back in the receipt
    and the caller removes them after the commit.

    `dry_run=True` counts everything and writes nothing - the same receipt, so
    the confirmation an operator reads names exactly what the delete will do
    rather than a second implementation's guess at it.
    """
    with _tx(conn, "IMMEDIATE"):
        survey = get_survey(conn, survey_id)
        if survey is None:
            raise LookupError(f"survey {survey_id!r} not found")
        # Re-checked inside the transaction even though the API checks first:
        # the API's read and this write are two statements, and the one that
        # destroys evidence is the one that has to be sure. A dry run is a
        # read: it answers over a live survey too, and `retired` in the receipt
        # is how the caller learns the retire step is still owed - refusing to
        # count would leave a confirmation dialog with nothing true to say.
        if not dry_run and not survey.get("retired_at"):
            raise NotRetired(
                f"survey {survey_id} is not retired - withdraw it from the estimate "
                "first (POST /v1/surveys/{id}/retire, with a reason), then delete it"
            )

        media = [dict(r) for r in conn.execute(
            "SELECT id, path, filename FROM media WHERE survey_id = ?", (survey_id,))]
        media_ids = [m["id"] for m in media]
        m_sql, m_args = _in_clause(media_ids)

        job_ids = [r[0] for r in conn.execute(
            f"SELECT id FROM job WHERE media_id IN {m_sql}", m_args)]
        j_sql, j_args = _in_clause(job_ids)

        # Three ways a run belongs to this survey, and all three are real:
        # through its media (every engine run), through `run.survey_id` (a
        # ground count or a manual correction), and through a job of this
        # survey's media (a run whose media row was already gone). Miss the
        # second and the survey delete dies on a foreign key; miss the third
        # and deleting the job cascades that run away unreported.
        run_ids = [r[0] for r in conn.execute(
            f"""SELECT id FROM run
                 WHERE media_id IN {m_sql} OR survey_id = ? OR job_id IN {j_sql}""",
            [*m_args, survey_id, *j_args],
        )]
        r_sql, r_args = _in_clause(run_ids)

        counts = {
            "media": len(media_ids),
            "jobs": len(job_ids),
            "runs": len(run_ids),
            "points": int(conn.execute(
                f"SELECT COUNT(*) FROM point WHERE run_id IN {r_sql}", r_args).fetchone()[0]),
            "edits": int(conn.execute(
                f"SELECT COUNT(*) FROM edit WHERE run_id IN {r_sql}", r_args).fetchone()[0]),
            "track_points": int(conn.execute(
                f"SELECT COUNT(*) FROM track_point WHERE media_id IN {m_sql}",
                m_args).fetchone()[0]),
        }
        receipt = {
            "survey_id": survey_id,
            # Whether the two-step gate has been passed. A dry run over a live
            # survey reports False and full counts, which is exactly what a
            # confirmation dialog needs to explain why the button is not armed.
            "retired": bool(survey.get("retired_at")),
            "retired_at": survey.get("retired_at"),
            "retired_reason": survey.get("retired_reason"),
            "counts": counts,
            # Absolute paths, straight out of the rows. The caller checks them
            # against the workspace before unlinking anything - a moved
            # workspace or a hand-edited row must not turn a delete into an
            # arbitrary file removal.
            "files": [m["path"] for m in media if m.get("path")],
            "filenames": [m["filename"] for m in media if m.get("filename")],
            "dry_run": bool(dry_run),
        }
        if dry_run:
            # Nothing was written; the IMMEDIATE transaction still bought a
            # consistent read of six tables, which is what makes the numbers
            # above a receipt rather than a sample.
            return receipt

        conn.execute(f"DELETE FROM edit WHERE run_id IN {r_sql}", r_args)
        conn.execute(f"DELETE FROM point WHERE run_id IN {r_sql}", r_args)
        conn.execute(f"DELETE FROM run WHERE id IN {r_sql}", r_args)
        conn.execute(f"DELETE FROM track_point WHERE media_id IN {m_sql}", m_args)
        conn.execute(f"DELETE FROM job WHERE media_id IN {m_sql}", m_args)
        conn.execute(f"DELETE FROM media WHERE id IN {m_sql}", m_args)
        conn.execute("DELETE FROM survey WHERE id = ?", (survey_id,))
    return receipt
# inferred populations
# --------------------------------------------------------------------------

POPULATION_DECISIONS = ("confirmed", "rejected")


def get_population(conn: sqlite3.Connection, population_id: str) -> Optional[dict]:
    population = _row(
        conn.execute("SELECT * FROM population WHERE id = ?", (population_id,)).fetchone(),
        "population",
    )
    if population is None:
        return None
    population["observations"] = _rows(
        conn.execute(
            """SELECT * FROM population_observation
                 WHERE population_id = ? ORDER BY observed_at, id""",
            (population_id,),
        ),
        "population_observation",
    )
    return population


def list_populations(conn: sqlite3.Connection, limit: int = 500) -> list[dict]:
    rows = _rows(
        conn.execute(
            "SELECT * FROM population ORDER BY updated_at DESC, id LIMIT ?", (limit,)
        ),
        "population",
    )
    for population in rows:
        population["observations"] = _rows(
            conn.execute(
                """SELECT * FROM population_observation
                     WHERE population_id = ? ORDER BY observed_at, id""",
                (population["id"],),
            ),
            "population_observation",
        )
    return rows


def list_population_link_reviews(conn: sqlite3.Connection) -> list[dict]:
    return _rows(
        conn.execute(
            """SELECT * FROM population_link_review
                 ORDER BY updated_at DESC, from_observation_id, to_observation_id"""
        ),
        "population_link_review",
    )


def rename_population(conn: sqlite3.Connection, population_id: str, name: str) -> Optional[dict]:
    clean = str(name).strip()
    if not clean:
        raise ValueError("population name cannot be blank")
    conn.execute(
        "UPDATE population SET name = ?, updated_at = ? WHERE id = ?",
        (clean, utcnow(), population_id),
    )
    return get_population(conn, population_id)


def _new_population(conn: sqlite3.Connection, name: str | None = None) -> dict:
    population_id = new_id()
    ordinal = int(conn.execute("SELECT COUNT(*) FROM population").fetchone()[0]) + 1
    conn.execute(
        "INSERT INTO population (id, name, updated_at) VALUES (?, ?, ?)",
        (population_id, (name or f"Group {ordinal}").strip(), utcnow()),
    )
    return _row(
        conn.execute("SELECT * FROM population WHERE id = ?", (population_id,)).fetchone(),
        "population",
    )


def sync_population_tracks(conn: sqlite3.Connection, tracks: Sequence[dict]) -> dict:
    """Persist computed snapshots without replacing operator decisions.

    Observation ids are derived from survey id + detection member ids by the
    client. When a recomputation contains an id already stored, that overlap
    reconnects the temporary algorithm track to its durable population. A
    confirmed assignment always wins over a new automatic suggestion.
    """
    mapped: list[dict] = []
    with _tx(conn, "IMMEDIATE"):
        for raw_track in tracks:
            observations = list(raw_track.get("observations") or [])
            if not observations:
                continue
            observation_ids = [str(o.get("id") or "").strip() for o in observations]
            if any(not value for value in observation_ids):
                raise ValueError("every population observation needs an id")

            placeholders = ",".join("?" for _ in observation_ids)
            existing = conn.execute(
                f"""SELECT population_id, assignment_status, COUNT(*) AS n
                       FROM population_observation WHERE id IN ({placeholders})
                      GROUP BY population_id, assignment_status
                      ORDER BY (assignment_status = 'confirmed') DESC, n DESC, population_id""",
                observation_ids,
            ).fetchall()
            if existing:
                population_id = str(existing[0]["population_id"])
            else:
                population_id = str(_new_population(conn)["id"])

            for observation in observations:
                oid = str(observation["id"])
                current = conn.execute(
                    "SELECT population_id, assignment_status FROM population_observation WHERE id = ?",
                    (oid,),
                ).fetchone()
                assigned = (
                    str(current["population_id"])
                    if current is not None and current["assignment_status"] == "confirmed"
                    else population_id
                )
                center = observation.get("center") or {}
                size = _as_int(observation.get("size"), "size")
                lat = _as_float(center.get("lat"), "lat")
                lng = _as_float(center.get("lng"), "lng")
                if size is None or size < 1 or lat is None or lng is None:
                    raise ValueError("population observation needs positive size and coordinates")
                source = str(observation.get("source") or "")
                if source not in ("points", "aggregate"):
                    raise ValueError("population observation source must be points or aggregate")
                member_ids = list(observation.get("memberIds") or [])
                now = utcnow()
                conn.execute(
                    """INSERT INTO population_observation
                           (id, population_id, survey_id, observed_at, lat, lng, size,
                            source, member_ids, assignment_status, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?)
                       ON CONFLICT(id) DO UPDATE SET
                           population_id = CASE
                             WHEN population_observation.assignment_status = 'confirmed'
                             THEN population_observation.population_id
                             ELSE excluded.population_id END,
                           survey_id = excluded.survey_id,
                           observed_at = excluded.observed_at,
                           lat = excluded.lat, lng = excluded.lng, size = excluded.size,
                           source = excluded.source, member_ids = excluded.member_ids,
                           updated_at = excluded.updated_at""",
                    (
                        oid, assigned, str(observation.get("surveyId") or ""),
                        str(observation.get("observedAt") or ""), lat, lng, size,
                        source, _json_dump(member_ids), now,
                    ),
                )
            conn.execute(
                "UPDATE population SET updated_at = ? WHERE id = ?", (utcnow(), population_id)
            )
            mapped.append({"track_id": raw_track.get("id"), "population_id": population_id})

    return {
        "tracks": mapped,
        "populations": list_populations(conn),
        "reviews": list_population_link_reviews(conn),
    }


def review_population_link(
    conn: sqlite3.Connection,
    from_observation_id: str,
    to_observation_id: str,
    decision: str,
    operator: str | None = None,
) -> dict:
    """Confirm or reject an inferred step and apply the identity consequence."""
    if decision not in POPULATION_DECISIONS:
        raise ValueError(f"decision must be one of {POPULATION_DECISIONS}")
    if from_observation_id == to_observation_id:
        raise ValueError("a population link needs two different observations")

    with _tx(conn, "IMMEDIATE"):
        before = conn.execute(
            "SELECT * FROM population_observation WHERE id = ?", (from_observation_id,)
        ).fetchone()
        after = conn.execute(
            "SELECT * FROM population_observation WHERE id = ?", (to_observation_id,)
        ).fetchone()
        if before is None or after is None:
            raise ValueError("both population observations must exist before review")

        now = utcnow()
        conn.execute(
            """INSERT INTO population_link_review
                   (from_observation_id, to_observation_id, decision, operator, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(from_observation_id, to_observation_id) DO UPDATE SET
                   decision = excluded.decision, operator = excluded.operator,
                   updated_at = excluded.updated_at""",
            (from_observation_id, to_observation_id, decision, operator, now),
        )

        if decision == "confirmed":
            keep = str(before["population_id"])
            merge = str(after["population_id"])
            conn.execute(
                "UPDATE population_observation SET population_id = ?, updated_at = ? WHERE population_id = ?",
                (keep, now, merge),
            )
            conn.execute(
                "UPDATE population_observation SET assignment_status = 'confirmed', updated_at = ? WHERE id IN (?, ?)",
                (now, from_observation_id, to_observation_id),
            )
            if merge != keep:
                conn.execute("DELETE FROM population WHERE id = ?", (merge,))
            population_id = keep
        else:
            old = str(after["population_id"])
            fresh = _new_population(conn)
            population_id = str(fresh["id"])
            # Rejecting A -> B means B and subsequent unconfirmed snapshots no
            # longer inherit A's identity. Earlier evidence remains untouched.
            conn.execute(
                """UPDATE population_observation
                      SET population_id = ?, updated_at = ?
                    WHERE population_id = ? AND observed_at >= ?
                      AND assignment_status != 'confirmed'""",
                (population_id, now, old, after["observed_at"]),
            )

    return {
        "review": _row(
            conn.execute(
                """SELECT * FROM population_link_review
                    WHERE from_observation_id = ? AND to_observation_id = ?""",
                (from_observation_id, to_observation_id),
            ).fetchone(),
            "population_link_review",
        ),
        "population_id": population_id,
        "populations": list_populations(conn),
    }


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

        check("list_survey_runs finds a run linked straight to its survey",
              [r["id"] for r in list_survey_runs(conn, obs["survey"]["id"])]
              == [obs["run"]["id"]],
              # Through run.survey_id, not through media - a ground count has
              # none, and the survey endpoint used to walk media alone and so
              # reported that a person's count did not exist.
              )
        check("list_survey_runs finds an engine run through its media",
              obs["run"]["id"] not in [r["id"] for r in list_survey_runs(conn, survey["id"])]
              and run_id in [r["id"] for r in list_survey_runs(conn, survey["id"])])

        # --- correcting a standing count --------------------------------
        # A whole sortie of its own so the corrections below cannot disturb the
        # rows every earlier check reads.
        c_survey = create_survey(conn, site_id=site["id"], captured_at="2026-08-03T08:00:00Z")
        c_media = create_media(conn, tmp / "corrected.jpg", "image",
                               survey_id=c_survey["id"], width=4000, height=3000)
        c_job = create_job(conn, c_media["id"], params)
        c_run = create_run(conn, c_job, c_media["id"], "countgd",
                           band=CountBand(low=100, best=118, high=140,
                                          basis="union_4_frames"))
        insert_points(conn, c_run, [Point(x=10.0, y=20.0), Point(x=30.0, y=40.0)])
        c_points = [p["id"] for p in get_points(conn, c_run)]
        add_edit(conn, c_run, "remove", point_id=c_points[0], operator="a.n")

        corrected = create_correction(conn, c_survey["id"], 127,
                                      reason="two pups double-counted on the spit",
                                      operator="a.n")
        c_first = corrected["run"]
        check("a correction is a NEW run, not an overwrite",
              c_first["id"] != c_run and get_run(conn, c_run)["count_best"] == 118)
        check("the engine's evidence survives a correction",
              len(get_points(conn, c_run)) == 2 and len(list_edits(conn, c_run)) == 1)
        check("a correction is the standing count",
              standing_run(conn, c_survey["id"])["id"] == c_first["id"])
        check("a correction is one number a person gave, not a band",
              (c_first["count_low"], c_first["count_best"], c_first["count_high"])
              == (127, 127, 127) and c_first["basis"] == "manual"
              and c_first["engine"] == "manual")
        check("a correction keeps the sortie's footage identity",
              c_first["media_id"] == c_media["id"] and c_first["survey_id"] == c_survey["id"],
              # NULL media would reload as a nameless ground count and the
              # sortie would look as though it had lost its footage.
              )
        check("a correction records what it replaced, verbatim",
              c_first["quality"]["corrects_run"] == c_run
              and c_first["quality"]["previous"]["best"] == 118
              and c_first["quality"]["previous"]["basis"] == "union_4_frames")
        check("a correction records who and why",
              c_first["quality"]["operator"] == "a.n"
              and "double-counted" in c_first["quality"]["reason"])
        check("a correction points at the run that holds the evidence",
              c_first["quality"]["evidence_run"] == c_run)
        check("supersedes names the run that was standing", corrected["supersedes"]["id"] == c_run)

        second = create_correction(conn, c_survey["id"], 131, operator="b.k")["run"]
        check("a correction of a correction still points at the engine run",
              second["quality"]["evidence_run"] == c_run
              and second["quality"]["corrects_run"] == c_first["id"],
              # Following the chain matters: naming the run just superseded
              # would send a client to fetch points from a row that has none.
              )
        check("both corrections and the engine run are all in the history",
              [r["id"] for r in list_survey_runs(conn, c_survey["id"])]
              == [second["id"], c_first["id"], c_run])
        check("a correction with no reason records None, not an empty claim",
              second["quality"]["reason"] is None)
        raises("create_correction refuses a fractional count", ValueError,
               create_correction, conn, c_survey["id"], 4.5)
        raises("create_correction refuses a negative count", ValueError,
               create_correction, conn, c_survey["id"], -1)
        raises("create_correction refuses a survey that does not exist", LookupError,
               create_correction, conn, "no-such-survey", 5)
        check("a refused correction wrote no run",
              len(list_survey_runs(conn, c_survey["id"])) == 3)

        # An upload nobody ever ran the engine over, counted by hand.
        uncounted = create_survey(conn, site_id=site["id"])
        lone = create_media(conn, tmp / "uncounted.jpg", "image",
                            survey_id=uncounted["id"], width=800, height=600)
        first = create_correction(conn, uncounted["id"], 9)
        check("a first hand count adopts the sortie's only piece of footage",
              first["run"]["media_id"] == lone["id"] and first["supersedes"] is None
              and first["run"]["quality"]["corrects_run"] is None,
              # Left NULL it would reload as a nameless ground count over a
              # file that is still sitting in the archive.
              )
        many = create_survey(conn, site_id=site["id"])
        create_media(conn, tmp / "a.jpg", "image", survey_id=many["id"])
        create_media(conn, tmp / "b.jpg", "image", survey_id=many["id"])
        check("with several files a hand count claims none of them",
              create_correction(conn, many["id"], 4)["run"]["media_id"] is None,
              # Picking one would assert which frame was counted; the survey
              # link already says everything that is actually known.
              )

        # --- hard delete, gated behind retirement ------------------------
        keep = create_survey(conn, site_id=site["id"], captured_at="2026-08-04T08:00:00Z")
        keep_media = create_media(conn, tmp / "keep.jpg", "image",
                                  survey_id=keep["id"], width=100, height=100)
        keep_run = create_run(conn, None, keep_media["id"], "countgd",
                              band=CountBand(low=1, best=2, high=3, basis="single_image"))
        insert_points(conn, keep_run, [Point(x=1.0, y=1.0)])

        raises("a survey still in the estimate cannot be destroyed", NotRetired,
               purge_survey, conn, c_survey["id"])
        check("a refused purge destroyed nothing",
              len(list_survey_runs(conn, c_survey["id"])) == 3
              and len(get_points(conn, c_run)) == 2)
        raises("purging a survey that does not exist is a lookup failure", LookupError,
               purge_survey, conn, "no-such-survey")

        update_survey(conn, c_survey["id"], retired_at=_utcnow(),
                      retired_reason="test junk", retired_by="a.n")
        preview = purge_survey(conn, c_survey["id"], dry_run=True)
        check("the preview counts what the delete will destroy",
              preview["counts"] == {"media": 1, "jobs": 1, "runs": 3, "points": 2,
                                    "edits": 1, "track_points": 0},
              preview["counts"])
        check("the preview names the files on disk, exactly as the rows hold them",
              preview["files"] == [c_media["path"]]
              and preview["filenames"] == ["corrected.jpg"],
              # Verbatim, unresolved: the caller checks them against the
              # workspace itself, and a path this module had already rewritten
              # would move that check onto a string nothing else ever stored.
              preview["files"])
        check("a dry run writes nothing",
              get_survey(conn, c_survey["id"]) is not None
              and len(list_survey_runs(conn, c_survey["id"])) == 3)

        receipt = purge_survey(conn, c_survey["id"])
        check("the purge reports what it destroyed",
              receipt["counts"] == preview["counts"] and receipt["dry_run"] is False)
        check("the survey is gone", get_survey(conn, c_survey["id"]) is None)
        check("no orphan runs", conn.execute(
            "SELECT COUNT(*) FROM run WHERE id IN (?, ?, ?)",
            (c_run, c_first["id"], second["id"])).fetchone()[0] == 0)
        check("no orphan points", conn.execute(
            "SELECT COUNT(*) FROM point WHERE run_id = ?", (c_run,)).fetchone()[0] == 0)
        check("no orphan edits", conn.execute(
            "SELECT COUNT(*) FROM edit WHERE run_id = ?", (c_run,)).fetchone()[0] == 0)
        check("no orphan media or jobs",
              get_media(conn, c_media["id"]) is None and get_job(conn, c_job) is None)
        check("the archive holds no dangling reference at all",
              conn.execute("PRAGMA foreign_key_check").fetchall() == [],
              # The one check that catches a table this function forgot: add a
              # child table later and skip it here, and this fails loudly
              # instead of leaving a row pointing at a survey nobody can find.
              )
        check("an unrelated survey is untouched",
              get_survey(conn, keep["id"]) is not None
              and get_run(conn, keep_run)["count_best"] == 2
              and len(get_points(conn, keep_run)) == 1
              and get_media(conn, keep_media["id"]) is not None)
        check("the sortie every earlier check reads is untouched",
              get_survey(conn, survey["id"]) is not None
              and verified_count(conn, run_id) == 5)
        # --- durable inferred populations ------------------------------
        snapshots = [
            {"id": "survey-a:group:alpha", "surveyId": "survey-a",
             "observedAt": "2026-08-01T09:00:00Z",
             "center": {"lat": 44.8, "lng": 50.3}, "size": 20,
             "source": "aggregate", "memberIds": ["det-a"]},
            {"id": "survey-b:group:bravo", "surveyId": "survey-b",
             "observedAt": "2026-08-03T09:00:00Z",
             "center": {"lat": 44.9, "lng": 50.4}, "size": 19,
             "source": "aggregate", "memberIds": ["det-b"]},
        ]
        synced = sync_population_tracks(
            conn, [{"id": "group-track-1", "observations": snapshots}]
        )
        pop_id = synced["tracks"][0]["population_id"]
        check("population sync creates one durable group",
              len(synced["populations"]) == 1
              and len(synced["populations"][0]["observations"]) == 2)
        renamed = rename_population(conn, pop_id, "Ulan Junior")
        check("population name persists", renamed["name"] == "Ulan Junior")
        again = sync_population_tracks(
            conn, [{"id": "rebuilt-track-99", "observations": snapshots}]
        )
        check("observation overlap survives an algorithm track id change",
              again["tracks"][0]["population_id"] == pop_id
              and get_population(conn, pop_id)["name"] == "Ulan Junior")

        rejected = review_population_link(
            conn, snapshots[0]["id"], snapshots[1]["id"], "rejected", "a.n"
        )
        check("rejecting a link splits the later observation",
              rejected["population_id"] != pop_id
              and len(list_populations(conn)) == 2)
        confirmed = review_population_link(
            conn, snapshots[0]["id"], snapshots[1]["id"], "confirmed", "a.n"
        )
        check("confirming a link merges and pins both observations",
              len(list_populations(conn)) == 1
              and all(o["assignment_status"] == "confirmed"
                      for o in get_population(conn, pop_id)["observations"]))
        check("population link verdict is durable",
              list_population_link_reviews(conn)[0]["decision"] == "confirmed")

        # --- environment ------------------------------------------------
        # The column list is duplicated from env.VALUE_COLUMNS to keep this
        # module free of the HTTP clients; that duplication is only safe if
        # something fails when the two drift apart.
        import env as env_mod  # same sys.path insert as `contract` above

        check("env column list matches the source clients",
              ENV_VALUE_COLUMNS == env_mod.VALUE_COLUMNS,
              # A source that starts measuring something the table has no
              # column for would otherwise be silently refused, one variable at
              # a time, with the loss visible only as an empty chart.
              f"db={len(ENV_VALUE_COLUMNS)} env={len(env_mod.VALUE_COLUMNS)}")
        check("every env column actually exists in the table",
              {r["name"] for r in conn.execute("PRAGMA table_info(env_sample)")}
              >= set(ENV_VALUE_COLUMNS) | set(ENV_META_COLUMNS)
              | {"source", "measured_at", "lat", "lng", "fetched_at"})

        def env_sample(source, measured_at, lat, lng, **values):
            meta = {
                "mur": (1000, "0.01° (~1 km)", "point"),
                "openmeteo_icon_eu": (6500, "6.5 km (ICON-EU)", "point"),
                "gwm_sea_level": (None, "whole basin", "basin"),
                "viirs_chl": (9000, "9 km", "point"),
            }.get(source, (1000, "1 km", "point"))
            return {
                "source": source, "dataset": f"{source}-dataset",
                "measured_at": measured_at, "lat": lat, "lng": lng,
                "values": values,
                "resolution_m": meta[0], "resolution": meta[1], "scope": meta[2],
                "latency_note": f"{source} lag",
            }

        first = insert_env_samples(conn, [
            env_sample("mur", "2026-08-08T09:00:00Z", 44.85, 50.35, sst_c=27.418),
            env_sample("coraltemp", "2026-08-08T12:00:00Z", 44.825, 50.325,
                       sst_c=27.7, sst_anomaly_c=3.9),
            env_sample("openmeteo_icon_eu", "2026-08-10T07:00:00Z", 44.875, 50.375,
                       wind_ms=3.16, wind_dir=288.0, gust_ms=6.2, air_t=29.8),
        ])
        check("insert_env_samples writes every source as its own row",
              first == {"written": 3, "new": 3, "skipped": []}, first)

        again = insert_env_samples(conn, [
            env_sample("mur", "2026-08-08T09:00:00Z", 44.85, 50.35, sst_c=27.418),
        ])
        check("re-storing the same slice dedupes instead of accumulating",
              again["written"] == 1 and again["new"] == 0
              and conn.execute("SELECT COUNT(*) FROM env_sample WHERE source='mur'"
                               ).fetchone()[0] == 1,
              again)

        # A second run of a source that measured only ONE of a pair must not
        # blank the other: VIIRS publishes concentration daily and thickness as
        # a 4-day composite, so the two halves of one row arrive separately.
        insert_env_samples(conn, [
            env_sample("viirs_ice", "2026-02-10T00:00:00Z", 45.8, 49.5, ice_conc=1.0),
        ])
        insert_env_samples(conn, [
            env_sample("viirs_ice", "2026-02-10T00:00:00Z", 45.8, 49.5,
                       ice_thickness_m=1.1076),
        ])
        merged = conn.execute(
            "SELECT ice_conc, ice_thickness_m FROM env_sample WHERE source='viirs_ice'"
        ).fetchone()
        check("a partial re-store merges rather than blanking what it did not measure",
              tuple(merged) == (1.0, 1.1076), tuple(merged))

        raises("a sample that measured nothing is refused", ValueError,
               _env_row, {"source": "mur", "measured_at": "2026-08-08T09:00:00Z",
                          "lat": 1.0, "lng": 1.0, "values": {}})
        raises("a sample with no measured_at is refused", ValueError,
               _env_row, {"source": "mur", "lat": 1.0, "lng": 1.0,
                          "values": {"sst_c": 3.0}})
        raises("a value with no column is refused, never dropped", ValueError,
               _env_row, {"source": "mur", "measured_at": "2026-08-08T09:00:00Z",
                          "lat": 1.0, "lng": 1.0, "values": {"salinity_psu": 12.8}})
        bad = insert_env_samples(conn, [
            {"source": "broken", "lat": 1.0, "lng": 1.0, "values": {"sst_c": 1.0}},
            env_sample("mur", "2026-08-07T09:00:00Z", 44.85, 50.35, sst_c=26.9),
        ])
        check("one bad sample does not cost the good one it arrived with",
              bad["written"] == 1 and bad["new"] == 1 and len(bad["skipped"]) == 1,
              bad)

        # A zero is a measurement and must survive; only None means "not
        # measured". This is the whole GFS-Wave lesson in one assertion.
        insert_env_samples(conn, [
            env_sample("openmeteo_mfwam", "2026-08-10T07:00:00Z", 44.875, 50.375,
                       wave_m=0.0, wave_period_s=2.9),
        ])
        calm = conn.execute(
            "SELECT wave_m, sst_c FROM env_sample WHERE source='openmeteo_mfwam'"
        ).fetchone()
        check("a measured zero is stored as zero and an unmeasured value as NULL",
              calm["wave_m"] == 0.0 and calm["sst_c"] is None)

        at = env_at(conn, 44.85, 50.35, "2026-08-10T07:00:00Z")
        by_source = {s["source"]: s for s in at}
        check("env_at answers with one row per source, never a merge",
              len(at) == len(by_source) and "mur" in by_source
              and "openmeteo_icon_eu" in by_source,
              sorted(by_source))
        check("env_at carries the provenance of each value",
              by_source["mur"]["values"] == {"sst_c": 27.418}
              and by_source["mur"]["measured_at"] == "2026-08-08T09:00:00Z"
              and by_source["mur"]["resolution_m"] == 1000
              and by_source["mur"]["latency_note"] == "mur lag")
        check("env_at reports how stale and how far away each value is",
              abs(by_source["mur"]["gap_hours"] - 46.0) < 0.01
              and by_source["mur"]["distance_km"] == 0.0,
              by_source["mur"]["gap_hours"])
        check("env_at picks the slice nearest the moment asked about",
              by_source["mur"]["values"]["sst_c"] == 27.418)
        check("env_at leaves out a source with nothing to say about that moment",
              all(s["source"] != "mur"
                  for s in env_at(conn, 44.85, 50.35, "2026-01-01T00:00:00Z")))
        check("env_at ignores a cell on the other side of the sea",
              env_at(conn, 39.0, 50.0, "2026-08-10T07:00:00Z") == [])

        series = env_series(conn, 44.85, 50.35,
                            "2026-08-01T00:00:00Z", "2026-08-11T00:00:00Z")
        stamps = [s["measured_at"] for s in series if s["source"] == "mur"]
        check("env_series returns both mur slices, oldest first",
              stamps == ["2026-08-07T09:00:00Z", "2026-08-08T09:00:00Z"], stamps)
        check("env_series honours the window",
              env_series(conn, 44.85, 50.35,
                         "2026-08-09T00:00:00Z", "2026-08-11T00:00:00Z",
                         sources=["mur"]) == [])

        # Two cells of one product at one slice: a layer, not a point.
        insert_env_samples(conn, [
            env_sample("mur", "2026-08-08T09:00:00Z", 45.35, 50.35, sst_c=26.1),
            env_sample("viirs_chl", "2026-08-08T12:00:00Z", 44.875, 50.375, chl_a=11.2764),
        ])
        grid = env_grid(conn, "2026-08-10T00:00:00Z", ["sst_c", "chl_a"])
        sst_layers = [l for l in grid if l["var"] == "sst_c"]
        mur_layer = next(l for l in sst_layers if l["source"] == "mur")
        check("env_grid keeps every source as its own layer",
              {(l["source"], l["var"]) for l in grid}
              == {("mur", "sst_c"), ("coraltemp", "sst_c"), ("viirs_chl", "chl_a")},
              {(l["source"], l["var"]) for l in grid})
        check("a layer is ONE slice, so its cells share a measured_at",
              mur_layer["measured_at"] == "2026-08-08T09:00:00Z"
              and mur_layer["count"] == 2)
        check("a layer states its true cell size and its sampled spacing apart",
              mur_layer["resolution_m"] == 1000
              and abs(mur_layer["spacing_deg"] - 0.5) < 1e-6,
              # 1 km cells half a degree apart: drawing them at the spacing
              # would claim a 50 km measurement, drawing them at the cell size
              # would show an empty map. Both numbers, or neither is honest.
              mur_layer["spacing_deg"])
        check("a 9 km layer is never folded into the 1 km one",
              next(l for l in grid if l["var"] == "chl_a")["resolution_m"] == 9000)
        raises("env_grid refuses a variable that is not measured here", ValueError,
               env_grid, conn, "2026-08-10T00:00:00Z", ["salinity_psu"])

        # The whole point of storing the basin figure against the altimetry
        # crossing rather than the survey: it is not a measurement of the
        # survey's cell and must not read as one.
        insert_env_samples(conn, [
            env_sample("gwm_sea_level", "2026-08-04T12:31:00Z", 41.97, 50.385,
                       sea_level_m=-28.46),
        ])
        basin = env_at(conn, 41.97, 50.385, "2026-08-10T00:00:00Z",
                       max_gap_h=None, sources=["gwm_sea_level"])
        check("a basin-scale figure keeps its own scope and coordinate",
              len(basin) == 1 and basin[0]["scope"] == "basin"
              and basin[0]["resolution_m"] is None
              and basin[0]["values"] == {"sea_level_m": -28.46})
        # 320 km from where the altimetry pass is taken, and six days old on a
        # ten-day product. Under the point rules it would be excluded twice
        # over - and it is exactly the variable the research doc says must
        # reach every survey, because the islands are joining the mainland.
        far = env_at(conn, 44.85, 50.35, "2026-08-10T00:00:00Z",
                     sources=["gwm_sea_level"])
        check("the basin figure reaches a survey 300 km from the altimetry pass",
              len(far) == 1 and far[0]["values"] == {"sea_level_m": -28.46}
              and far[0]["distance_km"] > 300, far)
        check("but it is still bounded - a year later it is not this survey's level",
              env_at(conn, 44.85, 50.35, "2027-08-10T00:00:00Z",
                     sources=["gwm_sea_level"]) == [])
        check("a point-scale source is NOT let out of the box by the same rule",
              env_at(conn, 41.97, 50.385, "2026-08-10T00:00:00Z",
                     sources=["mur"]) == [])

        env_rows_before = conn.execute("SELECT COUNT(*) FROM env_sample").fetchone()[0]
        init_db(conn)  # again, with data in the table
        check("init_db is idempotent over a populated env_sample",
              conn.execute("SELECT COUNT(*) FROM env_sample").fetchone()[0]
              == env_rows_before, env_rows_before)

        conn.close()

        # --- durability ------------------------------------------------
        reopened = connect(db_file)
        check("edits survive a reconnect", verified_count(reopened, run_id) == 5)
        check("job rows survive a reconnect", get_job(reopened, job_id)["status"] == "done")
        check("env samples survive a reconnect",
              env_at(reopened, 44.85, 50.35, "2026-08-10T07:00:00Z",
                     sources=["mur"])[0]["values"]["sst_c"] == 27.418)
        reopened.close()

    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        os.environ.pop("SEALV_DB", None)

    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        for name in FAILED:
            print(f"  FAILED: {name}")
        sys.exit(1)
