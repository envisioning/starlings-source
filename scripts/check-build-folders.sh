#!/bin/sh
# Only the build folders the scripts name live at the repo root:
# DerivedData (verify.sh), .build-app and .build-app-release (build-app.sh)
# and .build-ios (build-ios.sh). One-off DerivedData-* and .build-* folders
# held 25 GB in one checkout on 2026-10-11, and no script read them.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

stray=''
for entry in DerivedData?* .build-* .derivedData* SignedDerivedData; do
  [ -d "$entry" ] || continue
  case "$entry" in
    .build-app|.build-app-release|.build-ios) ;;
    *) stray="$stray $entry" ;;
  esac
done

if [ -n "$stray" ]; then
  printf 'build folders no script reads:%s\n' "$stray" >&2
  printf 'Delete them (rm -rf%s) and build into DerivedData, .build-app, .build-app-release or .build-ios.\n' "$stray" >&2
  exit 1
fi
