"""SQLite helpers for pollution tables. No ORM, just SQL."""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional

from .models import PollutionIncident, PollutionSource


def _row_to_incident(row: sqlite3.Row) -> dict:
    d = dict(row)
    if d.get("raw"):
        try:
            d["raw"] = json.loads(d["raw"])
        except Exception:
            pass
    if d.get("geom"):
        try:
            d["geom"] = json.loads(d["geom"])
        except Exception:
            pass
    return d


def upsert_source(conn: sqlite3.Connection, src: PollutionSource) -> None:
    conn.execute(
        """INSERT INTO pollution_source(id,name,url,type,poll_method,update_freq)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url,
             type=excluded.type, poll_method=excluded.poll_method, update_freq=excluded.update_freq""",
        (src.id, src.name, src.url, src.type, src.poll_method, src.update_freq),
    )


def list_sources(conn: sqlite3.Connection) -> list[dict]:
    cur = conn.execute("SELECT * FROM pollution_source ORDER BY id")
    return [dict(r) for r in cur.fetchall()]


def ensure_source_health(conn: sqlite3.Connection, source_id: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO pollution_source_health(source_id) VALUES (?)",
        (source_id,),
    )


def get_source_health(conn: sqlite3.Connection, source_id: str) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM pollution_source_health WHERE source_id = ?",
        (source_id,),
    ).fetchone()
    return dict(row) if row else None


def list_source_health(conn: sqlite3.Connection) -> list[dict]:
    cur = conn.execute(
        """SELECT s.*, COALESCE(h.status, 'never') AS status,
                  COALESCE(h.attempts, 0) AS attempts,
                  COALESCE(h.successes, 0) AS successes,
                  COALESCE(h.consecutive_failures, 0) AS consecutive_failures,
                  COALESCE(h.total_items, 0) AS total_items,
                  COALESCE(h.total_inserted, 0) AS total_inserted,
                  COALESCE(h.total_updated, 0) AS total_updated,
                  COALESCE(h.total_unchanged, 0) AS total_unchanged,
                  h.last_attempt_at, h.last_success_at, h.last_item_count,
                  h.last_inserted_count, h.last_updated_count, h.last_unchanged_count,
                  h.last_error, h.last_duration_ms, h.next_poll_at,
                  h.lease_owner, h.lease_until, h.updated_at
           FROM pollution_source AS s
           LEFT JOIN pollution_source_health AS h ON h.source_id = s.id
           ORDER BY s.id"""
    )
    return [dict(r) for r in cur.fetchall()]


def claim_source_poll(
    conn: sqlite3.Connection,
    source_id: str,
    owner: str,
    attempted_at: str,
    lease_until: str,
) -> bool:
    """Atomically lease a source and record an attempt across API processes."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        ensure_source_health(conn, source_id)
        cur = conn.execute(
            """UPDATE pollution_source_health
               SET status = 'running', attempts = attempts + 1,
                   last_attempt_at = ?, last_item_count = NULL,
                   last_inserted_count = NULL, last_updated_count = NULL,
                   last_unchanged_count = NULL, last_error = NULL,
                   last_duration_ms = NULL, lease_owner = ?, lease_until = ?, updated_at = ?
               WHERE source_id = ?
                 AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until <= ?)""",
            (attempted_at, owner, lease_until, attempted_at, source_id, attempted_at),
        )
        conn.execute("COMMIT")
        return cur.rowcount == 1
    except Exception:
        conn.execute("ROLLBACK")
        raise


def finish_source_poll(
    conn: sqlite3.Connection,
    source_id: str,
    owner: str,
    *,
    status: str,
    finished_at: str,
    item_count: Optional[int],
    inserted_count: int = 0,
    updated_count: int = 0,
    unchanged_count: int = 0,
    error: Optional[str],
    duration_ms: int,
    next_poll_at: str,
    success: bool,
    store_results: bool | None = None,
    release_lease: bool = True,
) -> bool:
    """Persist one terminal attempt without letting an expired owner overwrite a newer run."""
    stored = success if store_results is None else store_results
    cur = conn.execute(
        """UPDATE pollution_source_health
           SET status = ?,
               successes = successes + ?,
               consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures + 1 END,
               total_items = total_items + ?,
               total_inserted = total_inserted + ?,
               total_updated = total_updated + ?,
               total_unchanged = total_unchanged + ?,
               last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
               last_item_count = ?,
               last_inserted_count = ?,
               last_updated_count = ?,
               last_unchanged_count = ?,
               last_error = ?,
               last_duration_ms = ?,
               next_poll_at = ?,
               lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
               lease_until = CASE WHEN ? THEN NULL ELSE lease_until END,
               updated_at = ?
           WHERE source_id = ? AND lease_owner = ?""",
        (
            status,
            1 if success else 0,
            1 if success else 0,
            item_count if stored and item_count is not None else 0,
            inserted_count if stored else 0,
            updated_count if stored else 0,
            unchanged_count if stored else 0,
            1 if success else 0,
            finished_at,
            item_count,
            inserted_count if stored else None,
            updated_count if stored else None,
            unchanged_count if stored else None,
            error,
            duration_ms,
            next_poll_at,
            1 if release_lease else 0,
            1 if release_lease else 0,
            finished_at,
            source_id,
            owner,
        ),
    )
    return cur.rowcount == 1


def upsert_incident(conn: sqlite3.Connection, inc: PollutionIncident) -> str:
    """Store an incident and return inserted, updated, or unchanged."""
    inc.validate()
    values = (
        inc.source_id,
        inc.observed_at,
        inc.lat,
        inc.lng,
        inc.radius_m,
        json.dumps(inc.geom) if inc.geom is not None else None,
        inc.kind,
        inc.area_km2,
        inc.confidence,
        inc.location_precision,
        json.dumps(inc.raw, ensure_ascii=False) if inc.raw else None,
    )
    existing = conn.execute(
        """SELECT source_id,observed_at,lat,lng,radius_m,geom,kind,area_km2,
                  confidence,location_precision,raw
           FROM pollution_incident WHERE id = ?""",
        (inc.id,),
    ).fetchone()
    if existing is not None and tuple(existing) == values:
        return "unchanged"
    if existing is None:
        conn.execute(
            """INSERT INTO pollution_incident(
                   id,source_id,observed_at,lat,lng,radius_m,geom,kind,area_km2,
                   confidence,location_precision,raw
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (inc.id, *values),
        )
        action = "inserted"
    else:
        conn.execute(
            """UPDATE pollution_incident
               SET source_id=?, observed_at=?, lat=?, lng=?, radius_m=?, geom=?,
                   kind=?, area_km2=?, confidence=?, location_precision=?, raw=?
               WHERE id=?""",
            (*values, inc.id),
        )
        action = "updated"
    conn.execute(
        "INSERT INTO pollution_change(incident_id, action) VALUES (?, ?)",
        (inc.id, action),
    )
    return action

def update_incident_raw(
    conn: sqlite3.Connection,
    incident_id: str,
    raw: dict[str, Any],
    *,
    expected_raw: str | None,
) -> bool:
    """Replace incident evidence and publish the update through the same cursor."""
    serialized = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
    started = not conn.in_transaction
    if started:
        conn.execute("BEGIN IMMEDIATE")
    try:
        cursor = conn.execute(
            "UPDATE pollution_incident SET raw = ? WHERE id = ? AND raw IS ?",
            (serialized, incident_id, expected_raw),
        )
        if cursor.rowcount == 1:
            conn.execute(
                "INSERT INTO pollution_change(incident_id, action) VALUES (?, 'updated')",
                (incident_id,),
            )
        if started:
            conn.execute("COMMIT")
        return cursor.rowcount == 1
    except Exception:
        if started and conn.in_transaction:
            conn.execute("ROLLBACK")
        raise



def list_incidents(
    conn: sqlite3.Connection,
    bbox: Optional[tuple[float, float, float, float]] = None,
    since: Optional[str] = None,
    kind: Optional[str] = None,
    limit: int = 500,
) -> list[dict]:
    sql = "SELECT * FROM pollution_incident WHERE 1=1"
    args: list[Any] = []
    if bbox:
        west, south, east, north = bbox
        sql += " AND lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?"
        args.extend([west, east, south, north])
    if since:
        sql += " AND observed_at >= ?"
        args.append(since)
    if kind:
        sql += " AND kind = ?"
        args.append(kind)
    sql += " ORDER BY observed_at DESC LIMIT ?"
    args.append(limit)
    cur = conn.execute(sql, tuple(args))
    return [_row_to_incident(r) for r in cur.fetchall()]


def list_changes(conn: sqlite3.Connection, after: int = 0, limit: int = 500) -> list[dict]:
    rows = conn.execute(
        """SELECT c.seq, c.action, c.changed_at, i.*
           FROM pollution_change AS c
           JOIN pollution_incident AS i ON i.id = c.incident_id
           WHERE c.seq > ? ORDER BY c.seq LIMIT ?""",
        (after, limit),
    ).fetchall()
    changes: list[dict] = []
    for row in rows:
        item = _row_to_incident(row)
        item["seq"] = int(row["seq"])
        item["action"] = str(row["action"])
        item["changed_at"] = row["changed_at"]
        changes.append(item)
    return changes


def latest_change_seq(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COALESCE(MAX(seq), 0) FROM pollution_change").fetchone()
    return int(row[0]) if row else 0


def record_seen(conn: sqlite3.Connection, source_id: str, record_key: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM pollution_record_cache WHERE source_id=? AND record_key=?",
        (source_id, record_key),
    ).fetchone()
    return row is not None


def get_record(conn: sqlite3.Connection, source_id: str, record_key: str) -> dict | None:
    row = conn.execute(
        """SELECT source_id,record_key,content_hash,observed_at,outcome,updated_at
           FROM pollution_record_cache WHERE source_id=? AND record_key=?""",
        (source_id, record_key),
    ).fetchone()
    return dict(row) if row else None


def mark_record(
    conn: sqlite3.Connection,
    source_id: str,
    record_key: str,
    *,
    content_hash: Optional[str] = None,
    observed_at: Optional[str] = None,
    outcome: str,
) -> None:
    conn.execute(
        """INSERT INTO pollution_record_cache(
               source_id,record_key,content_hash,observed_at,outcome,updated_at
           ) VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(source_id,record_key) DO UPDATE SET
               content_hash=excluded.content_hash,
               observed_at=excluded.observed_at,
               outcome=excluded.outcome,
               updated_at=excluded.updated_at""",
        (source_id, record_key, content_hash, observed_at, outcome),
    )


def count_incidents(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(*) FROM pollution_incident").fetchone()
    return int(row[0]) if row else 0
