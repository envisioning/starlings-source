---
kind: reference
status: active
verified: 2026-11-04
summary: "Calendar: Google, EventKit and subscriptions, one week or day or month; ⌘2; `/calendar`"
surface: calendar
capabilities: [owner-calendar, owner-calendar-window, owner-schedule, owner-calendar-quick-add, owner-calendar-tools]
owns: [Sources/CalendarViewController.swift, Sources/CalendarWindowController.swift, Sources/CalendarAppKitChrome.swift, Sources/CalendarInspectorView.swift, Sources/StarlingsSearchablePickerOption.swift, Sources/StarlingsSearchablePickerField.swift, Sources/MainMenu.swift, iOS/MobileCalendarScreen.swift, iOS/MobileCalendarChrome.swift, iOS/MobileCalendarEventEditor.swift, iOS/MobileCalendarDisplaySettingsView.swift, iOS/MobileCalendarSourcesView.swift, iOS/MobileCalendarStore.swift, iOS/StarlingsSearchablePicker.swift, web/src/CalendarPage.tsx, web/src/CalendarEventEditor.tsx, web/src/LocalDateTimeField.tsx, web/src/SearchablePicker.tsx, web/src/searchable-picker.ts]
---

# Calendar

Your calendar, with the meetings that Starlings knows about.

## Where

| Client | Reach it | Views |
| --- | --- | --- |
| Mac | ⌘2 | Day / Week / Month, ⌃⌘1 / ⌃⌘2 / ⌃⌘3; sidebar of sources and the mini month; inspector for the chosen event; ✕, Esc, or a click on empty grid closes it, and the toolbar's right-sidebar toggle (⌃⌘I) brings it back |
| iPhone and iPad | The Calendar tab | Day, 2-day, 3-day, week, month, agenda; long-press moves an event; resize is in the editor |
| Web | `/calendar` | One Google week at a time, plus read-only Events, Milestones, Tasks and My availability layers |

A timed event's tile says more as it gets taller, on every client, and reads from its top edge: the title, then the time (`start – end`), then the place, or the meeting's platform when it has no place. An event made in a zone with a different offset adds that zone's clock, as in `12:05 – 14:05 (10:05 GMT)`. A row shows whole or not at all; a half-hour tile at the default zoom is the title alone. The wording is `fixtures/calendar-tile.json`.

The Calendar tab shows once you have a calendar source: Google, another Google account, a subscribed `.ics` feed, or Apple Calendar on Mac and iPhone. Until then the tab is hidden, along with its search entry and, on the Mac, its menu item and ⌘2. You connect a calendar from Home's Upcoming card or from Settings. A link to `/calendar` still opens it.

On a workspace whose suite is Microsoft 365 or other, Connect Google Calendar does not show, and the app says "Calendar connects to Google only." An admin sets the suite in Admin › People.

On Mac, when you select an event, its title shows in the Calendar tab. When you clear the selection, the tab title goes back to Calendar.

## Controls

| Control | Does | Where |
| --- | --- | --- |
| Today | Jumps to today | ⌘T on the Mac; the toolbar |
| Previous / Next | Moves one period | ⌘← / ⌘→ on the Mac; Earlier / Later on the web |
| New event… | An event at the next quarter hour; the form starts with Title, and its times move in 5-minute steps | ⌘N on the Mac; `+` on every client |
| Quick add event… | Type one sentence, such as "Coffee with Ana Thu 14:00 at Ground, 45 min"; New event opens with the title, times, place and guests filled in, for you to check and save | The `+` menu on every client |
| Open | The chosen event in the inspector | ⌘O |
| Join | Joins the chosen event's meeting in the app | ⌘J |
| Copy link | The event's meeting link | ⌘⇧C |
| Duplicate | A copy of the event; the way to move something on Envisioning Internal | ⌘D on the Mac |
| Delete | Removes a writable event; a recurring Google event asks This event or All events | ⌫ on the Mac; the editor on the web |
| Hide from Next | Removes the event from Home's Upcoming and meeting alerts; it leaves the Calendar grid too. Turn on Show hidden events (Settings → Calendar on Mac and iPhone and iPad, the Calendars menu on the web) to see it faded, and use Show in Next to restore it | The event's context menu on Mac and web, or its editor on iPhone and iPad |
| Reply | Accept, Maybe or Decline an invitation | The event's context menu on the Mac and the web, or the invitation's row in INBOX ([Answer a calendar invitation](../howto/answer-a-calendar-invitation.md)) |
| Reload | Fetches again | ⌘R |
| Search | Events in the window Search covers | ⌘F |
| Calendar | Type to narrow the available calendars in an event editor | Event editor |
| New events | Type to narrow writable calendars and choose where new events go by default | Calendar settings on iPhone and iPad |

In an event's guest list, a guest who is one of your contacts shows their
name, title and organization instead of the address. Selecting them opens
the contact in Work.

## Row menus (web)

Each event in the day list has a menu. Open it with the `…` on the row, a right-click, or ⇧F10. Blocks on the timeline have no menu.

| Group | Items |
| --- | --- |
| Join | Join, when the event has a meeting |
| Change | Edit…, when you can write the calendar; Hide from Next or Show in Next; Reply, when you are invited; Move to, when the event can move |
| Copy | Copy link, when the event has a meeting link |

Move to lists your calendars by account, with the event's calendar ticked. It shows on the Mac's right-click menu, on a long press of an event in the iPhone's month view and agenda, and in the editor on every client. The iPhone's day and week grids keep a long press for dragging an event to a new time. An event in a subscription or in the shared Global interest calendar has no Move to. Delete is in the editor. The web has no Duplicate.
The Calendar field searches available writable calendars by name and account on
Mac, iPhone/iPad and web.
The New events setting uses the same searchable calendar list on iPhone and iPad.

You choose sources on the Mac or the phone: which calendars show, which are hidden, and which subscribed feeds appear in Home's UPCOMING. The web uses those choices. Google calendars and selected subscribed feeds appear in Home's UPCOMING on Mac, iOS, and web. Subscribed feeds also appear in the web Calendar, read-only. EventKit events show only in the native Calendar view. The Upcoming display policy (how many following meetings, and so on) is under Settings → Upcoming on all three.

A task, milestone or published event opens read-only where an event opens: double-click it on the Mac, tap it on the phone, click it on the web. It shows when it is, its project, who has it, its status and its notes, with buttons into Work.

An admin chooses the workspace’s time-zone presets in Admin › People. Calendar uses those choices on Mac, iOS and web; an existing event keeps its own time zone.

## Leads to

A task you own opens in Mine. Anyone's task opens on its project's Tasks pane, and a milestone opens on its project. A published event opens its event page.

An event's meeting. Your own room opens with you as host. A colleague's room opens with a knock. Any other meeting opens in its own app. None open in the browser.
