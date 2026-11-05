---
kind: howto
status: active
verified: 2026-11-04
summary: "Answer the decisions an agent put to you, from INBOX on any client; how an agent asks and reads the answer"
capabilities: [owner-decision-queue]
owns: [packages/contracts/src/decision-asks.ts, services/control-plane/src/decision-asks.ts, services/control-plane/migrations/0063_decision_asks.sql]
---

# Answer a decision

An agent that needs you to choose something while you are not talking with
it puts the question in your decision queue instead of a GitHub comment. Each question comes
with its options, the one the agent recommends, and a **default-by** day.
You answer it in Starlings, on the web, the Mac or the phone, without the agent's
conversation open. The agent reads your answer back.

## Where decisions show

Decisions are the first rows in **INBOX** on Work's Overview and on Home's
WORK card, on every client. An overdue decision comes first, then the one
whose default-by day is soonest.

A row shows the question, who asked it, the recommended option, and the default-by day.
After the default-by day has passed, the row says **Overdue**.

## Answer one

1. Open the row. The sender is named above the context and links. Every option
   is a visible button, with the recommendation marked **Recommended**.
2. Optionally write a note.
3. Choose an option. On the Mac, press **Answer** to send your selection; no
   option is preselected. On the web and phone, choosing sends it immediately.
   The row leaves INBOX.

The row's menu (right-click on the Mac and the web, long-press on the phone)
also lists each option as **Answer: …**, to answer without opening it.

When the decision is about a subject, your answer is recorded as a decision
on that subject, and its channel gets a line about it. If the record store cannot be
reached, the answer is kept and the record is written when the answer is
sent again.

## The default-by day

The default-by day marks when the recommendation may be applied on purpose.
Nothing is decided for you when it passes. The row shows **Overdue**. The agent, or you, can then apply the
recommendation on purpose, and the agent says so when it does.

## For agents

An agent paired over MCP with write access uses the `ask_decision` tool:

- `ask` files a question: `question`, markdown `context`, two to six
  `options` (`key` and `label`), a `recommendation` that is one of the keys,
  and `default_by` as `YYYY-MM-DD`. Pass a `subject` door when the decision
  is about a subject, and `links` for the issue or pull request.
- `list` reads decisions back: `status` open, resolved or all, and `since`.
  `now` also returns `decisions_waiting` and `decisions_answered` (the last
  week), and `open` on a subject returns its `decision_asks`.
- `withdraw` takes a question back. `apply_default` applies the
  recommendation, and only after the default-by day.

The queue is not the first place to ask. When the member is talking with
you — in Claude Code, a chat or an IDE — ask there, even if the answer can
wait. Use the queue when nobody is in the conversation, and only for a real
choice: options that lead to different outcomes, one of which you could go
ahead on if nobody answers. A step the member has to do by hand — a secret, a
permission, a dashboard click — is not a decision; say it in the conversation,
or put it on the issue the work belongs to. Keep one open decision per issue,
and run `list` before asking.

Read the answer back before acting on it. To pair an agent, see
[Connect an agent over MCP](connect-an-agent-over-mcp.md).
