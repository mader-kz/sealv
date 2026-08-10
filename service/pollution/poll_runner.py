"""Run one poller in a process that can be stopped at its deadline."""
from __future__ import annotations

import asyncio
import inspect
import multiprocessing
from multiprocessing.connection import Connection
import threading
import time
import traceback
from typing import Any

from .registry import SourceUnavailableError


class PollerProcessError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        unavailable: bool = False,
        retry_after_seconds: float | None = None,
        partial_incidents: list[Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.unavailable = unavailable
        self.retry_after_seconds = retry_after_seconds
        self.partial_incidents = partial_incidents


def _child_main(connection: Connection, source_id: str, since: str) -> None:
    try:
        from .registry import REGISTRY, discover_pollers, get_poller

        discover_pollers()
        source = REGISTRY.get(source_id)
        poller = get_poller(source_id)
        if source is None or poller is None:
            raise SourceUnavailableError(f"no poller registered for {source_id}")
        result = poller(source, since)
        if inspect.isawaitable(result):
            result = asyncio.run(result)
        connection.send(("ok", result))
    except BaseException as exc:
        connection.send(
            (
                "error",
                {
                    "message": str(exc).strip() or type(exc).__name__,
                    "unavailable": isinstance(exc, SourceUnavailableError),
                    "retry_after_seconds": getattr(exc, "retry_after_seconds", None),
                    "partial_incidents": getattr(exc, "partial_incidents", None),
                    "traceback": traceback.format_exc(limit=12),
                },
            )
        )
    finally:
        connection.close()


def _stop_process(process: multiprocessing.Process) -> None:
    if process.is_alive():
        process.terminate()
        process.join(2.0)
    if process.is_alive():
        process.kill()
        process.join(2.0)
    else:
        process.join()


def run_poller_process(
    source_id: str,
    since: str,
    timeout_seconds: float,
    cancelled: threading.Event | None = None,
) -> Any:
    """Return a poller's value or stop its entire process at timeout/cancellation."""
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    process = context.Process(
        target=_child_main,
        args=(child, source_id, since),
        name=f"pollution-{source_id}",
        daemon=False,
    )
    process.start()
    child.close()
    deadline = time.monotonic() + timeout_seconds
    try:
        while True:
            if cancelled is not None and cancelled.is_set():
                raise asyncio.CancelledError()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"poller exceeded {timeout_seconds:g} seconds")
            if parent.poll(min(0.1, remaining)):
                kind, payload = parent.recv()
                if kind == "ok":
                    return payload
                raise PollerProcessError(
                    payload["message"],
                    unavailable=bool(payload.get("unavailable")),
                    retry_after_seconds=payload.get("retry_after_seconds"),
                    partial_incidents=payload.get("partial_incidents"),
                )
            if not process.is_alive():
                raise PollerProcessError(
                    f"poller process exited with code {process.exitcode} without a result"
                )
    finally:
        parent.close()
        _stop_process(process)
