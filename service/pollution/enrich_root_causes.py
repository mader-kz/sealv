"""Restart-safe root-cause enrichment for stored pollution incidents."""
from __future__ import annotations

import argparse
import json
import sqlite3
import time
from dataclasses import dataclass
from typing import Sequence

from service.db import connect, init_db
from service.pollution import db as pollution_db
from service.pollution.opencode_geocoder import (
    extract_report_details,
    validate_root_cause,
)

_EVIDENCE_FIELDS = (
    "title",
    "description",
    "text",
    "body",
    "content",
    "excerpt",
    "summary",
    "message",
    "caption",
)
_MAX_EVIDENCE_CHARS = 3000
_DEFAULT_DELAY_SECONDS = 0.5


@dataclass(frozen=True)
class EnrichmentCounts:
    selected: int = 0
    enriched: int = 0
    skipped: int = 0
    failed: int = 0


def _evidence_text(raw: dict[str, object]) -> str | None:
    """Return only bounded narrative fields from the stored source evidence."""
    parts: list[str] = []
    length = 0
    for field in _EVIDENCE_FIELDS:
        value = raw.get(field)
        if not isinstance(value, str) or not value.strip():
            continue
        separator = "\n\n" if parts else ""
        remaining = _MAX_EVIDENCE_CHARS - length - len(separator)
        if remaining <= 0:
            break
        part = value.strip()[:remaining]
        if part:
            parts.append(separator + part)
            length += len(separator) + len(part)
    return "".join(parts) or None


def enrich_root_causes(
    conn: sqlite3.Connection,
    *,
    limit: int | None = None,
    delay: float = _DEFAULT_DELAY_SECONDS,
    dry_run: bool = False,
) -> EnrichmentCounts:
    """Enrich missing causes, committing each successful row independently."""
    if limit is not None and limit < 0:
        raise ValueError("limit must not be negative")
    if delay < 0:
        raise ValueError("delay must not be negative")

    selected = enriched = skipped = failed = requests = 0
    rows = conn.execute("SELECT id, raw FROM pollution_incident ORDER BY id")
    for row in rows:
        if limit is not None and selected >= limit:
            break

        raw_text = row["raw"]
        if raw_text is None:
            raw: object = {}
        else:
            try:
                raw = json.loads(raw_text)
            except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
                selected += 1
                failed += 1
                continue

        if not isinstance(raw, dict):
            selected += 1
            failed += 1
            continue
        if "root_cause" in raw and raw["root_cause"] is not None:
            continue

        selected += 1
        evidence = _evidence_text(raw)
        if evidence is None:
            skipped += 1
            continue

        if requests and delay:
            time.sleep(delay)
        requests += 1
        try:
            extraction = extract_report_details(evidence)
            cause = validate_root_cause(extraction.root_cause)
        except Exception:
            failed += 1
            continue
        if cause is None:
            skipped += 1
            continue

        if dry_run:
            enriched += 1
            continue

        updated_raw = dict(raw)
        updated_raw["root_cause"] = cause
        try:
            updated = pollution_db.update_incident_raw(
                conn,
                str(row["id"]),
                updated_raw,
                expected_raw=raw_text,
            )
        except sqlite3.Error:
            failed += 1
            continue
        if updated:
            enriched += 1
        else:
            skipped += 1

    return EnrichmentCounts(selected, enriched, skipped, failed)


def _non_negative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must not be negative")
    return parsed


def _non_negative_float(value: str) -> float:
    parsed = float(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must not be negative")
    return parsed


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Backfill validated root causes for stored pollution incidents."
    )
    parser.add_argument("--db", help="SQLite database path (defaults to SEALV_DB)")
    parser.add_argument("--limit", type=_non_negative_int)
    parser.add_argument(
        "--delay",
        type=_non_negative_float,
        default=_DEFAULT_DELAY_SECONDS,
        help="minimum seconds between extraction requests (default: %(default)s)",
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    conn = init_db(connect(args.db))
    try:
        counts = enrich_root_causes(
            conn,
            limit=args.limit,
            delay=args.delay,
            dry_run=args.dry_run,
        )
    finally:
        conn.close()
    print(
        f"selected={counts.selected} enriched={counts.enriched} "
        f"skipped={counts.skipped} failed={counts.failed}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
