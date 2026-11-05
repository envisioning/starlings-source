---
kind: howto
status: active
verified: 2026-10-15
summary: "Find a time with a member at `/book/<slug>`"
capabilities: [entry-book, book-reschedule]
owns: [web/src/ScheduleScreen.tsx]
---

# Book a time

1. Open `/book/<slug>`, or press **Book a time** on a bare room page.
2. Pick a date, then a time. Change the city if the times are not in yours.
3. Enter your name, email and company, and what the meeting should cover. If the workspace offers an NDA, tick **Meet under NDA**: the NDA comes to your email to sign.
4. Press **Confirm booking**. You are on the calendar. The confirmation is the calendar invite. It carries the room link with a token.
5. To move or cancel it later, open the link in the invite, or on the room page the token opens. The booking page shows your booking: press **Cancel booking**, or pick a new time to move it.

On Envisioning, until its booking moves to Starlings, the confirmation is an email and you press **Change** to move or cancel.

The owner sees the booking on Calendar, on Home's UPCOMING and in INBOX. If the owner moves or cancels the meeting, the calendar invite tells you.

The workspace’s Admin › People settings supply time-zone presets and the default booking slot grid. A person’s saved booking settings still take precedence.
