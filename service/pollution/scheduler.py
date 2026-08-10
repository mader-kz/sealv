"""Autonomous, lease-backed pollution polling scheduler."""
from __future__ import annotations

import asyncio
import calendar
import hashlib
import os
import re
import time
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from . import db as pol_db
from .models import PollutionIncident, PollutionSource
from .poll_runner import PollerProcessError, run_poller_process
from .registry import REGISTRY, SourceUnavailableError, get_poller

try:
    from service.db import connect as _connect  # type: ignore
except Exception:
    from db import connect as _connect  # type: ignore

_FALSE_VALUES = {"0", "false", "no", "off", "disabled"}
_CADENCE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([smhdw]?)\s*$", re.IGNORECASE)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    return default if raw is None else raw.strip().lower() not in _FALSE_VALUES


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def six_month_cutoff(now: Optional[datetime] = None) -> datetime:
    """Return a calendar six-month runtime cutoff (not a fixed build-time date)."""
    current = (now or _utcnow()).astimezone(timezone.utc)
    month_index = current.year * 12 + current.month - 1 - 6
    year, month_zero = divmod(month_index, 12)
    month = month_zero + 1
    day = min(current.day, calendar.monthrange(year, month)[1])
    return current.replace(year=year, month=month, day=day)


def cadence_seconds(value: str, default: int = 3600) -> int:
    text = (value or "").strip().lower()
    aliases = {
        "minute": 60,
        "hourly": 3600,
        "daily": 86400,
        "weekly": 604800,
        "monthly": 2592000,
    }
    if text in aliases:
        return aliases[text]
    match = _CADENCE_RE.match(text)
    if not match:
        return default
    number = float(match.group(1))
    multiplier = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}[match.group(2).lower()]
    return max(15, int(number * multiplier))


class PollutionScheduler:
    def __init__(self) -> None:
        self.enabled = _env_bool("POLLUTION_SCHEDULER_ENABLED", False)
        self.concurrency = _env_int("POLLUTION_SCHEDULER_CONCURRENCY", 3, 1, 16)
        self.poll_timeout_s = _env_int("POLLUTION_POLL_TIMEOUT_SECONDS", 180, 10, 1800)
        self.tick_s = _env_int("POLLUTION_SCHEDULER_TICK_SECONDS", 15, 2, 300)
        self.default_cadence_s = _env_int("POLLUTION_DEFAULT_CADENCE_SECONDS", 3600, 60, 86400)
        self.error_retry_s = _env_int("POLLUTION_ERROR_RETRY_SECONDS", 300, 30, 3600)
        self.shutdown_timeout_s = _env_int("POLLUTION_SHUTDOWN_TIMEOUT_SECONDS", 20, 1, 120)
        self.jitter_pct = _env_int("POLLUTION_SCHEDULER_JITTER_PERCENT", 10, 0, 40)
        self.owner = f"{os.getpid()}:{uuid.uuid4().hex}"
        self._semaphore = asyncio.Semaphore(self.concurrency)
        self._locks: dict[str, asyncio.Lock] = {}
        self._active: dict[str, asyncio.Task] = {}
        self._runner: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self.started_at: Optional[str] = None

    def state(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "running": self._runner is not None and not self._runner.done(),
            "started_at": self.started_at,
            "active_sources": sorted(self._active),
            "concurrency": self.concurrency,
            "poll_timeout_seconds": self.poll_timeout_s,
            "six_month_cutoff": _iso(six_month_cutoff()),
        }

    async def start(self) -> dict[str, Any]:
        if not self.enabled or (self._runner is not None and not self._runner.done()):
            return self.state()
        await asyncio.to_thread(self._sync_registry)
        self._stop.clear()
        self.started_at = _iso(_utcnow())
        self._runner = asyncio.create_task(self._run_loop(), name="pollution-scheduler")
        return self.state()

    async def stop(self) -> None:
        self._stop.set()
        runner = self._runner
        if runner is not None:
            try:
                await asyncio.wait_for(asyncio.shield(runner), timeout=self.tick_s + 2)
            except asyncio.TimeoutError:
                runner.cancel()
                await asyncio.gather(runner, return_exceptions=True)
        active = list(self._active.values())
        if active:
            done, pending = await asyncio.wait(active, timeout=self.shutdown_timeout_s)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                if not task.cancelled():
                    task.exception()
        self._runner = None
        self.started_at = None

    async def _run_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self._start_due()
            except Exception as exc:
                print(f"[pollution] scheduler scan failed: {exc}")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.tick_s)
            except asyncio.TimeoutError:
                pass

    async def _start_due(self) -> None:
        await asyncio.to_thread(self._sync_registry)
        rows = await asyncio.to_thread(self._health_rows)
        now = _utcnow()
        for row in rows:
            source_id = str(row["id"])
            due_at = _parse_iso(row.get("next_poll_at"))
            lease_until = _parse_iso(row.get("lease_until"))
            if source_id in self._active or (due_at is not None and due_at > now):
                continue
            if lease_until is not None and lease_until > now:
                continue
            task = asyncio.create_task(self.run_source(source_id), name=f"pollution:{source_id}")
            self._active[source_id] = task
            task.add_done_callback(lambda finished, sid=source_id: self._task_done(sid, finished))

    def _task_done(self, source_id: str, task: asyncio.Task) -> None:
        self._active.pop(source_id, None)
        if not task.cancelled():
            error = task.exception()
            if error is not None:
                print(f"[pollution] scheduler task {source_id} failed: {error}")

    async def run_all(self, since: Optional[str] = None) -> list[dict[str, Any]]:
        await asyncio.to_thread(self._sync_registry)
        tasks = [asyncio.create_task(self.run_source(source_id, since)) for source_id in sorted(REGISTRY)]
        return await asyncio.gather(*tasks) if tasks else []

    async def run_source(self, source_id: str, since: Optional[str] = None) -> dict[str, Any]:
        source = REGISTRY.get(source_id)
        if source is None:
            return {"source_id": source_id, "status": "missing", "count": None}
        lock = self._locks.setdefault(source_id, asyncio.Lock())
        if lock.locked():
            return {"source_id": source_id, "status": "overlap_skipped", "count": None}
        async with lock, self._semaphore:
            previous = await asyncio.to_thread(self._source_health, source_id)
            attempted = _utcnow()
            lease_until = attempted + timedelta(seconds=self.poll_timeout_s + 60)
            claimed = await asyncio.to_thread(self._claim, source, attempted, lease_until)
            if not claimed:
                return {"source_id": source_id, "status": "overlap_skipped", "count": None}
            attempts = int((previous or {}).get("attempts") or 0) + 1
            failures = int((previous or {}).get("consecutive_failures") or 0)
            poll_since = since or self._since_for(previous, attempted)
            started = time.monotonic()
            status = "ok"
            try:
                poller = get_poller(source_id)
                if poller is None:
                    raise SourceUnavailableError("no poller registered")
                incidents = await self._invoke(source, poll_since)
                if incidents is None:
                    raise TypeError("poller returned None; return [] for a successful empty poll")
                if not isinstance(incidents, list):
                    raise TypeError(f"poller returned {type(incidents).__name__}, expected list")
                for incident in incidents:
                    if not isinstance(incident, PollutionIncident):
                        raise TypeError("poller returned a non-PollutionIncident item")
                    if incident.source_id != source_id:
                        raise ValueError(f"incident {incident.id} belongs to {incident.source_id}, not {source_id}")
                    incident.validate()
                finished = _utcnow()
                duration_ms = max(0, int((time.monotonic() - started) * 1000))
                next_at = self._next_poll(source, finished, attempts, failed=False)
                outcomes = await asyncio.to_thread(
                    self._persist_success,
                    source,
                    incidents,
                    finished,
                    duration_ms,
                    next_at,
                )
                return {
                    "source_id": source_id,
                    "status": status,
                    "count": len(incidents),
                    **outcomes,
                    "since": poll_since,
                    "duration_ms": duration_ms,
                }
            except asyncio.CancelledError:
                await asyncio.to_thread(
                    self._persist_failure,
                    source_id,
                    "cancelled during shutdown",
                    "error",
                    started,
                    self._next_poll(
                        source, _utcnow(), attempts, failed=True,
                        consecutive_failures=failures + 1,
                    ),
                    True,
                )
                raise
            except Exception as exc:
                finished = _utcnow()
                error = str(exc).strip() or type(exc).__name__
                next_at = self._next_poll(
                    source,
                    finished,
                    attempts,
                    failed=True,
                    consecutive_failures=failures + 1,
                    retry_after_seconds=getattr(exc, "retry_after_seconds", None),
                )
                partial_incidents = getattr(exc, "partial_incidents", None)
                if partial_incidents is not None:
                    if not isinstance(partial_incidents, list):
                        raise TypeError("partial poll result must be a list") from exc
                    for incident in partial_incidents:
                        if not isinstance(incident, PollutionIncident):
                            raise TypeError("partial poll result contains a non-incident") from exc
                        if incident.source_id != source_id:
                            raise ValueError(
                                f"incident {incident.id} belongs to {incident.source_id}, not {source_id}"
                            ) from exc
                        incident.validate()
                    duration_ms = max(0, int((time.monotonic() - started) * 1000))
                    outcomes = await asyncio.to_thread(
                        self._persist_success,
                        source,
                        partial_incidents,
                        finished,
                        duration_ms,
                        next_at,
                        status="partial",
                        error=error,
                        success=False,
                    )
                    print(f"[pollution] poller {source_id} partial: {error}")
                    return {
                        "source_id": source_id,
                        "status": "partial",
                        "count": len(partial_incidents),
                        **outcomes,
                        "since": poll_since,
                        "error": error,
                        "duration_ms": duration_ms,
                    }
                unavailable = isinstance(exc, SourceUnavailableError) or (
                    isinstance(exc, PollerProcessError) and exc.unavailable
                )
                status = "unavailable" if unavailable else "error"
                await asyncio.to_thread(
                    self._persist_failure,
                    source_id,
                    error,
                    status,
                    started,
                    next_at,
                    True,
                )
                print(f"[pollution] poller {source_id} {status}: {error}")
                return {
                    "source_id": source_id,
                    "status": status,
                    "count": None,
                    "since": poll_since,
                    "error": error,
                    "duration_ms": max(0, int((time.monotonic() - started) * 1000)),
                }

    async def _invoke(self, source: PollutionSource, since: str) -> Any:
        cancelled = threading.Event()
        try:
            return await asyncio.to_thread(
                run_poller_process,
                source.id,
                since,
                self.poll_timeout_s,
                cancelled,
            )
        except asyncio.CancelledError:
            cancelled.set()
            raise

    def _since_for(self, previous: Optional[dict], now: datetime) -> str:
        cutoff = six_month_cutoff(now)
        last_success = _parse_iso((previous or {}).get("last_success_at"))
        if last_success is not None:
            cutoff = max(cutoff, last_success - timedelta(minutes=5))
        return _iso(cutoff)

    def _next_poll(
        self,
        source: PollutionSource,
        now: datetime,
        attempts: int,
        *,
        failed: bool,
        consecutive_failures: int = 0,
        retry_after_seconds: float | None = None,
    ) -> datetime:
        normal_cadence = cadence_seconds(source.update_freq, self.default_cadence_s)
        cadence = normal_cadence
        if failed:
            exponent = max(0, min(consecutive_failures - 1, 12))
            cadence = min(normal_cadence, self.error_retry_s * (2 ** exponent))
        digest = hashlib.sha256(f"{source.id}:{attempts}".encode("utf-8")).digest()
        unit = int.from_bytes(digest[:2], "big") / 65535.0
        jitter = cadence * (self.jitter_pct / 100.0) * ((unit * 2.0) - 1.0)
        delay = max(15.0, cadence + jitter)
        if retry_after_seconds is not None:
            delay = max(delay, retry_after_seconds)
        return now + timedelta(seconds=delay)

    def _sync_registry(self) -> None:
        conn = _connect()
        try:
            for source in REGISTRY.values():
                pol_db.upsert_source(conn, source)
                pol_db.ensure_source_health(conn, source.id)
        finally:
            conn.close()

    def _health_rows(self) -> list[dict]:
        conn = _connect()
        try:
            return pol_db.list_source_health(conn)
        finally:
            conn.close()

    def _source_health(self, source_id: str) -> Optional[dict]:
        conn = _connect()
        try:
            return pol_db.get_source_health(conn, source_id)
        finally:
            conn.close()

    def _claim(self, source: PollutionSource, attempted: datetime, lease_until: datetime) -> bool:
        conn = _connect()
        try:
            pol_db.upsert_source(conn, source)
            return pol_db.claim_source_poll(conn, source.id, self.owner, _iso(attempted), _iso(lease_until))
        finally:
            conn.close()

    def _persist_success(
        self,
        source: PollutionSource,
        incidents: list[PollutionIncident],
        finished: datetime,
        duration_ms: int,
        next_at: datetime,
        *,
        status: str = "ok",
        error: str | None = None,
        success: bool = True,
    ) -> dict[str, int]:
        conn = _connect()
        outcomes = {"inserted": 0, "updated": 0, "unchanged": 0}
        try:
            conn.execute("BEGIN IMMEDIATE")
            for incident in incidents:
                action = pol_db.upsert_incident(conn, incident)
                outcomes[action] += 1
                raw = incident.raw if isinstance(incident.raw, dict) else {}
                record_key = next(
                    (
                        str(raw[key])
                        for key in ("canonical_url", "url", "original_url")
                        if raw.get(key)
                    ),
                    None,
                )
                if record_key:
                    content_hash = raw.get("_content_hash")
                    if not isinstance(content_hash, str) or not content_hash:
                        content = str(raw.get("body") or raw.get("text") or raw.get("row") or "")
                        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest() if content else None
                    pol_db.mark_record(
                        conn,
                        source.id,
                        record_key,
                        content_hash=content_hash,
                        observed_at=incident.observed_at,
                        outcome=action,
                    )
            updated = pol_db.finish_source_poll(
                conn,
                source.id,
                self.owner,
                status=status,
                finished_at=_iso(finished),
                item_count=len(incidents),
                inserted_count=outcomes["inserted"],
                updated_count=outcomes["updated"],
                unchanged_count=outcomes["unchanged"],
                error=error,
                duration_ms=duration_ms,
                next_poll_at=_iso(next_at),
                success=success,
                store_results=True,
            )
            if not updated:
                raise RuntimeError("poll lease expired before results were stored")
            conn.execute("COMMIT")
            return outcomes
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def _persist_failure(
        self,
        source_id: str,
        error: str,
        status: str,
        started: float,
        next_at: datetime,
        release_lease: bool,
    ) -> None:
        finished = _utcnow()
        conn = _connect()
        try:
            pol_db.finish_source_poll(
                conn,
                source_id,
                self.owner,
                status=status,
                finished_at=_iso(finished),
                item_count=None,
                error=error[:2000],
                duration_ms=max(0, int((time.monotonic() - started) * 1000)),
                next_poll_at=_iso(next_at),
                success=False,
                release_lease=release_lease,
            )
        finally:
            conn.close()


_SCHEDULER: Optional[PollutionScheduler] = None


def get_scheduler() -> PollutionScheduler:
    global _SCHEDULER
    if _SCHEDULER is None:
        _SCHEDULER = PollutionScheduler()
    return _SCHEDULER


async def start_scheduler() -> dict[str, Any]:
    return await get_scheduler().start()


async def stop_scheduler() -> None:
    if _SCHEDULER is not None:
        await _SCHEDULER.stop()
