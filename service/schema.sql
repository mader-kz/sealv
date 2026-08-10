-- SEALv detection backend schema.
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
    notes        TEXT,                -- free-text field notes, capped by the API
    -- Where this sortie was. Telemetry fills it from the track, a pin fills it
    -- from the operator dropping one on the map, and a ground count fills it
    -- from whoever typed it in. The SOURCE is stored next to the numbers
    -- because a GPS fix and a finger on a map are not the same evidence, and a
    -- map that draws them identically is making a claim it cannot support.
    lat             REAL,
    lng             REAL,
    location_source TEXT,             -- telemetry | pinned | manual | NULL
    -- Retirement, not deletion. A sortie withdrawn from the estimate (wrong
    -- site, duplicate upload, footage that turned out to be unusable) keeps
    -- every row it ever had; it is only filtered out of the default archive.
    -- Who withdrew it and why is the part that makes it defensible later.
    retired_at      TEXT,
    retired_reason  TEXT,
    retired_by      TEXT,
    -- A quick count: one frame cut out of a clip and ingested as a still,
    -- deliberately trading the cross-frame band for speed. `single_image` in
    -- the run's basis says the count came from one image; only these two say
    -- that image was a second of a video somebody chose not to analyse whole,
    -- which is the part a report has to be able to state.
    from_video      TEXT,             -- the clip's filename, NULL for a real still
    at_seconds      REAL,             -- offset of the chosen frame, seconds
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
    -- SHA-256 of the uploaded bytes. The same footage uploaded twice is the
    -- same sortie counted twice, which inflates a season's total by a whole
    -- colony - so the ingest path records the digest and tells the caller what
    -- it already holds. NULL on rows that predate the column: unknown, not
    -- unique, and the API says so rather than treating them as fresh.
    content_hash TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- ix_media_hash(content_hash) is NOT declared here, and that is deliberate.
-- This file is applied with executescript() before db._widen() has had a
-- chance to ALTER the column onto a database that predates it, so the index
-- statement would abort the whole script against exactly the archive the
-- widening exists to rescue - the service would fail to start on the boat.
-- It is created in db._widen(), which runs on every init_db, fresh or not.

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
    -- NULLable, both of them, for exactly one reason: a ground count. A human
    -- standing on the shore counting animals ran no job and uploaded no media,
    -- and it is still a count of that colony on that date - the one number in
    -- this archive that needs no engine to defend it. Forcing it to invent a
    -- job row and a media row would put fiction in two tables to satisfy a
    -- constraint. Machine runs still fill both; see db.create_observation.
    job_id         TEXT REFERENCES job(id) ON DELETE CASCADE,
    media_id       TEXT REFERENCES media(id) ON DELETE CASCADE,
    -- A run's survey normally comes through its media (run -> media -> survey),
    -- and for every engine run it still does; this column is NULL there. A
    -- ground count has no media, so without a direct link it would reach the
    -- archive with no date, no position and no site - a count floating free of
    -- the sortie it IS. Readers resolve COALESCE(media.survey_id, run.survey_id).
    survey_id      TEXT REFERENCES survey(id),
    engine         TEXT NOT NULL,     -- countgd | manual
    engine_params  TEXT,              -- json
    count_low      INTEGER,           -- confirmed in every frame (conservative)
    count_best     INTEGER,           -- consensus at min_support
    -- Permissive: everything any frame saw, corroborated or not. NOT the best
    -- single frame - that sits below the cross-frame union, so using it let
    -- count_best land above count_high.
    count_high     INTEGER,           -- seen by any frame at all (permissive)
    -- consensus_N_frames = agreement required (min_support > 1)
    -- union_N_frames     = min_support 1, no agreement required
    -- manual             = a person counted it; low = best = high, and the UI
    --                      must label it as a human's entry, never as a band
    basis          TEXT,              -- e.g. consensus_4_frames | union_4_frames | single_image | manual
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

-- A durable identity for an inferred seal group. The algorithm may rebuild
-- its candidate tracks as new surveys arrive; the observations below are the
-- stable seam that lets an operator's name and verdict survive that rebuild.
CREATE TABLE IF NOT EXISTS population (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS population_observation (
    id                TEXT PRIMARY KEY,
    population_id     TEXT NOT NULL REFERENCES population(id),
    survey_id          TEXT NOT NULL,
    observed_at        TEXT NOT NULL,
    lat                REAL NOT NULL,
    lng                REAL NOT NULL,
    size               INTEGER NOT NULL,
    source             TEXT NOT NULL, -- points | aggregate
    member_ids         TEXT NOT NULL, -- JSON array; evidence behind the snapshot
    assignment_status  TEXT NOT NULL DEFAULT 'auto', -- auto | confirmed
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_population_observation_population_time
    ON population_observation(population_id, observed_at);

-- Append-overwrite verdict per proposed edge. A rejected edge is retained so
-- the next automatic rebuild cannot quietly suggest it again.
CREATE TABLE IF NOT EXISTS population_link_review (
    from_observation_id TEXT NOT NULL,
    to_observation_id   TEXT NOT NULL,
    decision            TEXT NOT NULL, -- confirmed | rejected
    operator            TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (from_observation_id, to_observation_id),
    FOREIGN KEY (from_observation_id) REFERENCES population_observation(id),
    FOREIGN KEY (to_observation_id) REFERENCES population_observation(id)
);
-- Pollution: sources + incidents (estimated point + radius). Added 2026-08-10.
-- Encapsulated: new tables only, IF NOT EXISTS, no ALTER of existing tables.
CREATE TABLE IF NOT EXISTS pollution_source (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT,
    type        TEXT,
    poll_method TEXT,
    update_freq TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pollution_source_health (
    source_id           TEXT PRIMARY KEY REFERENCES pollution_source(id),
    status              TEXT NOT NULL DEFAULT 'never',
    attempts            INTEGER NOT NULL DEFAULT 0,
    successes           INTEGER NOT NULL DEFAULT 0,
    total_items         INTEGER NOT NULL DEFAULT 0,
    last_attempt_at     TEXT,
    last_success_at     TEXT,
    last_item_count     INTEGER,
    last_error          TEXT,
    last_duration_ms    INTEGER,
    next_poll_at        TEXT,
    lease_owner         TEXT,
    lease_until         TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_pollution_health_due ON pollution_source_health(next_poll_at);
CREATE TABLE IF NOT EXISTS field (
    name        TEXT PRIMARY KEY,
    alias       TEXT,
    lat         REAL NOT NULL,
    lng         REAL NOT NULL,
    radius_m    REAL NOT NULL DEFAULT 5000
);
CREATE TABLE IF NOT EXISTS pollution_incident (
    id                  TEXT PRIMARY KEY,
    source_id           TEXT NOT NULL REFERENCES pollution_source(id),
    observed_at         TEXT,
    lat                 REAL NOT NULL,
    lng                 REAL NOT NULL,
    radius_m            REAL NOT NULL DEFAULT 500,
    geom                TEXT,
    kind                TEXT,
    area_km2            REAL,
    confidence          REAL,
    location_precision  TEXT,
    raw                 TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_pollution_time ON pollution_incident(observed_at);
CREATE INDEX IF NOT EXISTS ix_pollution_geo ON pollution_incident(lat, lng);
CREATE INDEX IF NOT EXISTS ix_pollution_source ON pollution_incident(source_id);
