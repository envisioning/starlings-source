#!/usr/bin/env bash
# End-to-end check of the ambient capture engine (docs/AMBIENT_CAPTURE.md
# slice 1): record through the real controller for N seconds, stop, print the
# manifest. Play something and speak during the window; pull the headphones
# once to exercise the route-change rebuild.
#
#   ./scripts/ambient-smoke.sh [--no-build] [--seconds 30] [--input BRIO]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=app-names.sh
source "$ROOT/scripts/app-names.sh"
APP="$ROOT/DerivedData/Build/Products/Debug/$STARLINGS_APP"
BUILD=1; SECS=30; INPUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --seconds) shift; SECS="$1" ;;
    --input) shift; INPUT="$1" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if pgrep -x "$STARLINGS_APP_NAME" >/dev/null 2>&1; then echo "$STARLINGS_APP_NAME is running. Quit it first." >&2; exit 1; fi
if [ "$BUILD" -eq 1 ]; then
  "$ROOT/scripts/version-env.sh" --write-xcconfig
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer "$ROOT/scripts/build-lock" "starlings ambient-smoke" xcodebuild -project "$ROOT/Starlings.xcodeproj" -scheme Starlings -configuration Debug -derivedDataPath "$ROOT/DerivedData" -disableAutomaticPackageResolution -allowProvisioningUpdates build >/dev/null
fi
log="$ROOT/DerivedData/ambient-smoke.log"; : > "$log"
open --env "MEET_AMBIENT_SMOKE=$SECS" --env "MEET_AMBIENT_SMOKE_INPUT=$INPUT" --stdout "$log" -a "$APP"
for _ in $(seq 1 $((SECS + 120))); do
  grep -q "SMOKE COMPLETE\|start failed" "$log" 2>/dev/null && break
  sleep 1
done
sleep 1
pkill -x "$STARLINGS_APP_NAME" 2>/dev/null || true
cat "$log"
