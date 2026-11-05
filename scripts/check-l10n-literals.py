#!/usr/bin/env python3
"""No new English a person reads that skips the string tables (meet#799, meet#245).

The two `--translated pt-BR` gates see only keys: a literal that never went
through `t()` or `String(localized:)` is not a key, so they pass while it
ships in English. This check finds those literals with the same heuristics
the one-shot sweeps used (scripts/l10n-sweep/), and the hand-made plurals
that render wrong Portuguese ("tarefa abertas"):

    `n == 1 ? "" : "s"`, `n === 1 ? 'person' : 'people'`

It fails on a hit that is not in scripts/l10n-literal-baseline.json.

    scripts/check-l10n-literals.py           # check (part of verify:fast)
    scripts/check-l10n-literals.py --write   # rewrite the baseline from the tree

The baseline is the tree on 2026-10-04. Each entry names the issue that
removes it (meet#801 site, meet#804 web app, meet#805 Apple), `english`
for a literal that stays English on purpose (a brand, a sample name, an
admin readout, an error), or `code` where the heuristic matched code. --write
keeps those notes, drops entries that are gone, and adds new ones with
`issue: null`; the check fails on a null. Never add an entry to get past the
check: wrap the string, or use plural() / a catalog plural.

Entries are keyed by file, kind and text, with a count, not by line, so an
edit above a literal does not move it.
"""
import collections
import importlib.util
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASELINE = os.path.join(ROOT, "scripts", "l10n-literal-baseline.json")

SWIFT_DIRS = ["Sources", "iOS", "iOSActivities", "iOSShare", "watchOS", "watchOSWidgets"]
# The product site is English only (docs/LOCALIZATION.md § The product site).
WEB_DIRS = ["web/src"]
SKIP = re.compile(r"(^|/)(Generated|node_modules|dist|build|i18n)(/|$)|\.test\.|test-setup|vite-env|\.d\.ts$")


def load(name):
    path = os.path.join(ROOT, "scripts", "l10n-sweep", name)
    spec = importlib.util.spec_from_file_location(name.replace("-", "_")[:-3], path)
    module = importlib.util.module_from_spec(spec)
    saved = sys.argv
    sys.argv = [path]  # the sweeps read their own argv at import
    try:
        spec.loader.exec_module(module)
    finally:
        sys.argv = saved
    return module


SWIFT_LITERALS = load("swift-literals.py")
SWIFT_RETURNS = load("swift-returns.py")
WEB_JSX = load("web-jsx.py")

# `== 1 ? "" : "s"`, `!== 1 ? 'people' : 'person'`, `=== 1 ? t('Room') : t('Rooms')`:
# two short arms, one the plural of the other.
ARM = r"""(?:t\(\s*)?(?P<q{n}>["'])(?P<{name}>[A-Za-z]{{0,12}})(?P=q{n})\)?"""
PLURAL = re.compile(r"(?P<op>[!=]==?)\s*1\s*\?\s*" + ARM.format(n=1, name="a") + r"\s*:\s*" + ARM.format(n=2, name="b"))
# `=== 1 ? '1 job' : …`, `== 1 ? t('1 step') : …`: the singular written out.
SPELLED = re.compile(r"""[!=]==?\s*1\s*\?\s*(?:t\(\s*)?["'`]1 [A-Za-z][^"'`]*""")
IRREGULAR = {("person", "people"), ("child", "children")}


def plural_pair(singular, plural):
    if (singular, plural) in IRREGULAR:
        return True
    if singular == "" and plural in ("s", "es"):
        return True
    if singular and plural in (singular + "s", singular + "es"):
        return True
    return singular.endswith("y") and plural == singular[:-1] + "ies"


def plural_hits(line):
    for m in PLURAL.finditer(line):
        a, b = m.group("a").lower(), m.group("b").lower()
        one, other = (a, b) if m.group("op").startswith("=") else (b, a)
        if plural_pair(one, other):
            yield m.group(0)
    for m in SPELLED.finditer(line):
        yield m.group(0)


def files():
    for top, ext in [(d, ".swift") for d in SWIFT_DIRS] + [(d, (".ts", ".tsx")) for d in WEB_DIRS]:
        for dirpath, dirnames, names in os.walk(os.path.join(ROOT, top)):
            dirnames[:] = sorted(d for d in dirnames if not SKIP.search(d + "/"))
            for name in sorted(names):
                rel = os.path.relpath(os.path.join(dirpath, name), ROOT)
                if name.endswith(ext) and not SKIP.search(rel):
                    yield rel


def find():
    """Every hit as (file, kind, text, line number)."""
    hits = []
    for rel in files():
        swift = rel.endswith(".swift")
        with open(os.path.join(ROOT, rel), encoding="utf-8") as handle:
            lines = handle.read().split("\n")
        for number, line in enumerate(lines, 1):
            if swift:
                found = [("swift", text) for _, text in SWIFT_LITERALS.wrap_line(line)[1]]
                found += [("swift", text) for text in SWIFT_RETURNS.wrap_line(line)[1]]
            else:
                found = [("web", text) for _, text in WEB_JSX.wrap_line(line, rel)[1]]
            found += [("plural", text) for text in plural_hits(line)]
            hits += [(rel, kind, text, number) for kind, text in found]
    return hits


def main():
    write = "--write" in sys.argv
    hits = find()
    counts = collections.Counter((rel, kind, text) for rel, kind, text, _ in hits)
    with open(BASELINE, encoding="utf-8") as handle:
        baseline = json.load(handle)
    known = {(e["file"], e["kind"], e["text"]): e for e in baseline["entries"]}

    if write:
        entries = []
        for (rel, kind, text), count in sorted(counts.items()):
            entry = dict(known.get((rel, kind, text), {"file": rel, "kind": kind, "text": text, "issue": None}))
            entry["count"] = count
            entries.append(entry)
        baseline["entries"] = entries
        with open(BASELINE, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(baseline, indent=2, ensure_ascii=False) + "\n")
        print(f"check-l10n-literals: {len(entries)} entries, {sum(e['issue'] is None for e in entries)} need an issue")
        return 0

    fresh = []
    for (rel, kind, text), count in counts.items():
        allowed = known.get((rel, kind, text), {}).get("count", 0)
        if count > allowed:
            lines = [n for r, k, t, n in hits if (r, k, t) == (rel, kind, text)]
            fresh.append((rel, lines, kind, text))
    unexplained = [e for e in baseline["entries"] if e["issue"] is None]
    shrunk = sum(1 for key, e in known.items() if counts.get(key, 0) < e["count"])
    if shrunk:
        print(f"check-l10n-literals: {shrunk} baseline entries shrank. Run scripts/check-l10n-literals.py --write to lock that in.", file=sys.stderr)
    if not fresh and not unexplained:
        return 0
    print("check-l10n-literals: English a person reads that skips the string tables (docs/LOCALIZATION.md).", file=sys.stderr)
    for rel, lines, kind, text in sorted(fresh):
        fix = "use plural() on the web, a catalog plural on Apple" if kind == "plural" else (
            "wrap it in String(localized:)" if kind == "swift" else "wrap it in t()")
        print(f"  {rel}:{','.join(map(str, lines))}: {text!r}: {fix}", file=sys.stderr)
    for e in unexplained:
        print(f"  baseline entry with no issue: {e['file']}: {e['text']!r}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
