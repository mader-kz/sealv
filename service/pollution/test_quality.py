"""Focused contracts for pollution classification and location quality."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from service.pollution import classifier
from service.pollution.fields import geocode_field
from service.pollution.opencode_geocoder import (
    extract_coordinates,
    geocode_via_opencode,
    snap_to_water,
)
ISOLATED_ENV = {"POLLUTION_LOCAL_OPENCODE_GO": "0"}



LIVE_ARTICLE_EXAMPLES = {
    "https://orda.kz/neftjanoe-pjatno-v-kaspii-chto-izvestno-o-zagrjaznenii-u-pljazha-atash-v-mangistau-417627/": (
        "Нефтяное пятно в Каспии: что известно о загрязнении у пляжа Аташ "
        "в Мангистау"
    ),
    "https://tengrinews.kz/kazakhstan_news/utechka-nefti-proizoshla-na-mestorojdenii-tengiz-517213/": (
        "Утечка нефти произошла на месторождении Тенгиз"
    ),
    "https://www.inform.kz/ru/razliv-nefti-na-kaspii-oproverg-operator-kashagana-90432c": (
        "Разлив нефти на Каспии опроверг оператор Кашагана"
    ),
    "https://tengrinews.kz/kazakhstan_news/chernyiy-dyim-otkryitoe-plamya-poyavilis-kadryi-pojara-605800/": (
        "Черный дым и открытое пламя: появились кадры пожара на месторождении "
        "Кульжан в Мангистау"
    ),
}


class ClassifierQualityTests(unittest.TestCase):
    def test_four_live_relevant_examples_pass(self) -> None:
        with patch.dict(os.environ, ISOLATED_ENV, clear=True):
            for url, title in LIVE_ARTICLE_EXAMPLES.items():
                with self.subTest(url=url):
                    self.assertTrue(classifier.is_pollution_article(title))

    def test_irrelevant_caspian_ecology_fails(self) -> None:
        text = "Каспийская экосистема: ученые пересчитали тюленей и осетровых"
        with patch.dict(os.environ, ISOLATED_ENV, clear=True):
            self.assertFalse(classifier.is_pollution_article(text))

    def test_regional_name_can_replace_explicit_caspian_name(self) -> None:
        with patch.dict(os.environ, ISOLATED_ENV, clear=True):
            self.assertTrue(
                classifier.is_pollution_article(
                    "Күлжан кен орнында қара түтін шығып, өрт сөндірілді"
                )
            )

    def test_endpoint_failure_is_visible_and_fails_open_after_lexical_pass(self) -> None:
        environment = {"POLLUTION_CLASSIFIER_ENDPOINT": "https://classifier.invalid/v1"}
        with patch.dict(os.environ, environment, clear=True), patch.object(
            classifier, "_classify_with_endpoint", side_effect=TimeoutError("timed out")
        ), self.assertLogs(classifier.logger, level="WARNING") as captured:
            self.assertTrue(
                classifier.is_pollution_article("Caspian oil spill reported near Atash")
            )
        self.assertIn("classifier failed", captured.output[0])


class GeocoderQualityTests(unittest.TestCase):
    def test_decimal_dm_and_dms_coordinates(self) -> None:
        examples = {
            "coordinates 43.65321, 51.17234": (43.65321, 51.17234),
            "coordinates 43,65321; 51,17234": (43.65321, 51.17234),
            "43°39.200′ N 51°10.700′ E": (43.653333333333336, 51.178333333333335),
            "43°39'12\"N 51°10'42\"E": (43.653333333333336, 51.178333333333335),
            "43°39′12″ с.ш., 51°10′42″ в.д.": (43.653333333333336, 51.178333333333335),
        }
        for text, expected in examples.items():
            with self.subTest(text=text):
                resolved = extract_coordinates(text)
                self.assertIsNotNone(resolved)
                self.assertAlmostEqual(resolved[0], expected[0], places=6)
                self.assertAlmostEqual(resolved[1], expected[1], places=6)

    def test_source_coordinates_take_precedence_over_named_place(self) -> None:
        with patch.dict(os.environ, ISOLATED_ENV, clear=True):
            resolved = geocode_via_opencode(
                "Разлив у пляжа Аташ. Координаты 43.70000, 51.10000"
            )
            self.assertIsNotNone(resolved)
            self.assertEqual((resolved.lat, resolved.lng), (43.7, 51.1))
            self.assertEqual(resolved.place, "source coordinates")

    def test_four_article_places_resolve_from_verified_table(self) -> None:
        expected = ["Atash", "Tengiz", "Kashagan", "Kulzhan"]
        for title, name in zip(LIVE_ARTICLE_EXAMPLES.values(), expected):
            with self.subTest(name=name), patch.dict(
                os.environ, ISOLATED_ENV, clear=True
            ):
                resolved = geocode_via_opencode(title)
                self.assertIsNotNone(resolved)
                self.assertEqual(resolved.place, name)
                self.assertGreater(resolved.radius_m, 0)

    def test_official_report_places_use_specific_verified_entries(self) -> None:
        examples = {
            "п. Индер": "Inderbor",
            "с. Ганюшкино": "Kurmangazy",
            "с. Котяевка": "Bokeihan",
            "пос. Дамба": "Damba",
            "Курилкино": "Kurilkino",
            "Аккизтогай": "Aqkiiztogan",
        }
        for text, name in examples.items():
            with self.subTest(text=text):
                resolved = geocode_field(text)
                self.assertIsNotNone(resolved)
                self.assertEqual(resolved[3], name)

    def test_unknown_location_remains_unresolved(self) -> None:
        text = "На Каспии обнаружено нефтяное пятно у неизвестного безымянного мыса"
        with patch.dict(os.environ, ISOLATED_ENV, clear=True):
            self.assertIsNone(geocode_via_opencode(text))

    def test_alias_matching_does_not_use_substrings(self) -> None:
        self.assertIsNone(geocode_field("Источник: https://www.inaktau.kz/news/123"))

    def test_land_coordinate_is_not_arbitrarily_snapped(self) -> None:
        self.assertIsNone(snap_to_water(43.655, 51.178))


if __name__ == "__main__":
    unittest.main()
