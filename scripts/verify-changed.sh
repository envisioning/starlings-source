#!/bin/sh
# A session's gate: only what this branch's changes can break (2026-10-07).
#
# The full gate (`pnpm verify`) runs once per landing, in the land queue
# (scripts/land-queue.sh). A session runs this instead.
#
# Two passes:
#   1. Every cheap check (generated files, fixtures, strings, docs), run to
#      the end, with every failure listed at once and its fix. The heavy pass
#      does not start while one fails: a stale doc date never costs a build.
#   2. The heavy checks the changed paths reach: contract tests, the API
#      typecheck and tests, the web typecheck, tests and builds, the extension
#      tests, and the Apple builds and tests (verify.sh --apple).
#
# "Changed" is every file that differs from where this branch left
# origin/main, committed or not, plus untracked files.
#
#   pnpm verify:changed            the gate
#   pnpm verify:changed --list     print the changed files and the plan, run nothing
#
#   MEET_CHANGED_BASE  the ref to compare with (default origin/main)
set -u

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
. ./scripts/gate-lock.sh
gate_low_priority "$repo_dir/scripts/verify-changed.sh" "$@"

list_only=0
case "${1:-}" in
  --list) list_only=1 ;;
  '') ;;
  *) printf 'usage: verify-changed.sh [--list]\n' >&2; exit 2 ;;
esac

base_ref=${MEET_CHANGED_BASE:-origin/main}
base=$(git merge-base HEAD "$base_ref" 2>/dev/null) || {
  printf 'verify:changed: no merge base with %s; run git fetch origin\n' "$base_ref" >&2
  exit 2
}
changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)
if [ -z "$changed" ]; then
  printf 'verify:changed: nothing differs from %s\n' "$base_ref"
  exit 0
fi

touches() { printf '%s\n' "$changed" | grep -qE "$1"; }

contracts=0; api=0; web=0; site=0; ops=0; marketing_worker=0; extension=0; scripts=0; apple=0; android=0; docs_service=0; keep_service=0
touches '^(packages/contracts|standard)/' && contracts=1
touches '^(android/|fixtures/|scripts/verify-android\.sh|packages/contracts/src/upcoming-config\.json)' && android=1
touches '^services/control-plane/' && api=1
touches '^web/(src|public|index\.html|vite\.config|vitest\.config|tsconfig|package\.json)' && web=1
touches '^web/marketing/' && site=1
touches '^web/ops/' && ops=1
touches '^services/marketing/' && marketing_worker=1
touches '^services/docs/' && docs_service=1
touches '^services/keep/' && keep_service=1
# The marketing Worker loads native-app.ts with plain Node (no resolver).
touches '^packages/contracts/src/native-app\.ts$' && marketing_worker=1
touches '^extension/' && extension=1
touches '^scripts/' && scripts=1
touches '^(Sources|Tests|iOS|iOSActivities|iOSShare|iOSTests|watchOS|watchOSWidgets|Resources|Config|CLI|project\.yml|packages/contracts/swift)/?' && apple=1
# A contract shape reaches the Worker, the web and the Swift clients.
if [ "$contracts" = 1 ]; then api=1; web=1; apple=1; fi
# A dependency change can move anything. The root package.json holds
# scripts as well as dependencies: its scripts are checked with the others.
if touches '^(pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig)'; then contracts=1; api=1; web=1; docs_service=1; keep_service=1; fi
touches '^package\.json$' && scripts=1

plan="cheap checks"
[ "$scripts" = 1 ] && plan="$plan, script tests"
[ "$contracts" = 1 ] && plan="$plan, contract tests"
[ "$api" = 1 ] && plan="$plan, API typecheck and tests"
[ "$web" = 1 ] && plan="$plan, web typecheck, tests and build"
[ "$site" = 1 ] && plan="$plan, site typecheck and build"
[ "$ops" = 1 ] && plan="$plan, ops build"
[ "$marketing_worker" = 1 ] && plan="$plan, site Worker tests"
[ "$docs_service" = 1 ] && plan="$plan, Docs verify"
[ "$keep_service" = 1 ] && plan="$plan, Keep verify"
[ "$extension" = 1 ] && plan="$plan, extension tests"
[ "$apple" = 1 ] && plan="$plan, Mac tests and iOS build"
[ "$android" = 1 ] && plan="$plan, Android build"
printf 'verify:changed: %s files differ from %s\nverify:changed: %s\n' "$(printf '%s\n' "$changed" | wc -l | tr -d ' ')" "$base_ref" "$plan"
if [ "$list_only" = 1 ]; then
  printf '%s\n' "$changed"
  exit 0
fi

# Pass 1. Each check runs whatever the one before it said.
failed=''
cheap() {
  fix=$1; shift
  if ! "$@" >"$tmp_out" 2>&1; then
    printf '\n✗ %s\n' "$*" >&2
    grep -v '^sync-string-catalog: stale\|^sync-web-strings: stale' "$tmp_out" | tail -n 15 >&2
    failed="$failed
  $* -> $fix"
  fi
}
tmp_out=$(mktemp)
trap 'rm -f "$tmp_out"' EXIT

cheap 'pnpm openapi:gen' pnpm -s openapi:check
cheap 'node scripts/check-client-routes.mjs --write' node ./scripts/check-client-routes.mjs --check
cheap 'renumber or mark the migration' node ./scripts/check-migrations.mjs
cheap 'node scripts/sync-core-fixtures.mjs' node ./scripts/sync-core-fixtures.mjs --check
cheap 'fix the fixture it names' node --import ./scripts/node-ts-resolve.mjs ./scripts/check-central-auth-fixture.mjs
# A kit or sign-in fixture change in web/ reaches the copies Docs and Keep hold.
cheap 'fix the file it names' node ./scripts/check-json-satisfies.mjs
cheap 'use the shared time format' ./scripts/check-time-format.sh
cheap 'read the request policy registry' ./scripts/check-request-policy.sh
cheap 'read from the registry, not a copy' node ./scripts/check-mirrors.mjs
[ "${MEET_L10N_GATES:-0}" != 1 ] || cheap 'node scripts/sync-web-strings.mjs, then translate' node ./scripts/sync-web-strings.mjs --check --translated pt-BR
[ "${MEET_L10N_GATES:-0}" != 1 ] || cheap 'wrap the text in t() or String(localized:)' ./scripts/check-l10n-literals.py
cheap 'fix the copy it names' node ./scripts/check-copy.mjs
cheap 'give the control a hover state' node ./scripts/check-hover.mjs
cheap 'draw it with shadcn' node ./scripts/check-shadcn.mjs
cheap 'pnpm contracts:gen && pnpm registries:gen' pnpm -s contracts:check
cheap 'pnpm docs:map, then read each doc against the change and move its verified date' pnpm -s docs:check
if [ -n "$failed" ]; then
  printf '\nverify:changed: cheap checks failed; the heavy checks did not run:%s\n' "$failed" >&2
  exit 1
fi
printf 'verify:changed: cheap checks pass\n'
# Report-only: a code comment says why, it does not cite an issue (AGENTS.md).
node ./scripts/report-issue-refs.mjs --added "$base"

# Pass 2. Stops at the first failure: each step costs minutes.
set -e
if [ "$scripts" = 1 ]; then
  for test_file in scripts/*.test.mjs; do node --test "$test_file"; done
  python3 ./scripts/sync-string-catalog.test.py
fi
if [ "$contracts" = 1 ]; then
  pnpm contracts:test
  pnpm standard:check
fi
# The Workers and web test pools starve each other: those take the gate lock
# (gate-lock.sh). The checks above are plain node and take none.
if [ "$api" = 1 ] || [ "$web" = 1 ] || [ "$extension" = 1 ]; then
  gate_lock_acquire verify:changed
fi
if [ "$api" = 1 ]; then
  pnpm typecheck:api
  # A contract change can reach any route: the whole suite. Otherwise only
  # the tests that import a changed file.
  if [ "$contracts" = 1 ]; then
    pnpm test:api
  else
    pnpm --filter @starlings/control-plane exec sh ../../scripts/with-gate-lock.sh vitest run --changed "$base" --passWithNoTests
  fi
fi
if [ "$web" = 1 ]; then
  pnpm --filter @starlings/web exec tsc --noEmit
  if [ "$contracts" = 1 ]; then
    pnpm test:web
  else
    NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @starlings/web exec sh ../scripts/with-gate-lock.sh vitest run --changed "$base" --passWithNoTests
  fi
  pnpm build:web
fi
if [ "$site" = 1 ]; then
  # Vite does not typecheck: a missing import in site code builds, then
  # throws in the browser. web/tsconfig.json includes marketing/src.
  [ "$web" = 0 ] && pnpm --filter @starlings/web exec tsc --noEmit
  pnpm build:marketing
fi
[ "$ops" = 1 ] && pnpm --filter @starlings/web build:ops
[ "$marketing_worker" = 1 ] && node --test ./services/marketing/src/index.test.mjs
[ "$docs_service" = 1 ] && pnpm --filter docs-envisioning verify
[ "$keep_service" = 1 ] && pnpm --filter keep-envisioning verify
[ "$extension" = 1 ] && pnpm --filter @starlings/extension test
# The Mac tests, the iOS build, and the string catalog the builds extract.
# The Android debug build, on the mini (verify-android.sh).
[ "$android" = 1 ] && ./scripts/verify-android.sh
if [ "$apple" = 1 ]; then
  ./scripts/verify.sh --apple
fi
printf 'verify:changed: green\n'
