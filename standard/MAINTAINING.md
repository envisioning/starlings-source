# Maintaining the spec in this repo

This file stays in the monorepo. `scripts/publish-standard.mjs` leaves it
out of the public repo, `envisioning/starlings-subject-spec`
([ADR 0005](../docs/adr/0005-open-subject-standard.md) slice F).

## One source

- `standard/` in this repo is the only source. The public repo is a sync of
  it. Never edit the public repo by hand: the next sync overwrites it.
- The product site renders these files at build time (`virtual:meet-standard`
  in `web/vite.config.ts`). Do not copy their text into a page component.
- Every file except this one is public. Do not write monorepo paths,
  issue numbers or internal names into them. The publish script refuses to
  export a file that names `packages/`, `services/`, `docs/`, `@starlings/` or
  `meet#`.

## How the code connects

- `packages/contracts` imports the kinds and thing doors from
  `@starlings/subject-spec` (`subject-kinds.ts`, `search-values.ts`).
  `goals-decisions.ts` checks `crmDecisionSchema` against the standard
  decision at compile time.
- Files in `src/` import each other by the package name
  (`@starlings/subject-spec/kinds`), not by relative path, so plain Node can
  load them at build time.

## Gates

- `SPEC_VERSION` in `src/index.ts` and §Status in `SPEC.md` must agree;
  `pnpm build:marketing` fails when they do not.
- `pnpm standard:check` (in `verify:fast`) runs the conformance suite against
  the reference and against Starlings' `parseSearchDoor`, and fails when
  `conformance/cases.json` and the package disagree on kinds or version.
- A skill names only MCP tools that exist: `pnpm build:marketing` fails when
  an "On Starlings" row names a tool `services/control-plane/src/mcp.ts` does
  not define. `AGENTS.md` lists every skill; the build fails otherwise.

## Rules for the content

- Store-neutral first. Each skill states the procedure for any store that
  holds subjects. A section headed **On Starlings** then names the Starlings
  MCP tools for each step.
- `.claude-plugin/plugin.json` carries the spec version; `pnpm standard:check`
  fails when it differs from `SPEC_VERSION`. Validate the manifests with
  `claude plugin validate standard` after editing them.
- A change to the kinds, doors or records changes `conformance/cases.json`,
  `CHANGELOG.md` and, when it is not a patch, `SPEC_VERSION`, in the same
  commit (`SPEC.md` §Versions).

## Publishing

```sh
node scripts/publish-standard.mjs --target <checkout of envisioning/starlings-subject-spec>
```

The script copies the tracked files of `standard/` except this one, removes
files the source no longer has, refuses private references, and commits
`Sync from envisioning/starlings@<sha>` in the target. It pushes only with
`--push`. Publishing is MZ's call.
