---
kind: reference
status: active
verified: 2026-11-05
summary: "Home: the clock, the modules in your order, and your room. ⌘1; the first tab; `/`"
surface: home
capabilities: [owner-question-inbox, owner-home, owner-setup, owner-today-work, owner-calendar-from-email]
owns: [web/src/home-keys.ts, web/src/use-row-menu.tsx, web/src/QuickNotesPanel.tsx, web/src/QuickNoteDialog.tsx, web/src/SearchablePicker.tsx, web/src/searchable-picker.ts, web/src/quick-note-destinations.ts, web/src/snapshot-store.ts, web/src/crm-work.ts, web/src/quick-notes.ts, web/src/ThreadPane.tsx, Sources/QuickNotesMacView.swift, Sources/QuickNoteFiling.swift, Sources/QuickNoteTriageSheet.swift, Sources/QuickNoteDestinations.swift, Sources/StarlingsSearchablePickerOption.swift, Sources/StarlingsSearchablePickerField.swift, Sources/SnapshotStore.swift, Sources/OwnerSessionStore.swift, Sources/StarlingsDateFormatting.swift, Sources/OwnerLaunchView.swift, Sources/StarlingsHomeViewController.swift, Sources/HomeLayout.swift, Sources/MainMenu.swift, iOS/MobileQuickNotesCard.swift, iOS/MobileQuickNoteSheet.swift, iOS/MobileQuickNotesStore.swift, iOS/MobileQuickNoteTriageSheet.swift, iOS/StarlingsSearchablePicker.swift, iOS/StarlingsAPI.swift, iOS/MobileHomeView.swift, iOS/StarlingsMobileDesign.swift, iOS/MobileFirstRunCard.swift, web/src/App.tsx#HomePage, web/src/OwnerWebHome.tsx, web/src/SetupCard.tsx, web/src/OwnerToday.tsx, web/src/OwnerHomeCards.tsx, web/src/use-foreground-poll.ts, web/src/inbox-rows.tsx, web/src/task-row-menu.tsx, web/src/home-layout.ts, packages/contracts/src/home-layout-values.ts, fixtures/home-layout.json, watchOSWidgets/StarlingsWatchWidgets.swift]
---

# Home

What is happening today, and your room. One screen on the Mac, the phone and the browser.

## Where

| Client | Reach it | Note |
| --- | --- | --- |
| Mac | ⌘1, or the switcher in any window | The Home window. Your room opens in its own Room window, a tab beside Home when Use tabs is on |
| iPhone and iPad | The Home tab | For the signed-in owner, the top-bar **+** opens New Quick Note; Search and Settings are in More. Signed out there is no tab bar; the unsigned root is one card |
| Web | `/` | Signed in: the member Home. Signed out: the visitor door: Join a room, Sign in, Runs on Starlings |

## What is on it

The clock is always first, the version line always last. Between them, the modules, in the order and set you choose in Settings → Home. Inbox, Work, Commercial, Events and Quick access hide when they have nothing to show; Your room, Quick Notes and Upcoming always show. The rule is the same on every surface. Settings → Home offers only the
modules this workspace has on; hidden modules keep their saved position and
visibility when another row moves.

Under the clock, a new admin or member sees **Get started**: their setup steps, each ticked when the thing exists (a photo, a calendar, your agent, a first project). **Skip** clears one step from your card on every client; **Hide** puts it away until the next session; an admin can **Turn off for everyone**, and turn it back on in Admin › People. When every required step is done it says so once. Mac, iPhone and web draw the same steps; see [Set up your workspace](../howto/set-up-your-workspace.md).

The date beneath the clock uses the same weekday, day and month order on Mac, phone and web, in the selected app language.

| Module | Holds | Row opens |
| --- | --- | --- |
| INBOX | What is new: unread conversations, each with an accent dot and how long ago the last message came, and the items waiting on you (decisions, questions, agent work to check, calendar invitations, events from forwarded mail where your workspace takes mail, proposed tasks, comments, bookings, sales touches, offers and licenses coming due, early-access requests). Calendar invitations come first, the soonest event first, then decisions and questions, then the rest, newest first. Three rows, then **and N more in Work**, which opens Work's INBOX | A conversation opens Work for a subject's, Team for a person's; an item opens where it is resolved |
| MINE | All of Mine, in the same order as Mine in Work, with a count of the rest and a link to Work. Tasks and GitHub issues are in one list. Each row shows Overdue, Today, its due date, or its stage when it has no date. New things never land here | A task opens its details, an issue opens in Work |
| COMMERCIAL | Twelve-month offers, sales, pipeline and new-license totals from the CRM. On the web, a second card, **Signals accounts**, lists the Signals accounts to follow up: overdue first, then no owner, then no next task. Each row shows the stage, license, trial and partnership, the owner and next task, and the usage figures with their age. Accounts that are not now or lost are counted, not listed. The card refreshes every 15 seconds while Home is in front. **All Signals accounts in Work** opens Work's Signals view. A row's **Tasks…** lists the account's open tasks, marks one done, and adds a task with a due date and assignee | A Signals account opens its full record |
| QUICK NOTES | Capture now, file later. Each note shows how long ago you wrote it | The note |
| UPCOMING | The next meeting as the hero, then the following rows; on the web the hero includes event context and attendee status. **Join** appears ten minutes before the start and joins in the app. With no calendar connected, the card offers **Connect Google Calendar**, on a Google workspace only | The event |
| EVENTS | Upcoming published events of the workspace | The public event page |
| YOUR ROOM | The room's name and link, **Start** / **Join**, **Copy room link**; on the Mac, the WAITING ROOM queue is inside the room launcher. Cannot be hidden | — |
| QUICK ACCESS | The final module: full-width across both columns on wide Home, one column on narrow Home. One horizontal row with no vertical scrolling inside the card; scroll sideways to reach more tiles. Starred things come first, then up to eight recent-only things from this device; each tile shows its type and starred mark, and an overlap appears once | As it does from Search |

Events marked **Hide from Next** are omitted from UPCOMING and meeting alerts.

UPCOMING lists only events you organize or attend and have not declined. Events that sit only on a colleague's calendar or a shared Google calendar stay in Calendar. Your own blocks, and subscribed feeds you switched on for Upcoming, still show.
They remain visible in Calendar, where **Show in Next** restores them.

On the Mac, **WAITING ROOM** is part of the **YOUR ROOM** launcher, above the room action and with each guest's queue controls.

The circular Watch next-meeting complication shows the Envisioning mark when it is not showing an
imminent countdown. Tap the mark to open Starlings Home on Watch.

On iPhone and iPad the inline Quick Notes field wraps and grows up to six lines; Return still saves the note.

On iPhone and iPad the inline Quick Notes field wraps and grows up to six lines; Return still saves the note.

**File…** on a Quick Note opens a searchable destination picker on Mac, iPhone/iPad and web. Type to filter projects, leads or conversations; subject searches can reach entries beyond the first page. The choices are reused for five minutes and refreshed after their source lists change or the owner signs out.

**Move to** on an open Quick Note moves it to another workspace you are signed in to on the same Mac or iPhone. The note keeps its text and the time you wrote it. With one workspace there is no Move to; the web has none, because a browser tab holds one workspace.

## Controls

| Control | Does | Shortcut |
| --- | --- | --- |
| Start room | Opens your permanent room in its own window or tab. During a meeting it says **Open meeting** and brings that window back | ⌘↩ (Start Meeting) |
| Start & Admit | Opens the room and admits the next person in the waiting room | — |
| Join | Enter a room by slug, as a guest | ⌘J on the Mac |
| Copy room link | Puts `/room/<slug>` on the clipboard | ⌘⇧C |
| Search | Opens the Search palette; on iOS choose **Search anything…** in More | ⌘K on Mac and web |
| New Quick Note | Opens a capture drawer from the iOS Home bar; the unfiled note stays private | — |
| Settings | The gear (web header, iOS toolbar) or ⌘, | ⌘, |
| Home settings | The gear at the top right of the modules: Settings → Home, where the modules are ordered and switched | — |
| File… | Opens the searchable destination picker for a Quick Note; the project, lead and conversation choices are cached for five minutes | QUICK NOTES row |

## Row menus (web)

Every Home row and tile has a menu. Open it with the `…` on the row, a right-click, or ⇧F10. The `…` shows when the pointer is over the row or the row has focus; on a touch screen it is always there. Tab reaches the `…`; the arrow keys skip it.

| Row | Menu |
| --- | --- |
| INBOX | A conversation: Open, Copy link / Star. An item keeps its available actions (Accept / Decline, Dismiss, Resolve, an answer to a decision; Accept / Maybe / Decline on a calendar invitation; Add to calendar / Discard on an event from forwarded mail) |
| WORK | Done, Cancel task, then the task's details |
| QUICK NOTES | Edit, File… / Delete |
| UPCOMING | Join (a video meeting), then Hide from Next / Show in Next and Open in Calendar |
| EVENTS | Open, Copy link (an event with a sign-up page) |
| QUICK ACCESS | Open, Copy link / Star |

The Mac and the phone have more on some rows (Mute, Archive and Mark as read on a conversation). The web leaves those out until it has the call.

## Keyboard (web)

Tab reaches every row. On a long Home, the arrow keys are faster:

| Key | Does |
| --- | --- |
| ↓ / ↑ | Next / previous row, across modules |
| ⌥↓ / ⌥↑ | First row of the next / previous module |
| Home / End | First / last row |
| ⇧F10 | The row's menu; Escape puts you back on the row |
| ↩ | Open the row |

## Leads to

Calendar, Work, Team, Docs (the other four surfaces); [meeting](meeting.md) through Start or Join; [settings](settings.md).

## Assigned agent questions

On Mac, iOS and web, assigned questions appear in Home's Inbox card and Work INBOX,
with the sender and conversation/subject context. Open the row to choose one
option immediately, select several and press **Submit answer**, or explicitly
**Dismiss**. Answering or dismissing closes the same request in the web chat
on refresh. Another participant sees who the question is waiting on. A read or
closing the dialog leaves the question open. See [Answer a question](../howto/answer-a-question.md).

Mac and iOS also answer/dismiss from their canonical Inbox detail. Their inline
chat controls still infer outcomes from source replies; canonical native chat
refresh remains in. Notification coordination remains in
; leaving a chat does not create a new alert in this UX slice.
