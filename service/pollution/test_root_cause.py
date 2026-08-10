"""Focused contracts for pollution root-cause extraction and serialization."""
from __future__ import annotations

import json
import os
import unittest
from unittest.mock import MagicMock, Mock, patch
from datetime import datetime, timezone

from service.pollution import api, opencode_geocoder

from service.pollution.models import PollutionSource
from service.pollution.pollers import lada_rss, news, telegram

class RootCauseExtractionTests(unittest.TestCase):
    def _response(self, content: str) -> MagicMock:
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {"choices": [{"message": {"content": content}}]}
        ).encode("utf-8")
        return response

    def test_combined_completion_safely_parses_place_and_qualified_cause(self) -> None:
        urlopen = Mock(
            return_value=self._response(
                'Result follows: {not json} {"place":"Аташ",'
                '"root_cause":"Reported pipeline leak released oil."}'
            )
        )
        environment = {
            "POLLUTION_GEOCODER_ENDPOINT": "https://geocoder.example/v1/chat/completions",
            "POLLUTION_GEOCODER_API_KEY": "test-key",
        }
        with patch.dict(os.environ, environment, clear=True), patch.object(
            opencode_geocoder, "urlopen", urlopen
        ):
            result = opencode_geocoder.geocode_via_opencode(
                "Разлив у пляжа Аташ. Координаты 43.70000, 51.10000"
            )

        self.assertIsNotNone(result)
        self.assertEqual((result.lat, result.lng), (43.7, 51.1))
        self.assertEqual(result.place, "source coordinates")
        self.assertEqual(result.root_cause, "Reported pipeline leak released oil.")
        self.assertEqual(urlopen.call_count, 1)

    def test_unqualified_malformed_and_long_causes_are_rejected(self) -> None:
        invalid = (
            None,
            {"cause": "Reported leak."},
            "Pipeline leak caused the spill.",
            "Reported first event. Suspected second event.",
            "Reported " + "x" * 240,
        )
        for value in invalid:
            with self.subTest(value=value):
                self.assertIsNone(opencode_geocoder.validate_root_cause(value))
        self.assertEqual(
            opencode_geocoder.validate_root_cause("Suspected vessel discharge."),
            "Suspected vessel discharge.",
        )
        self.assertEqual(
            opencode_geocoder.validate_root_cause("Cause not yet determined."),
            "Cause not yet determined.",
        )

    def test_completion_failure_keeps_source_coordinates_and_null_cause(self) -> None:
        environment = {
            "POLLUTION_GEOCODER_ENDPOINT": "https://geocoder.example/v1/chat/completions",
            "POLLUTION_GEOCODER_API_KEY": "test-key",
        }
        with patch.dict(os.environ, environment, clear=True), patch.object(
            opencode_geocoder, "urlopen", side_effect=TimeoutError("timed out")
        ):
            result = opencode_geocoder.geocode_via_opencode(
                "Oil pollution reported at 43.70000, 51.10000"
            )

        self.assertIsNotNone(result)
        self.assertEqual((result.lat, result.lng), (43.7, 51.1))
        self.assertIsNone(result.root_cause)

    def test_long_completion_cause_becomes_null_without_losing_place(self) -> None:
        content = json.dumps(
            {
                "place": "Аташ",
                "root_cause": "Reported " + "x" * 240,
            }
        )
        environment = {
            "POLLUTION_GEOCODER_ENDPOINT": "https://geocoder.example/v1/chat/completions",
            "POLLUTION_GEOCODER_API_KEY": "test-key",
        }
        with patch.dict(os.environ, environment, clear=True), patch.object(
            opencode_geocoder, "urlopen", return_value=self._response(content)
        ):
            extracted = opencode_geocoder.extract_report_details(
                "Нефтяное загрязнение у неизвестного мыса"
            )

        self.assertEqual(extracted.place, "Аташ")
        self.assertIsNone(extracted.root_cause)


class CallerStorageTests(unittest.TestCase):
    def test_lada_stores_geocoder_root_cause(self) -> None:
        source = PollutionSource("lada_test", "Lada test", "https://example.test", "rss")
        resolved = opencode_geocoder.GeocodeResult(
            43.7,
            51.1,
            500.0,
            "Atash",
            "Reported pipeline leak.",
        )
        with patch.object(lada_rss, "is_pollution_article", return_value=True), patch.object(
            lada_rss, "geocode_via_opencode", return_value=resolved
        ):
            incident = lada_rss._incident_from_text(
                source,
                "Каспий: разлив нефти",
                "https://example.test/report",
                "Аташ",
                None,
                None,
            )

        self.assertIsNotNone(incident)
        self.assertEqual(incident.raw["root_cause"], "Reported pipeline leak.")

    def test_news_exact_coordinate_short_circuit_stores_root_cause(self) -> None:
        source = PollutionSource("news_test", "News test", "https://example.test", "scrape")
        article = news.Article(
            "https://example.test/report",
            "Caspian oil spill",
            "A source report with verified coordinates.",
            "2026-08-10T00:00:00+00:00",
            (43.7, 51.1),
        )
        details = opencode_geocoder.ReportExtraction(
            "Atash",
            "Suspected vessel discharge.",
        )
        with patch.object(news, "is_pollution_article", return_value=True), patch.object(
            news, "extract_report_details", return_value=details
        ):
            incident = news._incident_from_article(
                source,
                article,
                datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

        self.assertIsNotNone(incident)
        self.assertEqual(incident.raw["root_cause"], "Suspected vessel discharge.")

    def test_telegram_stores_one_extracted_cause_for_resolved_location(self) -> None:
        source = PollutionSource(
            "telegram_test",
            "Telegram test",
            "https://t.me/s/example",
            "scrape",
        )
        message = telegram._Message(
            "42",
            "2026-08-10T00:00:00+00:00",
            datetime(2026, 8, 10, tzinfo=timezone.utc),
            "Caspian oil spill at 43.70000, 51.10000",
            "https://t.me/example/42",
        )
        locations = [
            telegram._ResolvedLocation(
                43.7,
                51.1,
                500.0,
                "exact",
                "source_coordinates",
                "Reported pipeline leak.",
            )
        ]
        with patch.object(telegram, "_resolved_locations", return_value=locations):
            incidents = telegram._incidents_for_message(
                source,
                "example",
                message,
                "https://t.me/s/example",
            )

        self.assertEqual(len(incidents), 1)
        self.assertEqual(
            incidents[0].raw["root_cause"],
            "Reported pipeline leak.",
        )


class RootCauseApiTests(unittest.TestCase):
    def test_geojson_exposes_valid_root_cause_separately_from_title(self) -> None:
        connection = Mock()
        rows = [
            {
                "id": "test:1",
                "source_id": "test_source",
                "observed_at": "2026-08-10T00:00:00+00:00",
                "lat": 43.7,
                "lng": 51.1,
                "radius_m": 500.0,
                "kind": "spill",
                "area_km2": None,
                "confidence": None,
                "location_precision": "exact",
                "raw": {
                    "title": "Article evidence title",
                    "url": "https://example.test/report",
                    "root_cause": "Reported pipeline leak released oil.",
                },
            },
            {
                "id": "test:2",
                "source_id": "test_source",
                "observed_at": "2026-08-09T00:00:00+00:00",
                "lat": 43.8,
                "lng": 51.2,
                "radius_m": 500.0,
                "kind": "spill",
                "raw": {
                    "title": "Second evidence title",
                    "root_cause": "Unqualified invented cause",
                },
            },
        ]
        with patch.object(api, "_conn", return_value=connection), patch.object(
            api.pol_db, "list_incidents", return_value=rows
        ):
            collection = api.list_incidents(
                bbox=None,
                since=None,
                kind=None,
                limit=10,
            )

        first = collection["features"][0]["properties"]
        second = collection["features"][1]["properties"]
        self.assertEqual(first["title"], "Article evidence title")
        self.assertEqual(first["root_cause"], "Reported pipeline leak released oil.")
        self.assertIsNone(second["root_cause"])
        connection.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
