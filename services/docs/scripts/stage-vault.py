#!/usr/bin/env python3
"""Stage an Obsidian vault for `docsctl import`, with the frontmatter contract.

The vault stays untouched. This writes a copy under STAGING with, on every
file, the five keys meet/docs/DOCS.md §Knowledge model asks for:

    date:    from the filename (YYYY-MM-DD prefix), else the file's own
             `date` / `updated` frontmatter, else its modification time
    status:  dated  (nothing in a mirror governs; promote by hand)
    owner:   mz
    source:  vault:<relative path>
    tags:    the file's own tags plus the top folder, lower-cased

Folders that are not documents are skipped — agent skills, repo notes,
specs, the site mirror, Slack digests, and meeting notes (Granola lives
elsewhere; meetings are Meet's). Then:

    docsctl import STAGING --prefix /vault      # hash-based, repeatable

Usage: stage-vault.py ~/Vaults/Envisioning /tmp/vault-staging [--dry-run]
"""
from __future__ import annotations

import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# Not documents: agent skills, repo notes, specs, the site mirror, scratch.
# Then the folders that are curated natively instead — a document lives in one
# place, and a promoted document is not also a mirror row. `Clients` is here
# because its meetings are already Meet's, under /work/meetings, and its few
# real documents are curated under /work/<org>. `Research*` mz decided not to
# bring over at all.
SKIP_DIRS = {
    ".obsidian", "Skills", "Dev", "signals-playbooks-v2", "Website", "__Unorganized", "Clippings", "Patterns",
    "Research", "Research-Hubs", "research-outbound",
    "Research-Methodology",  # curated at /method
    "Vibe Coding",           # curated at /vibe-coding
    "Style Guides",          # curated at /house
    "Clients",               # /work/meetings and /work/<org>
}

# Individually promoted out of a folder that is otherwise mirrored.
SKIP_FILES = {
    "Strategy/2026-03-30-beyond-radars.md",
    "Strategy/2026-04-02-Competitor-Strategy.md",
    "Strategy/Marketing Plan.md",
    "Strategy/Competitors/Business-Model-Pricing.md",
    "Strategy/Hebbia Matrix vs. Signals - Battlecard.md",
    "Strategy/2026-03-30-envisioning-north-star.md",
    "Strategy/envisioning-strategy-2026-03-16.md",   # curated at /strategy
    "Operations/envisioning-partnerships.md",        # curated at /playbooks
}
SKIP_ANYWHERE = {"node_modules", ".git", "dist", "build", ".next", ".venv", "__pycache__"}

SKIP_FILE = re.compile(r"(_Slack-Digest-|\.DS_Store$|sync-(smoke-)?test-\d+|-sync-test-\d+|agent-mirror-proof-\d+)")
# A Granola note: `YYYY-MM-DD_Title.md` under Clients/ or Projects/ or Operations/.
MEETING_NOTE = re.compile(r"^\d{4}-\d{2}-\d{2}_")
MEETING_DIRS = {"Clients", "Projects", "Operations", "Vibe Coding"}
DATE_IN_NAME = re.compile(r"(\d{4}-\d{2}-\d{2})")
FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.S)


def split(text: str) -> tuple[dict[str, str], list[str], str]:
    """Return (scalar keys, tag list, body). Minimal YAML: `k: v` and `tags: [a, b]` / `- a` lists."""
    m = FRONTMATTER.match(text)
    if not m:
        return {}, [], text
    keys: dict[str, str] = {}
    tags: list[str] = []
    in_tags = False
    for line in m.group(1).splitlines():
        if in_tags and line.startswith("  - "):
            tags.append(line[4:].strip().strip("\"'"))
            continue
        in_tags = False
        if ":" not in line or line.startswith(" "):
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if k in ("tags", "tag"):
            if v.startswith("["):
                tags += [t.strip().strip("\"'") for t in v.strip("[]").split(",") if t.strip()]
            elif v:
                tags += [t for t in re.split(r"[,\s]+", v) if t]
            else:
                in_tags = True
        elif v:
            keys[k] = v.strip("\"'")
    return keys, tags, text[m.end():]


def yaml_str(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def stage(vault: Path, out: Path, dry: bool) -> None:
    count = skipped = 0
    for path in sorted(vault.rglob("*.md")):
        rel = path.relative_to(vault)
        top = rel.parts[0]
        # A checked-out project inside the vault is code, not notes. Its
        # dependencies carry thousands of READMEs nobody filed.
        if SKIP_ANYWHERE.intersection(rel.parts):
            skipped += 1
            continue
        if top in SKIP_DIRS or SKIP_FILE.search(path.name) or str(rel) in SKIP_FILES:
            skipped += 1
            continue
        if top in MEETING_DIRS and MEETING_NOTE.match(path.name):
            skipped += 1
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        keys, tags, body = split(text)

        date = None
        for candidate in (path.name, keys.get("date", ""), keys.get("updated", ""), keys.get("extracted", "")):
            found = DATE_IN_NAME.search(candidate)
            if found:
                date = found.group(1)
                break
        if not date:
            date = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%d")

        folder_tag = re.sub(r"[^a-z0-9]+", "-", top.lower()).strip("-")
        all_tags = []
        for t in tags + [folder_tag]:
            t = re.sub(r"[^a-z0-9:/_-]+", "-", t.lower()).strip("-")
            if t and t not in all_tags:
                all_tags.append(t)

        lines = ["---"]
        heading = re.search(r"^# +(.+?)\s*$", body, re.M)
        title = keys.get("title") or (heading.group(1).strip() if heading else path.stem)
        lines.append(f"title: {yaml_str(title)}")
        lines.append(f"date: {date}")
        lines.append("status: dated")
        lines.append("owner: mz")
        lines.append(f"source: {yaml_str('vault:' + str(rel))}")
        for k, v in keys.items():
            if k in ("title", "date", "status", "owner", "source", "tags", "tag"):
                continue
            lines.append(f"{k}: {yaml_str(v)}")
        lines.append("tags: [" + ", ".join(all_tags) + "]")
        lines.append("---")
        staged = "\n".join(lines) + "\n" + body.lstrip("\n")

        target = out / rel
        if dry:
            print(f"{rel}  date={date} tags={all_tags}")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(staged, encoding="utf-8")
        count += 1
    print(f"staged {count} documents, skipped {skipped}", file=sys.stderr)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        sys.exit(2)
    vault, out = Path(args[0]).expanduser(), Path(args[1]).expanduser()
    dry = "--dry-run" in sys.argv
    if not dry and out.exists():
        shutil.rmtree(out)
    stage(vault, out, dry)
