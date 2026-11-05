---
title: "What should a small consultancy automate first with AI?"
description: "The hand-off after a client call: turn what was agreed into tasks on the project, with the quote behind each one and a person accepting it."
slug: what-small-consultancies-should-automate-first
status: published
locale: en
published: 2026-10-09
updated: 2026-10-09
author: Envisioning
related: [why-agents-belong-in-the-same-project, connect-claude-to-team-projects-and-calls]
---

Automate the hand-off after a client call first. The call ends, someone works out what was agreed, and those commitments become tasks on the project. Let the software propose the tasks from the record of the call, and keep a person on the step that accepts them.

## Why the call is the right place to start

The input is known: a finished call's notes and transcript. The output is small: a list of internal actions on the project the call was about. And the person who owns the client relationship can check every item before it becomes work.

That makes mistakes easy to see. A broad brief such as "manage this client" asks the agent to guess what progress means. A list of commitments, each with the line that supports it, takes a minute to check.

## How it works in Starlings

We run our own client calls in Starlings, and this hand-off is built in. Starlings reads the transcript during the call and again when it ends, and proposes each action item on the call's project with the owner, the deadline and the exact quote. A proposed task has no owner or date until someone accepts it, and it links back to the call. After a call with people outside the team, the host also gets a drafted follow-up email. Approve opens it in the host's own mail app. Starlings never sends it.

See [what Starlings does with a call](/workspace/capabilities) for the full list.

## Rules for the first few calls

Agree on what counts as an action before you trust the list. "We agreed to send the draft by Friday" is a task. "We could look at the pricing again" is a question. Keep pricing, scope changes and anything else you would promise a client out of the first pass.

For the first few calls, compare the proposed list with what you would have written yourself. Count what it missed, what it invented and how much you edited. If checking the list takes longer than writing it, the workflow is not ready to expand.

## What to automate next: the brief before the call

Once the hand-off is reliable, the next job is the brief before the next call. A member's Claude, connected to the workspace, reads the client's history and writes the brief:

```text
I have a call with <client> tomorrow.
Read the last calls, the open tasks and the decisions filed on <client>.
Write a one-page brief: where things stand, what we owe them, what is still open.
Name the record behind each point. Do not file anything yet.
```

Read the brief against its sources. With **Also write** on, ask Claude to file it on the client, where the rest of the team will find it.

We moved our client work into one record so that jobs like this work. We have retired Zoom and Google Meet for client calls, our meeting notetaker, Slack, Notion and a separate task tool. We are still early in running Envisioning on Starlings, but one connection now gives an agent the whole client history. [How Envisioning runs on Starlings](/customers/envisioning) has the details.

For the Claude setup and what it can read, see [how to give Claude access to your team's projects and calls](/field-notes/connect-claude-to-team-projects-and-calls).
