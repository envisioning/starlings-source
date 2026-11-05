---
kind: reference
status: active
verified: 2026-10-15
summary: "Schedule: `/book/<slug>`, pick a time, say who you are"
surface: schedule
capabilities: [entry-book, book-reschedule]
owns: [web/src/ScheduleScreen.tsx]
---

# Schedule

Book time with a member. Open `/book/<slug>`, or press **Book a time** on [room-entry](room-entry.md).

## What is on it

| Element | Note |
| --- | --- |
| Dates, then times | A month calendar from the owner's availability; times shown in a city you pick. A day the owner is at one of the workspace's events carries the glyph, lists the event and offers no times; a line under the month names the glyph |
| Name, Email, Company or team | Asked here if you came directly. Otherwise, filled in from Room entry |
| What should we cover? | Goes on the booking |
| Meet under NDA | Where the workspace offers an NDA. The NDA comes to your email to sign, from Docs. The booking link shows whether it is signed |
| Confirm booking | Then **You're on the calendar** |
| Change | Reschedule or cancel an existing booking from its link. Where booking runs on Starlings, the link opens this page with the booking at the top: **Cancel booking**, or pick a new time to move it |
| Back | Up one step, to the room |

Web only. The Mac and the phone open this page in the browser.

Admin › People chooses the workspace’s time-zone presets and default booking slot grid. A person’s saved booking settings take precedence over the workspace grid.

## Leads to

A confirmed booking. Later, the booking token shows what the meeting is on the guest's [room-entry](room-entry.md) card.
