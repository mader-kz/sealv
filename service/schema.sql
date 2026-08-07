-- Tulen detection backend schema.
--
-- SQLite with WAL. Single-node worker pool for now; every construct here maps
-- 1:1 onto Postgres if this needs to scale out (the only change is the job
-- claim, which becomes SELECT ... FOR UPDATE SKIP LOCKED).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS site (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    region      TEXT,                 -- KZ-North | KZ-East | KZ-South | AZ | RU | TM | IR
    lat         REAL,
    lng         REAL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One flight / observation. The metadata here is what makes a count scientific
-- rather than a number: haul-out counts swing enormously with tide and ice.
CREATE TABLE IF NOT EXISTS survey (
    id           TEXT PRIMARY KEY,
    site_id      TEXT REFERENCES site(id),
    captured_at  TEXT,                -- ISO8601, from telemetry when available
    altitude_m   REAL,                -- drives GSD -> tiling, see geo.py
    gsd_cm_px    REAL,                -- ground sample distance
    -- How gsd_cm_px was obtained. "assumed_native_width" means we divided by the
    -- media's own width, which is only correct for an uncropped native frame -
    -- a screenshot or downscaled clip yields a value several times too coarse
    -- and mis-selects tiling. Recorded so a caller can tell a measured scale
    -- from an assumed one instead of trusting a plausible wrong number.
    -- Trustworthy: explicit | optics. Everything else names which term of
    -- gsd = sensor_mm * alt / (focal_mm * width_px) was guessed rather than
    -- given, because guessing any of them shifts scale silently.
    gsd_source   TEXT,                -- explicit | optics | assumed_optics
                                      -- | assumed_native_width
                                      -- | assumed_native_width_and_optics | unknown
    tide_state   TEXT,                -- low | falling | high | rising | unknown
    sea_ice_pct  REAL,
    operator     TEXT,
    notes        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media (
    id          TEXT PRIMARY KEY,
    survey_id   TEXT REFERENCES survey(id),
    path        TEXT NOT NULL,        -- local path in the workspace
    filename    TEXT,
    kind        TEXT NOT NULL,        -- image | video
    width       INTEGER,
    height      INTEGER,
    duration_s  REAL,
    bytes       INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Flight track from DJI SRT / JSON sidecar / manual pin.
CREATE TABLE IF NOT EXISTS track_point (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id    TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    t           REAL NOT NULL,        -- seconds from media start
    lat         REAL NOT NULL,
    lng         REAL NOT NULL,
    alt         REAL,
    source      TEXT                  -- srt | json | mp4 | manual
);
CREATE INDEX IF NOT EXISTS ix_track_media_t ON track_point(media_id, t);

CREATE TABLE IF NOT EXISTS job (
    id           TEXT PRIMARY KEY,
    media_id     TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    params       TEXT NOT NULL,       -- json
    status       TEXT NOT NULL,       -- queued | running | done | failed | cancelled
    progress     TEXT,                -- json {frames_done, frames_total, stage}
    error        TEXT,
    claimed_by   TEXT,
    -- A claim is a LEASE, not a handover. The worker running this job refreshes
    -- claimed_at while it works, so a claim that has stopped moving is a claim
    -- whose worker is gone - the only way to tell a crashed job from a slow one.
    -- See db.requeue_stale_jobs / db.heartbeat_job.
    claimed_at   TEXT,
    -- Claims so far. Recovery has to be bounded: a job that kills its worker
    -- (OOM, say) would otherwise be requeued forever, jamming the queue and
    -- taking the machine down with it on every retry.
    attempts     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_job_status ON job(status, created_at);

-- One detection pass. Counts are a BAND, never a single integer: we measured a
-- 25% spread across four frames 1.5s apart on animals that barely moved.
CREATE TABLE IF NOT EXISTS run (
    id             TEXT PRIMARY KEY,
    job_id         TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
    media_id       TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    engine         TEXT NOT NULL,
    engine_params  TEXT,              -- json
    count_low      INTEGER,           -- confirmed in every frame (conservative)
    count_best     INTEGER,           -- consensus at min_support
    -- Permissive: everything any frame saw, corroborated or not. NOT the best
    -- single frame - that sits below the cross-frame union, so using it let
    -- count_best land above count_high.
    count_high     INTEGER,           -- seen by any frame at all (permissive)
    -- consensus_N_frames = agreement required (min_support > 1)
    -- union_N_frames     = min_support 1, no agreement required
    basis          TEXT,              -- e.g. consensus_4_frames | union_4_frames | single_image
    quality        TEXT,              -- json {tiles_rejected, malformed, registration}
    seconds        REAL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_run_media ON run(media_id, created_at);

CREATE TABLE IF NOT EXISTS point (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    frame_idx  INTEGER,               -- NULL for stills
    x          REAL NOT NULL,         -- pixel coords in source resolution
    y          REAL NOT NULL,
    lat        REAL,                  -- NULL when no track available
    lng        REAL,
    score      REAL,                  -- detector confidence
    support    INTEGER,               -- frames confirming, NULL for stills
    status     TEXT NOT NULL DEFAULT 'auto'  -- auto | validated | false_positive
);
CREATE INDEX IF NOT EXISTS ix_point_run ON point(run_id);

-- Append-only. Who corrected a count and when is survey evidence, so edits are
-- never a destructive update of `point`.
CREATE TABLE IF NOT EXISTS edit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    op          TEXT NOT NULL,        -- add | remove | reinstate
    point_id    INTEGER,
    x           REAL,
    y           REAL,
    operator    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_edit_run ON edit(run_id, created_at);
