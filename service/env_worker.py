"""Environment collector: every few hours, ask the basin what it is doing.

Runs as its own process - `python -m service.env_worker` - alongside the
detection worker, and shares nothing with it but the database file. It claims
no jobs and touches no other table: its whole footprint is INSERT ... ON
CONFLICT into `env_sample`, in short IMMEDIATE transactions, which under WAL
lets the API read and the counting worker write throughout.

Why it exists at all, and why it starts now rather than when a model is wanted
-------------------------------------------------------------------------
Every source here is a stream, not an archive of record. MUR keeps its history
and ERA5 goes back to 1940, but ACSPO's archive is a rolling year, Sentinel-3
OLCI is a rolling ninety days, and the operational feeds publish one slice a
day and move on. A series that starts the day somebody wants to fit a model
starts empty, and no amount of budget buys back the winter that was not
recorded. The cheapest thing this project can do today is write down what the
sea is doing, every three hours, from the first day.

What one cycle collects
-----------------------
  * every SITE with a coordinate, and every distinct SURVEY coordinate, at
    `now` - the full point stack (wind, waves, both SSTs, ice, chlorophyll,
    sea level);
  * a coarse basin grid for every field a map is made of - both SSTs, the ice
    chart, wind and waves - so each layer has something to draw for the whole
    sea rather than a handful of dots around the sorties.

Rate and politeness
-------------------
Everything goes through `env.fetch`, which caches on disk per URL with a
per-source TTL and spaces requests per host. A cycle over twenty points costs
twenty requests once and nearly nothing on the next cycle inside the TTL,
because a daily product does not change between 09:00 and 12:00 and asking it
twice is just noise on somebody else's free service. The grid is the expensive
part - one strided request per field, not one per cell - and IMS is one 200 MB
download per DATE, decompressed to a basin patch and then read as bytes, which
is why the ice grid costs the same whether it samples ten cells or four
hundred.
"""

from __future__ import annotations

import argparse
import os
import signal
import sqlite3
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from typing import Any, Optional

from . import db, env

STOP = threading.Event()

#: Seconds between cycles. Three hours is the plan's figure and it matches the
#: fastest thing being collected: ICON-EU publishes a 3-hourly cycle, and the
#: satellite products are daily, so anything faster would re-read the same
#: slice and only cost somebody else bandwidth.
DEFAULT_INTERVAL_S = 3 * 3600.0

#: Grid sampling step in degrees. Half a degree over the basin is ~162 water
#: cells - a map that reads at basin zoom without pretending to a resolution
#: nobody sampled. It is a SPACING, not a cell size: every value returned is a
#: real 1 km product cell, and the layer says so (see db.env_grid).
DEFAULT_GRID_STEP = 0.5

#: Which fields the basin grid collects: sea-surface temperature from BOTH
#: products, the ice chart, the atmosphere (wind, gusts, air temperature,
#: pressure, cloud) and waves. BOTH atmospheric ids are listed so that whichever
#: one serves the date is the one that runs - ICON-EU inside its window, ERA5
#: outside it - and the other correctly stands aside.
#:
#: Wind and waves are here because they were pickable fields that nothing ever
#: collected across the basin: choosing wind drew FOUR arrows, the survey sites
#: the point sampler had visited, and read as a broken layer rather than as the
#: absence it was.
#:
#: CoralTemp is here because the field picker offers it as a basin field, and
#: it was not collected as one: its only rows came from the point sampler at
#: survey sites, so choosing it drew three dots hidden under the colony chips
#: and looked like a broken layer. It is also the whole point of keeping
#: sources separate - a second, independent reading of the same water, free to
#: disagree with MUR in public. Each is drawn at its own cell size and named,
#: never blended.
#:
#: Chlorophyll stays out: it is a 9 km field, and beside a 1 km one it invites
#: exactly the blending this product refuses. Ask for it with --grid-sources.
DEFAULT_GRID_SOURCES = (
    "mur", "coraltemp", "ims",
    "openmeteo_icon_eu", "openmeteo_era5", "openmeteo_mfwam",
)


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def _env_num(name: str, default: float, cast=float):
    """An environment override that will not stop the collector on a typo."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return cast(raw)
    except (TypeError, ValueError):
        log(f"{name}={raw!r} is not a number - using {default}")
        return default


def _install_signals() -> None:
    def handler(signum: int, _frame) -> None:
        if STOP.is_set():
            log("second signal - exiting now")
            os._exit(130)
        STOP.set()
        log(f"signal {signum} - finishing this cycle, then stopping")

    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)


# --------------------------------------------------------------------------
# where to look
# --------------------------------------------------------------------------

def collection_points(conn: sqlite3.Connection, max_points: int = 60) -> list[dict]:
    """Places worth a full point stack: named sites first, then sorties.

    Sites lead because a site is a place somebody decided matters, and its
    series is the one a model will be fitted against. Survey coordinates
    follow, deduplicated to ~1 km - a sortie is dozens of frames around one
    spot, and collecting the same 1 km SST cell forty times would spend forty
    requests to learn one number.

    Capped, because a season's archive is thousands of sorties and a cycle that
    tries to describe all of them individually stops being a three-hour cycle.
    The cap keeps the newest, which is where the operational value is; the
    older ones already have their conditions from the backfill.
    """
    out: list[dict] = []
    seen: set[tuple[float, float]] = set()

    def add(lat: Any, lng: Any, kind: str, ref: Optional[str], name: Optional[str]) -> None:
        if lat is None or lng is None:
            return
        try:
            lat_f, lng_f = float(lat), float(lng)
        except (TypeError, ValueError):
            return
        # ~1 km at this latitude. Two sorties inside one MUR cell are one point
        # to every source in the stack.
        key = (round(lat_f, 2), round(lng_f, 2))
        if key in seen:
            return
        seen.add(key)
        out.append({"lat": lat_f, "lng": lng_f, "kind": kind, "id": ref, "name": name})

    for site in db.list_sites(conn):
        add(site.get("lat"), site.get("lng"), "site", site.get("id"), site.get("name"))

    for row in conn.execute(
        """SELECT id, lat, lng FROM survey
            WHERE lat IS NOT NULL AND lng IS NOT NULL AND retired_at IS NULL
         ORDER BY COALESCE(captured_at, created_at) DESC, id DESC
            LIMIT ?""",
        (max_points * 4,),
    ):
        if len(out) >= max_points:
            break
        add(row["lat"], row["lng"], "survey", row["id"], None)

    return out[:max_points]


# --------------------------------------------------------------------------
# one cycle
# --------------------------------------------------------------------------

def collect_once(
    conn: sqlite3.Connection,
    when: Optional[datetime] = None,
    *,
    grid_step: float = DEFAULT_GRID_STEP,
    grid_sources: tuple[str, ...] = DEFAULT_GRID_SOURCES,
    max_points: int = 60,
    skip_grid: bool = False,
) -> dict:
    """One collection pass. Never raises; returns what it managed.

    Every failure is counted and named rather than thrown, for the reason the
    whole module exists: a chlorophyll host being down must not cost the wind
    that came with it, and a cycle that dies on the first bad response leaves
    a hole in the series that nothing later can fill. The receipt is logged, so
    a feed that has been failing since Tuesday is visible as a number rather
    than as an empty chart three weeks later.
    """
    when = when or datetime.now(timezone.utc)
    stamp = when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    started = time.perf_counter()
    receipt = {
        "at": stamp,
        "points": 0,
        "written": 0,
        "new": 0,
        "grid_cells": 0,
        "problems": [],
    }

    for place in collection_points(conn, max_points=max_points):
        if STOP.is_set():
            break
        try:
            samples, problems = env.collect_point(place["lat"], place["lng"], when)
        except Exception as exc:  # noqa: BLE001 - one place must not end the cycle
            receipt["problems"].append(
                {"where": place["id"], "source": "*", "error": f"{type(exc).__name__}: {exc}"}
            )
            continue
        stored = db.insert_env_samples(conn, samples)
        receipt["points"] += 1
        receipt["written"] += stored["written"]
        receipt["new"] += stored["new"]
        for problem in problems:
            receipt["problems"].append({"where": place["id"], **problem})
        for reason in stored["skipped"]:
            receipt["problems"].append({"where": place["id"], "source": "_store",
                                        "error": reason})

    if not skip_grid and not STOP.is_set():
        try:
            cells, problems = env.collect_grid(
                when, step_deg=grid_step, sources=grid_sources
            )
        except Exception as exc:  # noqa: BLE001
            cells, problems = [], [{"source": "grid", "error": f"{type(exc).__name__}: {exc}"}]
        stored = db.insert_env_samples(conn, cells)
        receipt["grid_cells"] = stored["written"]
        receipt["written"] += stored["written"]
        receipt["new"] += stored["new"]
        for problem in problems:
            receipt["problems"].append({"where": "grid", **problem})

    receipt["seconds"] = round(time.perf_counter() - started, 1)
    return receipt


def _log_receipt(receipt: dict) -> None:
    log(
        f"cycle {receipt['at']}: {receipt['points']} point(s), "
        f"{receipt['grid_cells']} grid cell(s), {receipt['written']} sample(s) stored, "
        f"{receipt['new']} new, {receipt['seconds']}s"
    )
    # Collapsed by source: "viirs_ice failed at 14 places" is one line an
    # operator can act on; fourteen identical stack-free sentences are not.
    tally: dict[tuple[str, str], int] = {}
    for problem in receipt["problems"]:
        text = " ".join(str(problem.get("error", "")).split())[:160]
        tally[(problem.get("source", "?"), text)] = \
            tally.get((problem.get("source", "?"), text), 0) + 1
    for (source, text), count in sorted(tally.items(), key=lambda kv: -kv[1]):
        log(f"  {source}: {text}" + (f"  (x{count})" if count > 1 else ""))


# --------------------------------------------------------------------------
# loop
# --------------------------------------------------------------------------

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m service.env_worker",
        description="Collect Caspian environmental conditions on a timer.",
    )
    parser.add_argument("--once", action="store_true",
                        help="run one cycle and exit")
    parser.add_argument("--db", default=None,
                        help="database path (defaults to db.default_db_path())")
    parser.add_argument(
        "--interval", type=float,
        default=_env_num("SEALV_ENV_INTERVAL_S", DEFAULT_INTERVAL_S),
        help=f"seconds between cycles (default {DEFAULT_INTERVAL_S:g}, "
             "$SEALV_ENV_INTERVAL_S)",
    )
    parser.add_argument("--grid-step", type=float,
                        default=_env_num("SEALV_ENV_GRID_STEP", DEFAULT_GRID_STEP),
                        help=f"basin grid spacing in degrees (default {DEFAULT_GRID_STEP})")
    parser.add_argument("--grid-sources", default=",".join(DEFAULT_GRID_SOURCES),
                        help="comma-separated sources for the basin grid")
    parser.add_argument("--max-points", type=int,
                        default=int(_env_num("SEALV_ENV_MAX_POINTS", 60, int)),
                        help="most places to describe individually per cycle")
    parser.add_argument("--no-grid", action="store_true",
                        help="points only, skip the basin grid")
    parser.add_argument("--time", default=None,
                        help="collect for this instant instead of now (ISO8601)")
    args = parser.parse_args(argv)

    _install_signals()

    grid_sources = tuple(s.strip() for s in args.grid_sources.split(",") if s.strip())
    unknown = [s for s in grid_sources if s not in env.SOURCES]
    if unknown:
        log(f"refusing to start: no such source(s) {unknown}; "
            f"known: {sorted(env.SOURCES)}")
        return 1

    try:
        when = env.as_utc(args.time) if args.time else None
    except ValueError as exc:
        log(f"refusing to start: --time {args.time!r} is not a timestamp ({exc})")
        return 1

    # No preflight.require here, deliberately: this worker needs no model, no
    # ffmpeg and no workspace - only the database and the network. Refusing to
    # start it because the detector cannot load would stop the series
    # accumulating for a reason that has nothing to do with it.
    conn = db.init_db(db.connect(args.db))
    log(
        f"env collector ready (every {args.interval:g}s, grid {args.grid_step}° "
        f"from {','.join(grid_sources) or 'nothing'}, cache {env.cache_dir()})"
    )

    try:
        while not STOP.is_set():
            try:
                receipt = collect_once(
                    conn, when,
                    grid_step=args.grid_step,
                    grid_sources=grid_sources,
                    max_points=args.max_points,
                    skip_grid=args.no_grid,
                )
                _log_receipt(receipt)
            except Exception:
                # A cycle that dies must not take the timer with it: the next
                # one is three hours of series away.
                log(f"cycle failed\n{traceback.format_exc()}")
            if args.once:
                return 0
            STOP.wait(max(60.0, args.interval))
    finally:
        conn.close()

    log("env collector stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
