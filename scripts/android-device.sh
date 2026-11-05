#!/usr/bin/env bash
# The A0 device loop on the build host (docs/agents/areas/android.md, "Device").
#
#   scripts/android-device.sh info      # the attached phone: model, Android, SoC, RAM, ABI
#   scripts/android-device.sh install   # install the last debug APK (verify-android.sh builds it)
#   scripts/android-device.sh logs      # copy the app's call logs to android/diagnostics/<serial>/
#
# One phone at a time: with more than one attached, set ANDROID_SERIAL.
set -euo pipefail

cd "$(dirname "$0")/.."
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
APP=work.starlings.android
APK=android/app/build/outputs/apk/debug/app-debug.apk

[ -x "$ADB" ] || { echo "android-device: no adb at $ADB (the SDK lives on the build host)" >&2; exit 1; }
"$ADB" get-state >/dev/null 2>&1 || { echo "android-device: no authorized phone (adb devices -l)" >&2; "$ADB" devices -l >&2; exit 1; }
prop() { "$ADB" shell getprop "$1" | tr -d '\r'; }

case "${1:-}" in
  info)
    echo "serial:   $("$ADB" get-serialno)"
    echo "model:    $(prop ro.product.manufacturer) $(prop ro.product.model)"
    echo "android:  $(prop ro.build.version.release) (SDK $(prop ro.build.version.sdk)), patch $(prop ro.build.version.security_patch)"
    echo "soc:      $(prop ro.soc.manufacturer) $(prop ro.soc.model)"
    echo "abi:      $(prop ro.product.cpu.abi)"
    echo "ram:      $("$ADB" shell cat /proc/meminfo | awk '/MemTotal/ {printf "%.1f GB\n", $2/1048576}')"
    ;;
  install)
    [ -f "$APK" ] || { echo "android-device: no $APK; run ./scripts/verify-android.sh first" >&2; exit 1; }
    "$ADB" install -r "$APK"
    ;;
  logs)
    # run-as reads the debug build's private files; the logs carry no personal data (CallLog.kt).
    out="android/diagnostics/$("$ADB" get-serialno)"
    mkdir -p "$out"
    for f in $("$ADB" shell run-as "$APP" ls files/diagnostics 2>/dev/null | tr -d '\r'); do
      "$ADB" exec-out run-as "$APP" cat "files/diagnostics/$f" >"$out/$f"
    done
    ls -1 "$out"
    ;;
  *)
    sed -n '2,8p' "$0" >&2
    exit 2
    ;;
esac
