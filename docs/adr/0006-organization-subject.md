---
kind: intent
status: active
verified: 2026-10-05
summary: "ADR 0006: every organization is a subject of kind `organization`; `partner` folds into it; client, partner and prospect are relationships read from records, never kinds; \"customer\" is not a Starlings word — accepted, not built"
---

# 0006 — The organization is the subject

**Status:** accepted · not built · **Date:** 2026-10-05 · **Decided by:** MZ

Starlings keeps as few dimensions in its core as possible. A relationship
with an organization is not a kind of thing. It is something the records
show.

---

## Context

- The subject kinds are `project`, `lead`, `partner` and `event`
  ([ADR 0005](0005-open-subject-standard.md), `standard/src/kinds.ts`).
- A `partner` subject is the organization itself. Its tasks file to
  `organization_id`, its documents file as the organization
  (`packages/contracts/src/subject-kinds.ts`), and D1 marks it with
  `organizations.is_partner` (migration 0073).
- [WORK_MODEL.md](../WORK_MODEL.md) §The base already calls an organization
  "a client". Browse has a CLIENTS group.
- Support needs one record per organization: its guest thread, its cards,
  its history ([SUPPORT.md](../SUPPORT.md)). The first draft added a
  `customer` kind for this, then a `client` kind.
- One firm can be a client, a partner and a prospect at the same time. A kind
  for each relationship gives that firm several subjects, and each new
  relationship adds a dimension.

## Decisions

| # | Decision |
| --- | --- |
| 1 | **The subject kinds are `project`, `lead`, `event` and `organization`.** Every organization is a subject of kind `organization`, in the base. `partner` is no longer a kind. |
| 2 | **A relationship is read from records, never stored as a kind.** An organization with an active project or license is a **client**. An organization with a partnership (today `is_partner`) is a **partner**. An organization with an open lead is a **prospect**. Browse groups and labels read these; no client flag exists. Core's `is_existing_client` mark counts as a record of the client relationship while Core holds the organization. Built for the organization's Relationship block (`organizationRelationships`); Browse groups do not read it yet. |
| 3 | **One word for each thing.** "Client" is the only word for an organization the workspace serves. "Customer" is not a Starlings word in the UI, the glossary or new docs. |
| 4 | **A lead stays a kind.** A lead is a deal with its own records (the qualification checklist), not a relationship. |
| 5 | **A relationship's work module adds records, not a kind.** Sales still adds `lead` and Events adds `event`, because a lead and an event are things. Partners holds partnership records. Support lets an organization's guest thread take support requests ([SUPPORT.md](../SUPPORT.md)). Neither adds a subject kind ([WORK_MODEL.md](../WORK_MODEL.md)). |
| 6 | **The spec changes once.** `organization` replaces `partner` in the Starlings Subject Spec. SPEC §Versions makes a removal a major change. The spec has no outside implementer yet, so the change ships as the next 0.x version, and a reader maps `subject:partner:<id>` to `subject:organization:<id>` for that one version. |

## Consequences

- Every place that switches on the `partner` kind changes: the standard and
  its conformance cases, `subject-kinds.ts` and the generated Swift table, the
  wire enums, D1 `kind` values (`subject_state`, `subject_access`), favorites
  (`crm.partner`), MCP tools, and the closed Swift enums on the Mac and iOS.
- Core keeps its partner rows. Starlings reads a Core partner as an
  organization subject until the Core fold.
- Organizations that are not partners become subjects for the first time.
  Browse needs a rule for which organizations it lists, so an import of
  hundreds of organizations does not flood the rail.

## Order

Installed Mac and iOS apps decode the kind with closed Swift enums, and the
updater has no hard minimum version. If the Worker sent `organization` first,
an older app would fail to decode whole responses. So the fold has two steps.

1. **Apps read both names (built 2026-10-05).** The wire generator
   (`scripts/gen-swift-contracts.mjs`, `READ_ALIASES`) decodes `organization`
   as `partner` in every wire kind that names `partner`. The two hand-written
   kinds built from server strings, `MeetingCategoryKind.SubjectKind` and
   `SearchSubjectKind`, do the same, so `subject:organization:<id>` doors
   open. Nothing on the wire changes. This ships in a release.
2. **The rename.** When that release is installed, and
   `MIN_RECOMMENDED_VERSION_MACOS` / `_IOS` point older apps at it, the
   standard, contracts, Worker, web, D1 and Swift names change to
   `organization`. The Worker still accepts `partner` from older apps, and
   the read aliases stay in the generator until no app sends `partner`.
   Built on the branch `org-kind-fold-2`, held until the floor moves:
   - **Accepting the old name.** Every kind schema in contracts reads
     `partner` as `organization` (`acceptingKindAliases`), and so does the
     `:kind` path parameter (`routes.ts`) and `/work/partner/<id>`
     (`parsePermalinkPath`). Spec 0.3.0 reads `subject:partner:<id>`.
   - **Core still says `partner`.** `toCoreKinds` in `src/crm.ts` sends
     `organization` to Core as `partner`; Core's answers come back through
     the kind schemas.
   - **Kept as they are:** derived thread and guest-thread ids (`idKind`
     hashes `organization` as `partner`, so no conversation is orphaned),
     the meeting filing kind `partner` and `partner_organization_id`
     (Core's values), favorite kinds such as `crm.partner`, the inbound
     mail prefix `pt`, the Partner pane, and the word Partner on screen.
     The word changes with the relationships slice.
   - **D1.** Migration `0093_organization_kind.sql` moves every stored
     subject kind.

## Related

[SUPPORT.md](../SUPPORT.md), [WORK_MODEL.md](../WORK_MODEL.md),
PARTNERS (HQ Docs), [ADR 0005](0005-open-subject-standard.md),
[ACCESS.md](../ACCESS.md).
