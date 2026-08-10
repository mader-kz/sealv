"""Runtime contracts for pollution polling safety and incremental delivery."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from service.db import connect, init_db
from service.pollution import db as pollution_db
from service.pollution.models import PollutionIncident, PollutionSource
from service.pollution.scheduler import PollutionScheduler, cadence_seconds


class SchedulerTimingTests(unittest.TestCase):
    def test_monthly_cadence_and_exponential_failure_backoff(self) -> None:
        self.assertEqual(cadence_seconds("monthly"), 30 * 86_400)
        source = PollutionSource(
            id="timing-test",
            name="Timing test",
            url="https://example.test",
            type="api",
            update_freq="daily",
        )
        now = datetime(2026, 8, 10, tzinfo=timezone.utc)
        with patch.dict(
            os.environ,
            {
                "POLLUTION_ERROR_RETRY_SECONDS": "300",
                "POLLUTION_SCHEDULER_JITTER_PERCENT": "0",
            },
            clear=True,
        ):
            scheduler = PollutionScheduler()
        first = scheduler._next_poll(
            source, now, 1, failed=True, consecutive_failures=1
        )
        fourth = scheduler._next_poll(
            source, now, 4, failed=True, consecutive_failures=4
        )
        rate_limited = scheduler._next_poll(
            source,
            now,
            1,
            failed=True,
            consecutive_failures=1,
            retry_after_seconds=3_600,
        )
        self.assertEqual(first - now, timedelta(minutes=5))
        self.assertEqual(fourth - now, timedelta(minutes=40))
        self.assertEqual(rate_limited - now, timedelta(hours=1))


class IncrementalPersistenceTests(unittest.TestCase):
    def test_outcomes_change_cursor_and_record_cache_are_durable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            conn = init_db(connect(Path(directory) / "sealv.db"))
            try:
                source = PollutionSource(
                    id="runtime-test",
                    name="Runtime test",
                    url="https://example.test/feed",
                    type="api",
                )
                pollution_db.upsert_source(conn, source)
                incident = PollutionIncident(
                    id="runtime-test:1",
                    source_id=source.id,
                    observed_at="2026-08-10T00:00:00+00:00",
                    lat=43.7,
                    lng=51.1,
                    radius_m=500,
                    kind="spill",
                    confidence=0.8,
                    location_precision="exact",
                    raw={"external_id": "record-1"},
                )
                self.assertEqual(pollution_db.upsert_incident(conn, incident), "inserted")
                self.assertEqual(pollution_db.upsert_incident(conn, incident), "unchanged")
                updated = replace(incident, confidence=0.9)
                self.assertEqual(pollution_db.upsert_incident(conn, updated), "updated")

                changes = pollution_db.list_changes(conn, after=0, limit=10)
                self.assertEqual([row["action"] for row in changes], ["inserted", "updated"])
                self.assertEqual(pollution_db.latest_change_seq(conn), changes[-1]["seq"])

                self.assertFalse(pollution_db.record_seen(conn, source.id, "record-1"))
                pollution_db.mark_record(
                    conn,
                    source.id,
                    "record-1",
                    content_hash="hash-1",
                    observed_at=incident.observed_at,
                    outcome="inserted",
                )
                self.assertTrue(pollution_db.record_seen(conn, source.id, "record-1"))

                pollution_db.ensure_source_health(conn, source.id)
                self.assertTrue(
                    pollution_db.claim_source_poll(
                        conn,
                        source.id,
                        "test-owner",
                        "2026-08-10T00:00:00Z",
                        "2026-08-10T00:05:00Z",
                    )
                )
                self.assertTrue(
                    pollution_db.finish_source_poll(
                        conn,
                        source.id,
                        "test-owner",
                        status="partial",
                        finished_at="2026-08-10T00:01:00Z",
                        item_count=3,
                        inserted_count=1,
                        updated_count=1,
                        unchanged_count=1,
                        error="one detail failed",
                        duration_ms=1000,
                        next_poll_at="2026-08-10T00:06:00Z",
                        success=False,
                        store_results=True,
                    )
                )
                health = pollution_db.get_source_health(conn, source.id)
                self.assertEqual(health["status"], "partial")
                self.assertEqual(health["successes"], 0)
                self.assertEqual(health["total_items"], 3)
                self.assertEqual(health["last_inserted_count"], 1)
                self.assertIsNone(health["last_success_at"])
            finally:
                conn.close()

    def test_init_seeds_changes_for_legacy_incidents(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sealv.db"
            conn = init_db(connect(path))
            source = PollutionSource(
                id="legacy-source",
                name="Legacy source",
                url="https://example.test/feed",
                type="api",
            )
            pollution_db.upsert_source(conn, source)
            incident = PollutionIncident(
                id="legacy-source:1",
                source_id=source.id,
                observed_at="2026-08-10T00:00:00Z",
                lat=43.7,
                lng=51.1,
                radius_m=500,
                kind="spill",
            )
            pollution_db.upsert_incident(conn, incident)
            conn.execute("DELETE FROM pollution_change")
            conn.close()

            migrated = init_db(connect(path))
            try:
                changes = pollution_db.list_changes(migrated, after=0, limit=10)
                self.assertEqual(
                    [(row["id"], row["action"]) for row in changes],
                    [(incident.id, "inserted")],
                )
            finally:
                migrated.close()


if __name__ == "__main__":
    unittest.main()
