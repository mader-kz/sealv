#!/usr/bin/env python3
"""Locale parity for webapp/index.html. Exits non-zero on a gap.

This exists because the lookup in the page is deliberately forgiving:

    let s = (I18N[LANG] && I18N[LANG][key]) ?? I18N.en[key] ?? key;

A missing `ru` string therefore renders the English one, and a missing `en`
string renders the raw key - `cnt.best` in the middle of the UI. Neither throws,
neither shows up in a console, and both look fine to whoever added the key in
the language they were working in. Only a reader of the other language ever
finds out. That is a bug class a machine should be catching, not a person.

Stdlib only, on purpose: it runs in CI before any dependency is installed, and
on a dev box with `python3 tools/check_i18n.py`.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

PAGE = Path(__file__).resolve().parent.parent / "webapp" / "index.html"

# The reference locale. `t()` falls back to it, so it is the one set that must
# be a superset of everything used; the others are compared against it.
BASE = "en"


def _span(text: str, open_at: int) -> tuple[int, int]:
    """Balanced-brace span starting at `open_at` (which must index a '{').

    String- and comment-aware, because the translations themselves contain
    braces - `"{n} frames"` is a real value in this file, and a naive brace
    count treats it as nesting and then runs off the end of the object.
    """
    depth = 0
    i = open_at
    n = len(text)
    while i < n:
        c = text[i]
        if c in "\"'`":
            quote = c
            i += 1
            while i < n and text[i] != quote:
                i += 2 if text[i] == "\\" else 1
        elif c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return open_at, i
        i += 1
    raise ValueError(f"unbalanced braces from offset {open_at}")


def _keys(block: str) -> set[str]:
    """Quoted keys at the top level of one locale object.

    Depth-aware so a nested object (none today, but the format invites one)
    cannot contribute phantom keys to the parent's set.

    Duplicates are a hard failure, not a dedup: in a JS object literal the
    LAST occurrence wins, so a stale key lower in the block silently overrides
    a fixed one above it. That exact failure shipped once - a legacy
    "tide.low" beat its replacement - and nothing in the page ever errors.
    """
    found: set[str] = set()
    dupes: list[str] = []
    depth = 0
    i = 0
    n = len(block)
    while i < n:
        c = block[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c in "\"'":
            quote = c
            start = i + 1
            i += 1
            while i < n and block[i] != quote:
                i += 2 if block[i] == "\\" else 1
            # A quoted run is a key only when a colon follows it and it sits
            # directly inside the locale object - otherwise it is a value.
            if depth == 1:
                after = i + 1
                while after < n and block[after] in " \t\n\r":
                    after += 1
                if after < n and block[after] == ":":
                    key = block[start:i]
                    if key in found:
                        dupes.append(key)
                    found.add(key)
        i += 1
    if dupes:
        raise ValueError(
            f"duplicate key(s) {sorted(set(dupes))} - the later value silently "
            f"overrides the earlier one"
        )
    return found


def load() -> tuple[dict[str, set[str]], set[str]]:
    """Returns (keys defined per locale, keys referenced by the page)."""
    src = PAGE.read_text(encoding="utf-8")

    anchor = src.index("const I18N")
    obj_start = src.index("{", anchor)
    _, obj_end = _span(src, obj_start)
    table = src[obj_start : obj_end + 1]

    defined: dict[str, set[str]] = {}
    for m in re.finditer(r"(?m)^\s{2}([a-z]{2}):\s*\{", table):
        start, end = _span(table, table.index("{", m.end() - 1))
        try:
            defined[m.group(1)] = _keys(table[start : end + 1])
        except ValueError as exc:
            raise ValueError(f"locale '{m.group(1)}': {exc}") from None

    used = set(re.findall(r'data-i18n(?:-ph)?="([^"]+)"', src))
    # t("...") is how JS-rendered strings reach the table; those never appear as
    # an attribute, so attribute scanning alone would miss every one of them.
    used |= set(re.findall(r'\bt\(\s*"([^"]+)"', src))
    return defined, used


def main() -> int:
    try:
        defined, used = load()
    except ValueError as exc:
        print(f"i18n FAIL  {exc}")
        return 1
    if BASE not in defined:
        print(f"FAIL: no '{BASE}' locale found in {PAGE.name}")
        return 1

    problems: list[str] = []
    base_keys = defined[BASE]

    missing = sorted(used - base_keys)
    if missing:
        problems.append(
            f"{len(missing)} key(s) used by the page but absent from '{BASE}' "
            f"- these render as the raw key text:\n    "
            + "\n    ".join(missing)
        )

    for loc in sorted(k for k in defined if k != BASE):
        gap = sorted(base_keys - defined[loc])
        if gap:
            problems.append(
                f"{len(gap)} key(s) missing from '{loc}' - these silently fall "
                f"back to English:\n    " + "\n    ".join(gap)
            )
        extra = sorted(defined[loc] - base_keys)
        if extra:
            problems.append(
                f"{len(extra)} key(s) in '{loc}' with no '{BASE}' counterpart "
                f"- dead or misspelled:\n    " + "\n    ".join(extra)
            )

    counts = ", ".join(f"{k}={len(v)}" for k, v in sorted(defined.items()))
    if problems:
        print(f"i18n FAIL  ({counts}, {len(used)} referenced)\n")
        for p in problems:
            print("  " + p + "\n")
        return 1

    print(f"i18n OK  ({counts}, {len(used)} referenced, all resolve)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
