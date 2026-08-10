"""Generic, resume-safe pollution backfill CLI.

Every registered source is discovered and its normal ``(source, since)`` poller
is reused.  The default cutoff is computed at runtime as six calendar months.
"""
from __future__ import annotations

import argparse
import asyncio
import calendar
import contextlib
import importlib
import inspect
import io
import json
import os
import pkgutil
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Iterable

from service.db import connect, init_db
from service.pollution import db as pollution_db
from service.pollution.models import PollutionIncident
from service.pollution.registry import REGISTRY, get_poller


_MAX_REJECTION_SAMPLES = 100
_DEFAULT_DELAY_SECONDS = 0.75


def _utc_datetime(value: str) -> datetime:
    """Parse an ISO date or timestamp and normalize it to UTC."""
    raw = value.strip()
    if not raw:
        raise ValueError("date must not be empty")
    if len(raw) == 10:
        raw += "T00:00:00+00:00"
    else:
        raw = raw.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _six_month_cutoff(now: datetime | None = None) -> datetime:
    """Subtract six calendar months without relying on a third-party package."""
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    absolute_month = current.year * 12 + current.month - 1 - 6
    year, zero_based_month = divmod(absolute_month, 12)
    month = zero_based_month + 1
    day = min(current.day, calendar.monthrange(year, month)[1])
    return current.replace(year=year, month=month, day=day)


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def _source_ids(values: Iterable[str] | None) -> list[str]:
    requested: list[str] = []
    for value in values or ():
        requested.extend(part.strip() for part in value.split(",") if part.strip())
    if not requested or requested == ["all"]:
        return sorted(REGISTRY)
    return list(dict.fromkeys(requested))


def _discover_pollers() -> tuple[list[str], list[dict[str, str]]]:
    """Import every module in the pollers package so all sources register."""
    package = importlib.import_module("service.pollution.pollers")
    imported: list[str] = []
    errors: list[dict[str, str]] = []
    modules = sorted(
        pkgutil.iter_modules(package.__path__, package.__name__ + "."),
        key=lambda info: info.name,
    )
    for module in modules:
        try:
            importlib.import_module(module.name)
            imported.append(module.name)
        except Exception as exc:
            errors.append(
                {
                    "stage": "import",
                    "module": module.name,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
    return imported, errors


@contextlib.contextmanager
def _poller_environment(max_pages: int | None, delay_seconds: float):
    """Expose optional paging controls without changing the poller contract."""
    names = (
        "SEALV_POLLUTION_BACKFILL",
        "SEALV_POLLUTION_MAX_PAGES",
        "SEALV_POLLUTION_DELAY_SECONDS",
    )
    previous = {name: os.environ.get(name) for name in names}
    try:
        os.environ["SEALV_POLLUTION_BACKFILL"] = "1"
        if max_pages is None:
            os.environ.pop("SEALV_POLLUTION_MAX_PAGES", None)
        else:
            os.environ["SEALV_POLLUTION_MAX_PAGES"] = str(max_pages)
        os.environ["SEALV_POLLUTION_DELAY_SECONDS"] = str(delay_seconds)
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


async def _invoke_poller(
    source_id: str,
    since: str,
    max_pages: int | None,
    delay_seconds: float,
) -> tuple[list[Any], list[str]]:
    poller = get_poller(source_id)
    if poller is None:
        raise RuntimeError("source has no registered poller")
    stdout = io.StringIO()
    stderr = io.StringIO()
    with (
        _poller_environment(max_pages, delay_seconds),
        contextlib.redirect_stdout(stdout),
        contextlib.redirect_stderr(stderr),
    ):
        result = poller(REGISTRY[source_id], since)
        if inspect.isawaitable(result):
            result = await result
    if result is None:
        result = []
    if not isinstance(result, list):
        raise TypeError(f"poller returned {type(result).__name__}, expected list")
    diagnostics = [
        line
        for line in (stdout.getvalue() + "\n" + stderr.getvalue()).splitlines()
        if line.strip()
    ]
    return result, diagnostics


def _rejection_reason(
    incident: Any,
    source_id: str,
    cutoff: datetime,
    seen_ids: set[str],
) -> str | None:
    if not isinstance(incident, PollutionIncident):
        return f"unexpected_type:{type(incident).__name__}"
    if not incident.id:
        return "missing_id"
    if incident.id in seen_ids:
        return "duplicate_id_in_response"
    if incident.source_id != source_id:
        return f"source_mismatch:{incident.source_id}"
    if not incident.observed_at:
        return "missing_observed_at"
    try:
        if _utc_datetime(incident.observed_at) < cutoff:
            return "before_cutoff"
    except (TypeError, ValueError):
        return "invalid_observed_at"
    if incident.lat is None or incident.lng is None:
        return "unresolved_coordinates"
    try:
        lat = float(incident.lat)
        lng = float(incident.lng)
    except (TypeError, ValueError):
        return "invalid_coordinates"
    if lat == 0.0 and lng == 0.0:
        return "unresolved_coordinates"
    try:
        incident.validate()
    except Exception as exc:
        return f"invalid_incident:{exc}"
    seen_ids.add(incident.id)
    return None


def _record_rejection(
    summary: dict[str, Any],
    source_id: str,
    incident: Any,
    reason: str,
) -> None:
    summary["_rejection_counts"][reason] += 1
    summary["totals"]["rejected"] += 1
    if len(summary["rejections"]) < _MAX_REJECTION_SAMPLES:
        summary["rejections"].append(
            {
                "source": source_id,
                "incident_id": getattr(incident, "id", None),
                "reason": reason,
            }
        )


async def run_backfill(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    started = datetime.now(timezone.utc)
    try:
        cutoff = _utc_datetime(args.since) if args.since else _six_month_cutoff(started)
    except (TypeError, ValueError) as exc:
        return {
            "errors": [{"stage": "arguments", "error": f"invalid --since: {exc}"}],
            "rejections": [],
            "rejection_counts": {},
            "sources": {},
            "totals": {
                "received": 0,
                "accepted": 0,
                "stored": 0,
                "already_present": 0,
                "rejected": 0,
            },
        }, 2
    since = _iso_utc(cutoff)
    try:
        delay_seconds = max(
            0.0,
            float(
                os.environ.get(
                    "SEALV_POLLUTION_DELAY_SECONDS", _DEFAULT_DELAY_SECONDS
                )
            ),
        )
    except ValueError:
        delay_seconds = _DEFAULT_DELAY_SECONDS
    imported, import_errors = _discover_pollers()
    selected = _source_ids(args.source)
    unknown = [source_id for source_id in selected if source_id not in REGISTRY]

    summary: dict[str, Any] = {
        "started_at": _iso_utc(started),
        "since": since,
        "dry_run": args.dry_run,
        "max_pages": args.max_pages,
        "delay_seconds": delay_seconds,
        "imported_modules": imported,
        "selected_sources": selected,
        "sources": {},
        "totals": {
            "received": 0,
            "accepted": 0,
            "stored": 0,
            "already_present": 0,
            "rejected": 0,
        },
        "errors": import_errors,
        "rejections": [],
        "_rejection_counts": Counter(),
    }
    if unknown:
        summary["errors"].append(
            {
                "stage": "arguments",
                "error": "unknown source",
                "sources": unknown,
                "available_sources": sorted(REGISTRY),
            }
        )
        summary["rejection_counts"] = {}
        summary.pop("_rejection_counts")
        summary["finished_at"] = _iso_utc(datetime.now(timezone.utc))
        return summary, 2

    conn = None
    if not args.dry_run:
        try:
            conn = init_db(connect())
        except Exception as exc:
            summary["errors"].append(
                {
                    "stage": "database",
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
            summary["rejection_counts"] = {}
            summary.pop("_rejection_counts")
            summary["finished_at"] = _iso_utc(datetime.now(timezone.utc))
            return summary, 1

    try:
        for index, source_id in enumerate(selected):
            source_summary: dict[str, Any] = {
                "received": 0,
                "accepted": 0,
                "stored": 0,
                "already_present": 0,
                "rejected": 0,
                "diagnostics": [],
            }
            summary["sources"][source_id] = source_summary
            try:
                incidents, diagnostics = await _invoke_poller(
                    source_id,
                    since,
                    args.max_pages,
                    delay_seconds,
                )
                source_summary["diagnostics"] = diagnostics
                source_summary["received"] = len(incidents)
                summary["totals"]["received"] += len(incidents)
                seen_ids: set[str] = set()
                if conn is not None:
                    pollution_db.upsert_source(conn, REGISTRY[source_id])
                for incident in incidents:
                    reason = _rejection_reason(incident, source_id, cutoff, seen_ids)
                    if reason is not None:
                        source_summary["rejected"] += 1
                        _record_rejection(summary, source_id, incident, reason)
                        continue
                    source_summary["accepted"] += 1
                    summary["totals"]["accepted"] += 1
                    if conn is None:
                        continue
                    present = conn.execute(
                        "SELECT 1 FROM pollution_incident WHERE id = ?",
                        (incident.id,),
                    ).fetchone()
                    pollution_db.upsert_incident(conn, incident)
                    source_summary["stored"] += 1
                    summary["totals"]["stored"] += 1
                    if present:
                        source_summary["already_present"] += 1
                        summary["totals"]["already_present"] += 1
            except Exception as exc:
                summary["errors"].append(
                    {
                        "stage": "poll",
                        "source": source_id,
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )
            if index + 1 < len(selected) and delay_seconds:
                time.sleep(delay_seconds)
    finally:
        if conn is not None:
            conn.close()

    summary["rejection_counts"] = dict(
        sorted(summary.pop("_rejection_counts").items())
    )
    summary["rejections_truncated"] = max(
        0, summary["totals"]["rejected"] - len(summary["rejections"])
    )
    summary["finished_at"] = _iso_utc(datetime.now(timezone.utc))
    return summary, 1 if summary["errors"] else 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Backfill all registered pollution sources (six months by default)."
    )
    parser.add_argument(
        "--since",
        help="ISO date/timestamp cutoff; default is six calendar months ago",
    )
    parser.add_argument(
        "--source",
        action="append",
        help="source ID, comma-separated IDs, or all; repeatable (default: all)",
    )
    parser.add_argument(
        "--max-pages",
        type=_positive_int,
        help="maximum pages per source; pollers read SEALV_POLLUTION_MAX_PAGES",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="fetch and validate without opening or writing the database",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    summary, status = asyncio.run(run_backfill(args))
    json.dump(summary, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
