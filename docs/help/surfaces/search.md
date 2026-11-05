---
kind: reference
status: active
verified: 2026-11-04
summary: "Search: the ⌘K palette, one box that finds anything and jumps anywhere"
surface: search
owns: [Sources/SearchPanelController.swift, Sources/Search.swift, iOS/MobileSearchView.swift, web/src/SearchPalette.tsx, web/src/search-doors.ts, packages/contracts/src/search.ts, packages/contracts/src/search-values.ts, fixtures/search-rows.json]
---

# Search

One search field. It finds a subject, a person, an agent, a contact (a person outside your team, by name, organization or address), a conversation, a document, an event, a task, an issue, a goal, a decision, a milestone or a call, and it jumps to a destination, a Settings page (Account, Home, Work, Calendar, Appearance or About: the pages every client has) or a verb.

## Where

| Client | Open it | Scoped field |
| --- | --- | --- |
| Mac | ⌘K over the key window | ⌘F is the window's own field: the same search with that window's scope |
| iPhone and iPad | The search field on each tab | Same |
| Web | ⌘K on any member page, or the magnifier beside the gear | The shared search palette |

Search uses the same matching and ranking rules everywhere. There is no separate search field in the Work sidebar.

## Rows

Choosing a row opens the item where it lives. A goal opens its project, a decision its subject. A milestone opens its project, and a call the subject it is filed on, or its first contact when it has no subject.

Tasks you hold are always in search. Once your workspace keeps tasks in Starlings, search finds every task and milestone you can see, by its title or notes, whoever holds it. Once it keeps calls in Starlings, search finds every call by its title or notes. Recent rows are what you opened last on this device; Home's Quick Access is the same list, with starred rows first.

Records with no subject page are in search on every client, where the workspace has them. Each table you can read is a row: on Mac, iPhone and Android it opens that table in Work; on the web it opens the table's own page in a new tab. On the web, records also arrive after a pause, under **Records** below Docs: a project or lead opens on its Fields in Work, anything else on its own page. On Mac, iPhone and Android, **Search records** under Browse ▸ Other records finds the same records.

Search shows only the destinations the tabs list. A workspace without Docs has no Docs destination and no New document, and without a calendar source there is no Calendar destination. A workspace without other records has no **Records** rows on any client.

A failed request says so, with Retry. An incomplete result set says `partial`.

## Leads to

Anywhere.
