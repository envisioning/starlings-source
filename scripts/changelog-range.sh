#!/usr/bin/env bash
# Print every CHANGELOG.md section from $TO down to, but excluding, $FROM.
#
# Releases are batched — a release ships whatever
# VERSION main holds by then, so one release routinely carries several bumps.
# Printing only the top section would ship the rest undocumented, and the notes
# would reference versions nobody ever received ("0.6.1 got them flying but
# drew an empty pill"). A range keeps the notes honest about everything the
# binary actually contains.
#
#   changelog-range.sh 0.6.2 0.5.0   # 0.6.2, 0.6.1 and 0.6.0
#   changelog-range.sh 0.6.2         # everything down to the oldest section
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHANGELOG="$ROOT/CHANGELOG.md"

TO="${1:-}"
FROM="${2:-}"

if [[ -z "$TO" ]]; then
  # shellcheck source=version-env.sh
  source "$ROOT/scripts/version-env.sh"
  TO="$MEET_VERSION"
fi

[[ -f "$CHANGELOG" ]] || { echo "error: missing $CHANGELOG" >&2; exit 1; }

# CHANGELOG is newest-first, so the range is a straight walk: start printing at
# the `## $TO` heading, stop when `## $FROM` shows up. Headings are kept — with
# several versions in one release the reader needs to see where each begins.
SECTION="$(awk -v to="$TO" -v from="$FROM" '
  /^## / {
    line = $0
    sub(/^## /, "", line)
    split(line, parts, / /)
    if (parts[1] == to) { found = 1; print; next }
    if (found && from != "" && parts[1] == from) { exit }
    if (found) { print; next }
    next
  }
  found { print }
' "$CHANGELOG")"

# One version in the range reads better without its own heading — that is what
# `changelog-section.sh` has always emitted, and it is what the update feed and
# the release notes carried before releases were batched. Keep headings only
# when there is more than one version to tell apart.
if [[ "$(grep -c '^## ' <<<"$SECTION")" -le 1 ]]; then
  SECTION="$(sed -e '1{/^## /d;}' <<<"$SECTION")"
fi

# Trim leading and trailing blank lines.
SECTION="$(printf '%s\n' "$SECTION" | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')"

if [[ -z "$SECTION" ]]; then
  echo "error: no CHANGELOG.md section for $TO" >&2
  exit 1
fi

printf '%s\n' "$SECTION"
