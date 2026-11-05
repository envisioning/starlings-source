---
kind: howto
status: active
verified: 2026-11-04
summary: "Answer or dismiss an assigned agent question from Home or Work Inbox on Mac, iOS and web"
capabilities: [owner-question-inbox, owner-agent-interactive-questions]
owns: [Sources/AttentionQuestionSheet.swift, Sources/AttentionQuestionState.swift, iOS/MobileAttentionQuestionSheet.swift, web/src/AttentionQuestionDialog.tsx, web/src/attention.ts, web/src/thread-parts.tsx, packages/contracts/src/inbox.ts, packages/contracts/src/inbox-values.ts, services/control-plane/src/inbox.ts]
---

# Answer a question

An agent can ask you for information or a preference with two to eight choices.
A Question gathers information; it does not approve an action. A Decision has
a recommendation and default-by day; see [Answer a decision](answer-a-decision.md).

## Find what needs you

On Mac, iPhone/iPad and web, Home's Inbox card and Work INBOX show questions
assigned to you. Work INBOX lists them after decisions. Each row names the asker
and its conversation or subject.
Questions stay there even while you are looking at their chat. Settings → Work →
Inbox lets you turn Questions off; the question remains in its conversation.

Mac and iPhone/iPad can also answer inline in chat. Their canonical chat refresh
is still being built: a dismissal in Inbox does not yet close native chat controls. Existing unassigned shared questions stay
in chat and keep their existing answer rules; nobody is guessed as a recipient.

## Answer or dismiss

1. Open the question row on Home or Work. The detail names who asked and
   shows the prompt and context.
2. For a single choice, press its button to send the answer. For several choices,
   select all that apply, then press **Submit answer**.
3. To decline to answer, press **Dismiss**. This records no choice and grants no
   authorization. Closing the detail leaves the question open.

The first valid answer or dismissal wins. If another surface answered first,
you see its result. The row leaves the pending queue; web chat shows the same
terminal state on refresh. An answer creates one human reply in the originating
conversation. Dismissal closes the request without inventing a reply message.
Agent delivery still uses the existing best-effort callback; an answered request
stays answered if delivery fails.

## Controls

| Control | Result |
| --- | --- |
| Open question | Opens the question detail from its row menu |
| Submit answer | Sends the selected choices for a multiple-choice question |
| Dismiss | Declines to answer and removes the question from the pending queue |
| Open conversation | Opens the actual source conversation and question on web |
| Close | Closes the detail without resolving an open question |

Only the assigned recipient sees active choices in Inbox detail on all three
clients and in web chat.
Other participants with access can read the state and see whom it waits on.
Failed refreshes report the error; they do not imply that nothing is waiting.
