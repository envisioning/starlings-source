#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

# A clock is user-facing by default in these trees. Machine timestamps and
# date-only labels are deliberately outside the scan; they do not become a
# loophole for a visible clock because the approved helpers are the only place
# where clock formatting is allowed.
swift_and_web="web/src Sources iOS iOSActivities iOSShare packages"
problems=0

require_contract() {
  file=$1
  label=$2
  pattern=$3
  if ! grep -Eq "$pattern" "$file" 2>/dev/null; then
    printf '%s\n%s\n' "$label" "$file" >&2
    problems=$((problems + 1))
  fi
}

# This is the one intentional use of Swift's `.shortened` spelling. The
# allowlist below is only safe while the file continues to pin its locales
# (en_GB or pt_BR by UI language, both 24-hour — step 5) and
# explicitly omit the meridiem marker. The Live Activity, the widgets and
# the watch read the same helper (see StarlingsGlance).
require_contract Sources/StarlingsDateFormatting.swift \
  'Native clock helper lost its English locale:' 'Locale\(identifier: "en_GB"\)'
require_contract Sources/StarlingsDateFormatting.swift \
  'Native clock helper lost its Portuguese locale:' 'Locale\(identifier: "pt_BR"\)'
require_contract Sources/StarlingsDateFormatting.swift \
  'Native clock helper lost its 24-hour component:' 'amPM: \.omitted'

report() {
  label=$1
  shift
  matches=$(find $swift_and_web \
    -type d -name '.*' -prune -o \
    -type f -exec grep -nE "$@" {} + 2>/dev/null || true)
  if [ -n "$matches" ]; then
    printf '%s\n%s\n' "$label" "$matches" >&2
    problems=$((problems + 1))
  fi
}

report 'Forbidden locale-default time formatter:' \
  -e 'toLocaleTimeString[[:space:]]*\(' \
  -e 'toLocaleString[[:space:]]*\(' \
  -e 'timeStyle[[:space:]]*=[[:space:]]*\.(short|medium|long|full)([[:space:]]|;|$)' \
  -e 'hour12[[:space:]]*:[[:space:]]*true' \
  -e 'hourCycle[[:space:]]*:[[:space:]]*.*h1[12]' \
  -e '(^|[^[:alpha:]])AM([^[:alpha:]]|$)' \
  -e '(^|[^[:alpha:]])PM([^[:alpha:]]|$)'

report 'Forbidden 12-hour date-format template or format string:' \
  -e 'setLocalizedDateFormatFromTemplate[[:space:]]*\([^)]*j' \
  -e 'dateFormat[[:space:]]*=[[:space:]]*.*h{1,2}:mm' \
  -e 'style[[:space:]]*:[[:space:]]*\.time'

# Native browser date/time controls render their clock in the user's locale,
# so they can display AM/PM even when the value is stored as `HH:MM`.
report 'Locale-rendered native clock input:' \
  -e 'datetime-local' \
  -e 'type[[:space:]]*=[[:space:]]*[^[:space:]]*time'

# `time: .shortened` is allowed only inside the two helpers that immediately
# pin the locale and h23 cycle. Keep this explicit so a future native caller
# cannot copy the spelling and accidentally inherit the owner's 12-hour locale.
matches=$(find web/src Sources iOS iOSActivities iOSShare packages \
  -type d -name '.*' -prune -o \
  -type f \
  ! -path 'Sources/StarlingsDateFormatting.swift' \
  ! -path 'iOSActivities/MeetingActivityWidget.swift' \
  -exec grep -nE 'time[[:space:]]*:[[:space:]]*\.shortened' {} + 2>/dev/null || true)
if [ -n "$matches" ]; then
  printf '%s\n%s\n' 'Unapproved shortened clock formatter:' "$matches" >&2
  problems=$((problems + 1))
fi

# Direct browser formatters are easy to make locale-dependent. Date-only
# rendering can use toLocaleDateString; clocks must go through formatTime.
matches=$(find web/src \
  -type d -name '.*' -prune -o \
  -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -path 'web/src/meeting-time.ts' \
  -exec grep -nE 'Intl\.DateTimeFormat' {} + 2>/dev/null \
  | grep -Fv 'Intl.DateTimeFormat().resolvedOptions().timeZone' || true)
if [ -n "$matches" ]; then
  printf '%s\n%s\n' 'Unapproved browser date/time formatter:' "$matches" >&2
  problems=$((problems + 1))
fi

if [ "$problems" -ne 0 ]; then
  printf '%s\n' 'Time-format guard failed. Use the shared 24-hour formatter.' >&2
  exit 1
fi

printf '%s\n' '24-hour time-format guard passed.'
