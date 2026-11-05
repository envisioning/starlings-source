---
title: "Why should an AI agent work in the same project as your team?"
description: "Because the request, its sources and the result then stay on the project, where the team finds them later. A chat answer has to be carried back by hand."
slug: why-agents-belong-in-the-same-project
status: published
locale: en
published: 2026-10-09
updated: 2026-10-09
author: Envisioning
related: [what-small-consultancies-should-automate-first, connect-claude-to-team-projects-and-calls]
---

An agent should work in the project because the project keeps the request, its sources and its result together. When the agent works in a separate chat, a person carries the context in and carries the answer back, and the project loses the record of who asked for what.

## A chat answer has to be carried back by hand

Take a client project with a decision in its conversation, an open task and notes from the last call. In a standalone chat, the agent sees only what someone pastes or connects. Someone still names the project, finds the source and copies the result to the right place. If they skip that last step, the answer stays in one person's chat history.

In the project, the agent reads the records the team reads, and its result lands next to them. A task it proposes goes on the project board. A call summary is filed on the subject the call was about.

We hit this ourselves. Envisioning's client history was spread across Zoom and Google Meet, a meeting notetaker, Slack, Notion and a task tool. Every agent needed a connection to each one and still had to guess which client a note was about. We have retired those tools and moved the client work onto Starlings. We are still early in that move, but an agent now needs one connection, and each call, task and document is already filed on its client. [How Envisioning runs on Starlings](/customers/envisioning) has the details.

## A personal Claude and a Team agent carry different authority

A member's own Claude connects over MCP and acts as that member. It can search and open what the member can read. It cannot write until the member pairs again with **Also write** turned on. See [how to connect Claude](/help/howto/connect-claude).

A Team agent is a member of the roster with its own identity. A teammate addresses it in a project conversation or hands it a task or issue. When it replies, the card moves to **Review** and a person checks the result. See [how to connect an agent as a Team member](/help/howto/connect-an-agent-as-a-team-member).

Neither one is an account that sees every project.

## What an agent can reach

- Records that the connecting member, or the Team agent, can already access.
- A meeting's notes and transcript after the meeting ends. Another member reads them only when the meeting is filed on a subject they can see. See [how to read a meeting transcript](/help/howto/read-a-meeting-transcript).
- No live audio, video or transcript. Starlings does not record the audio or video of its calls.

## Start with one card

Pick a project with recurring, low-risk internal work. Give the agent one assignment, name the source, and say what a useful result looks like. Starlings already proposes tasks from each finished call, so the agent can start on the next step: checking the board against what the team has since decided. This prompt works with a member's Claude connected read-only:

```text
Open the project <project name>.
Compare its open tasks with the decisions recorded on the project.
List each task that a later decision changed or made unnecessary, and quote that decision.
Do not change any task.
```

Check each item against the decision it quotes, then close or edit the tasks yourself. After a few weeks, ask two questions. Did the team spend less time finding context? Can everyone see where the work landed? If either answer is no, fix the source or narrow the assignment before you give the agent more access.

For the hand-off after a call and the brief before the next one, read [what a small consultancy should automate first](/field-notes/what-small-consultancies-should-automate-first).
