#!/usr/bin/env bash
# The app's names for the release and smoke scripts.
# Source it: `source "$ROOT/scripts/app-names.sh"`.
#
# The same bundle ID is NATIVE_APP_BUNDLE_ID in
# packages/contracts/src/native-app.ts and STARLINGS_BUNDLE_ID in project.yml;
# change all three together. scripts/update-app.sh does not source this file:
# it runs from inside the installed bundle, where this file is not.

# The product: Starlings.app, its executable and its process name.
STARLINGS_APP_NAME="Starlings"
STARLINGS_APP="$STARLINGS_APP_NAME.app"
STARLINGS_BUNDLE_ID="com.starlingshq.app"
STARLINGS_APP_GROUP="group.$STARLINGS_BUNDLE_ID"

# The iOS profiles, one per bundle, as they are named in App Store Connect.
STARLINGS_IOS_PROFILE_PREFIX="$STARLINGS_APP_NAME"

# The notarized Mac zip, its symbols, and the update feed the app reads
# (docs/UPDATER.md). The Meet feed, latest.json, stays on the last Meet
# release so a Meet install is never offered a Starlings build.
STARLINGS_MAC_ZIP="$STARLINGS_APP_NAME-macOS.zip"
STARLINGS_MAC_DSYMS="$STARLINGS_APP_NAME-macOS-dSYMs"
STARLINGS_FEED_FILE="starlings.json"
LEGACY_FEED_FILE="latest.json"

# Where the app writes on the Mac (Sources/AppFolders.swift).
STARLINGS_SUPPORT_DIR="$HOME/Library/Application Support/$STARLINGS_APP_NAME"
STARLINGS_LOGS_DIR="$HOME/Library/Logs/$STARLINGS_APP_NAME"

export STARLINGS_APP_NAME STARLINGS_APP STARLINGS_BUNDLE_ID STARLINGS_APP_GROUP \
  STARLINGS_MAC_ZIP STARLINGS_MAC_DSYMS \
  STARLINGS_IOS_PROFILE_PREFIX STARLINGS_FEED_FILE LEGACY_FEED_FILE STARLINGS_SUPPORT_DIR STARLINGS_LOGS_DIR
