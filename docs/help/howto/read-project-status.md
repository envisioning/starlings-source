---
kind: howto
status: active
verified: 2026-11-05
summary: "Have an agent answer where a project stands: which read to make, the six stage words, and what a status is not"
capabilities: [owner-work, owner-issues, owner-interactions, agent-meeting]
owns: [services/control-plane/src/mcp.ts]
---

# Read project status

An agent paired over MCP, such as Claude or Hermes, can answer "where does
this stand" without you opening Work. Ask it plainly, or use the
**project_status** prompt. To pair one, see
[Connect an agent over MCP](connect-an-agent-over-mcp.md).

**Status is a read of the subject.** The record of the tools an agent called
shows who looked. It does not show where the work stands.

## Which read answers which question

| Ask | The agent reads |
| --- | --- |
| Everything open, at once | `starlings://board/<days>`: every open subject with its open tasks and issues, plus what finished in the last `<days>` (1 to 90) |
| One subject | `search`, then `open` on that row's `door`: recent interactions, open tasks, open issues |
| One project's cards by stage | `starlings://board/project/<id>/<days>`: the project's tasks and issues, the read its Board makes, plus what finished in the last `<days>` (1 to 90) |
| One subject, with goals | `starlings://subject/<kind>/<id>`, where `kind` is `lead`, `project`, `partner` or `event` |
| What changed lately | `starlings://feed/<limit>`: interactions, newest first, 1 to 100 |
| Which subjects are busy | `starlings://subjects/<kind>`: open-task counts and last activity |
| Today | `now`: people around, the next 24 hours, your tasks and issues, quick notes |
| A meeting's transcript | `transcript`, on a meeting link from an interaction |

The **brief** prompt makes the one-subject read for you. The
**prep_next_meeting** prompt makes the read before a call.

## The six stages

A stage is one of `queued`, `doing`, `review`, `blocked`, `done`, `dropped`.
No other stage exists. Starlings computes the stage from the row and never stores
it. "In progress" and "waiting" are the agent's words, not stages. An open
issue with no `agent:*` label is **queued**. This does not mean that anyone
has started.

## What a status read does not do

- **It does not write.** `task`, `record_decision` and
  `set_goal` change the thing you asked about. A Claude answering a status
  question should ask before touching any of them.
- **It does not post to Talk.** Reads leave no line in a subject's Talk.
  Only writes do.
- **It is not the call record.** Every read adds a row that you can see under
  Settings → Account → **Connected agents**. That row shows that the agent
  looked. It does not answer the status question.
