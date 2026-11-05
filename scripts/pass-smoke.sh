#!/usr/bin/env bash
# The two-track pass on synthetic speech (docs/AMBIENT_CAPTURE.md slice 2):
# builds a capture folder from `say` — the mic track one voice, the system
# track two voices in turn — runs the pass over it in the Debug app, prints
# the segments. No upload; the keychain-gated API is not touched.
#
#   ./scripts/pass-smoke.sh [--no-build]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=app-names.sh
source "$ROOT/scripts/app-names.sh"
APP="$ROOT/DerivedData/Build/Products/Debug/$STARLINGS_APP"
BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0
if [ "$BUILD" -eq 1 ]; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer "$ROOT/scripts/build-lock" "starlings pass-smoke" xcodebuild -project "$ROOT/Starlings.xcodeproj" -scheme Starlings -configuration Debug -derivedDataPath "$ROOT/DerivedData" -disableAutomaticPackageResolution -allowProvisioningUpdates build >/dev/null
fi
work="$ROOT/DerivedData/pass-smoke"
container="$STARLINGS_SUPPORT_DIR/Captures/11111111-2222-4333-8444-555555555555"
rm -rf "$work" "$container"; mkdir -p "$work" "$container"
ln -s "$container" "$work/capture"
mic="$work/capture/capture_mic_0.caf"; sys="$work/capture/capture_system_0.caf"
to16k() { afconvert -f caff -d LEI16@16000 -c 1 "$1" "$2"; }
say -v Samantha -o "$work/mic.aiff" "Thanks everyone. Let's start with the scope for the pilot. I think we can ship the first version on Friday."
say -v Daniel -o "$work/a.aiff" "Sounds good to me. I will own the deployment and send the checklist tomorrow morning."
say -v Karen -o "$work/b.aiff" "One question. Do we need the legal review before Friday, or can it wait until the following week?"
# The system track: Daniel, a second of silence, then Karen — two speakers in turn.
sox_missing=0; command -v sox >/dev/null || sox_missing=1
if [ "$sox_missing" -eq 0 ]; then
  sox "$work/a.aiff" "$work/b.aiff" "$work/system.aiff" pad 0 1
else
  # No sox: concatenate with afconvert via a silent gap file.
  say -v Daniel -o "$work/system.aiff" "Sounds good to me. I will own the deployment and send the checklist tomorrow morning. [[slnc 1000]] One question. Do we need the legal review before Friday, or can it wait until the following week?"
fi
to16k "$work/mic.aiff" "$mic"; to16k "$work/system.aiff" "$sys"
frames() { afinfo "$1" | awk '/estimated duration/ {print int($3*16000)}'; }
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$work/capture/manifest.json" <<JSON
{ "version": 1, "id": "11111111-2222-4333-8444-555555555555", "source": "ambient",
  "startedAt": "$now", "endedAt": "$now", "status": "captured", "inputName": "say",
  "trackSampleRate": 16000, "title": "Synthetic pilot sync", "attendees": ["Rosa", "Daniel", "Karen"],
  "parts": [{ "index": 0, "micFile": "capture_mic_0.caf", "systemFile": "capture_system_0.caf",
              "startedAt": "$now", "endedAt": "$now", "micFrames": $(frames "$mic"), "systemFrames": $(frames "$sys") }],
  "events": [] }
JSON
# What the extension would have seen: Daniel's tile lit for the first
# stretch, Karen's after. Seconds from the capture's start.
: > "$container/speaking.jsonl"
for t in 0 1 2 3 4 5 6; do echo "{\"name\":\"Daniel\",\"at\":$t}" >> "$container/speaking.jsonl"; done
for t in 8 9 10 11 12; do echo "{\"name\":\"Karen\",\"at\":$t}" >> "$container/speaking.jsonl"; done
log="$work/pass-smoke.log"; : > "$log"
pkill -x "$STARLINGS_APP_NAME" 2>/dev/null || true; sleep 1
open --env "MEET_PASS_SMOKE=$container" --stdout "$log" -a "$APP"
for _ in $(seq 1 600); do grep -q "SMOKE COMPLETE" "$log" 2>/dev/null && break; sleep 1; done
pkill -x "$STARLINGS_APP_NAME" 2>/dev/null || true
cat "$log"
