#!/usr/bin/env bash
# Update the installed Starlings.app from the public update feed (or any https zip URL).
#
#   ./scripts/update-app.sh            # update if a newer release exists
#   ./scripts/update-app.sh --check    # say what would happen, change nothing
#   ./scripts/update-app.sh --yes      # no confirmation prompt
#   ./scripts/update-app.sh --version 0.1.1
#   ./scripts/update-app.sh --url https://…/Starlings-macOS.zip
#   ./scripts/update-app.sh --force    # reinstall even at the same version
#
# The app runs this too, from inside its own bundle, passing the version and
# URL it read from the update feed (docs/UPDATER.md). --url exists so the zip
# can move hosts without a client update — as it has, off GitHub, onto R2.
#
# Unlike Headroom there is no KeepAlive LaunchAgent inside the bundle — quit,
# verify, ditto, reopen is enough. Trust is notarization + Team ID, not the feed.
#
# The app was Meet.app before the rename. After Starlings.app is
# installed, a Meet.app beside it is stopped and moved to the Trash, so two
# copies do not run. The names are written here and not read from
# scripts/app-names.sh: this script runs from inside the installed bundle.
set -euo pipefail

APP_NAME="Starlings"
LEGACY_APP_NAME="Meet"
APP="${MEET_APP_PATH:-/Applications/$APP_NAME.app}"
ZIP_NAME="$APP_NAME-macOS.zip"

CHECK_ONLY=0
ASSUME_YES=0
FORCE=0
WANT_VERSION=""
WANT_URL=""
WANT_SHA256=""
WANT_SIZE=""
WAIT_PID=""
FEED_FILE=""
STAGE=""
INSTALLED_OK=0
QUIT_APP=0
BACKUP=""
LOCK_DIR="${TMPDIR:-/tmp}/$APP_NAME-update.lock"
LOCK_OWNED=0

die() { echo "error: $*" >&2; exit 1; }
note() { echo "$*" >&2; }

# The signing team and the feed are this build's settings
# (Config/Starlings.xcconfig). Inside a bundle they come from its Info.plist,
# under the same signature as this script. In a checkout they come from the
# xcconfig. No team means no update: nothing can be verified. docs/UPDATER.md.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
build_setting() {
  if [[ -x "$SCRIPT_DIR/identity-setting.sh" ]]; then
    "$SCRIPT_DIR/identity-setting.sh" "$2"
  else
    plutil -extract "$1" raw -o - "$SCRIPT_DIR/../Info.plist" 2>/dev/null || true
  fi
}
TEAM_ID="$(build_setting STARLINGS_TEAM_ID DEVELOPMENT_TEAM)"
[[ -n "$TEAM_ID" ]] || die "this build names no signing team, so it cannot verify an update"
# The feed and the zips are both anonymous, from the same origin.
FEED_URL="${MEET_UPDATE_FEED_URL:-$(build_setting STARLINGS_UPDATE_FEED_URL STARLINGS_UPDATE_FEED_URL)}"
DOWNLOAD_ORIGIN="${MEET_DOWNLOAD_ORIGIN:-${FEED_URL%%/updates/*}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check|-n) CHECK_ONLY=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --version) WANT_VERSION="${2:-}"; shift 2 ;;
    --url) WANT_URL="${2:-}"; shift 2 ;;
    --sha256) WANT_SHA256="${2:-}"; shift 2 ;;
    --size) WANT_SIZE="${2:-}"; shift 2 ;;
    --pid) WAIT_PID="${2:-}"; shift 2 ;;
    --app) APP="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

for required in curl codesign ditto mktemp open plutil spctl unzip; do
  command -v "$required" >/dev/null || die "$required required"
done

installed_version() {
  [[ -d "$APP" ]] || return 0
  plutil -extract CFBundleShortVersionString raw -o - \
    "$APP/Contents/Info.plist" 2>/dev/null || true
}

is_numeric_version() {
  [[ "$1" =~ ^[0-9]+(\.[0-9]+)*$ ]]
}

normalize_component() {
  local value="$1"
  value="$(printf '%s' "$value" | sed 's/^0*//')"
  printf '%s' "${value:-0}"
}

# BSD sort on older macOS releases does not provide GNU's -V. Compare decimal
# components directly so the updater never treats 1.4.10 as older than 1.4.9.
version_is_newer() {
  local left="$1"
  local right="$2"
  local i lhs rhs max_count
  local -a left_parts right_parts
  IFS='.' read -r -a left_parts <<< "$left"
  IFS='.' read -r -a right_parts <<< "$right"
  max_count="${#left_parts[@]}"
  if (( ${#right_parts[@]} > max_count )); then
    max_count="${#right_parts[@]}"
  fi
  for ((i = 0; i < max_count; i++)); do
    lhs="$(normalize_component "${left_parts[i]:-0}")"
    rhs="$(normalize_component "${right_parts[i]:-0}")"
    if [[ "$lhs" == "$rhs" ]]; then
      continue
    fi
    if (( ${#lhs} > ${#rhs} )); then
      return 0
    fi
    if (( ${#lhs} == ${#rhs} )) && [[ "$lhs" > "$rhs" ]]; then
      return 0
    fi
    return 1
  done
  return 1
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_OWNED=1
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return
  fi

  local owner=""
  if [[ -f "$LOCK_DIR/pid" ]]; then
    owner="$(<"$LOCK_DIR/pid")"
  fi
  if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
    die "another Starlings update is already running"
  fi

  # A terminated updater can leave only its lock behind. It is safe to reclaim
  # that exact, per-user directory, but never to remove a broad temp path.
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || die "another Starlings update is already starting"
  mkdir "$LOCK_DIR" || die "could not lock the updater"
  LOCK_OWNED=1
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

release_lock() {
  if [[ "$LOCK_OWNED" -eq 1 ]]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
    LOCK_OWNED=0
  fi
}

cleanup() {
  if [[ "$INSTALLED_OK" -eq 0 && -n "$BACKUP" && ! -d "$APP" && -d "$BACKUP" ]]; then
    mv "$BACKUP" "$APP" || true
  fi
  if [[ -n "$STAGE" && -d "$STAGE" ]]; then
    rm -rf "$STAGE"
  fi
  if [[ -n "$FEED_FILE" && -f "$FEED_FILE" ]]; then
    rm -f "$FEED_FILE"
  fi
  release_lock
  if [[ "$QUIT_APP" -eq 1 && "$INSTALLED_OK" -eq 0 && -d "$APP" ]]; then
    open "$APP" 2>/dev/null || true
  fi
}

trap cleanup EXIT

acquire_lock

if [[ -z "$WANT_VERSION" || -z "$WANT_URL" ]]; then
  [[ -n "$FEED_URL" ]] || die "this build names no update feed"
  FEED_FILE="$(mktemp -t meet-update-feed.XXXXXX)" \
    || die "could not create a temporary feed file"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$FEED_FILE" "$FEED_URL" \
    || die "could not read the update feed at $FEED_URL"
  plutil -convert xml1 -o /dev/null -- "$FEED_FILE" \
    || die "the update feed is not valid JSON"
fi

# macOS plutil is present on every supported host and parses JSON without
# depending on jq, Python, or a particular feed line wrapping.
feed_field() {
  [[ -n "$FEED_FILE" ]] || return 0
  plutil -extract "$1" raw -o - "$FEED_FILE" 2>/dev/null || true
}

if [[ -n "$WANT_VERSION" ]]; then
  TAG="v${WANT_VERSION#v}"
else
  FEED_VERSION="$(feed_field version)"
  [[ -n "$FEED_VERSION" ]] || die "could not read the update feed at $FEED_URL"
  TAG="v$FEED_VERSION"
fi
LATEST="${TAG#v}"
is_numeric_version "$LATEST" \
  || die "update version is not numeric: $LATEST"
INSTALLED="$(installed_version)"

if [[ -n "$INSTALLED" ]] && ! is_numeric_version "$INSTALLED"; then
  die "installed app has an unrecognized version: $INSTALLED"
fi

if [[ -z "$INSTALLED" ]]; then
  note "No app at $APP — this will install $LATEST fresh."
else
  note "installed $INSTALLED · latest $LATEST"
fi

if [[ -n "$INSTALLED" && "$FORCE" -eq 0 && -z "$WANT_VERSION" ]]; then
  if [[ "$INSTALLED" == "$LATEST" ]] || ! version_is_newer "$LATEST" "$INSTALLED"; then
    note "Already up to date."
    exit 0
  fi
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  note "Would install $LATEST. Nothing changed (--check)."
  exit 0
fi

if [[ "$ASSUME_YES" -eq 0 ]]; then
  printf 'Update %s (%s → %s)? [Y/n] ' "$APP" "${INSTALLED:-none}" "$LATEST" >&2
  read -r reply </dev/tty || reply=""
  case "$reply" in
    ""|y|Y|yes|YES) ;;
    *) note "Cancelled."; exit 0 ;;
  esac
fi

APP_DIR="$(dirname "$APP")"
# Keep the staging directory beside the installed bundle. This makes the two
# rename operations same-volume and avoids a cross-volume move on unusual Mac
# setups; the sandbox already grants this updater write access to /Applications.
STAGE="$(mktemp -d "$APP_DIR/.$APP_NAME-update.XXXXXX")" \
  || die "could not create a staging directory beside $APP"

# In-app path (--yes): the app terminates itself after spawning us. Wait for
# that exact process before touching the bundle. CLI path: quit via AppleScript
# and use the process name as the best available fallback.
process_is_running() {
  if [[ -n "$WAIT_PID" ]]; then
    kill -0 "$WAIT_PID" 2>/dev/null
  else
    pgrep -x "$APP_NAME" >/dev/null 2>&1
  fi
}

if process_is_running; then
  QUIT_APP=1
  if [[ -n "$WAIT_PID" || "$ASSUME_YES" -eq 1 ]]; then
    note "Waiting for Starlings to quit…"
  else
    note "Closing Starlings…"
    osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 40); do
    process_is_running || break
    sleep 0.5
  done
  if process_is_running; then
    die "Starlings did not quit; refusing to replace the running app"
  fi
fi

ZIP_URL="$WANT_URL"
# Only trust the feed's own url when it describes the version being installed.
if [[ -z "$ZIP_URL" && "$(feed_field version)" == "$LATEST" ]]; then
  ZIP_URL="$(feed_field url)"
fi
ZIP_URL="${ZIP_URL:-$DOWNLOAD_ORIGIN/download/mac/$LATEST/$ZIP_NAME}"
[[ "$ZIP_URL" == https://* ]] || die "download URL must use https"
[[ "$ZIP_URL" != *"@"* ]] || die "download URL must not contain credentials"

SHA256="$WANT_SHA256"
if [[ -z "$SHA256" && "$(feed_field version)" == "$LATEST" ]]; then
  SHA256="$(feed_field sha256)"
fi
if [[ -n "$SHA256" ]]; then
  [[ "$SHA256" =~ ^[0-9A-Fa-f]{64}$ ]] \
    || die "the update checksum is not a SHA-256 digest"
fi

EXPECTED_SIZE="$WANT_SIZE"
if [[ -z "$EXPECTED_SIZE" && "$(feed_field version)" == "$LATEST" ]]; then
  EXPECTED_SIZE="$(feed_field size)"
fi
if [[ -n "$EXPECTED_SIZE" ]]; then
  [[ "$EXPECTED_SIZE" =~ ^[0-9]+$ ]] \
    || die "the update size is not a non-negative integer"
fi

note "Downloading $TAG …"
curl -fsSL --proto '=https' --tlsv1.2 -o "$STAGE/$ZIP_NAME" "$ZIP_URL" \
  || die "download failed: $ZIP_URL"
if [[ -n "$EXPECTED_SIZE" ]]; then
  ACTUAL_SIZE="$(stat -f%z "$STAGE/$ZIP_NAME")"
  [[ "$ACTUAL_SIZE" == "$EXPECTED_SIZE" ]] \
    || die "download size differs from the feed (got $ACTUAL_SIZE, expected $EXPECTED_SIZE)"
fi
if [[ -n "$SHA256" ]]; then
  command -v shasum >/dev/null || die "shasum required to verify the update"
  ACTUAL_SHA256="$(shasum -a 256 "$STAGE/$ZIP_NAME" | awk '{print $1}' | tr '[:upper:]' '[:lower:]')"
  EXPECTED_SHA256="$(printf '%s' "$SHA256" | tr '[:upper:]' '[:lower:]')"
  [[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256" ]] \
    || die "download checksum differs from the feed"
fi
unzip -oq "$STAGE/$ZIP_NAME" -d "$STAGE/x" || die "the zip did not unpack"
NEW="$STAGE/x/$APP_NAME.app"
[[ -d "$NEW" ]] || die "no $APP_NAME.app inside the zip"

# ------------------------------------------------------------------ verify it
# All checks run before anything on disk is touched.

verify_bundle() {
  local bundle="$1"
  local expected_version="$2"
  local got_team bundle_version

  spctl -a -t exec "$bundle" 2>/dev/null || {
    note "Gatekeeper rejected $bundle"
    return 1
  }
  codesign --verify --deep --strict "$bundle" 2>/dev/null || {
    note "signature does not verify for $bundle"
    return 1
  }
  got_team="$(codesign -dv --verbose=4 "$bundle" 2>&1 \
    | sed -n 's/^TeamIdentifier=//p' | head -1)"
  if [[ "$got_team" != "$TEAM_ID" ]]; then
    note "signed by team ${got_team:-none}, expected $TEAM_ID"
    return 1
  fi
  bundle_version="$(plutil -extract CFBundleShortVersionString raw -o - \
    "$bundle/Contents/Info.plist" 2>/dev/null || true)"
  if [[ -z "$bundle_version" || "$bundle_version" != "$expected_version" ]]; then
    note "$bundle has version ${bundle_version:-none}, expected $expected_version"
    return 1
  fi
}

verify_bundle "$NEW" "$LATEST" \
  || die "downloaded app failed verification — refusing to install"

NEW_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - \
  "$NEW/Contents/Info.plist" 2>/dev/null || true)"

note "Verified $NEW_VERSION, notarized, team $TEAM_ID."

if [[ -d "$APP" ]]; then
  BACKUP="$STAGE/$APP_NAME.app.previous"
  mv "$APP" "$BACKUP"
fi

if ! ditto "$NEW" "$APP"; then
  note "copy failed — restoring the previous app"
  rm -rf "$APP"
  if [[ -n "$BACKUP" && -d "$BACKUP" ]]; then
    mv "$BACKUP" "$APP" || true
  fi
  die "install failed, previous version restored"
fi

# Verify the copy at its final path too. A successful ditto is not enough if a
# mount, ACL, or filesystem boundary changed anything while the bundle moved.
if ! verify_bundle "$APP" "$LATEST"; then
  note "installed app failed verification — restoring the previous app"
  rm -rf "$APP"
  if [[ -n "$BACKUP" && -d "$BACKUP" ]]; then
    mv "$BACKUP" "$APP" || true
  fi
  die "install failed, previous version restored"
fi

xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
INSTALLED_OK=1

# Meet.app, the app before the rename, beside the one just
# installed: stop it and move it to the Trash, so two copies do not run. Its
# data stays where it is; Starlings moves it on first launch. Best effort:
# the new app is installed whatever happens here.
retire_legacy_app() {
  local legacy executable kept
  legacy="$(dirname "$APP")/$LEGACY_APP_NAME.app"
  [[ -d "$legacy" && "$legacy" != "$APP" ]] || return 0
  executable="$legacy/Contents/MacOS/$LEGACY_APP_NAME"
  # Only that bundle's own process: its full executable path, anchored.
  if pgrep -f "^$executable( |\$)" >/dev/null 2>&1; then
    note "Stopping $LEGACY_APP_NAME…"
    pkill -TERM -f "^$executable( |\$)" 2>/dev/null || true
    for _ in $(seq 1 40); do
      pgrep -f "^$executable( |\$)" >/dev/null 2>&1 || break
      sleep 0.5
    done
    if pgrep -f "^$executable( |\$)" >/dev/null 2>&1; then
      note "$LEGACY_APP_NAME did not quit; left it at $legacy"
      return 0
    fi
  fi
  # FileManager.trashItem through the Objective-C bridge: the Trash without
  # asking Finder, so no automation prompt.
  if LEGACY="$legacy" osascript -l JavaScript \
      -e 'ObjC.import("Foundation")' \
      -e 'var path = $.NSProcessInfo.processInfo.environment.objectForKey("LEGACY").js' \
      -e '$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), null, null) ? "ok" : "no"' \
      2>/dev/null | grep -qx ok; then
    note "Moved $LEGACY_APP_NAME.app to the Trash."
    return 0
  fi
  # No Trash: rename it so it is no longer an app bundle anyone can open.
  kept="$legacy.previous"
  [[ ! -e "$kept" ]] || kept="$legacy.previous.$(date +%s)"
  if mv "$legacy" "$kept" 2>/dev/null; then
    note "Kept $LEGACY_APP_NAME.app as $kept."
  else
    note "Could not move $legacy; quit it and remove it by hand"
  fi
}
retire_legacy_app

open "$APP" 2>/dev/null || die "installed $NEW_VERSION, but Starlings could not be reopened"
note "Installed $NEW_VERSION."
