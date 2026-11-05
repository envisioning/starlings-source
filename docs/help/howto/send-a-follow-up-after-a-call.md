---
kind: howto
status: active
verified: 2026-10-20
summary: "After a call with people from outside your team, approve the drafted follow-up and its tasks from Inbox; your mail app sends it"
capabilities: [owner-after-call-follow-up]
owns: [services/control-plane/src/follow-ups.ts, services/control-plane/migrations/0107_meeting_follow_ups.sql, web/src/FollowUpDialog.tsx, web/src/follow-up-mail.ts, Sources/FollowUpSheet.swift, Sources/FollowUpMail.swift, iOS/MobileFollowUpSheet.swift]
---

# Send a follow-up after a call

After a call with people from outside your team, Starlings drafts the
follow-up for you to send them, next to the tasks the call produced. You
check both, and your own mail app sends the message. Starlings never sends
mail.

## When you get one

You get a follow-up when all of this is true:

- You hosted the call.
- The call is filed on a lead, a project or a partner. A call you file later
  gets its follow-up when you file it.
- Someone from outside your team was in the call and joined with an email
  address.

A call with only your team gets its tasks, and no follow-up.

The draft is written in the language of the call. It says what was agreed,
who does what by when, and the next step. It never quotes the transcript.

## Approve it

1. Open the follow-up in **Inbox**, on Work's Overview or on Home. It shows
   who it goes to, the subject, the message, and the tasks from the call.
2. Untick a task you do not want. Ticked tasks are accepted, the others are
   declined.
3. On the web you can change the subject and the message here. On the Mac and
   the iPhone you change them in your mail app.
4. Choose **Approve**. Your mail app opens a new message to the people from
   outside, with the subject and the message filled in. Read it and send it.

If the message is too long for a mail link, Starlings puts it on your
clipboard and opens the mail with the subject only. Paste the message in.

## Dismiss it

Choose **Dismiss** in the follow-up or in its row's menu. The follow-up leaves
Inbox. The tasks stay in Inbox for you to accept or decline.

A follow-up you do not answer leaves Inbox after a week.

## Who sees it

Only you, the host. The draft is kept with the call's transcript. Your
teammates see the call's notes and tasks as before.

## Controls

| Control | Where |
| --- | --- |
| Approve | The follow-up, on the web, the Mac and the iPhone |
| Dismiss | The follow-up, and its row's menu |
