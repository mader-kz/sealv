"""Shared configuration for optional pollution LLM completion calls."""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path

OPENCODE_GO_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions"
OPENCODE_ZEN_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions"
OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions"
DEFAULT_OPENCODE_MODEL = "deepseek-v4-flash"
DEFAULT_GEOCODER_MODEL = "gpt-5.6-luna"


def _local_opencode_go_key(environ: Mapping[str, str]) -> str | None:
    """Read the local OpenCode Go key without exposing credential failures."""
    if environ.get("POLLUTION_LOCAL_OPENCODE_GO") == "0":
        return None
    data_home = environ.get("XDG_DATA_HOME")
    base = Path(data_home).expanduser() if data_home else Path.home() / ".local/share"
    path = base / "opencode/auth.json"
    try:
        if path.stat().st_size > 1024 * 1024:
            return None
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None
    credential = document.get("opencode-go") if isinstance(document, dict) else None
    if not isinstance(credential, dict) or credential.get("type") != "api":
        return None
    key = credential.get("key")
    return key if isinstance(key, str) and key.strip() else None


def completion_config(
    prefix: str,
    environ: Mapping[str, str] | None = None,
    fallback_prefix: str | None = None,
) -> tuple[str, str, str | None] | None:
    """Resolve endpoint, model, and key for one pollution completion client."""
    env = os.environ if environ is None else environ
    default_opencode_model = (
        DEFAULT_GEOCODER_MODEL
        if prefix == "POLLUTION_GEOCODER"
        else DEFAULT_OPENCODE_MODEL
    )

    def setting(suffix: str) -> str | None:
        value = env.get(f"{prefix}_{suffix}")
        if value or fallback_prefix is None:
            return value
        return env.get(f"{fallback_prefix}_{suffix}")

    endpoint = setting("ENDPOINT")
    model = setting("MODEL")
    key = setting("API_KEY")

    if endpoint:
        key = key or env.get("OPENCODE_API_KEY") or env.get("OPENAI_API_KEY")
        default_model = "gpt-4o-mini" if "api.openai.com" in endpoint else default_opencode_model
        return endpoint, model or env.get("OPENCODE_MODEL") or default_model, key
    if key:
        return OPENCODE_ZEN_ENDPOINT, model or env.get("OPENCODE_MODEL") or default_opencode_model, key

    local_key = _local_opencode_go_key(env)
    if local_key:
        return OPENCODE_GO_ENDPOINT, model or default_opencode_model, local_key

    opencode_key = env.get("OPENCODE_API_KEY")
    if opencode_key:
        return (
            OPENCODE_ZEN_ENDPOINT,
            model or env.get("OPENCODE_MODEL") or default_opencode_model,
            opencode_key,
        )
    openai_key = env.get("OPENAI_API_KEY")
    if openai_key:
        return OPENAI_ENDPOINT, model or "gpt-4o-mini", openai_key
    return None
