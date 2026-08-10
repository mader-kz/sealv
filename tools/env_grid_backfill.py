#!/usr/bin/env python3
"""Backfill the basin GRID for past moments, so the time control has a past.

    python3 tools/env_grid_backfill.py --days 14 --step-hours 3
    python3 tools/env_grid_backfill.py --days 30 --sources weather,waves
    python3 tools/env_grid_backfill.py --days 7 --dry-run

What this is for, and how it differs from `env_backfill.py`
-----------------------------------------------------------
`env_backfill.py` fills in the conditions each SURVEY was flown in - a handful
of points, one moment each. This one fills the MAP: the whole water grid, at a
series of past moments, so that stepping the environment layer back a day shows
a field rather than the four dots the point sampler happened to leave there.

The collector writes one moment - `now` - every three hours, which means a
freshly deployed service has no past at all until it has been running for one.
The sources do have that past, so it is fetched rather than waited for.

Which sources, and why not all of them by default
--------------------------------------------------
  weather  wind, gusts, air temperature, pressure, cloud. Whichever of ICON-EU
           or ERA5 serves the date is used - the same rule the live collector
           follows, so the archive never mixes two models under one label.
  waves    significant height and period, MFWAM.

Those two are the default because they are cheap: Open-Meteo answers a whole
day in one request and takes a batch of coordinates at once, so a fortnight of
three-hourly slices costs under a hundred requests.

  sst      MUR and CoralTemp. One strided ERDDAP request per field per moment.
  ice      the IMS chart. NOT cheap in the same way: one download per DATE
           (~2 MB over the wire, ~2.8 MB stored per date), and it is the one
           source where asking for a hundred days means a hundred downloads.

Nothing here interpolates. A moment that a source has no slice for is simply
not written, and the map then says so in the reader's own words rather than
drawing a value nobody measured.

Re-running is safe: rows merge on (source, measured_at, lat, lng), so a second
pass reports `new` near zero rather than doubling the archive.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from service import db, env  # noqa: E402

#: Friendly names for what a person actually wants to backfill, resolved to the
#: source ids the collector uses. `weather` is a pair because which of the two
#: atmospheric models serves a date depends on the date.
GROUPS = {
    "weather": ("openmeteo_icon_eu", "openmeteo_era5"),
    "waves": ("openmeteo_mfwam",),
    "sst": ("mur", "coraltemp"),
    "ice": ("ims",),
}
DEFAULT_GROUPS = ("weather", "waves")


def resolve(groups: list[str], when: datetime) -> tuple[str, ...]:
    """Source ids for these groups at this moment.

    `weather` collapses to the ONE model that serves the date, so the caller
    never asks ERA5 for a day ICON-EU owns and then reports the resulting
    silence as a failure.
    """
    out: list[str] = []
    for name in groups:
        if name == "weather":
            out.append(env.weather_source_for(when))
        else:
            out.extend(GROUPS[name])
    return tuple(dict.fromkeys(out))


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", default=None,
                        help="database file (default: $SEALV_DB)")
    parser.add_argument("--days", type=int, default=14,
                        help="how far back to go (default 14)")
    parser.add_argument("--step-hours", type=int, default=3,
                        help="spacing between moments (default 3, the collector's cycle)")
    parser.add_argument("--grid-step", type=float, default=0.5,
                        help="grid spacing in degrees (default 0.5, as the collector)")
    parser.add_argument("--sources", default=",".join(DEFAULT_GROUPS),
                        help=f"comma-separated groups: {', '.join(GROUPS)} "
                             f"(default {','.join(DEFAULT_GROUPS)})")
    parser.add_argument("--dry-run", action="store_true",
                        help="list the moments and sources, ask nothing, write nothing")
    args = parser.parse_args(argv)

    groups = [g.strip() for g in args.sources.split(",") if g.strip()]
    unknown = [g for g in groups if g not in GROUPS]
    if unknown:
        parser.error(f"no such source group(s): {unknown}; known: {sorted(GROUPS)}")
    if args.days < 1 or args.step_hours < 1:
        parser.error("--days and --step-hours must both be at least 1")

    if args.db:
        os.environ["SEALV_DB"] = args.db

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    moments = [
        now - timedelta(hours=h)
        for h in range(args.step_hours, args.days * 24 + 1, args.step_hours)
    ]

    print(f"{len(moments)} moment(s), every {args.step_hours}h, back {args.days} day(s); "
          f"groups: {', '.join(groups)}", flush=True)
    if args.dry_run:
        for when in moments:
            print(f"  {when:%Y-%m-%d %H:%M}Z  ->  {', '.join(resolve(groups, when))}")
        print("dry run: nothing was requested and nothing was written")
        return 0

    conn = db.connect()
    written = new = failed = 0
    for when in moments:
        started = time.time()
        try:
            cells, problems = env.collect_grid(
                when, step_deg=args.grid_step, sources=resolve(groups, when)
            )
        except Exception as exc:  # noqa: BLE001 - one bad moment must not end the run
            failed += 1
            print(f"  {when:%Y-%m-%d %H:%M}Z  FAILED {type(exc).__name__}: {exc}", flush=True)
            continue
        report = db.insert_env_samples(conn, cells)
        written += report.get("written", 0)
        new += report.get("new", 0)
        note = ""
        if problems:
            note = "  | " + "; ".join(
                f"{p.get('source', '?')}: {str(p.get('error', ''))[:70]}" for p in problems
            )
        print(f"  {when:%Y-%m-%d %H:%M}Z  {len(cells):5d} cell(s), "
              f"{report.get('new', 0):5d} new  [{time.time() - started:.0f}s]{note}",
              flush=True)

    print(f"\n{written} row(s) written, {new} of them new"
          + (f", {failed} moment(s) failed" if failed else ""))
    # A run where every moment failed is a failed run, and a caller in a shell
    # script has to be able to tell.
    return 1 if failed == len(moments) and moments else 0


if __name__ == "__main__":
    raise SystemExit(main())
