#!/usr/bin/env bash
# Measure what the Mac audio stack actually gives us, once per audio device
# module. Answers the question the noise-reduction design hangs on: can Meet
# keep its per-app microphone picker *and* reach Apple's voice processing?
#
#   ./scripts/audio-spike.sh                  # build, then run both modules
#   ./scripts/audio-spike.sh --no-build       # reuse the Debug build
#   ./scripts/audio-spike.sh platformDefault  # one module only
#
# Each run captures four ~3s windows. Speak into the microphone the report says
# it selected — the level meter is how you tell whether the per-app choice held.
#
# Reports land in DerivedData/audio-spike-<module>.log (and, from inside the
# sandbox, the app's own container copy under Library/Logs/Starlings).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=app-names.sh
source "$ROOT/scripts/app-names.sh"
APP="$ROOT/DerivedData/Build/Products/Debug/$STARLINGS_APP"
BUILD=1
MODULES=(platformDefault audioEngine)

for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    platformDefault|audioEngine) MODULES=("$arg") ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Meet pins the module for the life of the process, so a spike run has to own
# the process. Never kill a meeting out from under someone.
if pgrep -x "$STARLINGS_APP_NAME" >/dev/null 2>&1; then
  echo "$STARLINGS_APP_NAME is running. Quit it first — the spike needs its own launch." >&2
  exit 1
fi

if [ "$BUILD" -eq 1 ]; then
  echo "Building Debug…"
  "$ROOT/scripts/version-env.sh" --write-xcconfig
  # Signed with the real team on purpose: TCC keys the microphone grant to the
  # signature, and an unsigned build re-prompts on every rebuild.
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    "$ROOT/scripts/build-lock" "starlings audio-spike" xcodebuild \
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

for module in "${MODULES[@]}"; do
  log="$ROOT/DerivedData/audio-spike-$module.log"
  rm -f "$log"
  : > "$log"

  echo
  echo "════ $module ════"
  echo "Speak into the microphone the report selects, and watch the meter."
  echo

  open --env "MEET_AUDIO_SPIKE=1" \
       --env "MEET_AUDIO_ADM=$module" \
       --stdout "$log" \
       -a "$APP"

  tail -f "$log" &
  tail_pid=$!
  # The app quits itself once the report is complete.
  for _ in $(seq 1 120); do
    if grep -q "SPIKE COMPLETE" "$log" 2>/dev/null; then break; fi
    sleep 1
  done
  sleep 1
  kill "$tail_pid" 2>/dev/null || true
  wait "$tail_pid" 2>/dev/null || true

  if ! grep -q "SPIKE COMPLETE" "$log" 2>/dev/null; then
    echo "timed out waiting for $module — see $log" >&2
  fi
  pkill -x "$STARLINGS_APP_NAME" 2>/dev/null || true
  sleep 1
done

echo
echo "Reports:"
for module in "${MODULES[@]}"; do
  echo "  $ROOT/DerivedData/audio-spike-$module.log"
done
