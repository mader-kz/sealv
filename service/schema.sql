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

-- One measurement of the environment, from ONE source, at ONE point and time.
--
-- The key is (source, measured_at, lat, lng) and the source is part of it on
-- purpose. A single coordinate and moment is described by five or six feeds
-- with different cell sizes and different lags - MUR at 1 km two days back,
-- chlorophyll at 9 km reconstructed through cloud, sea level as one figure for
-- the whole basin ten days wide - and folding them into one row would force a
-- choice of "the" temperature and throw the rest away. So a point-time gets
-- several rows, one per source, and every value carries its own provenance all
-- the way to the screen (research doc §7.6).
--
-- Every measurable column is NULLable and stays NULL when the source did not
-- measure it. NULL here means "not measured", never zero: NCEP GFS-Wave answers
-- HTTP 200 with a full series of exact 0.0 over a basin where it has no grid
-- nodes at all, and a pipeline that stored those would learn that the Caspian
-- is always calm. service/env.py refuses fill values before they reach this
-- table; the schema keeps that refusal representable.
--
-- `measured_at` is the SLICE's own time - when the satellite passed or the
-- model step is valid for - and `fetched_at` is when we asked. The distance
-- between them is the latency the operator has to be told about, so both are
-- stored rather than collapsed into one "timestamp".
CREATE TABLE IF NOT EXISTS env_sample (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT NOT NULL,        -- stable id, see env.SOURCES
    dataset       TEXT,                 -- exact product id the value came from
    measured_at   TEXT NOT NULL,        -- ISO8601 Z, the slice's time
    lat           REAL NOT NULL,        -- the CELL's coordinate, not the ask
    lng           REAL NOT NULL,
    -- atmosphere
    wind_ms         REAL,
    wind_dir        REAL,               -- degrees, meteorological (from)
    gust_ms         REAL,
    air_t           REAL,               -- degrees C
    pressure        REAL,               -- hPa at the surface
    cloud           REAL,               -- percent
    -- sea state
    wave_m          REAL,               -- significant wave height
    wave_period_s   REAL,
    -- water
    sst_c           REAL,
    sst_anomaly_c   REAL,               -- against the long baseline
    -- ice. class is IMS (1 sea, 2 land, 3 sea ice, 4 snow-covered land);
    -- conc and thickness come from a different product at a different lag,
    -- which is why they are separate columns and usually separate rows.
    ice_class       REAL,
    ice_conc        REAL,
    ice_thickness_m REAL,
    -- biology proxy and the basin-scale figure
    chl_a           REAL,               -- mg/m3
    sea_level_m     REAL,               -- EGM2008 datum
    -- provenance of the measurement itself, stored beside it so a reader never
    -- has to look up what "mur" means to know the cell was 1 km wide.
    resolution_m  REAL,                 -- NULL for a basin-wide figure
    resolution    TEXT,                 -- human form of the same fact
    scope         TEXT,                 -- point | basin
    latency_note  TEXT,
    fetched_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The dedupe key. A backfill rerun, an overlapping worker cycle and a manual
-- probe all produce the same row for the same slice; without this they would
-- produce three, and a series would show one measurement as three events.
CREATE UNIQUE INDEX IF NOT EXISTS ux_env_sample
    ON env_sample(source, measured_at, lat, lng);
-- Nearest-in-time for one place (the survey card, the series) and the grid
-- slice for one moment (the map layer). Both are the whole read pattern.
CREATE INDEX IF NOT EXISTS ix_env_sample_cell ON env_sample(lat, lng, measured_at);
CREATE INDEX IF NOT EXISTS ix_env_sample_slice ON env_sample(source, measured_at);

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
    source_id             TEXT PRIMARY KEY REFERENCES pollution_source(id),
    status                TEXT NOT NULL DEFAULT 'never',
    attempts              INTEGER NOT NULL DEFAULT 0,
    successes             INTEGER NOT NULL DEFAULT 0,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    total_items           INTEGER NOT NULL DEFAULT 0,
    total_inserted        INTEGER NOT NULL DEFAULT 0,
    total_updated         INTEGER NOT NULL DEFAULT 0,
    total_unchanged       INTEGER NOT NULL DEFAULT 0,
    last_attempt_at       TEXT,
    last_success_at       TEXT,
    last_item_count       INTEGER,
    last_inserted_count   INTEGER,
    last_updated_count    INTEGER,
    last_unchanged_count  INTEGER,
    last_error            TEXT,
    last_duration_ms      INTEGER,
    next_poll_at          TEXT,
    lease_owner           TEXT,
    lease_until           TEXT,
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
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
CREATE TABLE IF NOT EXISTS pollution_change (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id  TEXT NOT NULL REFERENCES pollution_incident(id) ON DELETE CASCADE,
    action       TEXT NOT NULL CHECK (action IN ('inserted', 'updated')),
    changed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ix_pollution_change_incident ON pollution_change(incident_id);
INSERT INTO pollution_change (incident_id, action, changed_at)
SELECT incident.id, 'inserted', strftime('%Y-%m-%dT%H:%M:%fZ', incident.created_at)
FROM pollution_incident AS incident
WHERE NOT EXISTS (
    SELECT 1 FROM pollution_change AS change WHERE change.incident_id = incident.id
);
CREATE TABLE IF NOT EXISTS pollution_record_cache (
    source_id     TEXT NOT NULL REFERENCES pollution_source(id) ON DELETE CASCADE,
    record_key    TEXT NOT NULL,
    content_hash  TEXT,
    observed_at   TEXT,
    outcome       TEXT NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (source_id, record_key)
);
CREATE TABLE IF NOT EXISTS pollution_host_rate (
    host             TEXT PRIMARY KEY,
    next_request_at  REAL NOT NULL
);
