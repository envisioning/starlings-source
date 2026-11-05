#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

# The Android gate (2026-10-28): a debug build of android/ and its JVM
# tests, which hold the Kotlin rules to fixtures/. Gradle runs only
# on the build host, the mini, which has the SDK and JDK 21. Another Mac sends
# this script there with `remote-build`, the same way verify.sh sends the
# Apple build. The laptop never runs ./gradlew, and this gate fails rather
# than build there when the mini does not answer.
#
#   MEET_GATE_REMOTE  1 (default) or 0 (build here; the mini sets it)
#   REMOTE_BUILD_HOST the build host (default mini-4p, Tailscale MagicDNS)
gate_host=${REMOTE_BUILD_HOST:-mini-4p}
this_host=$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -d -)
gate_name=$(printf '%s' "${gate_host%%.*}" | tr '[:upper:]' '[:lower:]' | tr -d -)

if [ "${MEET_GATE_REMOTE:-1}" != 0 ] && [ "$this_host" != "$gate_name" ]; then
  remote_build=$(command -v remote-build || printf '%s' "$HOME/.local/bin/remote-build")
  if [ ! -x "$remote_build" ] || ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$gate_host" true 2>/dev/null; then
    printf 'verify-android: %s does not answer, and Gradle does not run on this Mac\n' "$gate_host" >&2
    exit 1
  fi
  printf 'verify-android: the Android build runs on %s\n' "$gate_host" >&2
  REMOTE_BUILD_HOST=$gate_host exec "$remote_build" "MEET_GATE_REMOTE=0 ./scripts/verify-android.sh"
fi

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${MEET_ANDROID_JAVA_HOME:-$HOME/opt/jdk-21/Contents/Home}"
for need in "$ANDROID_HOME/platform-tools" "$JAVA_HOME/bin/java"; do
  [ -e "$need" ] || { printf 'verify-android: %s is missing on this Mac\n' "$need" >&2; exit 1; }
done

cd android
log=$(mktemp "${TMPDIR:-/tmp}/verify-android.XXXXXX")
trap 'rm -f "$log"' EXIT
# The repository's copy: the land queue's PATH has no ~/.local/bin.
run() { ../scripts/build-lock gradle ./gradlew --no-daemon --quiet assembleDebug testDebugUnitTest >"$log" 2>&1; }
if run; then cat "$log"; exit 0; fi
cat "$log"
# Under load the JVM test worker sometimes cannot reach Gradle on localhost
# ("Could not connect to server", Connection refused) before any test runs.
# That is the machine, not the code: run once more, and only for that.
if grep -q 'Could not connect to server' "$log"; then
  printf 'verify-android: the Gradle test worker did not connect; running once more\n' >&2
  if run; then cat "$log"; exit 0; fi
  cat "$log"
fi
exit 1
