---
kind: howto
status: active
verified: 2026-11-04
summary: "Turn a task into an issue on the subject's repository"
capabilities: [owner-work, owner-issues]
owns: [Sources/WorkRowActions.swift, iOS/WorkRowActionMenu.swift, web/src/WorkRows.tsx, web/src/rail-row.tsx]
---

# File a task on GitHub

The subject must be a project with a linked repository.

1. Open the task: in MINE, or on the subject's Tasks pane.
2. Choose **File on GitHub** from the row's menu. On the web, the open task has it too.
3. The task becomes an issue on the repository, with a link back to the task. The task and the issue stay one card. The board sets the card's column from the issue's `agent:*` labels.

To start from an issue instead, use **New Issue** (⌥⌘I) on the subject.

Star the task or issue from its Work row to keep it in Starred. This does not
change its issue state or board column.
