"""Focused contracts for pollution completion credential selection."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

from service.pollution import classifier, opencode_geocoder
from service.pollution.completion_config import (
    DEFAULT_GEOCODER_MODEL,
    DEFAULT_OPENCODE_MODEL,
    OPENCODE_GO_ENDPOINT,
    OPENCODE_ZEN_ENDPOINT,
    completion_config,
)


class CompletionConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_data_home = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_data_home.cleanup)
        self.data_home = Path(self.temporary_data_home.name)
        self.auth_path = self.data_home / "opencode/auth.json"

    def _environment(self, **overrides: str) -> dict[str, str]:
        return {"XDG_DATA_HOME": str(self.data_home), **overrides}

    def _write_go_credential(self, key: str) -> None:
        self.auth_path.parent.mkdir(parents=True, exist_ok=True)
        self.auth_path.write_text(
            json.dumps({"opencode-go": {"type": "api", "key": key}}),
            encoding="utf-8",
        )

    def test_local_go_is_selected_for_both_completion_paths(self) -> None:
        key = "unit-" + "credential"
        self._write_go_credential(key)
        environment = self._environment()

        classifier_config = completion_config("POLLUTION_CLASSIFIER", environment)
        geocoder_config = completion_config("POLLUTION_GEOCODER", environment)

        self.assertEqual(
            classifier_config,
            (OPENCODE_GO_ENDPOINT, DEFAULT_OPENCODE_MODEL, key),
        )
        self.assertEqual(
            geocoder_config,
            (OPENCODE_GO_ENDPOINT, DEFAULT_GEOCODER_MODEL, key),
        )

    def test_local_go_geocoder_model_overrides_preserve_precedence(self) -> None:
        key = "local-" + "credential"
        self._write_go_credential(key)
        explicit = self._environment(POLLUTION_GEOCODER_MODEL="explicit-geocoder")
        fallback = self._environment(POLLUTION_CLASSIFIER_MODEL="shared-model")

        self.assertEqual(
            completion_config(
                "POLLUTION_GEOCODER",
                explicit,
                fallback_prefix="POLLUTION_CLASSIFIER",
            ),
            (OPENCODE_GO_ENDPOINT, "explicit-geocoder", key),
        )
        self.assertEqual(
            completion_config(
                "POLLUTION_GEOCODER",
                fallback,
                fallback_prefix="POLLUTION_CLASSIFIER",
            ),
            (OPENCODE_GO_ENDPOINT, "shared-model", key),
        )

    def test_local_go_reaches_classifier_and_geocoder_requests(self) -> None:
        self._write_go_credential("unit-" + "credential")
        environment = self._environment()
        classifier_response = MagicMock()
        classifier_response.__enter__.return_value.read.return_value = json.dumps(
            {"choices": [{"message": {"content": "yes"}}]}
        ).encode("utf-8")
        classifier_urlopen = Mock(return_value=classifier_response)
        geocoder_response = MagicMock()
        geocoder_response.__enter__.return_value.read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "place": "Аташ",
                                    "root_cause": "Reported pipeline leak.",
                                }
                            )
                        }
                    }
                ]
            }
        ).encode("utf-8")
        geocoder_urlopen = Mock(return_value=geocoder_response)

        with patch.dict(os.environ, environment, clear=True), patch.object(
            classifier, "urlopen", classifier_urlopen
        ), patch.object(opencode_geocoder, "urlopen", geocoder_urlopen):
            self.assertTrue(
                classifier.is_pollution_article("Caspian oil spill near Atash")
            )
            extracted = opencode_geocoder.extract_report_details(
                "Разлив нефти у неизвестного безымянного мыса"
            )
            self.assertEqual(extracted.place, "Аташ")
            self.assertEqual(extracted.root_cause, "Reported pipeline leak.")

        classifier_request = classifier_urlopen.call_args.args[0]
        self.assertEqual(classifier_request.full_url, OPENCODE_GO_ENDPOINT)
        classifier_payload = json.loads(classifier_request.data.decode("utf-8"))
        self.assertEqual(classifier_payload["model"], DEFAULT_OPENCODE_MODEL)
        self.assertEqual(classifier_payload["max_tokens"], 128)
        geocoder_request = geocoder_urlopen.call_args.args[0]
        self.assertEqual(geocoder_request.full_url, OPENCODE_GO_ENDPOINT)
        geocoder_payload = json.loads(geocoder_request.data.decode("utf-8"))
        self.assertEqual(geocoder_payload["model"], DEFAULT_GEOCODER_MODEL)
        self.assertEqual(geocoder_payload["max_tokens"], 256)
        prompt = geocoder_payload["messages"][0]["content"]
        self.assertIn('"root_cause"', prompt)
        self.assertIn("Never infer a cause", prompt)

    def test_explicit_component_configuration_wins_over_local_go(self) -> None:
        self._write_go_credential("local-" + "credential")
        environment = self._environment(
            POLLUTION_CLASSIFIER_ENDPOINT="https://classifier.example/v1/chat/completions",
            POLLUTION_CLASSIFIER_MODEL="explicit-classifier",
            POLLUTION_CLASSIFIER_API_KEY="classifier-" + "credential",
            POLLUTION_GEOCODER_ENDPOINT="https://geocoder.example/v1/chat/completions",
            POLLUTION_GEOCODER_MODEL="explicit-geocoder",
            POLLUTION_GEOCODER_API_KEY="geocoder-" + "credential",
        )

        self.assertEqual(
            completion_config("POLLUTION_CLASSIFIER", environment),
            (
                "https://classifier.example/v1/chat/completions",
                "explicit-classifier",
                "classifier-" + "credential",
            ),
        )
        self.assertEqual(
            completion_config(
                "POLLUTION_GEOCODER",
                environment,
                fallback_prefix="POLLUTION_CLASSIFIER",
            ),
            (
                "https://geocoder.example/v1/chat/completions",
                "explicit-geocoder",
                "geocoder-" + "credential",
            ),
        )

    def test_classifier_configuration_falls_back_for_geocoder(self) -> None:
        self._write_go_credential("local-" + "credential")
        environment = self._environment(
            POLLUTION_CLASSIFIER_ENDPOINT="https://classifier.example/v1/chat/completions",
            POLLUTION_CLASSIFIER_MODEL="shared-model",
            POLLUTION_CLASSIFIER_API_KEY="shared-" + "credential",
        )

        self.assertEqual(
            completion_config(
                "POLLUTION_GEOCODER",
                environment,
                fallback_prefix="POLLUTION_CLASSIFIER",
            ),
            (
                "https://classifier.example/v1/chat/completions",
                "shared-model",
                "shared-" + "credential",
            ),
        )

    def test_disabled_local_discovery_preserves_zen_fallback(self) -> None:
        self._write_go_credential("local-" + "credential")
        environment = self._environment(
            POLLUTION_LOCAL_OPENCODE_GO="0",
            OPENCODE_API_KEY="zen-" + "credential",
        )

        self.assertEqual(
            completion_config("POLLUTION_CLASSIFIER", environment),
            (OPENCODE_ZEN_ENDPOINT, DEFAULT_OPENCODE_MODEL, "zen-" + "credential"),
        )
        self.assertEqual(
            completion_config("POLLUTION_GEOCODER", environment),
            (OPENCODE_ZEN_ENDPOINT, DEFAULT_GEOCODER_MODEL, "zen-" + "credential"),
        )

    def test_missing_and_malformed_credentials_are_ignored(self) -> None:
        environment = self._environment()
        self.assertIsNone(completion_config("POLLUTION_CLASSIFIER", environment))

        self.auth_path.parent.mkdir(parents=True, exist_ok=True)
        malformed_documents = [
            "not json",
            json.dumps({"opencode-go": {"type": "oauth", "key": "ignored"}}),
            json.dumps({"opencode-go": {"type": "api", "key": ""}}),
        ]
        for document in malformed_documents:
            with self.subTest(document=document):
                self.auth_path.write_text(document, encoding="utf-8")
                self.assertIsNone(completion_config("POLLUTION_GEOCODER", environment))

    def test_classifier_failure_log_does_not_leak_key_or_exception_text(self) -> None:
        key = "private-" + "credential"
        self._write_go_credential(key)
        with patch.dict(os.environ, self._environment(), clear=True), patch.object(
            classifier, "_classify_with_endpoint", side_effect=RuntimeError(key)
        ), self.assertLogs(classifier.logger, level="WARNING") as captured:
            self.assertTrue(classifier.is_pollution_article("Caspian oil spill near Atash"))

        output = "\n".join(captured.output)
        self.assertNotIn(key, output)
        self.assertIn("RuntimeError", output)


if __name__ == "__main__":
    unittest.main()
