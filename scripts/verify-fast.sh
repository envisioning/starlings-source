#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
. ./scripts/gate-lock.sh
gate_low_priority "$repo_dir/scripts/verify-fast.sh" "$@"
gate_lock_acquire verify:fast

# MCP discovery, route inventory and the checked-in OpenAPI projection.
# The starlings-auth D1 id may still be a placeholder here; a deploy refuses it.
# Central sign-in: the AUTH binding's fixed origin, the auth Worker's config.
node --test ./scripts/production-domain-policy.test.mjs
# Workspace provisioning: arguments, names, the env block.
# Retiring a workspace: the removal plan from its record.
# The GitHub App manifest and its creation script (docs/GITHUB_CONNECTOR.md).
node --test ./scripts/github-app-create.test.mjs
# The fleet deploy: plan, rings, holds, smoke decision; the D1 bookmark arguments.
# Inbound mail: the the workspace domain catch-all plan.
# The size and change hot-spot report, on throwaway repositories.
node --test ./scripts/code-hotspots.test.mjs
pnpm openapi:check

# Every route a client calls exists on the Worker, with that method.
# Writes nothing; `node scripts/check-client-routes.mjs --write` refreshes fixtures/routes.json.
node ./scripts/check-client-routes.mjs --check
node --test ./scripts/check-client-routes.test.mjs

# D1 migrations: numbered in order, destructive steps marked.
node ./scripts/check-migrations.mjs
node --test ./scripts/check-migrations.test.mjs

# Core's recorded projections: the copy in fixtures/core matches a sibling Core
# checkout, or there is none and this says so.
node ./scripts/sync-core-fixtures.mjs --check
node --test ./scripts/sync-core-fixtures.test.mjs

# The service sign-in fixture Docs and Keep copy parses with Meet's schemas
# (docs/CENTRAL_AUTH.md "Services").
node --import ./scripts/node-ts-resolve.mjs ./scripts/check-central-auth-fixture.mjs

# Only the build folders the scripts name sit at the repo root.
./scripts/check-build-folders.sh
# The worktree sweep the land queue runs, on throwaway repositories.
node --test ./scripts/worktrees-sweep.test.mjs
# Fast no-Xcode guard for source contracts, CI locking, strings, docs and web.
node ./scripts/check-json-satisfies.mjs
./scripts/check-time-format.sh
# No client keeps its own list of what a write clears.
./scripts/check-request-policy.sh
# No new hand-copied list: a "Mirrors …" comment not in the baseline fails.
node ./scripts/check-mirrors.mjs
node --test ./scripts/verify-lock.test.mjs
# Every changelog update is well formed and CHANGELOG.md matches them (changelog/README.md).
# The release script's green-commit rule.
node --test ./scripts/check-release-green.test.mjs
# Translation checks are paused until product-market fit (2026-10-09); MEET_L10N_GATES=1 turns them on.
if [ "${MEET_L10N_GATES:-0}" = 1 ]; then
node ./scripts/sync-web-strings.mjs --check --translated pt-BR
# No new English that skips t() or String(localized:), and no hand-made plural.
./scripts/check-l10n-literals.py
fi
# Permission inventory and catalog review rules, without an Apple toolchain.
python3 ./scripts/sync-string-catalog.test.py
# The copy law's mechanical rules over both catalogs (docs/DESIGN.md).
node ./scripts/check-copy.mjs
# Everything clickable responds to the pointer, on all three clients (AGENTS.md 18).
node ./scripts/check-hover.mjs
# The web draws its controls with shadcn, and no heading has an eyebrow.
node ./scripts/check-shadcn.mjs
pnpm contracts:check
node --test ./scripts/check-wire-compat.test.mjs
pnpm contracts:test
pnpm standard:check
pnpm --filter @starlings/extension test
pnpm typecheck:api
pnpm test:api
pnpm --filter @starlings/web exec tsc --noEmit
pnpm test:web
pnpm build:web
pnpm build:marketing
pnpm --filter @starlings/web build:ops
node --test ./services/marketing/src/index.test.mjs
# Docs and Keep: their kit and fixture copies, typecheck, tests and SPA build.
pnpm --filter docs-envisioning verify
pnpm --filter keep-envisioning verify
