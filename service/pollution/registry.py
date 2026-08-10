"""Single place to register sources. No magic, just a dict."""
from __future__ import annotations

from typing import Callable, Optional

from .models import PollutionIncident, PollutionSource

class SourceUnavailableError(RuntimeError):
    """The source is intentionally unavailable, not a successful empty poll."""


# id -> PollutionSource
REGISTRY: dict[str, PollutionSource] = {}
# id -> poll function: async or sync (source, since) -> list[PollutionIncident]
_POLLERS: dict[str, Callable] = {}


def register_source(source: PollutionSource, poller: Optional[Callable] = None) -> PollutionSource:
    REGISTRY[source.id] = source
    if poller is not None:
        _POLLERS[source.id] = poller
        source.poller = getattr(poller, "__module__", "") + "." + getattr(poller, "__name__", "")
    return source


def get_sources() -> list[PollutionSource]:
    return list(REGISTRY.values())


def get_poller(source_id: str) -> Optional[Callable]:
    return _POLLERS.get(source_id)


async def poll_all(since: Optional[str] = None) -> list[PollutionIncident]:
    """Call every registered poller, collect incidents. Failures are skipped, not fatal."""
    import asyncio
    import inspect

    out: list[PollutionIncident] = []
    for sid, fn in _POLLERS.items():
        try:
            src = REGISTRY[sid]
            res = fn(src, since)
            if inspect.isawaitable(res):
                res = await res
            if res:
                out.extend(res)
        except Exception as e:
            # log but don't crash other pollers
            print(f"[pollution] poller {sid} failed: {e}")
    return out


def clear_registry() -> None:
    REGISTRY.clear()
    _POLLERS.clear()
