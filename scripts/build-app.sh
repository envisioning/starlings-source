#!/usr/bin/env bash
# Build a distributable Starlings.app (Headroom-style Developer ID + notarize).
#
#   ./scripts/build-app.sh                 # Debug → dist/ (ad-hoc sign)
#   ./scripts/build-app.sh --release       # Release; Developer ID if
#                                          # MEET_SIGN_IDENTITY is set, else ad-hoc
#   ./scripts/build-app.sh --release --notarize
#
# Versioning (see scripts/version-env.sh):
#   MARKETING_VERSION        ← VERSION
#   CURRENT_PROJECT_VERSION  ← git rev-list --count HEAD
#
# Notarize env:
#   MEET_SIGN_IDENTITY     e.g. "Developer ID Application: … (TEAMID)";
#                          found in the login keychain when there is one
#   MEET_NOTARY_PROFILE    notarytool keychain profile (default: starlings),
#                          used when the three APPLE_API_* below are unset
#   APPLE_API_KEY_PATH     path to AuthKey_XXXX.p8  (or APPLE_API_KEY contents)
#   APPLE_API_KEY_ID
#   APPLE_API_ISSUER_ID
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=version-env.sh
source "$ROOT/scripts/version-env.sh"
# shellcheck source=app-names.sh
source "$ROOT/scripts/app-names.sh"

CONFIG=Debug
NOTARIZE=0
for arg in "$@"; do
  case "$arg" in
    --release) CONFIG=Release ;;
    --debug) CONFIG=Debug ;;
    --notarize) NOTARIZE=1 ;;
    -h|--help)
      cat <<'EOF'
Build Starlings.app for distribution.

  ./scripts/build-app.sh
  ./scripts/build-app.sh --release
  ./scripts/build-app.sh --release --notarize
EOF
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$NOTARIZE" -eq 1 && "$CONFIG" != "Release" ]]; then
  echo "error: --notarize requires --release" >&2
  exit 1
fi

command -v xcodebuild >/dev/null || { echo "error: Xcode required" >&2; exit 1; }
command -v xcodegen >/dev/null || { echo "error: xcodegen required (brew install xcodegen)" >&2; exit 1; }

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

cd "$ROOT"
"$ROOT/scripts/version-env.sh" --write-xcconfig
xcodegen generate

DERIVED="$ROOT/.build-app"
if [[ "$CONFIG" == "Release" ]]; then
  DERIVED="$ROOT/.build-app-release"
fi
# shellcheck source=source-packages.sh
. "$ROOT/scripts/source-packages.sh"
seed_source_packages "$DERIVED"

echo "Building $STARLINGS_APP_NAME $MEET_VERSION ($MEET_BUILD) [$CONFIG]"

"$ROOT/scripts/build-lock" "starlings build-app" xcodebuild \
  -project Starlings.xcodeproj \
  -scheme Starlings \
  -configuration "$CONFIG" \
  -derivedDataPath "$DERIVED" \
  -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO \
  "MARKETING_VERSION=$MEET_VERSION" \
  "CURRENT_PROJECT_VERSION=$MEET_BUILD" \
  build

APP_SRC=$(find "$DERIVED/Build/Products/$CONFIG" -maxdepth 1 -name "$STARLINGS_APP" | head -1)
[[ -n "$APP_SRC" && -d "$APP_SRC" ]] || { echo "error: $STARLINGS_APP not found under $DERIVED" >&2; exit 1; }

DIST="$ROOT/dist"
rm -rf "$DIST"
mkdir -p "$DIST"
ditto "$APP_SRC" "$DIST/$STARLINGS_APP"
APP="$DIST/$STARLINGS_APP"
ENTITLEMENTS="$ROOT/Config/Starlings.entitlements"

# Xcode's ARCHS setting controls targets we compile, but the LiveKit XCFrameworks
# and the embedded CLI can still arrive as universal binaries. Meet is Apple
# Silicon-only, so remove every Intel slice before signing the bundle.
thin_arm64_payloads() {
  local binary archs tmp mode
  while IFS= read -r -d '' binary; do
    archs="$(lipo -archs "$binary" 2>/dev/null || true)"
    [[ -n "$archs" ]] || continue
    case " $archs " in
      *" arm64 "*) ;;
      *)
        echo "error: $binary has no arm64 slice" >&2
        return 1
        ;;
    esac
    [[ "$archs" == "arm64" ]] && continue
    tmp="${binary}.arm64"
    mode="$(stat -f '%Lp' "$binary")"
    lipo "$binary" -thin arm64 -output "$tmp"
    chmod "$mode" "$tmp"
    mv -f "$tmp" "$binary"
  done < <(find "$APP/Contents" -type f \( -perm -111 -o -name '*.dylib' \) -print0)
}

assert_arm64_payloads() {
  local binary archs
  while IFS= read -r -d '' binary; do
    archs="$(lipo -archs "$binary" 2>/dev/null || true)"
    [[ -z "$archs" || "$archs" == "arm64" ]] || {
      echo "error: Intel slice remains in $binary ($archs)" >&2
      return 1
    }
  done < <(find "$APP/Contents" -type f \( -perm -111 -o -name '*.dylib' \) -print0)
}

thin_arm64_payloads

# Ad-hoc, but inside-out and with the entitlements — the same walk the
# Developer ID path does, for the same reason: LiveKit's nested frameworks have
# to be sealed as bundles before the outer app, or the outer signature fails
# with "code object is not signed at all In subcomponent: ….framework". This
# used to be a one-line `codesign … || true`, which meant every local build
# quietly shipped *unsigned* — so it ran without its entitlements, in the wrong
# container, with camera and microphone prompts behaving unlike the real app.
# Restricted entitlements (associated domains, for Keep's passkeys) need a
# provisioning profile that grants them; a Mac app carrying one without a
# profile is killed by the kernel at launch (exit 137, "Launchd job spawn
# failed", error 163). Neither signing path embeds a profile yet, so both
# strip the key. When a Developer ID profile with Associated Domains exists
# and the Developer ID path embeds it, that path stops calling this
# (docs/KEEP.md).
strip_restricted_entitlements() {
  local stripped
  stripped="$(mktemp -t meet-entitlements).plist"
  cp "$ENTITLEMENTS" "$stripped"
  /usr/libexec/PlistBuddy -c 'Delete :com.apple.developer.associated-domains' "$stripped" 2>/dev/null || true
  ENTITLEMENTS="$stripped"
}

sign_adhoc() {
  strip_restricted_entitlements

  if [[ -d "$APP/Contents/Frameworks" ]]; then
    while IFS= read -r fw; do
      codesign --force --sign - "$fw"
    done < <(
      find "$APP/Contents/Frameworks" -name '*.framework' -print \
        | awk '{ print length, $0 }' | sort -nr | cut -d' ' -f2-
    )
  fi

  while IFS= read -r -d '' binary; do
    case "$binary" in
      */Frameworks/*.framework/*) continue ;;
    esac
    codesign --force --sign - "$binary"
  done < <(find "$APP/Contents" -type f \( -perm -111 -o -name '*.dylib' \) -print0)

  codesign --force --sign - --entitlements "$ENTITLEMENTS" "$APP"
  codesign --verify --deep --strict "$APP"
}

sign_developer_id() {
  local identity="${MEET_SIGN_IDENTITY:-}"
  strip_restricted_entitlements
  if [[ -z "$identity" ]]; then
    echo "error: MEET_SIGN_IDENTITY required for --notarize" >&2
    echo "  e.g. export MEET_SIGN_IDENTITY='Developer ID Application: Name (TEAMID)'" >&2
    exit 1
  fi

  # Inside-out. Nested LiveKit frameworks must be sealed as bundles before the
  # outer app — signing loose Mach-O inside them leaves
  # "code object is not signed at all In subcomponent: ….framework".
  if [[ -d "$APP/Contents/Frameworks" ]]; then
    while IFS= read -r fw; do
      codesign --force --options runtime --timestamp \
        --sign "$identity" \
        "$fw"
    done < <(
      find "$APP/Contents/Frameworks" -name '*.framework' -print \
        | awk '{ print length, $0 }' | sort -nr | cut -d' ' -f2-
    )
  fi

  while IFS= read -r -d '' binary; do
    case "$binary" in
      */Frameworks/*.framework/*) continue ;;
    esac
    codesign --force --options runtime --timestamp \
      --sign "$identity" \
      "$binary"
  done < <(find "$APP/Contents" -type f \( -perm -111 -o -name '*.dylib' \) -print0)

  codesign --force --options runtime --timestamp \
    --sign "$identity" \
    --entitlements "$ENTITLEMENTS" \
    "$APP"

  codesign --verify --deep --strict --verbose=2 "$APP"
}

notarize_and_staple() {
  local key_path="${APPLE_API_KEY_PATH:-}"
  local key_id="${APPLE_API_KEY_ID:-}"
  local issuer="${APPLE_API_ISSUER_ID:-}"
  local submit_zip="$DIST/Meet-notarize.zip"

  # On a Mac, the credentials live in the keychain, not in the environment:
  # the `starlings` profile, an App Store Connect API key of its own. Not
  # `notarize`: an old Apple ID item under that name wins the lookup and
  # Apple refuses it (2026-10-04). Store it once with
  #   xcrun notarytool store-credentials starlings --key … --key-id … --issuer …
  if [[ -z "$key_id" || -z "$issuer" ]]; then
    local profile="${MEET_NOTARY_PROFILE:-starlings}"
    ditto -c -k --keepParent "$APP" "$submit_zip"
    echo "Submitting to Apple notarization (keychain profile '$profile')…"
    xcrun notarytool submit "$submit_zip" --keychain-profile "$profile" --wait || {
      echo "error: notarization failed. If the profile is missing, store it once:" >&2
      echo "  xcrun notarytool store-credentials $profile --key <AuthKey.p8> --key-id <id> --issuer <issuer>" >&2
      exit 1
    }
    xcrun stapler staple "$APP"
    xcrun stapler validate "$APP"
    rm -f "$submit_zip"
    return
  fi

  local tmp_key=""
  if [[ -z "$key_path" ]]; then
    if [[ -z "${APPLE_API_KEY:-}" ]]; then
      echo "error: set APPLE_API_KEY_PATH or APPLE_API_KEY (.p8 contents) for --notarize" >&2
      exit 1
    fi
    tmp_key="$(mktemp -t AuthKey).p8"
    printf '%s\n' "$APPLE_API_KEY" > "$tmp_key"
    key_path="$tmp_key"
  fi

  ditto -c -k --keepParent "$APP" "$submit_zip"

  echo "Submitting to Apple notarization…"
  xcrun notarytool submit "$submit_zip" \
    --key "$key_path" \
    --key-id "$key_id" \
    --issuer "$issuer" \
    --wait

  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  rm -f "$submit_zip"
  [[ -n "$tmp_key" ]] && rm -f "$tmp_key"
}

# Developer ID whenever the identity is at hand, not only for --notarize. An
# ad-hoc signature is a different app to the keychain on every build, so each
# rebuild asked for the login password once per stored item — four times. A
# Developer ID signature carries the Team ID, so "Always Allow" survives a
# rebuild. Notarization is still opt-in; a local install does not need it.
if [[ -z "${MEET_SIGN_IDENTITY:-}" ]]; then
  # Take the one Developer ID Application certificate in the login keychain
  # when there is exactly one; two would be a choice this script cannot make.
  found=$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | sort -u)
  if [[ -n "$found" && $(printf '%s\n' "$found" | wc -l) -eq 1 ]]; then
    export MEET_SIGN_IDENTITY="$found"
    echo "Signing with $MEET_SIGN_IDENTITY"
  fi
fi

if [[ "$NOTARIZE" -eq 1 ]]; then
  sign_developer_id
  notarize_and_staple
elif [[ -n "${MEET_SIGN_IDENTITY:-}" ]]; then
  sign_developer_id
else
  sign_adhoc
fi

assert_arm64_payloads

ZIP="$DIST/$STARLINGS_MAC_ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
printf '%s\n' "$MEET_VERSION+$MEET_BUILD" > "$DIST/version.txt"

# A bundle that shipped without the updater can never self-update.
UPDATER="$APP/Contents/Resources/update-app.sh"
[[ -f "$UPDATER" ]] || { echo "error: update-app.sh missing from app Resources" >&2; exit 1; }
# The updater refuses to run without the team it verifies against.
if [[ -n "${MEET_SIGN_IDENTITY:-}" ]]; then
  [[ -n "$(plutil -extract STARLINGS_TEAM_ID raw -o - "$APP/Contents/Info.plist" 2>/dev/null)" ]] \
    || { echo "error: a signed build needs DEVELOPMENT_TEAM (Config/Starlings.xcconfig)" >&2; exit 1; }
fi

echo "Built $ZIP"
