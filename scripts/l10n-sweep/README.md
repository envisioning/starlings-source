# l10n sweep scripts

One-shot rewriters that routed the existing string literals through the
catalog (steps 2 and 3). Heuristic, not a parser: they wrap a
literal when it starts uppercase or contains a space, and skip symbol
names, keys, paths, format-only strings and wire values. Every run needs a
compile and a read of the diff afterwards; CRM status words and diagnostic
log lines were the things they got wrong.

Each takes `--write` and a list of files; without `--write` it reports.

| Script | Rewrites |
| --- | --- |
| `swift-literals.py` | AppKit labels, `title:`, `.stringValue =`, `NSAlert`, `operation:`, accessibility → `String(localized:)` |
| `swift-returns.py` | `case .x: "Title"` arms and `return "Sentence"` → `String(localized:)` |
| `web-jsx.py` | JSX text nodes and `title=`/`placeholder=`/`aria-label=` props, `fallbackError:` and friends → `t()` |
| `web-templates.py` | `` `Hosted by ${x}` `` → `t('Hosted by {x}', { x })`; leaves nested quotes to a person |
| `web-quoted.py` | remaining bare `'Sentence'` literals → `t()` |

`swift-literals.py`, `swift-returns.py` and `web-jsx.py` also expose
`wrap_line()`: `scripts/check-l10n-literals.py` imports it to find the same
literals in the whole tree and fail on new ones. Change a
heuristic here and the check changes with it; rerun the check with
`--write` if the baseline moves.

What is left to sweep is the baseline, `scripts/l10n-literal-baseline.json`,
grouped by issue. After a sweep: build, run
`scripts/sync-string-catalog.py`, translate, commit the catalog.
