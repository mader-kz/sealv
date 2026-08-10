"""Regression contracts for per-record upstream failures."""
from __future__ import annotations

from datetime import datetime, timezone
import unittest
from unittest.mock import patch

from service.pollution import net
from service.pollution.models import PollutionIncident, PollutionSource
from service.pollution.pollers import (
    firms,
    kazhydromet,
    lada_rss,
    news,
    noaa_ospo,
    operators,
    telegram,
    transparent,
)
from service.pollution.registry import SourceUnavailableError


class PollerPartialFailureTests(unittest.TestCase):
    def test_save_caspian_keeps_records_before_one_detail_fails(self) -> None:
        listing = '<a href="/tpost/one">One</a><a href="/tpost/two">Two</a>'

        def fetch(url: str) -> str:
            if url == transparent.save_caspian.url:
                return listing
            if url.endswith("/one"):
                return "<p>first report</p>"
            raise SourceUnavailableError("detail unavailable", retry_after_seconds=50)

        with patch.object(transparent, "_fetch", side_effect=fetch):
            records, errors = transparent._save_caspian_records(
                transparent.save_caspian
            )

        self.assertEqual([record["text"] for record in records], ["first report"])
        self.assertEqual(len(errors), 1)
        with self.assertRaises(SourceUnavailableError) as caught:
            transparent._finish_records(
                transparent.save_caspian, (records, errors), None
            )
        self.assertEqual(caught.exception.retry_after_seconds, 50)

    def test_operator_poll_returns_collected_incidents_as_partial(self) -> None:
        incident = PollutionIncident(
            id="operator:one",
            source_id=operators.NCOC_NEWS.id,
            observed_at="2026-08-10T00:00:00Z",
            lat=43.7,
            lng=51.1,
            radius_m=500,
            kind="spill",
        )

        def fetch(url: str) -> bytes:
            if url.endswith("/one"):
                return b"first report"
            retry = 30 if url.endswith("/two") else 300
            raise SourceUnavailableError("detail unavailable", retry_after_seconds=retry)

        with patch.object(
            operators,
            "_source_links",
            return_value=(
                [
                    "https://example/one",
                    "https://example/two",
                    "https://example/three",
                ],
                [],
            ),
        ), patch.object(operators, "_fetch", side_effect=fetch), patch.object(
            operators, "_parse_html", return_value=("reported oil spill", [])
        ), patch.object(operators, "_incident", return_value=incident):
            with self.assertRaises(SourceUnavailableError) as caught:
                operators.poll(operators.NCOC_NEWS)

        self.assertEqual(caught.exception.retry_after_seconds, 300)
        self.assertEqual(caught.exception.partial_incidents, [incident])

    def test_ncoc_listing_keeps_links_before_later_page_failure(self) -> None:
        first_page = (
            b'{"data":[{"slug":"first","published_at":"2026-08-10T00:00:00Z"}]}'
        )
        failure = SourceUnavailableError("listing failed", retry_after_seconds=180)
        with patch.object(operators, "_fetch", side_effect=[first_page, failure]):
            links, errors = operators._ncoc_links(
                datetime(2026, 2, 10, tzinfo=timezone.utc)
            )

        self.assertEqual(links, ["https://www.ncoc.kz/en/news/first"])
        self.assertEqual(errors, [failure])

    def test_ncoc_listing_marks_malformed_later_page_partial(self) -> None:
        first_page = (
            b'{"data":[{"slug":"first","published_at":"2026-08-10T00:00:00Z"}]}'
        )
        with patch.object(operators, "_fetch", side_effect=[first_page, b"not-json"]):
            links, errors = operators._ncoc_links(
                datetime(2026, 2, 10, tzinfo=timezone.utc)
            )

        self.assertEqual(links, ["https://www.ncoc.kz/en/news/first"])
        self.assertEqual(len(errors), 1)

    def test_retry_after_rejects_nonfinite_and_caps_large_values(self) -> None:
        with patch.dict(
            "os.environ",
            {"POLLUTION_MAX_RETRY_AFTER_SECONDS": "3600"},
        ):
            self.assertIsNone(net._retry_after("inf"))
            self.assertEqual(net._retry_after("999999"), 3600)

    def test_malformed_lada_xml_raises_source_error(self) -> None:
        with patch.object(lada_rss, "_fetch", return_value=b"<broken"):
            with self.assertRaises(SourceUnavailableError):
                lada_rss._poll_single(lada_rss._lada)

    def test_kazhydromet_docx_poll_keeps_prior_document_incidents(self) -> None:
        month = datetime(2026, 7, 1, tzinfo=timezone.utc)
        with patch.object(kazhydromet, "_fetch", return_value=b"document"), patch.object(
            kazhydromet, "_selected_year", return_value=2026
        ), patch.object(
            kazhydromet,
            "_html_links",
            return_value=["https://example/vz-july.docx", "https://example/vz-august.docx"],
        ), patch.object(
            kazhydromet, "_document_month", return_value=month
        ), patch.object(
            kazhydromet, "_month_is_new_enough", return_value=True
        ), patch.object(
            kazhydromet,
            "_docx_rows",
            side_effect=[["зафиксирован разлив нефти"], SourceUnavailableError("invalid document")],
        ), patch.object(
            kazhydromet, "geocode_field", return_value=(43.7, 51.1, 500.0, "Test")
        ):
            with self.assertRaises(SourceUnavailableError) as caught:
                kazhydromet.poll(kazhydromet.SRC)

        self.assertEqual(len(caught.exception.partial_incidents or []), 1)

    def test_sitemap_index_keeps_retry_after(self) -> None:
        error = SourceUnavailableError("rate limited", retry_after_seconds=120)
        source = PollutionSource(
            id="informburo_sitemap",
            name="Informburo",
            url="https://informburo.kz/sitemap.xml",
            type="scrape",
            poll_method="sitemap",
            update_freq="3h",
        )
        with patch.object(news, "_fetch", side_effect=error):
            with self.assertRaises(SourceUnavailableError) as caught:
                news._list_sitemaps(source, datetime.now(timezone.utc))

        self.assertEqual(caught.exception.retry_after_seconds, 120)

    def test_telegram_keeps_incidents_before_later_page_failure(self) -> None:
        observed = datetime.now(timezone.utc)
        message = telegram._Message(
            message_id="10",
            observed_at=observed.isoformat(),
            observed_dt=observed,
            text="разлив нефти в Актау",
            url="https://t.me/example/10",
        )
        incident = PollutionIncident(
            id="telegram_azh:10",
            source_id="telegram_azh",
            observed_at=observed.isoformat(),
            lat=43.7,
            lng=51.1,
            radius_m=500,
            kind="spill",
        )
        source = PollutionSource(
            id="telegram_azh",
            name="Telegram",
            url="https://t.me/s/AzhKz_RU",
            type="scrape",
        )
        failure = SourceUnavailableError("page failed", retry_after_seconds=30)
        with patch.object(
            telegram, "_fetch_html", side_effect=[("https://t.me/page1", "page"), failure]
        ), patch.object(telegram, "_extract_messages", return_value=[message]), patch.object(
            telegram, "_incidents_for_message", return_value=[incident]
        ), patch.object(telegram, "_max_pages", return_value=2):
            with self.assertRaises(SourceUnavailableError) as caught:
                telegram.telegram_poll(source)

        self.assertEqual(caught.exception.partial_incidents, [incident])
        self.assertEqual(caught.exception.retry_after_seconds, 30)

    def test_firms_keeps_incidents_before_later_window_failure(self) -> None:
        source = PollutionSource(
            id="firms_viirs",
            name="FIRMS",
            url="https://firms.modaps.eosdis.nasa.gov",
            type="api",
        )
        csv_text = (
            "latitude,longitude,frp,acq_date,acq_time,confidence\n"
            "43.7,51.1,100,2026-08-10,1200,h\n"
        )
        failure = SourceUnavailableError("window failed", retry_after_seconds=60)
        with patch.object(firms, "DATASETS", ("TEST",)), patch.object(
            firms, "_map_key", return_value="key"
        ), patch.object(
            firms,
            "_parse_since",
            return_value=(datetime(2026, 8, 9, tzinfo=timezone.utc), True),
        ), patch.object(
            firms, "_availability", return_value={"TEST": None}
        ), patch.object(
            firms, "_windows", return_value=[(1, None), (1, None)]
        ), patch.object(
            firms,
            "_fetch",
            side_effect=[(csv_text, "https://example/first"), failure],
        ), patch.object(
            firms, "_nearest_oil_site", return_value=("Test field", 1.0)
        ):
            with self.assertRaises(SourceUnavailableError) as caught:
                firms.poll(source)

        self.assertEqual(len(caught.exception.partial_incidents or []), 1)
        self.assertEqual(caught.exception.retry_after_seconds, 60)

    def test_noaa_keeps_incidents_before_later_report_failure(self) -> None:
        polygon = {
            "type": "Polygon",
            "coordinates": [[[51.0, 43.0], [51.2, 43.0], [51.0, 43.2], [51.0, 43.0]]],
        }
        failure = SourceUnavailableError("report failed", retry_after_seconds=90)
        reports = [
            ("https://example/one.txt", "https://example/one.zip", "20260810_one"),
            ("https://example/two.txt", "https://example/two.zip", "20260810_two"),
        ]
        with patch.object(
            noaa_ospo,
            "_get",
            side_effect=[
                (b"Surveillance Reports", noaa_ospo.ARCHIVE),
                (b"oil pollution CASPIAN", reports[0][0]),
                (b"zip", reports[0][1]),
                failure,
            ],
        ), patch.object(
            noaa_ospo, "_candidate_reports", return_value=reports
        ), patch.object(
            noaa_ospo, "_zip_polygons", return_value=[polygon]
        ), patch.object(
            noaa_ospo, "_geometry_center_radius", return_value=(43.1, 51.1, 500.0)
        ):
            with self.assertRaises(SourceUnavailableError) as caught:
                noaa_ospo.poll(noaa_ospo.SRC)

        self.assertEqual(len(caught.exception.partial_incidents or []), 1)
        self.assertEqual(caught.exception.retry_after_seconds, 90)

    def test_lada_keeps_rss_incidents_before_archive_page_failure(self) -> None:
        incident = PollutionIncident(
            id="lada_rss:rss-one",
            source_id="lada_rss",
            observed_at=datetime.now(timezone.utc).isoformat(),
            lat=43.7,
            lng=51.1,
            radius_m=500,
            kind="spill",
        )
        failure = SourceUnavailableError("archive page failed", retry_after_seconds=75)
        item = {"link": "https://lada.kz/report", "title": "Report", "date_raw": None}
        with patch.object(lada_rss, "_poll_single", return_value=[incident]), patch.object(
            lada_rss, "_fetch_text", side_effect=["page", failure]
        ), patch.object(
            lada_rss, "_extract_lada_items", return_value=[item]
        ), patch.object(
            lada_rss, "_incident_from_text", return_value=incident
        ):
            with self.assertRaises(SourceUnavailableError) as caught:
                lada_rss._poll_lada_paginated(lada_rss._lada, max_pages=2)

        self.assertEqual(caught.exception.partial_incidents, [incident])
        self.assertEqual(caught.exception.retry_after_seconds, 75)


if __name__ == "__main__":
    unittest.main()
