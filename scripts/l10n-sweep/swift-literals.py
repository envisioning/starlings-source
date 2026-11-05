#!/usr/bin/env python3
"""Wrap AppKit-facing string literals in String(localized:) — one pass, Sources/ only.

Usage: sweep.py [--write] [files...]
"""
import re, sys, os, glob, collections

WRITE = "--write" in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith("--")]
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
files = args or sorted(glob.glob(f"{ROOT}/Sources/*.swift"))
# scripts/check-l10n-literals.py imports wrap_line() to find the same literals.

LIT = r'(?=")'  # the literal itself is read by scan_literal

# (regex with a named group `pre` before the literal, note)
PATTERNS = [
    # argument labels
    r'(?P<pre>\b(?:title|detail|footer|header|placeholder|message|operation|subtitle|caption|informative|prompt|labelWithString|wrappingLabelWithString|withTitle|toolTip|placeholderString|messageText|informativeText|help|hint|emptyText|emptyTitle|emptyMessage|buttonTitle|actionTitle|secondaryTitle|primaryTitle|confirmTitle|cancelTitle|headline|explanation|footnote|note|summary|status|statusText|helpText|accessibilityLabel|accessibilityHelp|accessibilityValue):\s*)' + LIT,
    # property assignments
    r'(?P<pre>\.(?:stringValue|title|toolTip|placeholderString|messageText|informativeText|placeholderAttributedString|alternateTitle|label|text|subtitle|prompt|helpText)\s*=\s*)' + LIT,
    # calls whose first positional argument is the text
    r'(?P<pre>\b(?:presentAlert|setAccessibilityLabel|setAccessibilityHelp|setAccessibilityValue|setAccessibilityTitle|StarlingsToast\.show|showToast|toast|announce|setStatus|setMessage|setHint|setStartTitle|setTitle|setSubtitle|setLabel|setPlaceholder|setDetail|setEmpty|setFooter|setHeader|setCaption)\(\s*)' + LIT,
    # `var startTitle = "Start room"`, `let emptyLabel = "…"`: a stored title
    r'(?P<pre>\b(?:var|let)\s+\w*(?:[tT]itle|[lL]abel|[mM]essage|[dD]etail|[pP]laceholder|[cC]aption|[sS]ubtitle|[hH]int|[fF]ooter|[hH]eader|[nN]otice|[tT]ext)\w*\s*(?::\s*String)?\s*=\s*)' + LIT,
    # any call whose first positional argument is the text — actionItem("…"),
    # EnvisioningRetryState("…"), statusLabel.showError("…"), parts.append("…") —
    # except calls that take data, log, or are SwiftUI views that localize on
    # their own (the deny list; `notice` is denied because `log.notice` is the
    # common one — the UI `notice(` helper is handled by name below)
    r'(?P<pre>(?<![\w.])(?![\w.]*\b(?:NSLog|print|debugPrint|run|push|setValue|Guide|Logger|URL|Data|Set|Array|Character|Locale|TimeZone|Calendar|DateFormatter|NSRegularExpression|Regex|Notification|NSNotification|Selector|NSSound|NSImage|UIImage|Image|Color|NSColor|Font|NSFont|UserDefaults|FileManager|Bundle|JSONDecoder|JSONEncoder|String|Substring|NSAttributedString|AttributedString|contains|hasPrefix|hasSuffix|split|components|replacingOccurrences|range|firstIndex|index|starts|joined|trimmingCharacters|padding|matches|encode|decode|XCTAssert\w*|XCTFail|precondition|preconditionFailure|assert|assertionFailure|fatalError|separator|Date|DateComponents|NSPredicate|CFPreferencesCopyValue|exit|write|record|log|track|measure|signpost|os_log|lookup|CGSize|CGPoint|CGRect|Task|DispatchQueue|Timer|require|Symbol|symbol|icon|Icon|glyph|Glyph|appendingPathComponent|dropFirst|dropLast|setLocalizedDateFormatFromTemplate|configuredValue|NSClassFromString|invalidIdentity|operationFailed|systemCall|withID|component|line|flag|Text|Label|Button|Toggle|Section|Picker|Menu|TextField|SecureField|DatePicker|Link|Tab|ContentUnavailableView|LabeledContent|ProgressView|navigationTitle|navigationSubtitle|accessibilityHint|accessibilityLabel|accessibilityValue|alert|confirmationDialog|init|help|badge|searchable|Stepper|NavigationLink|DisclosureGroup|GroupBox|ShareLink|error|info|notice|warning|debug|fault)\()(?!lines\.append\(|report\.|log\.|logger\.|StarlingsCLI)[A-Za-z_][\w.]*\(\s*)' + LIT,
    r'(?P<pre>(?<![\w.])notice\(\s*)' + LIT,
    r'(?P<pre>\bsetSecondaryButtonTitle\([\w.]+,\s*)' + LIT,
    # `? "Join room" : "Start room"` — both arms of a ternary
    r'(?P<pre>(?<=\s)\?\s+)' + LIT,
    r'(?P<pre>(?<=\s)\?\s+(?:String\(localized: )?"(?:[^"\\]|\\.)*"\)?\s+:\s+)' + LIT,
]
REGEXES = [re.compile(p) for p in PATTERNS]

SKIP_LINE = re.compile(r'String\(localized:|NSLocalizedString|^\s*//|^\s*case .* = "|forKey:|UserDefaults|Notification\.Name|URL\(|URLQueryItem|https?:|Spike')
FORMAT_ONLY = re.compile(r'^(\s|%[-+ 0#]*\d*(\.\d+)?(ll|l|h)?[@dfsux]|[^\w]|\\\(.*\))*$')


def scan_literal(line: str, start: int):
    """Return the end index (exclusive) of the string literal opening at `start`, or None."""
    if line.startswith('"""', start):
        return None
    i = start + 1
    depth = 0
    while i < len(line):
        c = line[i]
        if depth == 0:
            if c == '\\':
                if line.startswith('\\(', i):
                    depth = 1; i += 2; continue
                i += 2; continue
            if c == '"':
                return i + 1
            i += 1
        else:
            if c == '"':
                end = scan_literal(line, i)
                if end is None: return None
                i = end; continue
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
            i += 1
    return None


def is_prose(text: str) -> bool:
    if not text or FORMAT_ONLY.match(text):
        return False
    if re.match(r'^[a-z0-9_.\-/:]+$', text):  # symbol name, key, path
        return False
    if "\\(" not in text and re.match(r'^[A-Za-z]+\.[a-z]', text):  # dotted identifier
        return False
    if "_" in text and text == text.lower():  # `select_account consent`: a wire value with a space
        return False
    if re.match(r'^[A-Z0-9_]{1,6}$', text):  # POST, DELETE, YES, TZ: a code, not a word
        return False
    return text[0].isupper() or " " in text or text[0] in "…—–•·" or text.startswith("\\(")


def wrap_line(line: str):
    """The line with its prose literals wrapped, and the literals it wrapped."""
    found = []
    new = line
    if SKIP_LINE.search(line):
        return new, found
    for rx in REGEXES:
        pos = 0
        while True:
            m = rx.search(new, pos)
            if not m: break
            q = m.end()
            end = scan_literal(new, q)
            if end is None:
                pos = q + 1; continue
            lit = new[q:end]
            inner = lit[1:-1]
            if not is_prose(inner):
                pos = end; continue
            found.append((m.group("pre").strip(), inner))
            wrapped = f'String(localized: {lit})'
            new = new[:q] + wrapped + new[end:]
            pos = q + len(wrapped)
    return new, found


def main():
    stats = collections.Counter()
    samples = collections.defaultdict(list)
    for path in files:
        src = open(path, encoding="utf-8").read()
        out_lines = []
        changed = False
        for line in src.split("\n"):
            new, found = wrap_line(line)
            for key, inner in found:
                stats[os.path.basename(path)] += 1
                if len(samples[key]) < 3: samples[key].append(inner[:60])
            if new != line:
                changed = True
            out_lines.append(new)
        if changed and WRITE:
            open(path, "w", encoding="utf-8").write("\n".join(out_lines))

    total = sum(stats.values())
    print(f"{'wrote' if WRITE else 'would wrap'} {total} literals in {len(stats)} files")
    for k, v in sorted(samples.items()):
        print(f"  {k:32s} {v}")


if __name__ == "__main__":
    main()
