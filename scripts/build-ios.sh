#!/usr/bin/env bash
# Archive the Starlings iPhone/iPad target and optionally publish it to
# TestFlight. CI always uses --manual-signing: an App Store Connect API key
# cannot create an Apple Distribution identity and must not be allowed to mint
# development certificates on every build.
#
#   ./scripts/build-ios.sh --manual-signing
#   ./scripts/build-ios.sh --manual-signing --upload
#
# Required for --manual-signing:
#   IOS_APP_STORE_PROFILE_NAME            (default: "Starlings App Store")
#   IOS_ACTIVITIES_APP_STORE_PROFILE_NAME (default: "Starlings Activities App Store")
#   IOS_SHARE_APP_STORE_PROFILE_NAME      (default: "Starlings Share App Store")
#   IOS_WATCH_APP_STORE_PROFILE_NAME      (default: "Starlings Watch App Store")
#   IOS_WATCH_WIDGETS_APP_STORE_PROFILE_NAME (default: "Starlings Watch Widgets App Store")
# For --upload (without APPLE_API_KEY, asc uses its keychain profile):
#   APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER_ID
#   ASC_APP_ID (the Starlings App Store record; required),
#   ASC_TESTFLIGHT_GROUP (default: Public)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=version-env.sh
source "$ROOT/scripts/version-env.sh"
# shellcheck source=app-names.sh
source "$ROOT/scripts/app-names.sh"

MANUAL_SIGNING=0
UPLOAD=0
for arg in "$@"; do
  case "$arg" in
    --manual-signing) MANUAL_SIGNING=1 ;;
    --upload) UPLOAD=1 ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

[[ "$MANUAL_SIGNING" -eq 1 ]] || {
  echo "error: use --manual-signing for an App Store/TestFlight archive" >&2
  exit 1
}
command -v xcodebuild >/dev/null || { echo "error: Xcode is required" >&2; exit 1; }
command -v xcodegen >/dev/null || { echo "error: XcodeGen is required" >&2; exit 1; }

cd "$ROOT"

# The team comes from the overlay (Config/Starlings.xcconfig). The default names
# none, and an App Store archive cannot be made without one.
TEAM_ID="$("$ROOT/scripts/identity-setting.sh" DEVELOPMENT_TEAM)"
[[ -n "$TEAM_ID" ]] || { echo "error: no DEVELOPMENT_TEAM in Config/Envisioning/Identity.xcconfig" >&2; exit 1; }

PROFILE_NAME="${IOS_APP_STORE_PROFILE_NAME:-$STARLINGS_IOS_PROFILE_PREFIX App Store}"
BUNDLE_ID="$STARLINGS_BUNDLE_ID"
# The Live Activity widget extension is a second bundle, so it needs a second
# App Store profile. Both must exist in the portal or the archive fails.
ACTIVITIES_BUNDLE_ID="$STARLINGS_BUNDLE_ID.activities"
ACTIVITIES_PROFILE_NAME="${IOS_ACTIVITIES_APP_STORE_PROFILE_NAME:-$STARLINGS_IOS_PROFILE_PREFIX Activities App Store}"
# xcodebuild command-line settings apply to every target, so a single
# PROVISIONING_PROFILE_SPECIFIER would hand the app's profile to the extension.
# The names go into the generated project per target instead — project.yml
# reads these two variables, and Debug is untouched (it signs automatically).
export IOS_APP_STORE_PROFILE_NAME="$PROFILE_NAME"
export IOS_ACTIVITIES_APP_STORE_PROFILE_NAME="$ACTIVITIES_PROFILE_NAME"
# The watch app and its complication are two more bundles, two more profiles.
# Both App IDs carry the App Group ($STARLINGS_APP_GROUP), assigned in the
# portal: turning the capability on is not enough.
WATCH_BUNDLE_ID="$STARLINGS_BUNDLE_ID.watchkitapp"
WATCH_PROFILE_NAME="${IOS_WATCH_APP_STORE_PROFILE_NAME:-$STARLINGS_IOS_PROFILE_PREFIX Watch App Store}"
WATCH_WIDGETS_BUNDLE_ID="$STARLINGS_BUNDLE_ID.watchkitapp.widgets"
WATCH_WIDGETS_PROFILE_NAME="${IOS_WATCH_WIDGETS_APP_STORE_PROFILE_NAME:-$STARLINGS_IOS_PROFILE_PREFIX Watch Widgets App Store}"
# The share extension (Save to Docs from Safari) is one more bundle and one
# more profile. Its App ID carries the same App Group.
SHARE_BUNDLE_ID="$STARLINGS_BUNDLE_ID.share"
SHARE_PROFILE_NAME="${IOS_SHARE_APP_STORE_PROFILE_NAME:-$STARLINGS_IOS_PROFILE_PREFIX Share App Store}"
export IOS_SHARE_APP_STORE_PROFILE_NAME="$SHARE_PROFILE_NAME"
export IOS_WATCH_APP_STORE_PROFILE_NAME="$WATCH_PROFILE_NAME"
export IOS_WATCH_WIDGETS_APP_STORE_PROFILE_NAME="$WATCH_WIDGETS_PROFILE_NAME"

# Config/Version.xcconfig is gitignored and generated, and every target names it
# as its config file — so on a clean checkout `xcodegen generate` fails spec
# validation before it ever compiles anything. build-app.sh has always written
# it first; this script did not, which is why it only ever worked on a machine
# that had already built the Mac app. See docs/RELEASING.md ("Versioning").
"$ROOT/scripts/version-env.sh" --write-xcconfig
xcodegen generate

DERIVED="$ROOT/.build-ios"
ARCHIVE="$DERIVED/Starlings.xcarchive"
EXPORT_DIR="$DERIVED/export"
DIST="$ROOT/dist"
EXPORT_OPTIONS="$DERIVED/ExportOptions.plist"

rm -rf "$DERIVED"
mkdir -p "$DERIVED" "$DIST"
# Each archive starts from an empty folder; clone the shared Swift packages
# instead of fetching them again (source-packages.sh).
# shellcheck source=source-packages.sh
. "$ROOT/scripts/source-packages.sh"
seed_source_packages "$DERIVED/DerivedData"
cp "$ROOT/Config/StarlingsiOS-ExportOptions.plist" "$EXPORT_OPTIONS"

# Meet ships two iOS bundles: the app and the Live Activity widget extension.
# Both profiles are fetched into both provisioning profile search paths by the
# Release workflow before this script runs.
/usr/libexec/PlistBuddy -c "Add :teamID string ${TEAM_ID}" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c 'Set :signingStyle manual' "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c 'Add :signingCertificate string Apple Distribution' "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c 'Add :provisioningProfiles dict' "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy \
  -c "Add :provisioningProfiles:${BUNDLE_ID} string ${PROFILE_NAME}" \
  "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy \
  -c "Add :provisioningProfiles:${ACTIVITIES_BUNDLE_ID} string ${ACTIVITIES_PROFILE_NAME}" \
  "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy \
  -c "Add :provisioningProfiles:${SHARE_BUNDLE_ID} string ${SHARE_PROFILE_NAME}" \
  "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy \
  -c "Add :provisioningProfiles:${WATCH_BUNDLE_ID} string ${WATCH_PROFILE_NAME}" \
  "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy \
  -c "Add :provisioningProfiles:${WATCH_WIDGETS_BUNDLE_ID} string ${WATCH_WIDGETS_PROFILE_NAME}" \
  "$EXPORT_OPTIONS"

VERSION_ARGS=(
  "MARKETING_VERSION=$MEET_VERSION"
  "CURRENT_PROJECT_VERSION=$MEET_BUILD"
  "DEVELOPMENT_TEAM=$TEAM_ID"
  'CODE_SIGN_STYLE=Manual'
  'CODE_SIGN_IDENTITY=Apple Distribution'
)

echo "Archiving $STARLINGS_APP_NAME iOS $MEET_VERSION ($MEET_BUILD) with profiles '$PROFILE_NAME' + '$ACTIVITIES_PROFILE_NAME' + '$WATCH_PROFILE_NAME' + '$WATCH_WIDGETS_PROFILE_NAME'"
"$ROOT/scripts/build-lock" "starlings build-ios" xcodebuild archive \
  -project Starlings.xcodeproj \
  -scheme Starlings-iOS \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -derivedDataPath "$DERIVED/DerivedData" \
  "${VERSION_ARGS[@]}"

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTIONS"

IPA="$(find "$EXPORT_DIR" -maxdepth 1 -name '*.ipa' -print -quit)"
[[ -n "$IPA" && -f "$IPA" ]] || {
  echo "error: no IPA exported under $EXPORT_DIR" >&2
  exit 1
}
cp "$IPA" "$DIST/Starlings-iOS.ipa"
cat > "$DIST/ios-version.txt" <<EOF
version=$MEET_VERSION
build=$MEET_BUILD
bundle=$BUNDLE_ID
EOF
echo "Exported $DIST/Starlings-iOS.ipa ($MEET_VERSION+$MEET_BUILD)"

[[ "$UPLOAD" -eq 1 ]] || exit 0

# The Starlings record in App Store Connect, and its external public group.
# 6821608926 is the Starlings record (com.starlingshq.app). 6800228716 is the
# Meet record, which refuses a build with another bundle ID.
ASC_APP_ID="${ASC_APP_ID:-6821608926}"
[[ -n "$ASC_APP_ID" ]] || { echo "error: set ASC_APP_ID to the Starlings App Store Connect app id" >&2; exit 1; }
ASC_TESTFLIGHT_GROUP="${ASC_TESTFLIGHT_GROUP:-Public}"
command -v asc >/dev/null || { echo "error: asc is required (brew install asc)" >&2; exit 1; }

# CI passes the API key in the environment. On MZ's Mac (cut-release.sh) asc
# uses the key in its own keychain profile.
if [[ -n "${APPLE_API_KEY:-}" ]]; then
  for variable in APPLE_API_KEY_ID APPLE_API_ISSUER_ID; do
    [[ -n "${!variable:-}" ]] || { echo "error: $variable is required with APPLE_API_KEY" >&2; exit 1; }
  done
  KEY_PATH="$DERIVED/AuthKey.p8"
  printf '%s\n' "$APPLE_API_KEY" > "$KEY_PATH"
  chmod 600 "$KEY_PATH"
  trap 'rm -f "$KEY_PATH"' EXIT
  export ASC_KEY_ID="$APPLE_API_KEY_ID"
  export ASC_ISSUER_ID="$APPLE_API_ISSUER_ID"
  export ASC_PRIVATE_KEY_PATH="$KEY_PATH"
  export ASC_BYPASS_KEYCHAIN=true
fi

echo "Uploading $MEET_VERSION+$MEET_BUILD to TestFlight…"
asc builds upload --app "$ASC_APP_ID" --ipa "$DIST/Starlings-iOS.ipa" --wait --output table
asc builds update \
  --app "$ASC_APP_ID" \
  --latest \
  --uses-non-exempt-encryption=false \
  --output table
# --submit asks Apple to review the build for the external public group. It is
# still Apple, not CI, that approves beta review; once approved, the stable
# public TestFlight link immediately exposes this build to its group.
asc builds add-groups \
  --app "$ASC_APP_ID" \
  --latest \
  --group "$ASC_TESTFLIGHT_GROUP" \
  --submit \
  --confirm \
  --output table

echo "TestFlight submission finished ($MEET_VERSION+$MEET_BUILD → $ASC_TESTFLIGHT_GROUP)."
