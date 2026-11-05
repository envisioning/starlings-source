#!/usr/bin/env bash
# Print the CHANGELOG.md section for a version, or fail if it has none.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHANGELOG="$ROOT/CHANGELOG.md"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  # shellcheck source=version-env.sh
  source "$ROOT/scripts/version-env.sh"
  VERSION="$MEET_VERSION"
fi

[[ -f "$CHANGELOG" ]] || { echo "error: missing $CHANGELOG" >&2; exit 1; }

SECTION="$(awk -v want="$VERSION" '
  /^## / {
    if (found) exit
    line = $0
    sub(/^## /, "", line)
    split(line, parts, / /)
    if (parts[1] == want) { found = 1; next }
    next
  }
  found { print }
' "$CHANGELOG")"

SECTION="$(printf '%s\n' "$SECTION" | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')"

if [[ -z "$SECTION" ]]; then
  echo "error: no CHANGELOG.md section for $VERSION" >&2
  exit 1
fi

printf '%s\n' "$SECTION"
