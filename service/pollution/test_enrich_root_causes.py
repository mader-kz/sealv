"""Focused contracts for the restart-safe root-cause enrichment CLI."""
from __future__ import annotations

import json
import unittest
from unittest.mock import Mock, patch

from service.db import connect, init_db
from service.pollution import enrich_root_causes
from service.pollution.opencode_geocoder import ReportExtraction


class RootCauseEnrichmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = init_db(connect(":memory:"))
        self.conn.execute(
            "INSERT INTO pollution_source (id, name) VALUES (?, ?)",
            ("test-source", "Test source"),
        )

    def tearDown(self) -> None:
        self.conn.close()

    def _insert(
        self,
        incident_id: str,
        raw: str | dict[str, object] | None,
        *,
        lat: float = 43.75,
        lng: float = 51.25,
    ) -> None:
        raw_text = json.dumps(raw, ensure_ascii=False) if isinstance(raw, dict) else raw
        self.conn.execute(
            """
            INSERT INTO pollution_incident
                (id, source_id, observed_at, lat, lng, radius_m, geom, kind, raw)
            VALUES (?, 'test-source', '2026-08-10T00:00:00Z', ?, ?, 750,
                    'POINT(51.25 43.75)', 'oil', ?)
            """,
            (incident_id, lat, lng, raw_text),
        )

    def _raw(self, incident_id: str) -> object:
        value = self.conn.execute(
            "SELECT raw FROM pollution_incident WHERE id = ?", (incident_id,)
        ).fetchone()["raw"]
        return json.loads(value) if value is not None else None

    def test_updates_only_root_cause_and_is_idempotent(self) -> None:
        original = {
            "title": "Pipeline operator reported a leak",
            "description": "Oil entered a drainage channel.",
            "url": "https://example.test/evidence",
            "coordinates": [43.75, 51.25],
        }
        self._insert("incident-a", original)
        extractor = Mock(
            return_value=ReportExtraction(None, "Reported pipeline leak released oil.")
        )

        with patch.object(enrich_root_causes, "extract_report_details", extractor):
            counts = enrich_root_causes.enrich_root_causes(self.conn, delay=0)

        self.assertEqual(
            counts, enrich_root_causes.EnrichmentCounts(1, 1, 0, 0)
        )
        extractor.assert_called_once_with(
            "Pipeline operator reported a leak\n\nOil entered a drainage channel."
        )
        stored = self._raw("incident-a")
        self.assertEqual(
            stored,
            original | {"root_cause": "Reported pipeline leak released oil."},
        )
        geometry = self.conn.execute(
            "SELECT lat, lng, radius_m, geom, kind FROM pollution_incident WHERE id = ?",
            ("incident-a",),
        ).fetchone()
        self.assertEqual(
            tuple(geometry), (43.75, 51.25, 750.0, "POINT(51.25 43.75)", "oil")
        )
        change = self.conn.execute(
            "SELECT incident_id, action FROM pollution_change ORDER BY seq"
        ).fetchone()
        self.assertEqual(tuple(change), ("incident-a", "updated"))

        extractor.reset_mock()
        with patch.object(enrich_root_causes, "extract_report_details", extractor):
            resumed = enrich_root_causes.enrich_root_causes(self.conn, delay=0)
        self.assertEqual(resumed, enrich_root_causes.EnrichmentCounts())
        extractor.assert_not_called()

    def test_skips_when_extraction_has_no_valid_cause(self) -> None:
        self._insert("incident-skip", {"text": "Pollution was observed."})
        extractor = Mock(return_value=ReportExtraction(None, None))

        with patch.object(enrich_root_causes, "extract_report_details", extractor):
            counts = enrich_root_causes.enrich_root_causes(self.conn, delay=0)

        self.assertEqual(
            counts, enrich_root_causes.EnrichmentCounts(1, 0, 1, 0)
        )
        self.assertEqual(self._raw("incident-skip"), {"text": "Pollution was observed."})

    def test_malformed_raw_is_failed_without_calling_extraction(self) -> None:
        self._insert("incident-malformed", "{not-json")
        extractor = Mock()

        with patch.object(enrich_root_causes, "extract_report_details", extractor):
            counts = enrich_root_causes.enrich_root_causes(self.conn, delay=0)

        self.assertEqual(
            counts, enrich_root_causes.EnrichmentCounts(1, 0, 0, 1)
        )
        extractor.assert_not_called()
        stored = self.conn.execute(
            "SELECT raw FROM pollution_incident WHERE id = 'incident-malformed'"
        ).fetchone()["raw"]
        self.assertEqual(stored, "{not-json")

    def test_dry_run_reports_enrichment_without_writing(self) -> None:
        original = {"body": "The report attributes the spill to a tank rupture."}
        self._insert("incident-dry", original)
        extractor = Mock(
            return_value=ReportExtraction(None, "Reported tank rupture released oil.")
        )

        with patch.object(enrich_root_causes, "extract_report_details", extractor):
            counts = enrich_root_causes.enrich_root_causes(
                self.conn, delay=0, dry_run=True
            )

        self.assertEqual(
            counts, enrich_root_causes.EnrichmentCounts(1, 1, 0, 0)
        )
        self.assertEqual(self._raw("incident-dry"), original)

    def test_limit_bounds_missing_rows_in_stable_order(self) -> None:
        self._insert("incident-a", {"text": "First report"})
        self._insert("incident-b", {"text": "Second report"})
        extractor = Mock(
            return_value=ReportExtraction(None, "Reported first causal event.")
        )

        with patch.object(enrich_root_causes, "extract_report_details", extractor):
            counts = enrich_root_causes.enrich_root_causes(
                self.conn, limit=1, delay=0
            )

        self.assertEqual(
            counts, enrich_root_causes.EnrichmentCounts(1, 1, 0, 0)
        )
        extractor.assert_called_once_with("First report")
        self.assertEqual(
            self._raw("incident-a")["root_cause"], "Reported first causal event."
        )
        self.assertNotIn("root_cause", self._raw("incident-b"))

    def test_no_evidence_text_is_skipped_without_extraction(self) -> None:
        original = {
            "url": "https://example.test/evidence",
            "coordinates": [43.75, 51.25],
            "source": "test-source",
        }
        self._insert("incident-empty", original)
        extractor = Mock()

        with patch.object(enrich_root_causes, "extract_report_details", extractor):
            counts = enrich_root_causes.enrich_root_causes(self.conn, delay=0)

        self.assertEqual(
            counts, enrich_root_causes.EnrichmentCounts(1, 0, 1, 0)
        )
        extractor.assert_not_called()
        self.assertEqual(self._raw("incident-empty"), original)


if __name__ == "__main__":
    unittest.main()
