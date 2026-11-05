#!/usr/bin/env bash
# Prints one identity build setting as a Release build resolves it: the overlay
# (Config/Envisioning/Identity.xcconfig) when it exists, then the public default
# (Config/Starlings.xcconfig). Prints nothing when neither sets a value.
#
#   ./scripts/identity-setting.sh DEVELOPMENT_TEAM
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
key="${1:?usage: identity-setting.sh <BUILD_SETTING>}"

for file in Config/Envisioning/Identity.xcconfig Config/Starlings.xcconfig; do
  [[ -f "$ROOT/$file" ]] || continue
  for name in "$key[config=Release]" "$key"; do
    if line="$(awk -v name="$name =" 'index($0, name) == 1 { print; found = 1; exit } END { exit !found }' "$ROOT/$file")"; then
      value="${line#"$name ="}"
      value="${value# }"
      printf '%s\n' "${value//\$()/}"
      exit 0
    fi
  done
done
