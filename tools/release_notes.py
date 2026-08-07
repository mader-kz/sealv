#!/usr/bin/env python3
"""Scaffold and validate the bilingual release notes for a tag.

Release notes are written by a human into `docs/releases/<tag>.md`, not
generated from commit subjects. That is deliberate: the notes must be English
and Russian 1:1, and nothing in CI can translate. A workflow that auto-generated
them would either emit English under a Russian heading or drop the second half -
both worse than asking for two minutes of writing.

What CI *can* check is the structure, and that is what this does:

    tools/release_notes.py --scaffold v1.2.0   # skeleton + commits since v1.1.x
    tools/release_notes.py v1.2.0              # validate, print final body
    tools/release_notes.py v1.2.0 --check      # validate only, print nothing

Stdlib only; runs identically on a laptop and on a runner.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTES_DIR = ROOT / "docs" / "releases"

EN_TITLE = "## What's Changed"
RU_TITLE = "## Что изменилось"

# The section vocabulary, in the order the template lists them. A release uses
# whichever subset applies and omits the rest entirely - an empty "### Bug Fixes"
# is a defect, not a formality.
SECTIONS = [
    ("New Features", "Новые возможности"),
    ("Bug Fixes", "Исправления"),
    ("Improvements", "Улучшения"),
    ("Breaking Changes", "Ломающие изменения"),
]
EN_TO_RU = dict(SECTIONS)

# Product names that belong to unrelated projects and must never appear in a
# release body. URLs are exempt - a repository address is not branding.
FORBIDDEN = ("trustpay", "kimano", "hubpay", "veripay")


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=False
    ).stdout.strip()


def previous_tag(tag: str) -> str | None:
    """The tag immediately before `tag` in version order.

    Version-sorted rather than date-sorted: tags get pushed out of order often
    enough (a backported patch, a re-cut release) that creation time is the
    wrong key for "what came before this version".
    """
    tags = [t for t in _git("tag", "--sort=-v:refname").splitlines() if t.strip()]
    if tag in tags:
        i = tags.index(tag)
        return tags[i + 1] if i + 1 < len(tags) else None
    return tags[0] if tags else None


def repo_slug() -> str:
    """owner/name from the origin remote, for the compare link."""
    url = _git("remote", "get-url", "origin")
    m = re.search(r"github\.com[:/]+([^/]+/[^/.]+)", url)
    return m.group(1) if m else "OWNER/REPO"


def _blocks(text: str) -> tuple[str, str]:
    """Split the body into its English and Russian halves."""
    if EN_TITLE not in text:
        raise ValueError(f"missing English heading {EN_TITLE!r}")
    if RU_TITLE not in text:
        raise ValueError(f"missing Russian heading {RU_TITLE!r}")
    ru_at = text.index(RU_TITLE)
    if text.index(EN_TITLE) > ru_at:
        raise ValueError("English section must come before the Russian one")
    return text[text.index(EN_TITLE) : ru_at], text[ru_at:]


def _parse(block: str) -> dict[str, int]:
    """Section heading -> number of bullets under it."""
    out: dict[str, int] = {}
    current: str | None = None
    for line in block.splitlines():
        s = line.strip()
        if s.startswith("### "):
            current = s[4:].strip()
            out[current] = 0
        elif s.startswith(("- ", "⚠️", "* ")) and current:
            out[current] += 1
    return out


def validate(tag: str, text: str) -> list[str]:
    """Every structural rule the template implies. Returns human-readable errors."""
    errors: list[str] = []
    try:
        en_block, ru_block = _blocks(text)
    except ValueError as exc:
        return [str(exc)]

    en, ru = _parse(en_block), _parse(ru_block)

    unknown = [s for s in en if s not in EN_TO_RU]
    if unknown:
        errors.append(
            f"unknown English section(s) {unknown}; allowed: {list(EN_TO_RU)}"
        )
    known_ru = set(EN_TO_RU.values())
    unknown_ru = [s for s in ru if s not in known_ru]
    if unknown_ru:
        errors.append(
            f"unknown Russian section(s) {unknown_ru}; allowed: {sorted(known_ru)}"
        )

    for name, count in en.items():
        if count == 0:
            errors.append(f"'{name}' has no bullets - omit the section entirely")
    for name, count in ru.items():
        if count == 0:
            errors.append(f"'{name}' пустой - убери секцию целиком")

    # The rule that actually catches half-done translations: same sections, same
    # bullet counts. A missing Russian bullet is invisible to a Russian reader
    # in exactly the way a missing translation always is.
    for en_name in en:
        ru_name = EN_TO_RU.get(en_name)
        if ru_name is None:
            continue
        if ru_name not in ru:
            errors.append(f"'{en_name}' has no Russian counterpart '{ru_name}'")
        elif ru[ru_name] != en[en_name]:
            errors.append(
                f"'{en_name}' has {en[en_name]} bullet(s) but '{ru_name}' has "
                f"{ru[ru_name]} - translation must be 1:1"
            )
    for ru_name in ru:
        if ru_name not in {EN_TO_RU[e] for e in en if e in EN_TO_RU}:
            errors.append(f"'{ru_name}' has no English counterpart")

    if not en:
        errors.append("no sections at all - the release describes nothing")

    # Branding check ignores links: github.com/<org>/... is an address.
    prose = re.sub(r"https?://\S+", "", text).lower()
    for word in FORBIDDEN:
        if word in prose:
            errors.append(f"remove the product name '{word}' from the notes body")

    if re.search(r"\bTODO\b|<описание>|<description>", text):
        errors.append("scaffold placeholders are still in the file")

    return errors


def build_body(tag: str, text: str) -> str:
    """The final release body: the authored notes plus the compare link."""
    body = text.strip()
    body = re.sub(r"\n*\*\*Full Changelog\*\*.*$", "", body).rstrip()
    prev = previous_tag(tag)
    slug = repo_slug()
    link = (
        f"https://github.com/{slug}/compare/{prev}...{tag}"
        if prev
        else f"https://github.com/{slug}/commits/{tag}"
    )
    return f"{body}\n\n**Full Changelog**: {link}\n"


def scaffold(tag: str) -> Path:
    path = NOTES_DIR / f"{tag}.md"
    if path.exists():
        print(f"{path.relative_to(ROOT)} already exists - editing that instead")
        return path

    prev = previous_tag(tag)
    rng = f"{prev}..HEAD" if prev else "HEAD"
    commits = [
        c for c in _git("log", "--no-merges", "--pretty=format:%s", rng).splitlines()
        if c.strip()
    ]

    listing = "\n".join(f"#   {c}" for c in commits) or "#   (no commits found)"
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"""<!--
# Commits since {prev or 'the beginning'} - group these into the sections below,
# one bullet per logical change, then delete this comment.
{listing}
#
# Rules: start each bullet with a verb (Add/Fix/Remove/Update/Improve). Omit any
# section with nothing in it - in BOTH languages. Keep identifiers, env vars and
# paths untranslated. Every English bullet needs exactly one Russian bullet.
-->

{EN_TITLE}
### New Features
- Add something

{RU_TITLE}
### Новые возможности
- Добавить что-то
""",
        encoding="utf-8",
    )
    return path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("tag", help="release tag, e.g. v1.2.0")
    ap.add_argument("--scaffold", action="store_true",
                    help="create the notes file from the commit range")
    ap.add_argument("--check", action="store_true",
                    help="validate only; print nothing on success")
    args = ap.parse_args()

    if not re.fullmatch(r"v\d+\.\d+\.\d+", args.tag):
        print(f"::error::tag {args.tag!r} is not vMAJOR.MINOR.PATCH", file=sys.stderr)
        return 2

    if args.scaffold:
        path = scaffold(args.tag)
        print(f"wrote {path.relative_to(ROOT)} - fill it in, both languages")
        return 0

    path = NOTES_DIR / f"{args.tag}.md"
    if not path.is_file():
        print(
            f"::error::{path.relative_to(ROOT)} does not exist. Release notes are "
            f"written, not generated. Run:\n"
            f"    python3 tools/release_notes.py {args.tag} --scaffold",
            file=sys.stderr,
        )
        return 1

    text = path.read_text(encoding="utf-8")
    errors = validate(args.tag, text)
    if errors:
        print(f"::error::{path.relative_to(ROOT)} is not a valid bilingual release "
              f"note:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    if args.check:
        print(f"{path.relative_to(ROOT)}: bilingual structure OK", file=sys.stderr)
        return 0

    print(build_body(args.tag, text), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
