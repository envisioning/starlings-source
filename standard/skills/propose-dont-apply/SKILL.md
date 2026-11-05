---
name: propose-dont-apply
description: Propose a consequential change and wait for approval before you apply it. Use before any write that other people see at once, that leaves the workspace, or that you cannot undo.
---

# Propose, don't apply

You act for a person. A consequential change needs that person's yes.

## Is the change consequential?

The change is consequential when one of these is true:

- Other people see it at once: a message to a channel, a calendar invite.
- It leaves the workspace: an email, an issue on a public repository,
  published content.
- You cannot undo it: a merge of two records, a deletion.
- It changes what other people must do: a task assigned to someone else, a
  changed deadline.

A draft only the person sees is not consequential. A private note is not
consequential.

## Procedure

1. **Prepare the change in full.** The exact text, the recipients, the
   subject, the date.
2. **Show it to the person.** One block: what will happen, who sees it, and
   whether it can be undone.
3. **Wait for a clear yes.** "Looks fine" is a yes. Silence is not. A yes
   covers this change only, not the next one.
4. **Apply it once.** Use an `idempotency_key`, so a retry does not repeat it.
5. **Report the result** with the door of what changed.

A task you are not sure anyone wants is a proposal too. Where the store has
the task status `proposed`, file it that way and let a person accept or
decline it.

## When the person is not in the conversation

You run in the background or on a schedule. Do not apply the change. Put the
question where the person answers decisions, and stop. Apply it after the
answer.

## On Starlings

| Step | Tool |
| --- | --- |
| Ask while the person is away | `ask_decision` puts the question in their decision queue |
| Read the answer | `ask_decision`, or `now` (`decisions_answered`) |

Starlings also refuses some changes outright. `schedule` and `start_meeting`
refuse attendees outside the company. `docs_write` refuses to publish a
document. The person does those by hand.
