---
kind: intent
status: active
verified: 2026-10-10
summary: "ADR 0005: the subject data model is an open standard, the Starlings Subject Spec (public at envisioning/starlings-subject-spec), Apache-2.0, with Starlings as its reference implementation; site.example publishes the spec, portable skills and agent instructions as agent-readable pages first, a public repo later; accepts ADR 0003 Part 1 — accepted, not built"
---

# 0005 — The open subject standard

**Status:** accepted · not built · **Date:** 2026-10-03 · **Decided by:** MZ

Starlings is agent-native. Agents outside Starlings must read and write
subjects the same way agents inside it do. So the subject data model is the
most open part of the product, not a secret. This ADR accepts
[ADR 0003](0003-the-ledger.md) Part 1 (how we own a format we give away) and
adds the name, the licence split, and the public pages.

---

## Context

- STRATEGY (HQ Docs) §The unit of work names the **subject** as
  the join key no other suite has. It also calls the data model a moat. This
  ADR corrects that: the data model is the protocol. The moats are the network
  between workspaces, the signed act record, hosted operations, and the apps.
- ADR 0003 Part 1 proposed a published contract, a conformance suite and
  version authority. Nobody accepted it. This ADR accepts decisions 1 to 7 of
  that part. ADR 0003 Part 2 (the act record) stays proposed.
- `LICENSE` says Apache-2.0 but `envisioning/starlings` is private. No outside
  party has received code yet, and MZ is the only human contributor. The
  licence can still change at no cost.
- The workspace already serves agents: `llms.txt`, `llms-full.txt`, markdown
  twins of every help page, `/mcp`, `/connect`, `/openapi.json`. The product
  site `site.example` has none of these for the standard.

## Decisions

| # | Decision |
| --- | --- |
| 1 | **The subject model is an open standard.** Subject kinds, the subject record, the act record, identifiers and permalinks, and topology. Any agent or tool can implement it without asking. |
| 2 | **The standard is the Starlings Subject Spec.** (MZ, 2026-10-03; replaces "a neutral name", decided earlier the same day.) The neutral candidates (Commonplace, Open Subject Protocol, Docket, Topos, Dossier) were all too common. One name means one trademark filing, and the conformance mark is "Works with Starlings". The cost: some competing tools will hesitate to adopt a vendor-named format. If a foundation or a second implementation ever needs a neutral name, the spec is renamed on donation, as Swagger became OpenAPI. The package is `@starlings/subject-spec`. |
| 3 | **Licence: Apache-2.0 for the standard.** Schema, spec text, conformance suite, reference fixtures and skills. Apache, not MIT, because it grants patents explicitly, terminates the grant for a party that sues, and excludes trademarks in writing. |
| 4 | **Pages first, repo later.** `site.example` publishes the standard from this monorepo now. A public repo follows when the core package is stable and has its own version. |
| 5 | **Every page is agent-readable and generated.** Each page has a markdown twin at `<path>.md`, a line in the site's `llms.txt`, and one source in a registry or a repo file. No page restates a schema by hand (invariant 30). |
| 6 | **Four public sections.** `/spec`: the subject model, rendered from JSON Schema with a download. `/skills`: portable `SKILL.md` files an agent installs. `/agents`: how an agent connects, its authority, approval rules, tools, limits and errors. `llms.txt`: the index of all three. |
| 7 | **The schema comes from an extracted core package.** `packages/contracts` mixes the subject core with Envisioning and product shapes (`crm.ts`, `commercial.ts`, `deployment.ts`, `home-layout.ts`). The standard takes the core only, as its own package, and `packages/contracts` imports it. |
| 8 | **Skills teach the procedure, MCP gives the verbs.** The first skills: find the subject before acting; read its chain; file every output to it with attribution; propose a consequential change and wait for approval; record a decision as a decision. Each skill works on any conformant store, not only Starlings. |
| 9 | **The name is protected by trademark, compatibility by the suite.** Register Starlings (EUIPO, classes 9 and 42, 38 to decide); one filing covers the product and the spec. "Works with Starlings" is a mark that only a passing conformance run earns. |

## Slices

| Slice | What | Waits on |
| --- | --- | --- |
| A | **Built 2026-10-03.** `standard/skills/` with five skills; `/skills` and `/skills/<name>` with markdown twins and the raw `SKILL.md` | |
| B | **Built 2026-10-03.** `/agents` from `standard/AGENTS.md` plus the MCP tool list read from `mcp.ts`; the product Worker answers `Accept: text/markdown` with a page's twin | |
| C | **Built 2026-10-03, v0.1.0.** `standard/` is the workspace package `@starlings/subject-standard`: subject kinds, thing doors, the decision record. `packages/contracts` reads kinds and thing doors from it; `crmDecisionSchema` keeps its wire shape and is checked against the standard decision at compile time. `/spec` renders `standard/SPEC.md` plus `/spec/schema.json`, generated from zod at build time | |
| D | **Built 2026-10-03.** Site `llms.txt` lists A to C | |
| E | **Built 2026-10-03.** `standard/conformance/`: `cases.json` (the contract), a zero-dependency `run.mjs` and the reference adapter, published at `/spec/conformance/`. `pnpm standard:check` (in `verify:fast`) runs it against the reference package and Starlings' `parseSearchDoor`, and fails when `cases.json` and the package disagree on kinds or version. The marketing build refuses to publish when the reference fails | |
| F | **Published 2026-10-03** at https://github.com/envisioning/starlings-subject-spec (first sync from `c4af1e75`). Public repo chosen by MZ, issues only while `standard/` is the source. `scripts/publish-standard.mjs` syncs the tracked files of `standard/` except `MAINTAINING.md`, rewrites site links, refuses files that name monorepo paths, and commits `Sync from envisioning/starlings@<sha>`. `standard/` gained `NOTICE` (the marks), `CONTRIBUTING.md`, `CHANGELOG.md` and `MAINTAINING.md`. Questions 2 to 4 concern the product repo and do not block the spec repo | |

## Open questions

1. ~~**The standard's name.**~~ **Decided 2026-10-03 (MZ):** the Starlings
   Subject Spec (decision 2).
2. ~~**The product's licence.**~~ **Decided 2026-10-09 (MZ):
   FSL-1.1-ALv2.** Self-hosting for internal use is allowed, a competing
   hosted service is not, and each version becomes Apache-2.0 two years after
   its release. `LICENSE` and `NOTICE` carry it; `standard/` stays
   Apache-2.0. The repo stays private until a public launch is scheduled
.
   *Was: FSL-1.1-ALv2 or AGPL-3.0; AGPL would let a third party host the
   product commercially as long as it published its changes.*
3. ~~**Contributions.**~~ **Decided 2026-10-10 (MZ): a CLA for the
   product**, so the licence can change and exceptions can be sold; a DCO
   for the standard. The CLA text and its check land with the public repo
.
4. ~~**IP owner.**~~ **Decided 2026-10-10 (MZ): Envisioning stays the
   owner and licensor**, also when the repo goes public; Starlings is not a
   separate company yet. The CLAs are written to be assignable, so a later
   spin-out (STARLINGS (HQ Docs) phase 6) transfers the code,
   the marks, the domains and the accounts in one step, with a perpetual
   licence back to Envisioning. *Was, earlier the same day:
   assign to a Starlings entity before going public.*
5. ~~**Spec text licence.**~~ **Decided 2026-10-10 (MZ): Apache-2.0, one
   licence for the whole standard**, prose included (`SPEC.md`, the skills'
   text, the `/spec` pages). One file, the patent grant covers the spec,
   and skills that mix prose and procedure need no split.
   `standard/LICENSE` already covers it. *Was: Apache-2.0 with the code,
   or CC-BY-4.0 for prose.*
