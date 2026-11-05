---
kind: howto
status: active
verified: 2026-10-22
summary: "Which GitHub labels move a card on the Work board, and which are inert"
capabilities: [owner-work, owner-issues]
owns: [packages/contracts/src/work-items.ts, fixtures/work-items.json]
---

# Labels the board reads

Each issue on a connected repository is a card in Work. Four labels set the
card's column. The board ignores all other labels, so you can add your own
triage labels.

[Connect a repository](connect-a-repository.md) first.

## The four stage labels

| Column | The issue is |
| --- | --- |
| queued | open, with `agent:queued`, **or with no stage label** |
| doing | open, with `agent:building` |
| review | open, with `agent:review` |
| blocked | open, with `agent:failed` |

The table gives three rules.

- **No label means queued.** A brand-new issue is already in the first column.
  It does not mean that anyone has started.
- **With more than one stage label, the highest wins.** The order is blocked,
  then review, then doing.
- **Any other label is inert.** `bug`, `needs-triage`, your own vocabulary, and
  even `agent:out-of-scope` leave the card where it is. The board ignores
  letter case in labels.
- **A stage label means an agent holds the issue.** An open issue with no
  assignee and no stage label shows in Overview's **UNOWNED**; any of the four
  stage labels, or an assignee, takes it off. Other labels do not.

## Closing a card

| Close it as | The board reads |
| --- | --- |
| completed | done |
| not planned, or duplicate | dropped |

If you close an issue with the default reason, the board shows it as done. For
work you decided against, close it as **not planned**.

## Tasks, for a subject with no repository

A task uses its own status rather than a label: `pending`, `in_progress`,
`review`, `blocked`, `completed`, `cancelled`, in the same six columns. A task
filed to GitHub stays one card. While the task and the issue both exist, the
task's status sets the column.
