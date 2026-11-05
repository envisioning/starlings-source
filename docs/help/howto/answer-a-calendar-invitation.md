---
kind: howto
status: active
verified: 2026-11-05
summary: "Accept, Maybe or Decline a Google Calendar invitation from the Inbox on Mac, iPhone and web"
capabilities: [owner-calendar]
owns: [services/control-plane/src/inbox.ts, packages/contracts/src/inbox.ts, web/src/inbox-rows.tsx, Sources/WorkInbox.swift, iOS/MobileWorkView.swift]
---

# Answer a calendar invitation

When someone invites you to an event on Google Calendar, the invitation waits
in your Inbox until you answer it. Starlings reads every Google account you
connected in Settings → Calendar.

## Find it

- **Home:** the Inbox card lists it first, above everything else waiting on
  you. When you have more than one, the event that starts first comes first.
- **Work → INBOX:** the same row, with the rest of your Inbox.

The row shows the event's title, when it is and which calendar it is on.

## Answer it

| Where | How |
| --- | --- |
| Home, on any client | Press **Accept**, **Maybe** or **Decline** on the row |
| Work INBOX on Mac and web | Open the row menu (right-click or `…`) and choose an answer |
| Work INBOX on iPhone and iPad | Swipe the row, or press and hold it |

Your answer goes to Google Calendar, so the organizer sees it and the row
leaves the Inbox at once. An accepted event shows in Upcoming.

**Open in Calendar** in the row menu opens the event itself, with its guests,
notes and call link.

## When a row leaves on its own

- You answered it somewhere else: Google Calendar, Gmail or another device.
- The event ended.
- The organizer cancelled it.

## Turn it off

Settings → Work → Inbox → **Calendar invitations**. Invitations still wait in Google
Calendar and in Starlings Calendar, where you can answer them from the event.

## If an invitation does not show

Check that the Google account it was sent to is connected in Settings →
Calendar. Starlings reads every calendar on a connected account, whether or not
it is turned on in Calendar's Calendars menu.
