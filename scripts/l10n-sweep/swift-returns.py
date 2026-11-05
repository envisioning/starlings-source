import re, sys, glob, collections

WRITE = "--write" in sys.argv
files = [a for a in sys.argv[1:] if not a.startswith("--")]
ARM = re.compile(r'^(?P<pre>\s*(?:case [^:\n]+|default):\s*)"(?P<lit>(?:[^"\\]|\\.)*)"\s*$')
RET = re.compile(r'^(?P<pre>\s*return )"(?P<lit>(?:[^"\\]|\\.)*)"\s*$')
def prose(t):
    if not re.search(r'[A-Za-z]', t): return False
    if re.match(r'^[A-Z0-9_]+$', t): return False           # GET, UTF8, ALLCAPS codes
    if re.match(r'^[a-z0-9_.\-/:]+$', t): return False       # keys, symbols
    if re.match(r'^[A-Za-z]+\.[a-z]', t): return False        # dotted identifier
    if re.match(r"^%", t) or "/" in t: return False
    return t[0].isupper() or " " in t
def wrap_line(line):
    """The line with a prose `case` arm or `return` literal wrapped, and the literal."""
    if "String(localized" in line or "//" in line:
        return line, []
    for rx in (ARM, RET):
        m = rx.match(line)
        if m and prose(m.group("lit")):
            return f'{m.group("pre")}String(localized: "{m.group("lit")}")', [m.group("lit")]
    return line, []

def main():
    n = collections.Counter(); samples = []
    for path in files:
        src = open(path, encoding="utf-8").read(); out = []; changed = False
        for line in src.split("\n"):
            new, found = wrap_line(line)
            for lit in found:
                n[path] += 1
                if len(samples) < 400: samples.append(lit[:50])
            if new != line: changed = True
            out.append(new)
        if changed and WRITE: open(path, "w", encoding="utf-8").write("\n".join(out))
    print(("wrote " if WRITE else "would wrap ") + str(sum(n.values())))
    import random; random.seed(1); print(sorted(set(random.sample(samples, min(60, len(samples))))))

if __name__ == "__main__":
    main()
