---
kind: intent
status: active
verified: 2026-10-07
summary: "ADR 0008: a lead and a project stay separate subject kinds; a won lead links to the projects it became through `projects.lead_id`, on Core and on D1; both subjects show the edge, the project's History reads the lead's History across it, and one Win action closes the lead and starts the project — accepted and built"
---

# 0008 — The lead-to-project edge

**Status:** accepted · built · **Date:** 2026-10-06 · **Decided by:** MZ

A lead is a deal. A project is the work that a won deal starts. They are two
subjects with an edge between them. Neither one is a type of the other.

---

## Context

- The subject kinds are `project`, `lead`, `event` and `organization`
  ([ADR 0006](0006-organization-subject.md)). ADR 0006 decision 4 keeps
  `lead` as a kind because a lead has its own records.
- On 2026-10-06 MZ asked if `project` should take subtypes (lead, event, and
  others) in place of separate kinds. The answer was no:
  - An event is the parent of projects, not one of them. One event holds a
    sponsor project, a talk, a booth and a lead (`projects.event_id`,
    [EVENTS.md](../EVENTS.md)).
  - The fold of `partner` into `organization` needs two app releases and a
    version-floor move. A second fold costs the same again, and
    the Subject Spec takes a second breaking change after 0.3.0.
  - Core keeps leads and projects in two tables. A lead id and a project id
    can be the same value, so one `subject:project:<id>` door cannot name
    both until the Core fold.
  - The real need behind subtypes is continuity: the work of a won deal must
    not lose its history. An edge gives that.
- Core has the edge: `projects.lead_id`. D1 copied the column
  (`0073_work_subjects.sql`, [WORKSPACE_STORE.md](../WORKSPACE_STORE.md)).
- What Starlings does with the edge today:
  - **Writes it.** MCP `create_project` takes `lead`. `work-d1.ts` inserts
    and updates `lead_id` (`PROJECT_FIELDS`). Core does the same through its
    record routes.
  - **Returns it, one way.** The project detail carries `lead_id`
    (`crmSubjectDetailSchema`). A lead's detail does not list its projects.
  - **Shows it nowhere.** No client draws the edge, and History does not
    read across it.
  - **Has no win action.** A member sets the lead to Closed Won and creates
    the project as two separate acts. Nothing joins them.

## Decisions

| # | Decision |
| --- | --- |
| 1 | **Two kinds, one edge.** `lead` and `project` stay subject kinds. `project` takes no subtype. ADR 0006 decision 4 stands. |
| 2 | **The edge is `projects.lead_id`, on both stores.** It points from the project to the lead. It is the one source; no `leads.project_id` exists. One lead can start more than one project (a pilot, then a rollout). A project comes from at most one lead. |
| 3 | **Both subjects show the edge.** A project shows "Won from" and its lead. A lead shows the projects it started. Both travel in the detail's `related`, the shape an organization's detail uses (`crmSubjectRelatedSchema`): a lead's `related.projects` is `projects WHERE lead_id = ?`, a project's `related.leads` is its one lead. Web, Mac, iOS and MCP `open` read it from the detail. No client queries the edge itself. |
| 4 | **Each subject keeps its own records.** The lead's Talk, tasks, documents and decisions stay on the lead. Nothing moves when a lead is won, so no door, thread id or permalink breaks. |
| 5 | **The project's History reads across the edge.** The project's History merges the lead's interactions with its own by time, each lead row marked "From the lead". The lead's Talk event lines stay on the lead: they are its own coordination record, read per thread. The lead's History does not read forward into the project. |
| 6 | **One Win action.** On an open lead, Win sets the lead to Closed Won and creates a project with the lead's organization, contact and title and `lead_id` set. The member can edit the title before it saves. One Worker route, `POST /api/crm/subjects/lead/:id/win`, does it in the same order on both stores: the project first, then the task moves, then the status change. A failure leaves a linked project on an open lead, never a won lead with no project; the answer says so (`lead_closed`, `unmoved_task_ids`). A closed lead is refused. Win shows on every lead row, because a row does not carry the lead's status. |
| 7 | **Open tasks are the member's choice.** Win lists the lead's open tasks. The member checks the ones that move to the project. The rest stay on the lead. |
| 8 | **Win is one MCP action.** `win_lead` takes the lead door, an optional title and the task ids to move, and returns the project door. `create_project` with `lead` stays, for a second project from a lead that is already won. |
| 9 | **Not in the Subject Spec yet.** The spec has no relations between subjects. The edge enters the spec when the spec defines relations, as an additive change. Until then it is Starlings' record. |
| 10 | **A won or lost lead is closed.** (MZ, 2026-10-07.) Closed Won and Closed Lost are the closed lead statuses; every other status is open. A closed lead leaves the default lists, the rail, the pickers and the lead counts, and Win does not show on it. It still opens from a link and from the project's **Won from**. Search already lists open subjects only. One registry in `packages/contracts` holds the closed statuses. |

## Slices

| Slice | What | Store |
| --- | --- | --- |
| A | **Built 2026-10-06.** The lead's detail carries `related.projects`, the project's detail `related.leads`. No contract change: `related` was already optional on every detail. The Worker's detail, create and update answers drop related subjects the person cannot see, and leads when Sales is off (`readableSubjectDetail`). No client draws it yet; each gates `related` to organizations | D1 in `work-d1.ts`. Core in core-web's `meet-crm-subjects` id read, because Core's project list reads no `lead_id` filter |
| B | **Built 2026-10-06.** Web, Mac and iOS draw the edge in the subject Overview's related group: PROJECTS on a lead, WON FROM on a project, hidden when empty. MCP `open` answers `projects` on a lead and `won_from` on a project, each with its door | Both |
| C | **Built 2026-10-06.** `GET /api/crm/interactions?project_id=` adds the lead's interactions, deduplicated by id, newest first, within `limit`, each with `from_lead: true`, when the person sees the lead and Sales is on. A failed lead read leaves the project's own rows. Web, Mac and iOS prefix those rows "From the lead"; MCP `open` gets them through the same read | Both, in the Worker |
| D | **Built 2026-10-06.** The Win route, the registry action `win-lead` (lead rows, all clients), the Win sheet on web, Mac and iOS (title, the lead's open tasks all checked), and MCP `task(action: "win_lead")` | Both, through the existing create, task-move and update calls |
| E | **Built 2026-10-07.** `SUBJECT_STATUS_CHOICES` gains `closed` and `isSubjectClosed` (Swift `SubjectStatusRegistry.isClosed`); the lead filter opens on `open`. `status=open`, and no status, exclude closed leads on D1 (`work-d1.ts`) and on Core (core-web `meet-crm-subjects`), and the open count leaves them out. List rows carry `status`. The registry action `win-lead` reads the fact `isOpenLead`; web's header menu checks the same. [](https://github.com/envisioning/starlings-source/issues/1073) | Both |

## Consequences

- A lead with Closed Won and no project stays valid. Old data has them, and
  some wins start no project.
- The project reporting does not change. A project from a lead is a project.
- The lead stays in the Sales work module. With Sales off, a project hides
  its "Won from" row and its History skips the lead rows
  ([WORK_MODEL.md](../WORK_MODEL.md) rule 2). The `lead_id` stays.
- Core's own new-project-from-lead page sets `lead_id` but does not close
  the lead or move tasks. Whether Core matches Win is open:
  [](https://github.com/envisioning/starlings-source/issues/1074).
- Subject access applies across the edge. A person who cannot see the lead
  does not get the lead's History rows on the project.

## Related

[ADR 0006](0006-organization-subject.md), [WORK_MODEL.md](../WORK_MODEL.md),
[WORKSPACE_STORE.md](../WORKSPACE_STORE.md), [EVENTS.md](../EVENTS.md),
SIGNALS_SALES (HQ Docs), [TIMELINE.md](../TIMELINE.md).
