#!/usr/bin/env bash
# Install the Starlings App Store provisioning profiles from App Store Connect: one
# per bundle (the app, the Live Activity extension, the share extension, the
# watch app and its complication). Keeping them in ASC rather than as opaque
# secrets makes renewal auditable.
#
#   ./scripts/install-ios-profiles.sh
#
# asc reads its credentials from the environment (ASC_KEY_ID, ASC_ISSUER_ID,
# ASC_PRIVATE_KEY_PATH; release.yml) or, on MZ's Mac, from its keychain
# profile. Used by release.yml and by cut-release.sh.
set -euo pipefail
# shellcheck source=app-names.sh
source "$(cd "$(dirname "$0")" && pwd)/app-names.sh"

command -v asc >/dev/null || { echo "error: asc is required (brew install asc)" >&2; exit 1; }
command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }

LIST="$(asc profiles list --limit 200 --output json)"
install_profile() {
  local name="$1" bundle="$2" id
  id="$(jq -r --arg name "$name" '.data[] | select(.attributes.name == $name and .attributes.profileState == "ACTIVE") | .id' <<<"$LIST" | head -1)"
  [[ -n "$id" ]] || {
    echo "error: no active '$name' profile. Create an App Store profile for $bundle that includes this Apple Distribution certificate." >&2
    # Say what is actually there. Matching is by exact name, so the usual
    # cause is a profile that exists under a different one, and a bare "not
    # found" sends you back to the portal guessing.
    echo "active profiles visible to this key:" >&2
    jq -r '.data[] | select(.attributes.profileState == "ACTIVE")
           | "  - \(.attributes.name)  [\(.attributes.profileType)]"' <<<"$LIST" >&2 \
      || echo "  (none)" >&2
    exit 1
  }
  for destination in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
    mkdir -p "$destination"
    # asc refuses to overwrite, and a second release finds the file there.
    rm -f "$destination/$id.mobileprovision"
    asc profiles download --id "$id" --output "$destination/$id.mobileprovision" >/dev/null
  done
}
# The names build-ios.sh asks for (: "Starlings …", not "Meet …").
install_profile "$STARLINGS_IOS_PROFILE_PREFIX App Store" "$STARLINGS_BUNDLE_ID"
install_profile "$STARLINGS_IOS_PROFILE_PREFIX Activities App Store" "$STARLINGS_BUNDLE_ID.activities"
install_profile "$STARLINGS_IOS_PROFILE_PREFIX Share App Store" "$STARLINGS_BUNDLE_ID.share"
install_profile "$STARLINGS_IOS_PROFILE_PREFIX Watch App Store" "$STARLINGS_BUNDLE_ID.watchkitapp"
install_profile "$STARLINGS_IOS_PROFILE_PREFIX Watch Widgets App Store" "$STARLINGS_BUNDLE_ID.watchkitapp.widgets"
echo "Installed the five $STARLINGS_APP_NAME App Store profiles."
