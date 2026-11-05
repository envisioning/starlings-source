# Starlings Subject Spec

A **subject** is one thing a company works on: a project, a lead, an organization
or an event. It holds its own history across time. Tools and agents that
share the subject share the context. This spec defines the subject kinds,
the doors that address things, and the records an agent reads and writes.

Starlings is the reference implementation. Any tool may implement this spec
without permission. The licence is Apache-2.0.

## Status

Version 0.4.0. This is a draft. It names the kinds, the doors and three
records (the subject, the task and the decision) and has a conformance suite
for them. Other records follow: the goal, the meeting record and the act
record, a signed, append-only log of what each person and agent did.

## Subject kinds

| Kind | What it is |
| --- | --- |
| `project` | Work the company delivers, usually for a client |
| `lead` | A possible piece of work, before it is won or lost |
| `organization` | An organization the company works with: a client, a partner, a prospect. Those are relationships, read from its records, not kinds |
| `event` | A dated gathering the company runs or attends |

A reader accepts `partner`, the kind 0.3.0 replaced, as `organization` for
one version. A writer writes only `organization`.

What each kind can receive (tasks, documents, issues, meetings) is the
implementation's decision. The spec does not require one kind to hold tasks
and another not to.

## Doors

A **door** is the stable address of a thing. An agent passes doors between
tools instead of names.

- A subject: `subject:<kind>:<id>`, for example `subject:lead:7f3a…`.
- Any other thing: `<kind>:<id>`, where the kind is one of `person`,
  `agent`, `contact`, `thread`, `document`, `event`, `task` or `issue`.

A `person` is someone in the workspace, named by an address. A `contact` is
someone outside it the company works with, a client's or a partner's
person, named by the implementation's id: a contact has several addresses,
and one may change.

The id is opaque. It may contain `:`. Only the first colon (and, for a
subject, the second) is part of the grammar. A person or an agent is named by
an address, for example `person:ada@example.com`.

An implementation may define more doors for its own places and actions.
Those doors are not part of the standard, and an agent must not expect
another implementation to read them.

## Records

An implementation may add fields to any record. It must keep every field the
spec names, with the same type. A field the spec marks nullable is present
with `null`, not left out. The fields are in the schema below.

### Subject

One thing a company works on. A subject has a kind, an id that is unique
within that kind, a title, and an optional line of context. Its door is
`subject:<kind>:<id>`.

### Task

Work someone must do. A task usually belongs to one subject, named by
`subject_kind` and `subject_id`; both are null for a task that belongs to
none. Its due date is a day, `YYYY-MM-DD`, with no time.

| Status | Meaning |
| --- | --- |
| `proposed` | An agent suggested it. No person has accepted it yet |
| `pending` | Accepted, not started |
| `in_progress` | Someone is working on it |
| `review` | Done, waiting for a check |
| `blocked` | Cannot move until something else happens |
| `completed` | Done |
| `cancelled` | Dropped after it was accepted |
| `declined` | A person turned down a proposed task |

An agent that is not sure a task is wanted files it as `proposed` and lets a
person accept or decline it.

### Decision

A settled choice on one subject. An implementation writes a decision once
and does not edit it. To change a decision, it records a new decision whose
body names the old one.

## Conformance

An implementation conforms when it passes every case in the conformance
suite for the spec version it claims. The cases are one JSON file,
`/spec/conformance/cases.json`. The file is the contract: an implementation in
any language reads it and runs the rules below.

| Section | Rule |
| --- | --- |
| `subjectKinds` | The implementation knows exactly these kinds |
| `doors.valid` | Reading `door` gives `parsed`, and writing `parsed` gives `door` back |
| `doors.aliased` | Reading `door`, which names a kind by a name it replaced, gives `parsed`; writing `parsed` gives `written`, the current name |
| `doors.invalid` | Reading the door gives nothing |
| `doors.productOnly` | The door may be read by the product that defines it, but never as one of the `doorKinds` |
| `subjects.valid`, `tasks.valid`, `decisions.valid` | The record is valid. An extra field does not make it invalid |
| `subjects.invalid`, `tasks.invalid`, `decisions.invalid` | The record is not valid. A decision case with `bodyLength` sets `body` to that many characters first |

For a JavaScript or TypeScript implementation, `/spec/conformance/run.mjs`
runs the cases with no dependencies. Write an adapter module that exports
`subjectKinds`, `parseDoor`, `doorString` and, optionally,
`validateSubject`, `validateTask` and `validateDecision`, then run `node run.mjs ./adapter.mjs`. The reference
implementation's adapter is `/spec/conformance/reference-adapter.mjs`.

## Versions

The version is `MAJOR.MINOR.PATCH`.

- A **patch** changes wording only.
- A **minor** version adds a record, a field, a kind or a door kind. A
  reader that does not know the addition ignores it.
- A **major** version removes or changes something. One major version is
  current at a time, and the spec announces a major change before it ships.

## Schema

The JSON Schema (draft 2020-12) is generated from the reference
implementation's code, so it cannot disagree with it. Download it at
`/spec/schema.json`.
