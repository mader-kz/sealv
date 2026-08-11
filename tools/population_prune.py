#!/usr/bin/env python3
"""Drop auto-assigned population groups so the tracker can recompute them.

    python3 tools/population_prune.py --dry-run
    python3 tools/population_prune.py

Why this is needed at all
-------------------------
`sync_population_tracks` never deletes: it persists what the client computed and
protects operator decisions, but a group that the algorithm has stopped
producing simply stays. That is the right behaviour for a durable identity - a
population an ecologist confirmed must not vanish because a recomputation
disagreed - and the wrong behaviour after a change to how groups are FORMED,
because every group from the old rule survives beside the new ones and the map
draws both.

Which is what a 5 m grouping radius left behind. On a dense haul-out it cut 575
animals into 65 pairs, each becoming its own `Group N` with exactly one
observation; raising the radius produces the right groups but cannot remove the
wrong ones.

What is deleted, and what is never deleted
-------------------------------------------
Only populations whose every observation is still `auto` - never touched by a
person. A population is KEPT if any of these is true:

  * any observation is `confirmed` or `rejected` - somebody ruled on it;
  * it has been renamed from the generated `Group N`;
  * a link review references it - somebody judged a connection through it.

Deleting an auto group costs nothing: the client recomputes groups from the
detections on the next view and syncs them straight back. Deleting a confirmed
one would destroy a judgement that cannot be recomputed, which is why the rule
above is a whitelist of reasons to keep rather than a guess at what is stale.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from service import db  # noqa: E402


def keepers(conn) -> set[str]:
    """Population ids that carry something a person did."""
    keep: set[str] = set()
    for row in conn.execute(
        """SELECT DISTINCT population_id FROM population_observation
            WHERE assignment_status IS NOT NULL AND assignment_status <> 'auto'"""
    ):
        keep.add(row[0])
    for row in conn.execute("SELECT id, name FROM population"):
        name = (row[1] or "").strip()
        # The generated name is `Group <n>`; anything else was typed.
        parts = name.split()
        if not (len(parts) == 2 and parts[0] == "Group" and parts[1].isdigit()):
            keep.add(row[0])
    try:
        for row in conn.execute(
            """SELECT DISTINCT population_id FROM population_observation
                WHERE id IN (SELECT from_observation_id FROM population_link_review
                             UNION SELECT to_observation_id FROM population_link_review)"""
        ):
            keep.add(row[0])
    except Exception:  # noqa: BLE001 - the review table is optional history
        pass
    keep.discard(None)
    return keep


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", default=None, help="database file (default: $SEALV_DB)")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would go, delete nothing")
    args = parser.parse_args(argv)
    if args.db:
        os.environ["SEALV_DB"] = args.db

    conn = db.init_db(db.connect())
    total = int(conn.execute("SELECT COUNT(*) FROM population").fetchone()[0])
    keep = keepers(conn)
    doomed = [
        row[0] for row in conn.execute("SELECT id FROM population")
        if row[0] not in keep
    ]
    obs = int(conn.execute(
        "SELECT COUNT(*) FROM population_observation"
    ).fetchone()[0])

    print(f"{total} population(s), {obs} observation(s)")
    print(f"  keep   {len(keep)} (operator decision, rename, or link review)")
    print(f"  drop   {len(doomed)} (auto only - the tracker recomputes these)")
    if args.dry_run:
        print("dry run: nothing was deleted")
        return 0
    if not doomed:
        print("nothing to do")
        return 0

    marks = ",".join("?" for _ in doomed)
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            f"DELETE FROM population_observation WHERE population_id IN ({marks})", doomed
        )
        conn.execute(f"DELETE FROM population WHERE id IN ({marks})", doomed)
    left = int(conn.execute("SELECT COUNT(*) FROM population").fetchone()[0])
    print(f"deleted {len(doomed)}; {left} population(s) remain")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
