---
name: record-a-decision
description: Record a settled choice as a decision on its subject, not as a chat message. Use when a call, a thread or the person settles something the team must not reopen.
---

# Record a decision

A decision in a chat scrolls away. A recorded decision stays on the subject,
and the next agent reads it as settled.

## Is it a decision?

It is a decision when the team chose one option and closed the others: a
price, a scope, a date, a vendor, a no. A plan, an idea or an open question is
not a decision.

## Procedure

1. **Confirm it is settled.** Find who decided and where: a call, a message,
   the person in this conversation. If nobody decided, it is a question. Ask
   it instead (see [propose-dont-apply](../propose-dont-apply/SKILL.md)).
2. **Write it in one to three sentences.** What was chosen. What it replaces,
   if anything. One sentence of reason.
3. **Name the source.** The meeting, the thread or the person.
4. **Record it on the subject's door.**
5. **Do not repeat it as a message.** The record shows on the subject. One
   line, never two.

## Rules

- A decision you inferred is not a decision. Record only what someone
  stated.
- To change a settled decision, record a new decision that names the old
  one. Do not edit history.

## On Starlings

| Step | Tool |
| --- | --- |
| Record | `record_decision` |
| Ask instead, when nobody decided | `ask_decision` |
| Read earlier decisions | `now` (`decisions_answered`), `open` on the subject |
