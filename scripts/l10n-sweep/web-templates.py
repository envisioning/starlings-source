#!/usr/bin/env python3
"""`Hosted by ${event.host}` -> t('Hosted by {host}', { host: event.host }). Usage: tplsweep.py [--write] files..."""
import re, sys, os, collections

WRITE = "--write" in sys.argv
files = [a for a in sys.argv[1:] if not a.startswith("--")]
stats = collections.Counter(); left = []


def scan_template(line, start):
    """end index (exclusive) of the template literal opening at start, or None if nested/quoted."""
    i = start + 1
    while i < len(line):
        c = line[i]
        if c == "\\":
            i += 2; continue
        if c == "`":
            return i + 1
        if line.startswith("${", i):
            depth = 1; i += 2
            while i < len(line) and depth:
                if line[i] in "'\"`":
                    return None  # a quote inside an expression: leave to a person
                if line[i] == "{": depth += 1
                elif line[i] == "}": depth -= 1
                i += 1
            continue
        i += 1
    return None


def placeholder_name(expr, used):
    m = re.findall(r"[A-Za-z_]\w*", expr)
    base = m[-1] if m else "value"
    if base in ("length", "size", "trim", "toUpperCase", "toLowerCase") and len(m) > 1:
        base = m[-2] if m[-2] not in ("length",) else m[-3] if len(m) > 2 else base
    name = base; n = 2
    while name in used:
        name = f"{base}{n}"; n += 1
    return name


def convert(body):
    parts = []; vars_ = []; used = set(); i = 0; text = ""
    while i < len(body):
        if body.startswith("${", i):
            depth = 1; j = i + 2
            while depth:
                if body[j] == "{": depth += 1
                elif body[j] == "}": depth -= 1
                j += 1
            expr = body[i + 2:j - 1].strip()
            name = placeholder_name(expr, used); used.add(name)
            vars_.append((name, expr)); text += "{" + name + "}"; i = j
        else:
            text += body[i]; i += 1
    return text, vars_


def is_prose(text):
    plain = re.sub(r"\{\w+\}", "", text)
    return bool(re.search(r"[A-Za-z]{2,}", plain)) and (" " in plain.strip() or plain.strip()[:1].isupper())


for path in files:
    src = open(path, encoding="utf-8").read(); out = []
    for ln, line in enumerate(src.split("\n"), 1):
        new = line; pos = 0
        if line.lstrip().startswith(("//", "*")) or "className" in line or "Bearer" in line or "`##" in line or "http" in line:
            out.append(new); continue
        while True:
            k = new.find("`", pos)
            if k < 0: break
            end = scan_template(new, k)
            if end is None:
                left.append(f"{path}:{ln}: {line.strip()[:120]}"); break
            body = new[k + 1:end - 1]
            if "${" not in body or "\n" in body:
                pos = end; continue
            text, vars_ = convert(body)
            if not is_prose(text) or "'" in text and '"' in text:
                pos = end; continue
            q = '"' if "'" in text else "'"
            args = ", ".join(f"{n}: {e}" if not re.fullmatch(r"[A-Za-z_]\w*", e) or n != e else n for n, e in vars_)
            rep = f"t({q}{text}{q}, {{ {args} }})"
            new = new[:k] + rep + new[end:]; pos = k + len(rep); stats[os.path.basename(path)] += 1
        out.append(new)
    result = "\n".join(out)
    if result != src and WRITE:
        if "from './i18n'" not in result:
            lines = result.split("\n")
            last = max((i for i, l in enumerate(lines) if l.startswith("import ")), default=-1)
            while last >= 0 and last + 1 < len(lines) and not (lines[last].rstrip().endswith(";") or lines[last].rstrip().endswith("'")):
                last += 1
            lines.insert(last + 1, "import { t } from './i18n';"); result = "\n".join(lines)
        open(path, "w", encoding="utf-8").write(result)

print(f"{'wrote' if WRITE else 'would convert'} {sum(stats.values())} template literals in {len(stats)} files")
print("left for a person:"); print("\n".join(left))
