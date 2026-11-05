#!/usr/bin/env python3
"""Route web UI string literals through t(). Usage: websweep.py [--write] files..."""
import re, sys, os, collections

WRITE = "--write" in sys.argv
files = [a for a in sys.argv[1:] if not a.startswith("--")]

# 1. JSX text nodes: >text<  (no braces inside; tag before must not be code-like)
NODE = re.compile(r'(?P<open><(?P<tag>[A-Za-z][\w.]*)(?:\s[^<>]*?)?>)(?P<text>[^<>{}]*[A-Za-z]{2,}[^<>{}]*)(?=<)')
# text nodes that follow a closing tag or a brace expression: `}text<` / `</b> text<`
TAIL = re.compile(r'(?P<open>(?:</[\w.]+>|\}))(?P<text>[^<>{}]*[A-Za-z]{2,}[^<>{}]*)(?=<)')
NO_TEXT_TAGS = {"code", "kbd", "pre", "samp", "style", "script", "time"}
# 2. string props
PROP = re.compile(r'\b(?P<name>title|placeholder|aria-label|alt|aria-description|label|eyebrow|description|hint|caption|subtitle|detail|message|emptyText|emptyTitle|heading|summary|name)=(?P<q>")(?P<text>[^"\n]+)"')
# 3. single-quoted values after known keys inside object literals / calls
SQ = re.compile(r"\b(?P<name>fallbackError|message|label|title|placeholder|description|eyebrow|empty|hint|caption|subtitle|detail|text|prompt|heading|error|note|summary|body|explainer|tooltip|ariaLabel|aria|actionLabel|emptyMessage|emptyTitle|confirmLabel|cancelLabel|confirm|cancel)(?P<sep>\s*[:=]\s*)(?P<q>')(?P<text>(?:[^'\\\n]|\\.)*[A-Za-z]{2,}(?:[^'\\\n]|\\.)*)'")

def is_prose(text: str) -> bool:
    s = text.strip()
    if not s or not re.search(r"[A-Za-z]{2,}", s):
        return False
    if re.match(r"^[a-z0-9_.\-/:#@?&=%+]+$", s):  # identifiers, keys, paths, css classes
        return False
    if re.match(r"^[A-Z0-9_]+$", s) and " " not in s:  # CONST codes
        return False
    if s.startswith("http") or "://" in s or s.startswith("/"):
        return False
    if re.match(r"^[A-Za-z]+\.[a-z]", s):  # dotted identifier
        return False
    return s[0].isupper() or " " in s or s[0] in "…—–•·(\"'‘“"


def jsx_key(text: str) -> str:
    """A JS string literal for the key: single quotes unless the text has one."""
    if "'" not in text:
        return f"'{text}'"
    if '"' not in text:
        return f'"{text}"'
    return "'" + text.replace("'", "\\'") + "'"


def wrap_line(line: str, path: str):
    """The line with its prose literals routed through t(), and (kind, text) for each."""
    found = []
    stripped = line.lstrip()
    if stripped.startswith("//") or stripped.startswith("*") or "t('" in line or 't("' in line:
        return line, found

    def sq(m):
        text = m.group("text")
        if not is_prose(text) or m.group("name") in ("name",):
            return m.group(0)
        found.append(("sq:" + m.group("name"), text))
        return f"{m.group('name')}{m.group('sep')}t('{text}')"

    def prop(m):
        text = m.group("text")
        if not is_prose(text):
            return m.group(0)
        found.append(("prop:" + m.group("name"), text))
        return f"{m.group('name')}={{t({jsx_key(text)})}}"

    def node(m):
        text = m.group("text")
        tag = m.groupdict().get("tag")
        if tag and tag.lower() in NO_TEXT_TAGS:
            return m.group(0)
        lead = text[: len(text) - len(text.lstrip())]
        trail = text[len(text.rstrip()):]
        core = text.strip()
        if not is_prose(core):
            return m.group(0)
        found.append(("node", core))
        return f"{m.group('open')}{lead}{{t({jsx_key(core)})}}{trail}"

    new = SQ.sub(sq, line)
    if path.endswith(".tsx"):
        new = PROP.sub(prop, new)
        new = NODE.sub(node, new)  # tails are restructured by hand
    return new, found


def main():
    stats = collections.Counter(); samples = collections.defaultdict(list)
    for path in files:
        src = open(path, encoding="utf-8").read()
        out = []
        for line in src.split("\n"):
            new, found = wrap_line(line, path)
            for kind, text in found:
                stats[os.path.basename(path)] += 1
                if len(samples[kind]) < 4: samples[kind].append(text[:60])
            out.append(new)
        result = "\n".join(out)
        if result != src and WRITE:
            if "from './i18n'" not in result and 'from "./i18n"' not in result:
                # add the import after the last import line
                lines = result.split("\n")
                last = max((i for i, l in enumerate(lines) if l.startswith("import ")), default=-1)
                # multi-line import: advance to its closing line
                while last >= 0 and last + 1 < len(lines) and not (lines[last].rstrip().endswith(";") or lines[last].rstrip().endswith("'")):
                    last += 1
                lines.insert(last + 1, "import { t } from './i18n';")
                result = "\n".join(lines)
            open(path, "w", encoding="utf-8").write(result)

    print(f"{'wrote' if WRITE else 'would wrap'} {sum(stats.values())} in {len(stats)} files")
    for k, v in sorted(samples.items()):
        print(f"  {k:22s} {v}")


if __name__ == "__main__":
    main()
