#!/usr/bin/env bash
# What Accessibility sees of Zoom, and what ZoomCallReader makes of it
# (docs/AMBIENT_CAPTURE.md §5). Run during a real Zoom call to tune the reads.
# First run asks for the Accessibility grant: System Settings › Privacy &
# Security › Accessibility → Starlings. Under the App Sandbox that grant may not
# take — `accessibility trusted: false` after enabling is that answer.
#
#   ./scripts/zoom-smoke.sh [--no-build]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=app-names.sh
source "$ROOT/scripts/app-names.sh"
APP="$ROOT/DerivedData/Build/Products/Debug/$STARLINGS_APP"
if [ "${1:-}" != "--no-build" ]; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer "$ROOT/scripts/build-lock" "starlings zoom-smoke" xcodebuild -project "$ROOT/Starlings.xcodeproj" -scheme Starlings -configuration Debug -derivedDataPath "$ROOT/DerivedData" -disableAutomaticPackageResolution -allowProvisioningUpdates build >/dev/null
fi
pkill -x "$STARLINGS_APP_NAME" 2>/dev/null || true; sleep 1
log="$ROOT/DerivedData/zoom-smoke.log"; : > "$log"
open --env "MEET_ZOOM_SMOKE=1" --stdout "$log" -a "$APP"
for _ in $(seq 1 60); do grep -q "SMOKE COMPLETE" "$log" 2>/dev/null && break; sleep 1; done
pkill -x "$STARLINGS_APP_NAME" 2>/dev/null || true
cat "$log"
