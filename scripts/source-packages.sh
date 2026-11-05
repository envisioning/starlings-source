# One copy of the Swift packages for every worktree. Sourced by
# verify.sh, build-app.sh and build-ios.sh.
#
# Each worktree resolved its own `SourcePackages` (0.8 GB), and a fresh
# worktree had none, so `pnpm verify` failed until someone copied them in.
# Now the gate keeps the last good set in ~/Library/Caches/starlings, and a
# build that has none gets an APFS clone of it (`cp -c`): one copy on disk,
# but each build still writes only its own folder. A shared folder that two
# builds write at once is what AGENTS.md forbids, so this never symlinks.
#
#   MEET_SOURCE_PACKAGES_CACHE  where the shared set lives

source_packages_cache=${MEET_SOURCE_PACKAGES_CACHE:-$HOME/Library/Caches/starlings/SourcePackages}

# Give <derived data folder> the shared packages when it has none, and point
# their binary artifacts at this folder.
seed_source_packages() {
  if [ ! -d "$1/SourcePackages" ] && [ -d "$source_packages_cache" ]; then
    mkdir -p "$1"
    cp -cR "$source_packages_cache" "$1/SourcePackages" 2>/dev/null \
      || cp -R "$source_packages_cache" "$1/SourcePackages"
    printf 'source packages: cloned %s into %s\n' "$source_packages_cache" "$1/SourcePackages"
  fi
  rehome_source_packages "$1"
}

# workspace-state.json names each XCFramework by the absolute path of the
# build that resolved it. A clone kept the old path, so the build looked in
# another worktree and failed with "There is no XCFramework found"
# (2026-11-01, on mini-4p). Rewrite those paths to this folder.
rehome_source_packages() {
  state="$1/SourcePackages/workspace-state.json"
  [ -f "$state" ] || return 0
  here=$(CDPATH= cd -- "$1/SourcePackages" && pwd -P) || return 0
  sed -i '' -E "s|\"path\" : \"[^\"]*/SourcePackages/artifacts/|\"path\" : \"$here/artifacts/|g" "$state"
}

# After a build passed, keep <derived data folder>'s packages as the shared
# set. Called under the gate's `xcode` lock, so two gates never write it at
# once; the swap is two renames, so a build that seeds meanwhile sees the
# old set or the new one, never half of either.
store_source_packages() {
  [ -d "$1/SourcePackages/checkouts" ] || return 0
  parent=$(dirname "$source_packages_cache")
  mkdir -p "$parent"
  staging="$source_packages_cache.new.$$"
  rm -rf "$staging"
  cp -cR "$1/SourcePackages" "$staging" 2>/dev/null || cp -R "$1/SourcePackages" "$staging" || { rm -rf "$staging"; return 0; }
  rm -rf "$source_packages_cache.old"
  [ -d "$source_packages_cache" ] && mv "$source_packages_cache" "$source_packages_cache.old"
  mv "$staging" "$source_packages_cache"
  rm -rf "$source_packages_cache.old"
}
