"""Bounded, paced HTTP reads for pollution source collectors."""
from __future__ import annotations

from dataclasses import dataclass
from email.utils import parsedate_to_datetime
import math
import os
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from service import db as service_db

from .registry import SourceUnavailableError

DEFAULT_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 20.0
_HOST_LOCK = threading.Lock()
_LOCAL_NEXT: dict[str, float] = {}


@dataclass(frozen=True)
class HttpResponse:
    body: bytes
    url: str
    status: int
    charset: str


def _env_float(name: str, default: float, low: float, high: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return min(high, max(low, value))


def _max_response_bytes() -> int:
    try:
        value = int(os.environ.get("POLLUTION_MAX_RESPONSE_BYTES", str(25 * 1024 * 1024)))
    except ValueError:
        value = 25 * 1024 * 1024
    return min(100 * 1024 * 1024, max(64 * 1024, value))


def _host_interval() -> float:
    return _env_float("POLLUTION_HOST_MIN_INTERVAL_SECONDS", 0.75, 0.0, 60.0)


def _reserve_locally(host: str, interval: float) -> float:
    with _HOST_LOCK:
        now = time.time()
        reserved = max(now, _LOCAL_NEXT.get(host, 0.0))
        _LOCAL_NEXT[host] = reserved + interval
        return reserved


def _reserve_request(host: str, interval: float) -> float:
    if interval <= 0:
        return time.time()
    conn = None
    try:
        conn = service_db.connect(timeout=5.0)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS pollution_host_rate(host TEXT PRIMARY KEY, next_request_at REAL NOT NULL)"
        )
        conn.execute("BEGIN IMMEDIATE")
        now = time.time()
        row = conn.execute(
            "SELECT next_request_at FROM pollution_host_rate WHERE host=?", (host,)
        ).fetchone()
        reserved = max(now, float(row[0]) if row else 0.0)
        conn.execute(
            """INSERT INTO pollution_host_rate(host,next_request_at) VALUES (?,?)
               ON CONFLICT(host) DO UPDATE SET next_request_at=excluded.next_request_at""",
            (host, reserved + interval),
        )
        conn.execute("COMMIT")
        return reserved
    except (OSError, sqlite3.Error):
        if conn is not None and conn.in_transaction:
            conn.execute("ROLLBACK")
        return _reserve_locally(host, interval)
    finally:
        if conn is not None:
            conn.close()


def pace(url: str) -> None:
    host = (urlsplit(url).hostname or "unknown").lower()
    reserved = _reserve_request(host, _host_interval())
    delay = reserved - time.time()
    if delay > 0:
        time.sleep(delay)


def _max_retry_after_seconds() -> float:
    return _env_float(
        "POLLUTION_MAX_RETRY_AFTER_SECONDS",
        86_400.0,
        60.0,
        7 * 86_400.0,
    )


def _bounded_retry_after(seconds: float) -> float | None:
    if not math.isfinite(seconds):
        return None
    return min(_max_retry_after_seconds(), max(0.0, seconds))


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return _bounded_retry_after(float(value))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
            return _bounded_retry_after(parsed.timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            return None


def _read_limited(response, max_bytes: int) -> bytes:
    length = response.headers.get("Content-Length")
    if length:
        try:
            if int(length) > max_bytes:
                raise SourceUnavailableError(
                    f"response too large: {length} bytes exceeds {max_bytes}"
                )
        except ValueError:
            pass
    body = response.read(max_bytes + 1)
    if len(body) > max_bytes:
        raise SourceUnavailableError(f"response exceeded {max_bytes} bytes")
    return body


def fetch(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_bytes: int = DEFAULT_MAX_BYTES,
    method: str = "GET",
    data: bytes | None = None,
    audit_url: str | None = None,
) -> HttpResponse:
    """Fetch one response with cross-process host pacing and a hard body limit."""
    max_bytes = min(max_bytes, _max_response_bytes())
    pace(url)
    request = Request(url, headers=headers or {}, method=method, data=data)
    try:
        with urlopen(request, timeout=timeout) as response:
            body = _read_limited(response, max_bytes)
            return HttpResponse(
                body=body,
                url=response.geturl(),
                status=int(response.status),
                charset=response.headers.get_content_charset() or "utf-8",
            )
    except HTTPError as exc:
        retry_after = _retry_after(exc.headers.get("Retry-After") if exc.headers else None)
        error = SourceUnavailableError(
            f"HTTP {exc.code} for {audit_url or url}", retry_after_seconds=retry_after
        )
        raise error from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise SourceUnavailableError(f"request failed for {audit_url or url}: {exc}") from exc


def fetch_bytes(url: str, **kwargs) -> bytes:
    return fetch(url, **kwargs).body


def fetch_text(url: str, **kwargs) -> str:
    response = fetch(url, **kwargs)
    return response.body.decode(response.charset, errors="replace")
