---
title: "How to give Claude access to your team's projects and calls"
description: "Add your workspace's /mcp address as a connector in Claude, sign in as yourself and start read-only. Claude then reads what you can read, nothing more."
slug: connect-claude-to-team-projects-and-calls
status: published
locale: en
published: 2026-10-09
updated: 2026-10-09
author: Envisioning
related: [why-agents-belong-in-the-same-project, what-small-consultancies-should-automate-first]
---

Add your Starlings workspace to Claude as an MCP connector at `<your workspace origin>/mcp`, sign in as yourself, and leave **Also write** off. Claude then reads the projects, conversations, documents, tasks and finished calls that you can read, and nothing else. The [Claude setup guide](/help/howto/connect-claude) has the steps for claude.ai, Claude Desktop and Claude Code.

This connects your own Claude. A shared agent that teammates address together joins the Team with its own identity. See [how to connect an agent as a Team member](/help/howto/connect-an-agent-as-a-team-member).

## Start read-only

When you pair, Starlings asks whether Claude may also write. Leave it off at first. Read access is enough for research, summaries and drafts in Claude's own conversation. When you want Claude to create a task or file a document, pair again with **Also write** on. Claude then writes within your own permissions. Starlings records each call under your account and the client name, and marks written work with the client that made it.

Each workspace has its own address and its own connector. Use the workspace where the project lives.

## What Claude can see

Claude sees what your account sees. It can search and open the subjects, conversations, documents, tasks and issues you can read. It reads a call's notes and transcript after the call ends, when you hosted it or when it is filed on a subject you can access. A call that nobody filed stays visible only to its host.

Claude cannot read a call while it runs, join a room, or hear audio or video. Starlings does not record the audio or video of its calls.

Text that Claude reads goes to Anthropic under your own Claude account. Pair only the client you mean to use, and only for records you may share with that service. Pause or revoke the connection in **Settings → Account → Connected agents**.

## Ask one question you can check

Pick a project whose history you know, and ask:

```text
Find the project <project name>.
Summarize the decisions from its last finished call, and list its open tasks.
Name the record behind each line.
```

Check the answer against the records. If Claude cannot find a call or a task, check that the record is filed on the project and that your account can see it. A call's title alone does not make an unfiled transcript visible to another member.

We use this connection to brief ourselves before client calls. [What a small consultancy should automate first](/field-notes/what-small-consultancies-should-automate-first) has the prompt. For why the request and the result belong on the project, read [why agents belong in the same project](/field-notes/why-agents-belong-in-the-same-project).
