---
kind: howto
status: active
verified: 2026-11-04
summary: "See a project's tasks and issues by stage, move them, filter them, and hide the columns you do not use"
capabilities: [owner-work]
owns: [web/src/ProjectBoard.tsx, web/src/BoardColumn.tsx, iOS/MobileProjectBoardView.swift, Sources/WorkCardBoardView.swift]
---

# Use a project's board

Every project has a **Board**. It shows the project's tasks and its GitHub
issues in six columns: Queued, Doing, Review, Blocked, Done and Dropped.
Done and Dropped stay behind **Finished** until you open them.

## Open it

- **Web:** open the project in Work, then choose **Board**.
- **Mac:** open the project, then choose **Board** on the TASKS header.
- **iPhone and iPad:** open the project, then choose **Board** in the pane
  picker.

The board reads the project again every 30 seconds while it is on screen,
so a move an agent makes shows without a reload.

## Move a card

- **Mac and web:** drag the card to another column.
- **Every client:** open the card's menu and choose **Move to**.
- **iPhone and iPad:** swipe a card to mark it Done.

A task's column is its status. An issue's column is its state and
its `agent:*` label on GitHub. See
[Labels the board reads](labels-the-board-reads.md).

## Filter and hide columns

The filter menu has these parts.

- **Held by:** Anyone, People, Any agent, or one agent. An issue with an
  `agent:*` label is the agent's. A task is a person's.
- **Due:** Any date, or Overdue: open tasks due before today.
- **Side:** Any side, your team, Client, or Unassigned. An issue has no
  date and no side, so it shows only while Due and Side are at Any.
- **Columns:** a switch for each column. Starlings keeps your choice for
  every project and every device. The board says how many cards sit in
  hidden columns. You cannot drop a card into a hidden column, but **Move
  to** still lists every column.

## Delete a task

Open a task card's menu and choose **Delete**. Starlings asks first. An
issue has no Delete here; close it on GitHub.

## Hand a card to an agent

Open the card's menu and choose **Hand off to** and an agent on the Mac and iPhone, or **Hand off…** on the web. See
[Hand off a card to an agent](hand-off-a-card-to-an-agent.md).

## Open the conversation

A card's last line is the last thing that happened to it. Choose it to open
the project's Talk at that message.
