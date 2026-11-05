#!/usr/bin/env bash
# Slice 0 of docs/AMBIENT_CAPTURE.md: does a CoreAudio process tap
# deliver real system audio inside Meet's App Sandbox once the grant is given?
#
#   ./scripts/tap-spike.sh                 # build Debug, then run one 30 s window
#   ./scripts/tap-spike.sh --no-build      # reuse the Debug build
#   ./scripts/tap-spike.sh --seconds 60    # a longer window
#   ./scripts/tap-spike.sh --input BRIO    # a microphone by name (substring)
#
# During the window: play audio in Zoom or a browser, speak into the mic, and
# pull the headphones once. The report prints one line a second per stream —
# frames, peak, RMS. Read the last section: it names the answer.
#
# First run: macOS asks for "System Audio Recording Only" (and Microphone if
# not already granted). Grant, then run again — the first window records the
# pre-grant state, which is itself one of the issue's questions.
#
# Then revoke it in System Settings › Privacy & Security › Screen & System
# Audio Recording and run once more: that is the silent-zeros measurement.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=app-names.sh
source "$ROOT/scripts/app-names.sh"
APP="$ROOT/DerivedData/Build/Products/Debug/$STARLINGS_APP"
BUILD=1
SECONDS_WINDOW=30
INPUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --seconds) shift; SECONDS_WINDOW="$1" ;;
    --input) shift; INPUT="$1" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if pgrep -x "$STARLINGS_APP_NAME" >/dev/null 2>&1; then
  echo "$STARLINGS_APP_NAME is running. Quit it first — the spike needs its own launch." >&2
  exit 1
fi

if [ "$BUILD" -eq 1 ]; then
  echo "Building Debug…"
  "$ROOT/scripts/version-env.sh" --write-xcconfig
  # Signed with the real team: TCC keys the grant to the signature, and an
  # unsigned build re-prompts on every rebuild.
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    "$ROOT/scripts/build-lock" "starlings tap-spike" xcodebuild \
    -project "$ROOT/Starlings.xcodeproj" \
    -scheme Starlings \
    -configuration Debug \
    -derivedDataPath "$ROOT/DerivedData" \
    -disableAutomaticPackageResolution \
    -allowProvisioningUpdates \
    build >/dev/null
fi

if [ ! -d "$APP" ]; then
  echo "no Debug build at $APP — run without --no-build" >&2
  exit 1
fi

log="$ROOT/DerivedData/tap-spike.log"
rm -f "$log"
: > "$log"

echo
echo "════ process tap under the sandbox ════"
echo "If macOS asks to let $STARLINGS_APP_NAME record system audio, ALLOW it — the run waits on that click."
echo "Then play something, speak, pull the headphones. ${SECONDS_WINDOW}s."
echo

open --env "MEET_TAP_SPIKE=1" \
     --env "MEET_TAP_SPIKE_SECONDS=$SECONDS_WINDOW" \
     --env "MEET_TAP_SPIKE_INPUT=$INPUT" \
     --stdout "$log" \
     -a "$APP"

tail -f "$log" &
tail_pid=$!
# Generous: the first run blocks on the consent dialog until somebody clicks.
for _ in $(seq 1 $((SECONDS_WINDOW + 300))); do
  if grep -q "SPIKE COMPLETE" "$log" 2>/dev/null; then break; fi
  sleep 1
done
sleep 1
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true

if ! grep -q "SPIKE COMPLETE" "$log" 2>/dev/null; then
  echo "timed out — see $log" >&2
fi
pkill -x "$STARLINGS_APP_NAME" 2>/dev/null || true

echo
echo "Report: $log"
echo "Audio:  the CAF paths named in the report (inside the app's sandbox container)"
