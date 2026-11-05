---
name: file-to-the-subject
description: File every output (a task, a document, a message, an issue, a note) to the subject it is about, with attribution. Use whenever you produce something the team should see later.
---

# File to the subject

Output that lives only in your chat is lost when the chat ends. File it to
the subject, so the next person and the next agent find it.

## Procedure

1. **Choose the right kind of output.**
   - Work someone must do: a task.
   - A longer text the team reads and edits: a document.
   - A short update to the people on the subject: a message.
   - A settled choice: a decision. See [record-a-decision](../record-a-decision/SKILL.md).
   - A bug or change in code: an issue on the linked repository.
2. **Attach it to the subject's door.** Never create an output with no
   subject when a subject exists.
3. **Write it so it stands alone.** A reader who did not see your chat must
   understand it. Name the source: the call, the document, the message.
4. **Keep the attribution.** You act for a person. Do not write as if the
   person wrote it by hand. The store shows your client name beside the
   output.
5. **Return the door.** Tell the person what you filed and where, with the
   new thing's door.

## Rules

- One output, one place. Do not post the same text as a message and a
  document.
- Follow [propose-dont-apply](../propose-dont-apply/SKILL.md) for output
  other people see at once, such as a message to a channel.
- Use an `idempotency_key` when you retry a write.

## On Starlings

| Output | Tool |
| --- | --- |
| Task | `task` |
| Document | `docs_write` |
| Message | `send_message` |
| Issue | `create_issue` |
| Goal | `set_goal` |
| File a quick note | `task`, `create_issue`, `send_message` or `docs_write`, with the note's id as `quick_note` |
