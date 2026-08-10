#!/usr/bin/env python3
"""Backfill the conditions every survey in the archive was flown in.

    python3 tools/env_backfill.py --db /tmp/sealv-env.db
    python3 tools/env_backfill.py --dry-run          # what it WOULD ask, and where
    python3 tools/env_backfill.py --survey 361dd191e427

Why this runs before anything else is built on top of it
--------------------------------------------------------
A count of a haul-out is not comparable to another count of the same haul-out
unless both carry the conditions they were made in - haul-out numbers swing
enormously with ice, wind and tide, and a trend line drawn through counts made
in different weather is a picture of the weather. The archive already holds
the sorties; the conditions are recoverable for every one of them, because the
sources reach back far further than this project does (ERA5 to 1940, MUR to
2002, altimetric sea level to 1992). So they are fetched once, now, and stored
beside the counts rather than looked up on demand forever.

Which moment, and which place
-----------------------------
Both are decided per survey and RECORDED, never guessed silently:

  time   `captured_at` when the sortie has one. Many rows in a working archive
         do not - a still uploaded without EXIF, a survey created before the
         column was filled - and for those the row's own `created_at` is used
         and reported as `created_at`. That is a weaker claim about when the
         animals were counted and the report says so rather than presenting an
         upload timestamp as a flight time.
  place  the survey's own `lat`/`lng`; failing that, its SITE's coordinate,
         reported as `site`. A survey with neither is skipped and named. It is
         not given the basin's centre, or the last known point, or anything
         else that would put a temperature on a sortie nobody can locate.

Every value written carries its own source and slice time, so a card can say
"27.4 °C, MUR 1 km, slice of 2026-08-08" for a sortie flown on the 10th, and
the reader can see the two-day lag instead of being told the sea was 27.4 at
the moment of the flight.

Rerunning is free and safe: the store dedupes on
(source, measured_at, lat, lng) and `env.fetch` caches every response on disk,
so a second run costs almost nothing and adds nothing. The receipt separates
`stored` from `new` precisely so a rerun cannot be mistaken for new data.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from service import db, env  # noqa: E402


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _when_for(survey: dict) -> tuple[Optional[str], str]:
    """(timestamp, how we know it). None when even `created_at` is unusable."""
    captured = (survey.get("captured_at") or "").strip()
    if captured:
        return captured, "captured_at"
    created = (survey.get("created_at") or "").strip()
    if created:
        return created, "created_at"
    return None, "unknown"


def _where_for(survey: dict, sites: dict[str, dict]) -> tuple[Optional[float], Optional[float], str]:
    """(lat, lng, how we know it). (None, None, 'none') when nothing locates it."""
    lat, lng = survey.get("lat"), survey.get("lng")
    if lat is not None and lng is not None:
        return float(lat), float(lng), (survey.get("location_source") or "survey")
    site = sites.get(survey.get("site_id") or "")
    if site and site.get("lat") is not None and site.get("lng") is not None:
        return float(site["lat"]), float(site["lng"]), "site"
    return None, None, "none"


def backfill(
    conn,
    *,
    survey_ids: Optional[list[str]] = None,
    limit: Optional[int] = None,
    dry_run: bool = False,
    sources: Optional[list[str]] = None,
) -> dict:
    """Fetch and store the conditions for every survey that can be located."""
    sites = {s["id"]: s for s in db.list_sites(conn)}
    if survey_ids:
        rows = [db.get_survey(conn, sid) for sid in survey_ids]
        surveys = [r for r in rows if r is not None]
        for sid, row in zip(survey_ids, rows):
            if row is None:
                log(f"  survey {sid}: not in this database")
    else:
        surveys = db._rows(
            conn.execute(
                "SELECT * FROM survey ORDER BY COALESCE(captured_at, created_at), id"
            ),
            "survey",
        )
    if limit:
        surveys = surveys[: max(1, int(limit))]

    receipt: dict[str, Any] = {
        "surveys": len(surveys),
        "described": 0,
        "skipped_no_place": [],
        "skipped_no_time": [],
        "stored": 0,
        "new": 0,
        "per_source": {},
        "problems": {},
        "time_basis": {},
        "place_basis": {},
        "attempted": set(),
        "rows": [],
    }

    for survey in surveys:
        sid = survey["id"]
        when, time_basis = _when_for(survey)
        lat, lng, place_basis = _where_for(survey, sites)
        if lat is None or lng is None:
            receipt["skipped_no_place"].append(sid)
            continue
        if when is None:
            receipt["skipped_no_time"].append(sid)
            continue
        try:
            moment = env.as_utc(when)
        except ValueError:
            receipt["skipped_no_time"].append(sid)
            continue

        receipt["time_basis"][time_basis] = receipt["time_basis"].get(time_basis, 0) + 1
        receipt["place_basis"][place_basis] = receipt["place_basis"].get(place_basis, 0) + 1

        if dry_run:
            receipt["rows"].append({
                "survey": sid, "lat": lat, "lng": lng,
                "when": env.iso(moment), "time_basis": time_basis,
                "place_basis": place_basis, "sources": [],
            })
            continue

        samples, problems = env.collect_point(lat, lng, moment, sources=sources)
        stored = db.insert_env_samples(conn, samples)
        receipt["described"] += 1
        receipt["stored"] += stored["written"]
        receipt["new"] += stored["new"]
        for sample in samples:
            key = sample["source"]
            receipt["per_source"][key] = receipt["per_source"].get(key, 0) + 1
        for problem in problems:
            text = " ".join(str(problem["error"]).split())[:120]
            key = f"{problem['source']}: {text}"
            receipt["problems"][key] = receipt["problems"].get(key, 0) + 1
            receipt["attempted"].add(problem["source"])
        receipt["attempted"].update(s["source"] for s in samples)
        for reason in stored["skipped"]:
            key = f"_store: {reason}"
            receipt["problems"][key] = receipt["problems"].get(key, 0) + 1

        receipt["rows"].append({
            "survey": sid, "lat": lat, "lng": lng,
            "when": env.iso(moment), "time_basis": time_basis,
            "place_basis": place_basis,
            "sources": [
                {"source": s["source"], "measured_at": s["measured_at"],
                 "values": s["values"]}
                for s in samples
            ],
        })
        log(
            f"  {sid}  {lat:.4f},{lng:.4f}  {env.iso(moment)} ({time_basis}/{place_basis})"
            f"  -> {len(samples)} source(s): "
            + (", ".join(sorted(s["source"] for s in samples)) or "none")
        )

    return receipt


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tools/env_backfill.py",
        description="Store the environmental conditions of every existing survey.",
    )
    parser.add_argument("--db", default=None,
                        help="database path (defaults to $SEALV_DB / ~/.sealv/sealv.db)")
    parser.add_argument("--survey", action="append", default=None,
                        help="one survey id; repeatable. Default: all of them")
    parser.add_argument("--limit", type=int, default=None,
                        help="stop after this many surveys")
    parser.add_argument("--sources", default=None,
                        help="comma-separated subset of sources to ask")
    parser.add_argument("--dry-run", action="store_true",
                        help="list what would be asked, and from where, without asking")
    parser.add_argument("--json", action="store_true",
                        help="print the full receipt as JSON on stdout")
    args = parser.parse_args(argv)

    sources = [s.strip() for s in (args.sources or "").split(",") if s.strip()] or None
    if sources:
        unknown = [s for s in sources if s not in env.SOURCES and s != "weather"]
        if unknown:
            log(f"no such source(s): {unknown}; known: {sorted(env.SOURCES)}")
            return 1

    conn = db.init_db(db.connect(args.db))
    started = time.perf_counter()
    log(f"backfilling from {db.default_db_path() if not args.db else args.db}")
    log(f"cache: {env.cache_dir()}")
    try:
        receipt = backfill(
            conn,
            survey_ids=args.survey,
            limit=args.limit,
            dry_run=args.dry_run,
            sources=sources,
        )
    finally:
        conn.close()

    seconds = round(time.perf_counter() - started, 1)
    log("")
    log(f"surveys in scope:      {receipt['surveys']}")
    log(f"described:             {receipt['described']}")
    log(f"samples stored:        {receipt['stored']}  ({receipt['new']} new)")
    log(f"time taken from:       {dict(sorted(receipt['time_basis'].items()))}")
    log(f"position taken from:   {dict(sorted(receipt['place_basis'].items()))}")
    if receipt["per_source"]:
        log("values per source:")
        for name, count in sorted(receipt["per_source"].items()):
            meta = env.SOURCES.get(name, {})
            log(f"  {name:<20} {count:>4}   {meta.get('resolution', '')}")
    # Sources with NO value are named, not omitted - a feed that answered
    # nothing for every sortie is the most important line in this report, and
    # leaving it out is how it goes unnoticed for a season. The two cases are
    # kept apart because they mean opposite things: "asked, said nothing" is a
    # source to go and look at; "never asked" is a source this run had no
    # occasion for (ERA5 only covers dates the forecast API no longer holds).
    attempted = receipt["attempted"]
    silent = [n for n in sorted(attempted) if n not in receipt["per_source"]]
    unasked = [n for n in sorted(env.SOURCES) if n not in attempted]
    if silent and not args.dry_run:
        log(f"asked but answered for NO survey: {silent}")
    if unasked and not args.dry_run:
        log(f"not applicable to these dates, never asked: {unasked}")
    if receipt["problems"]:
        log("why values are missing:")
        for reason, count in sorted(receipt["problems"].items(), key=lambda kv: -kv[1]):
            log(f"  x{count:<4} {reason}")
    if receipt["skipped_no_place"]:
        log(f"skipped, no coordinate at all ({len(receipt['skipped_no_place'])}): "
            f"{', '.join(receipt['skipped_no_place'])}")
        log("  a sortie nobody can locate gets no conditions - not the basin's "
            "centre, not the nearest site, nothing.")
    if receipt["skipped_no_time"]:
        log(f"skipped, no usable time ({len(receipt['skipped_no_time'])}): "
            f"{', '.join(receipt['skipped_no_time'])}")
    log(f"done in {seconds}s")

    if args.json:
        import json
        receipt["attempted"] = sorted(receipt["attempted"])
        print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
