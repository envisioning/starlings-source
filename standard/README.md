# Starlings Subject Spec

An open standard for how people and agents work on the same record. A
**subject** is one thing a company works on: a project, a lead, an organization or
an event. The spec defines the subject kinds, the doors that address things,
the records an agent reads and writes, a conformance suite, and portable
skills that teach an agent the procedure.

[Starlings](https://starlingshq.com) is the reference implementation. Any
tool may implement the spec without permission.

## What is here

| Path | What | Also at |
| --- | --- | --- |
| `SPEC.md` | The spec: subject kinds, doors, records, conformance, versions | [starlingshq.com/spec](https://starlingshq.com/spec) |
| `AGENTS.md` | How an agent works on subjects: the model, authority, approval, errors | [starlingshq.com/agents](https://starlingshq.com/agents) |
| `skills/<name>/SKILL.md` | Portable skills in the [Agent Skills](https://agentskills.io) format. Each one is one procedure | [starlingshq.com/skills](https://starlingshq.com/skills) |
| `src/` | The reference code (TypeScript, zod): kinds, doors and records. The JSON Schema is generated from `src/schema.ts` | [starlingshq.com/spec/schema.json](https://starlingshq.com/spec/schema.json) |
| `conformance/` | `cases.json`, the conformance contract; `run.mjs`, a zero-dependency runner; the reference adapter | [starlingshq.com/spec/conformance/](https://starlingshq.com/spec/conformance/cases.json) |
| `.claude-plugin/` | The Claude Code plugin marketplace (`starlings`) and plugin (`starlings-skills`) that install the skills | |
| `CHANGELOG.md` | Every spec version | |

## Use it

- **Install the skills.** In Claude Code, this repository is a plugin
  marketplace:

  ```sh
  claude plugin marketplace add envisioning/starlings-subject-spec
  claude plugin install starlings-skills@starlings
  ```

  For another agent, copy a skill folder into its skills folder, for example
  `~/.claude/skills/find-the-subject/`.
- **Implement the spec.** Read `SPEC.md`, then run the conformance suite. In
  JavaScript or TypeScript, write an adapter and run
  `node conformance/run.mjs ./your-adapter.mjs`; the runner needs no
  dependencies. To run the reference implementation's own adapter, install
  the dependencies first (`npm install`), then run
  `node conformance/run.mjs conformance/reference-adapter.mjs`. In another
  language, port `conformance/cases.json`; the file is the contract.
- **Validate records.** Use the JSON Schema at
  `https://starlingshq.com/spec/schema.json`.

## How this repository is maintained

This repository is published from the Starlings source tree. Each version
here is a sync of that tree, so pull requests cannot be merged. Open an issue
for a question, a bug in the spec, or a proposal. See `CONTRIBUTING.md`.

## Licence

Apache-2.0. See `LICENSE`. The licence grants no right to the Starlings name
or marks. See `NOTICE`.
