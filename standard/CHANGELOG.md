# Changelog

Every version of the Starlings Subject Spec, newest first. `SPEC.md`
§Versions says what a patch, a minor and a major version may change.

## 0.4.0

- A door kind: `contact:<id>`, a person outside the workspace the company
  works with. A contact has several addresses, so the door names its id,
  not an address.

## 0.3.0

- The `partner` kind becomes `organization`. Client, partner and prospect
  are relationships an organization has, read from its records, not kinds.
- A reader accepts `partner` as `organization` for this version. A writer
  writes only `organization`. The suite gains `doors.aliased` for this.

## 0.2.0

- Records: the subject and the task.
- Task statuses, including `proposed` for a task an agent suggested and
  `declined` for one a person turned down.
- A rule for every record: a nullable field is present with `null`.
- The conformance suite grows to 60 checks, with subject and task cases.
  The runner accepts `validateSubject` and `validateTask`.
- The repository is a Claude Code plugin marketplace: `starlings-skills`
  installs the five skills.

## 0.1.0

The first draft.

- Subject kinds: `project`, `lead`, `partner`, `event`.
- Doors: `subject:<kind>:<id>` and `<kind>:<id>` for `person`, `agent`,
  `thread`, `document`, `event`, `task` and `issue`.
- Records: the decision.
- A conformance suite with 46 checks, and a zero-dependency runner.
- Five skills: find-the-subject, read-the-chain, file-to-the-subject,
  propose-dont-apply, record-a-decision.
