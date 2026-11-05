#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
# shellcheck source=app-names.sh
. ./scripts/app-names.sh

# Two gates (2026-10-05). `pnpm verify` is the gate for each slice: the Mac
# tests and a Debug build of the iOS app, with no simulator. `pnpm
# verify:release` (this script with --release) adds the iOS tests on a
# simulator and the Mac and iOS Release builds. Run it once before a push
# that changes Swift. Every Swift session in parallel ran all four builds on
# each slice, and the Mac stayed at 100% CPU.
#
# `--apple` runs only the Apple part, after the fast gate has passed some
# other way: `pnpm verify:changed` uses it when Swift changed.
release=0
apple_only=0
for arg in "$@"; do
  case "$arg" in
    --release) release=1 ;;
    --apple) apple_only=1 ;;
    *) printf 'usage: verify.sh [--release] [--apple]\n' >&2; exit 2 ;;
  esac
done

. ./scripts/gate-lock.sh
gate_low_priority "$repo_dir/scripts/verify.sh" "$@"
# Each xcodebuild takes every core by default. Four jobs leave the rest of
# the Mac to the sessions that are not building.
xcode_jobs=${MEET_XCODE_JOBS:-4}

# The Apple part runs on the build Mac, mini-4p, when it can (2026-10-20).
# On the 10-core laptop at background QoS an iOS build took 2.5 hours, and
# parallel agent gates took the load to 105. `remote-build` (~/.local/bin)
# copies this worktree's tracked files, uncommitted edits included, to the
# mini and runs `verify.sh --apple` there under the mini's machine lock. So
# the laptop takes neither the `xcode` lock nor its machine lock for it.
# Everything moves, the simulator tests of --release too: every build here
# has CODE_SIGNING_ALLOWED=NO, so none needs the laptop's signing identity,
# and the mini has the iPhone simulators the land queue already uses.
# The build stays on this Mac when:
#   - this Mac is the build host (the land queue runs on the mini), or the
#     gate is the land queue (MEET_LAND_QUEUE=1);
#   - MEET_GATE_REMOTE=0 (the mini sets it for the copy it runs);
#   - remote-build is not installed, or the host does not answer ssh in 5 s.
#
#   MEET_GATE_REMOTE  1 (default) or 0
#   REMOTE_BUILD_HOST the build host (default mini-4p, Tailscale MagicDNS)
gate_host=${REMOTE_BUILD_HOST:-mini-4p}
gate_remote=0
remote_build=$(command -v remote-build || printf '%s' "$HOME/.local/bin/remote-build")
this_host=$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -d -)
if [ "${MEET_GATE_REMOTE:-1}" != 0 ] && [ "${MEET_LAND_QUEUE:-}" != 1 ] \
  && [ "$this_host" != "$(printf '%s' "${gate_host%%.*}" | tr '[:upper:]' '[:lower:]' | tr -d -)" ] \
  && [ -x "$remote_build" ]; then
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "$gate_host" true 2>/dev/null; then
    gate_remote=1
  else
    printf 'verify: %s does not answer; the Apple build runs on this Mac\n' "$gate_host" >&2
  fi
fi

current_derived_data=$(CDPATH= cd -- "$repo_dir" && pwd -P)/DerivedData
if [ -d "$repo_dir/DerivedData" ]; then
  current_derived_data=$(CDPATH= cd -- "$repo_dir/DerivedData" && pwd -P)
fi
# Only processes named xcodebuild, then their arguments one PID at a time.
# `pgrep -fl xcodebuild` also matched any shell whose text named xcodebuild,
# and a multi-line command printed extra lines whose first word ("run()")
# was read as a PID. A waiting loop that named the pattern then matched
# itself, never ended, and blocked every gate on the Mac (2026-10-04).
# A remote gate builds in the mini's copy, not in this DerivedData.
running_builds=''
[ "$gate_remote" = 1 ] || for build_pid in $(pgrep -x xcodebuild || true); do
  build_args=$(ps -o args= -p "$build_pid" 2>/dev/null | tr '\n' ' ' || true)
  case "$build_args" in
    *'-derivedDataPath DerivedData '*) running_builds="$running_builds $build_pid" ;;
  esac
done
for build_pid in $running_builds; do
  build_cwd=$(lsof -a -p "$build_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
  # If the process cannot be inspected, fail closed. Otherwise resolve its
  # relative DerivedData path and only serialize builds that share this one.
  if [ -z "$build_cwd" ]; then
    printf 'verify: refusing to start; cannot inspect xcodebuild PID %s using -derivedDataPath DerivedData\n' "$build_pid" >&2
    exit 1
  fi
  build_derived_data="$build_cwd/DerivedData"
  if [ -d "$build_derived_data" ]; then
    build_derived_data=$(CDPATH= cd -- "$build_derived_data" && pwd -P)
  fi
  if [ "$build_derived_data" = "$current_derived_data" ]; then
    printf 'verify: refusing to start; xcodebuild PID %s is using -derivedDataPath DerivedData\n' "$build_pid" >&2
    exit 1
  fi
done

# verify:fast takes the `gate` lock itself and releases it when it ends;
# the Apple builds and tests below hold the `xcode` lock and the machine lock
# (gate-lock.sh, build-lock).
if [ "$apple_only" = 0 ]; then
  pnpm verify:fast
  # The land queue runs this gate, so main never takes a broken android/.
  ./scripts/verify-android.sh
fi
if [ "$gate_remote" = 1 ]; then
  # utility and 8 jobs: the mini's 8 performance cores, and its machine lock
  # keeps every other heavy build off them meanwhile.
  remote_args='--apple'
  [ "$release" = 0 ] || remote_args='--apple --release'
  printf 'verify: the Apple build runs on %s\n' "$gate_host" >&2
  REMOTE_BUILD_HOST=$gate_host exec "$remote_build" \
    "MEET_GATE_REMOTE=0 MEET_GATE_QOS=utility MEET_XCODE_JOBS=\${MEET_XCODE_JOBS:-8} ./scripts/verify.sh $remote_args"
fi
# Other repos call the installed copy of the machine lock (a new Mac has none).
[ -x "$HOME/.local/bin/build-lock" ] || ./scripts/build-lock --install || true
gate_lock_acquire verify xcode
# Warns when core-kit or envisioning-ui is pinned behind its branch.
node ./scripts/check-package-pins.mjs
./scripts/version-env.sh --write-xcconfig
xcodegen generate
# A fresh worktree clones the shared Swift packages (source-packages.sh).
. ./scripts/source-packages.sh
seed_source_packages DerivedData

# The suite asserts English sentences. The test host is Starlings.app, and its
# AppleLanguages override — the Language setting of whoever runs the tests —
# would otherwise pick the strings. -testLanguage pins it.
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild \
  -project Starlings.xcodeproj \
  -scheme Starlings \
  -configuration Debug \
  -derivedDataPath DerivedData \
  -disableAutomaticPackageResolution \
  -jobs "$xcode_jobs" \
  CODE_SIGNING_ALLOWED=NO \
  -testLanguage en -testRegion GB \
  test -quiet
# The packages built and passed: they become the set the next worktree clones.
store_source_packages DerivedData

# The iOS app is a separate SwiftUI target but shares the pinned LiveKit SDK,
# version stamp, API origins, and wire models.
# No `-sdk` on any iOS build: it applies to every target in the scheme, and
# the embedded watch app and its complication would be compiled against the
# iPhone SDK. The destination picks the SDK per platform on its own.
if [ "$release" = 0 ]; then
  # A generic simulator destination compiles the app and boots nothing.
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    xcodebuild \
    -project Starlings.xcodeproj \
    -scheme Starlings-iOS \
    -configuration Debug \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath DerivedData \
    -disableAutomaticPackageResolution \
    -jobs "$xcode_jobs" \
    CODE_SIGNING_ALLOWED=NO \
    build -quiet
else
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    xcodebuild \
    -project Starlings.xcodeproj \
    -scheme Starlings \
    -configuration Release \
    -derivedDataPath DerivedData \
    -disableAutomaticPackageResolution \
    -jobs "$xcode_jobs" \
    CODE_SIGNING_ALLOWED=NO \
    build -quiet

  # The iOS tests run on a simulator: the destination is chosen
  # at run time, so the gate does not depend on a particular simulator model
  # being installed. The device Release build below catches stricter
  # whole-module concurrency and framework-slice issues.
  ios_sim_udid=$(DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    xcrun simctl list devices available -j | python3 -c '
import json, sys
for devices in json.load(sys.stdin)["devices"].values():
    for device in devices:
        if device.get("isAvailable", True) and device["name"].startswith("iPhone"):
            print(device["udid"])
            sys.exit(0)
' || true)
  if [ -z "$ios_sim_udid" ]; then
    printf 'verify: no iPhone simulator is installed, so the iOS tests cannot run.\n' >&2
    printf 'verify: install one with Xcode > Settings > Components, or: xcodebuild -downloadPlatform iOS\n' >&2
    exit 1
  fi
  printf 'verify: running the iOS tests on simulator %s\n' "$ios_sim_udid"

  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    xcodebuild \
    -project Starlings.xcodeproj \
    -scheme Starlings-iOS \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$ios_sim_udid" \
    -derivedDataPath DerivedData \
    -disableAutomaticPackageResolution \
    -jobs "$xcode_jobs" \
    CODE_SIGNING_ALLOWED=NO \
    -testLanguage en -testRegion GB \
    test -quiet

  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
    xcodebuild \
    -project Starlings.xcodeproj \
    -scheme Starlings-iOS \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -derivedDataPath DerivedData \
    -disableAutomaticPackageResolution \
    -jobs "$xcode_jobs" \
    CODE_SIGNING_ALLOWED=NO \
    build -quiet
fi

debug_cli="DerivedData/Build/Products/Debug/starlings"
test -x "$debug_cli"
test "$("$debug_cli" version)" = '{"cli_version":"0.1.0","protocol_version":1}'

# The String Catalog must hold every key the compiler just extracted, with
# a pt-BR value or `shouldTranslate: false` (AGENTS.md invariant 29). Reads
# the .stringsdata the builds above wrote; a new or moved string without a
# sync and a translation is a failure here, not an English label in
# Portuguese later. The Release bundles' InfoPlist strings exist only after
# --release.
# Paused until product-market fit (2026-10-09): MEET_L10N_GATES=1 turns it on.
if [ "$release" = 0 ]; then
  [ "${MEET_L10N_GATES:-0}" != 1 ] || ./scripts/sync-string-catalog.py --check --translated pt-BR
  exit 0
fi
[ "${MEET_L10N_GATES:-0}" != 1 ] || ./scripts/sync-string-catalog.py --check --translated pt-BR --built-products DerivedData/Build/Products

release_plist="DerivedData/Build/Products/Release/$STARLINGS_APP/Contents/Info.plist"
test "$(/usr/libexec/PlistBuddy -c 'Print :MEET_ALLOW_DEV_AUTH' "$release_plist")" = "NO"
# Origins are asserted against the xcconfig itself, so the domain cutover is a
# one-file change and verify can never disagree with the source of truth.
expected_api=$(./scripts/identity-setting.sh MEET_API_ENDPOINT)
expected_web=$(./scripts/identity-setting.sh MEET_WEB_ORIGIN)
test -n "$expected_api"
test -n "$expected_web"
test "$(/usr/libexec/PlistBuddy -c 'Print :MEET_API_ENDPOINT' "$release_plist")" = "$expected_api"
test "$(/usr/libexec/PlistBuddy -c 'Print :MEET_WEB_ORIGIN' "$release_plist")" = "$expected_web"
test "$(/usr/libexec/PlistBuddy -c 'Print :STARLINGS_TEAM_ID' "$release_plist")" = "$(./scripts/identity-setting.sh DEVELOPMENT_TEAM)"
test "$(/usr/libexec/PlistBuddy -c 'Print :STARLINGS_UPDATE_FEED_URL' "$release_plist")" = "$(./scripts/identity-setting.sh STARLINGS_UPDATE_FEED_URL)"
expected_version="$(./scripts/version-env.sh --print)"
actual_short="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$release_plist")"
actual_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$release_plist")"
test "${actual_short}+${actual_build}" = "$expected_version"
# Versions must be plist *strings*: NSNumber bundle versions crash Metal's
# telemetry as soon as Portrait/VFX effects start (admitting with camera on).
test "$(plutil -type CFBundleShortVersionString "$release_plist")" = "string"
test "$(plutil -type CFBundleVersion "$release_plist")" = "string"

ios_release_plist="DerivedData/Build/Products/Release-iphoneos/$STARLINGS_APP/Info.plist"
test "$(/usr/libexec/PlistBuddy -c 'Print :MEET_API_ENDPOINT' "$ios_release_plist")" = "$expected_api"
test "$(/usr/libexec/PlistBuddy -c 'Print :MEET_WEB_ORIGIN' "$ios_release_plist")" = "$expected_web"
ios_short="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ios_release_plist")"
ios_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$ios_release_plist")"
test "${ios_short}+${ios_build}" = "$expected_version"
test "$(plutil -type CFBundleShortVersionString "$ios_release_plist")" = "string"
test "$(plutil -type CFBundleVersion "$ios_release_plist")" = "string"

release_cli="DerivedData/Build/Products/Release/starlings"
embedded_release_cli="DerivedData/Build/Products/Release/$STARLINGS_APP/Contents/Resources/starlings"
test -x "$release_cli"
test -x "$embedded_release_cli"
test "$("$release_cli" version)" = '{"cli_version":"0.1.0","protocol_version":1}'
cmp -s "$release_cli" "$embedded_release_cli"
