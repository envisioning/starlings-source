---
kind: reference
status: active
verified: 2026-11-05
summary: "Work: every subject, what needs you, what you owe; ⌘3; `/work`"
surface: work
capabilities: [owner-question-inbox, owner-work, owner-issues, owner-channels, owner-interactions, owner-meet-about, owner-task-reader, owner-goals-decisions, owner-agent-interactive-questions, owner-decision-queue]
owns: [web/src/WorkRecordGroups.tsx, web/src/LicenseForm.tsx, Sources/WorkLicenseEditor.swift, Sources/LicenseParts.swift, iOS/MobileRecordGroups.swift, iOS/MobileLicenseView.swift, Sources/WorkWindowController.swift, Sources/WorkContactPage.swift, Sources/ContactListFilter.swift, Sources/ContactProfileDraft.swift, iOS/MobileContactView.swift, web/src/WorkContact.tsx, web/src/WorkInteractionEditor.tsx, Sources/WorkInteractionEditor.swift, Sources/WorkInteractionsView.swift, Sources/WorkInteractions.swift, iOS/MobileInteractionEditor.swift, iOS/MobileSubjectInteractions.swift, web/src/WorkContactsGroup.tsx, web/src/contacts.ts, Sources/WorkItems.swift, Sources/MeetingControlAPI.swift, Sources/WorkIssueChrome.swift, Sources/WorkInspectorViewController.swift, Sources/WorkSubjectEditor.swift, Sources/WorkRelationPicker.swift, Sources/MeetingCategory.swift, Sources/WorkOverviewView.swift, Sources/WorkInbox.swift, Sources/WorkRowActions.swift, Sources/WorkSubjectOverviewView.swift, Sources/GoalDecisionSheets.swift, Sources/GoalsDecisions.swift, Sources/MainMenu.swift, Sources/MainWindowController.swift, Sources/TeamWindowController.swift#TeamViewController, Sources/QuickNoteFiling.swift, Sources/QuickNoteTriageSheet.swift, Sources/QuickNoteDestinations.swift, Sources/StarlingsSearchablePickerOption.swift, Sources/StarlingsSearchablePickerField.swift, Sources/TaskMoveSheet.swift, Sources/MeetingTaskEditor.swift, Sources/WorkCardBoardView.swift, Sources/SnapshotStore.swift, Sources/OwnerSessionStore.swift, iOS/StarlingsAppModel.swift, iOS/StarlingsAPI.swift, iOS/MobileMyWorkStore.swift, iOS/MobileWorkView.swift, iOS/MobileSubjectOverviewView.swift, iOS/MobileSubjectEditorView.swift, iOS/MobileRelationPicker.swift, iOS/WorkRowActionMenu.swift, iOS/MobileSubjectTasks.swift, iOS/MobileTasksPanel.swift, iOS/MobileGoalsDecisions.swift, iOS/MobileQuickNotesStore.swift, iOS/MobileQuickNoteTriageSheet.swift, iOS/StarlingsSearchablePicker.swift, packages/contracts/src/work-items.ts, packages/contracts/src/crm.ts, packages/contracts/src/index.ts, packages/contracts/src/wire.ts, packages/contracts/src/capabilities.ts, services/control-plane/src/recently-closed.ts, services/control-plane/src/unowned.ts, services/control-plane/src/board.ts, services/control-plane/src/core-cache.ts, services/control-plane/src/crm.ts, services/control-plane/src/index.ts#route, web/src/WorkPage.tsx, web/src/WorkActivity.tsx, web/src/SubjectFieldsPane.tsx, web/src/core-fields.ts, web/src/KeepHandoffDialog.tsx, packages/contracts/src/core-fields.ts, packages/contracts/src/work-actions.ts, web/src/crm-work.ts, web/src/CmsRecordEditor.tsx, web/marketing/src/FeaturesPage.tsx, web/marketing/src/features.tsx, web/src/QuickNotesPanel.tsx, web/src/QuickNoteDialog.tsx, web/src/SearchablePicker.tsx, web/src/searchable-picker.ts, web/src/quick-note-destinations.ts, web/src/ThreadPane.tsx, web/src/quick-notes.ts, web/src/WorkRows.tsx, web/src/SubjectGoals.tsx, web/src/SubjectDecisions.tsx, web/src/PeerAvatar.tsx, web/src/FavoriteToggle.tsx, web/src/docs-list.tsx, web/src/inbox-rows.tsx, web/src/task-row-menu.tsx, web/src/SurfaceShell.tsx, web/src/SiteChrome.tsx, Sources/ThreadPaneView.swift, Sources/ThreadTranscriptViews.swift, iOS/MobileThreadView.swift, iOS/MobileThreadStore.swift]
---

# Work

Projects, leads, partners and events, with their goals, tasks, issues, decisions, documents and the one conversation on each.

## Where

| Client | Reach it |
| --- | --- |
| Mac | ⌘3; Mine is ⌥⌘3 |
| iPhone and iPad | The Work tab |
| Web | `/work` |

## Shape

When signed out on web, the page shows a centered card with the Work heading and one sign-in action.

On Mac and web the rail is a jump list: **Overview**, then **SUBJECTS** with Browse at its foot. **INBOX** and **MINE** are Overview's two columns, each with its filter beside its heading; on a wide window each column scrolls on its own. **Quick Notes** has a separate list below INBOX in that same scroll column, followed by **Activity**, and **UNOWNED** a separate list below MINE in its column. Every one of these headers folds: click its chevron to close or open the list; each device remembers its own folds. Web search is the shared ⌘K palette, opened from the header search button or the keyboard shortcut. On iPad the Work tab follows the Mac: a sidebar of **Overview**, then **SUBJECTS** with Browse at its foot, and Overview shows INBOX with Quick Notes below it in one column and MINE with UNOWNED below it in the other. On iPhone, and on an iPad in a narrow Split View, the Work tab is one list: Today, then INBOX, Quick Notes, Activity, MINE and UNOWNED as separate sections, then SUBJECTS. On every device INBOX, Quick Notes, MINE and UNOWNED stay separate lists; they are never merged into one. The column shows what you chose. The inspector shows the one item you chose inside the column. On Mac, the selected task, issue or Quick Note stays marked in its list while the inspector shows it.

A subject's views are one row of tabs under its name, on every client: **Overview**, then Talk (when it is not beside Overview), Board, Tasks, Issues, History, Documents and Fields, as the subject has them. A partner and an event lead with their own page. A subject's context groups (Team, Agents, Work, Relationship and About) sit beside its panes on Mac and web, and at the top of the subject overview on iOS. Choosing a person or agent opens their direct message in Team.

Mine and each subject's Tasks pane list open tasks. **Recently finished** keeps your completed or cancelled tasks and closed GitHub issues from the last seven days, newest first. Choose it in Mine's filter menu, under **Due**, on every client: it replaces the open list until you choose another Due option or **Reset**. Choose **Reopen** to put one back into open work. Home's **QUICK ACCESS** module is what you opened, not what you completed. To find older closed GitHub issues, open a project's **Issues** pane and set **State** to **Closed**; **Order** can sort by **Recently updated**.

On Mac, the Work tab includes the open subject or direct item in its title, such as `Work — Project name`; returning to Overview clears the item title.

When filing a Quick Note, the destination picker searches as you type. It searches projects and leads beyond the first page, and filters the conversation list in place. The choices stay cached for five minutes and clear when their source lists change or the owner signs out.

A new lead requires an organization. A project may have one or none. Search the workspace's organizations in the Organization picker on Mac, iPhone/iPad or web; when no exact match exists, create the organization from that picker. In the same sheet, the Contact picker puts one contact on a lead and the Contacts picker puts several on a project. Both search the workspace's contacts on Mac, iPhone/iPad and web, with or without Core.

An organization's page lists its people under **CONTACTS**. **Add contact** (the + beside it on Mac and web, the row under them on iPhone and iPad) adds one to that organization: a name, a title, the organization, and addresses, one per line with the primary first. A contact opens on their own page (in the inspector on Mac, pushed on iPhone and iPad, `/work/contact/<id>` on the web): their addresses, the projects and leads they are on, the calls they were in and the members who met them. **Edit** changes any of it. Search finds a contact by name, organization or address. One address belongs to one contact; an address that is already another contact's is refused.

Browse → **CONTACTS** lists every contact, after the organizations. Search finds a contact by name, address, title or organization. The filter menu narrows the list by organization, country, partner, existing client, Signals status and language. Each device remembers its own filter.

A contact's page has **Edit**, **Merge…** and **Delete**, on the web, the Mac and the iPhone. Edit also sets the birthday, the language, the Signals status and the characteristics. A new contact needs no source. Merge… takes a duplicate contact: the older one stays and keeps every link and address, and the other is deleted. Delete asks first. It is refused while a call or a task still names the contact, and the refusal names them. Its leads and projects stay, without the contact.

An organization's page has **Edit organization**, **Merge…** and **Delete**, on the web, the Mac and the iPhone. Edit organization changes its name, website, industry, legal name, city, country, LinkedIn, domain and notes, and the Partner, Agency and Existing client flags. Merge… takes a duplicate organization: the older of the two stays and keeps every link, and the other is deleted. Delete asks first, and is refused while a project, lead, contact or task still points at the organization; the refusal names them.

In Mac Browse, leads use the same openable subject rows as projects, with the
organization logo when available and a lead icon when one is not on file.

A won or lost lead is closed. Browse, SUBJECTS, the lead pickers and the lead
counts show open leads; pick **All**, **Closed Won** or **Closed Lost** in
Browse's status filter to see the closed ones. A closed lead still opens from
a link and from its project's **Won from**.

Browse → **EVENTS** lists upcoming events. Each row shows the days remaining,
or **Today** when the event is today.

The same searchable picker is used for long subject, assignee, owner and goal
choices in Work task and goal forms, and Mac's board filters. Calendar source
choices in the event editor use it on all three clients. Web CMS relation and
time-zone fields use it too. Each list keeps its existing order; short fixed
choices such as status and responsibility stay compact.

| Destination | Holds |
| --- | --- |
| Overview | Today's meetings, INBOX above Quick Notes in one column, and MINE beside them; the column with nothing chosen. On Mac, a task or issue from either list, or a Quick Note or document, opens in the right inspector and keeps the lists visible |
| INBOX | What is new and waits on you; each row leaves when resolved. Your own overdue and assigned work is never here: MINE lists it. Decisions an agent asked you name their sender and come first, overdue first ([Answer a decision](../howto/answer-a-decision.md)). A card you handed to an agent is a row when the agent moves it to Review or Blocked, and leaves when the card moves on. The row opens the card. After a call you hosted with people from outside your team, the drafted follow-up and the call's tasks are a row too ([Send a follow-up after a call](../howto/send-a-follow-up-after-a-call.md)). A guest or an organization who wrote on a subject you can see, and got no answer yet, is a row until someone replies or you dismiss it; it opens that subject's Talk. A message from an app user or a public contact opens its conversation in Team, on Mac, iOS and web. When Starlings support answers a question you asked in Help, that is a row too; opening it opens the conversation |
| Activity | The latest 30 interactions and quiet event lines from the past seven days on your visible, unmuted open projects and events, plus leads with Sales on. Expanded by default; each row opens its subject at History. It never adds to INBOX counts. Partial history keeps the available rows and offers Retry |
| Quick Notes | Captured notes without a subject, in their own list below INBOX. File… or delete a note here |
| MINE | What you owe, by when. Complete a task from its row: it starts fading out immediately on the web and iPhone/iPad, while Mac shows its completed mark. Right-click a task (long-press on the phone) for Done, Cancel Task or **Hand off to** an agent, and an issue for Close issue, Close as not planned, Reopen issue or Hand off. A failed write restores the task. The same menu is on every list that shows them |
| UNOWNED | Open work on any open subject that nobody on the workspace's side holds: a task with no assignee that the client does not owe, and a GitHub issue with no assignee and no `agent:*` stage label. Same order and rows as MINE; its filter menu shows **Tasks** (the default), **GitHub issues** or **All work**, then **Subjects**: one checkmark per subject with unowned work of that type; uncheck one to hide its rows, and **Show all subjects** brings them back. Both are remembered on each device. A row you complete, cancel, close or assign leaves the list at once. Right-click a row (long-press on the phone) and choose **Assign to ▸** a teammate (you are first, as **Me**): a task becomes theirs on the workspace's side, an issue gets their GitHub username as its assignee (teammates with no GitHub username cannot take an issue). Shown only when there is something in it, and a row leaves the list once someone holds it |
| Recently finished | A choice in MINE's filter menu: your own recently completed or cancelled tasks and closed issues, in place of the open list; Reopen puts the row back into open work | Reopen button |
| SUBJECTS | Every open subject, starred first, the ones with new talk first |
| A subject | Its Overview: **Talk** beside Goals / Tasks / Issues / Decisions / Documents / History; metadata in the inspector, and Fields as a tab. A lead that came from a form shows the form's answers first, every question with what the person wrote. Context groups fold independently; choosing someone in Team or Agents opens their direct message. On a project or lead, Team lists first the person who answers for it, marked **Responsible**, or **Responsible (suggested)** when nobody chose and the open tasks point to someone; a person row's menu has **Make responsible**. It names who answers, and changes nobody's access. On the web, decisions head History |
| A task | Its page: status, due date, subject, who is responsible and who holds it, then **Activity**, everything said about the task in the threads you can read. That is the hand-off with what done looks like, the agent's steps and answers, its questions, and the event lines. Answer an agent's question here, in Inbox or in Talk: one answer clears all three. On the web, **Open in Talk** shows a line in its conversation. On the Mac it is in the task's inspector, on iPhone and iPad at the foot of the task |
| Fields | Every field of a project or lead. Change what you need, then **Save**; **Revert** drops the draft. On the Mac and the phone the pane reads and writes through Starlings, on any workspace: the title, status, dates, URL, description, the Internal switch and a lead's notes and qualification checklist, and the project notes and EVID where Project specs is on. The organization, lead and contacts show as names and change in Edit details…; a partner's fields are read-only. On the web, the pane lists every field the registry has: text, numbers, dates, toggles and choices edit in place; relations, lists, countries and industries show read-only. An event's fields are its Event page |
| Sales | An optional section inside Work for leads; switched on in Settings → Work |
| Offers and Licenses | Two groups on Browse. Filter offers by status and licenses by product and status. Pick **Signals** to see the Signals customers. Web and Mac open and edit a row, and iPhone and Android open it to read. A license can also be created from the Licenses group on an organization or a lead. An offer lists who viewed it: when, and by which address | Browse |

## Controls

| Control | Does | Shortcut |
| --- | --- | --- |
| New Project… / New Lead… / New Document / New Quick Note… | The `+` menu; a new lead requires an organization, and a project may have one, searchable or created from the picker | — |
| Edit details… | Update a project's organization, contacts, name, status, dates, URL and description | project menu on Mac; subject menu on iPhone and iPad |
| Edit organization / Delete | Change an organization's fields, or delete it once nothing points at it | the organization's page on web |
| Win… | On an open lead: start its project with the lead's organization, contact and title, move the open tasks you pick, and close the lead as won. The new project opens. The project shows the lead under **Won from**, the lead lists it under **Projects**, and the project's History includes the lead's calls, meetings and notes, marked **From the lead** | lead row menu on Mac, iPhone, iPad and web; the lead's header menu on web |
| New Task | A task on the open subject; on a project it names the goal it serves | ⌥⌘T |
| Log | A call, meeting or note on the open subject's History, with its type, title, date and time, summary, link, organization, lead, project and contacts. A project fills in its project and organization, a lead its lead and organization, a partner itself | History header on Mac and web; the + on History on iPhone and iPad; the + on Overview's History group on web |
| Edit / Delete… | Change a History row in the same editor, or delete it after you confirm. Starlings refuses a row you cannot change | the History row's reader; the inspector on Mac |
| New Goal | A goal on the open project: title, target date, owner. A goal row settles as Met or Dropped, and reopens | Overview header + |
| Record Decision | A decision on the open subject, citing a live goal when there is one. Written once. Starlings posts a line about it in the channel | Overview header + |
| Open decision | A decision in INBOX: the sender, context and links, and a button per option with the recommended one marked. Choose one to answer, with an optional note; on the Mac, press Answer to send the selection. The row's menu lists each option as **Answer: …** | decision row menu |
| Mark as Decision | The channel line, verbatim, becomes a decision on the subject | line menu |
| More actions | On a Talk message: reply, react (including to your own), copy, mark as a decision, save your own text as a Quick Note copy, or edit and withdraw your own message | message menu |
| Save as Quick Note | Copies your message text into your private Quick Notes list; the original stays in Talk. Use **File…** on the copy to triage it into shared work | your message menu |
| Submit answer | Sends the selected options for a multiple-select question. A single choice is sent when selected. Questions gather information; they do not approve an action | interactive question |
| New Issue | An issue on the open subject's repository | ⌥⌘I |
| New Document | A document filed on the open subject | ⌥⌘D |
| Float Document | The document open in the inspector, in a window of its own that stays on top (Mac) | ⇧⌘F |
| Meet about this | Opens your room with the subject attached, so the record files there | — |
| Message | Opens a person's or agent's direct message in Team from the subject context | person row |
| Overview | Back to the lounge | ⌥⌘0 |
| Back / Forward | Through what you opened | ⌘[ / ⌘] |
| Show Right Sidebar / Hide Right Sidebar | Show or hide the selected item's context panel; the web defaults to closed and remembers an open panel per surface | header on web; toolbar on Mac |
| Board | A project's tasks and issues by stage. Drag a card to another column, or use its menu to move it or hand it off. The filter picks who holds the cards shown and which columns you hide; hidden columns follow you to every device | a project's Board tab; on Mac, also Board on the project's TASKS header |
| Search | Mac: Subjects and Docs with this window's scope; web: global search. Type in a searchable picker to narrow its list. File Quick Note searches projects and leads beyond the first page | ⌘F on Mac; ⌘K on web |
| Filters | Narrow the open task or issue list by its available facets | list header |
| State | Show Open, Closed or All GitHub issues; ordering is a separate choice | a project's Issues pane |
| Browse | Its foot row, **Other records**: records with no subject page, read and edited in place. Search them by name, or open a table your account can list. Mac, iPhone and Android open it from the foot of Browse; the web finds these tables and records in Search and opens each on its own page | The foot of Browse |
| Keep vault | Mac and iPhone: opens the project's vault in Keep. Web: says to open it on Mac or iPhone, with the download links; a browser never holds vault keys and the web shows no vault material | project menu |
| File on GitHub | Turns a task into an issue on the linked repository, from the task row | row menu |
| Star / Unstar | Keeps a CRM/CMS subject, task or issue in Home's QUICK ACCESS list; subject stars also lift it to the top of SUBJECTS | row menu; a top-left star badge marks starred rows |
| Hand off to %@ | Gives a card to an agent: use the menu of a card or of any task or issue row, or drop it on the agent in the sidebar (Mac). Starlings posts it in the subject's Talk with the agent's @mention. The card then moves itself: Doing when the agent starts, Blocked when it asks you something, Review when it answers | drag, or the row or card menu |

## Row menus (web)

Every Work row you can act on has a menu. Open it with the `…` on the row, a right-click, or ⇧F10. The `…` shows when the pointer is over the row or the row has focus; on a touch screen it is always there. A top-left star badge marks a starred row; Star / Unstar stays in the row menu. The groups and their order come from one registry across the clients; each client omits actions it cannot perform. The Mac marks destructive actions in red.

| Row | Menu |
| --- | --- |
| A subject, in SUBJECTS and Browse | Star, Mute / Open, Edit details…, Win… (an open lead) / Open tasks, Open issues, New task, New issue / Keep vault (a project), Open full record. A partner: Star, Mute / Open, Open talk, Open history / Open tasks, New task / Open full record |
| A task, in MINE, INBOX and a subject's Tasks | Done, Cancel task / its door / File on GitHub / Open full record / Star. A proposed task: Accept, Decline / its door / Open full record |
| An issue, in MINE and a subject's Issues | Close issue, Close as not planned, or Reopen issue / Open full record / Star |
| INBOX: unread talk | Open the subject / Mark as read, Mute / Open full record |
| Quick Notes | File… / Delete |
| INBOX: a sales touch | Start a lead… / Dismiss, Copy contact email |
| INBOX: a document comment | Open document, Open the subject / Resolve / Open full record |
| INBOX: agent work to check | Open / Open the subject, Open on GitHub (an issue) |
| INBOX: a follow-up | Open / Dismiss |
| INBOX: a booking | Open in Calendar, Copy contact email / Dismiss |
| INBOX: a calendar invitation | Accept, Maybe, Decline / Open in Calendar |
| INBOX: an event from forwarded mail (where your workspace takes mail) | Add to calendar, Discard |
| INBOX: interest | Copy contact email / Dismiss. The row itself opens the lead the request filed |
| INBOX: form submission | Copy contact email / Dismiss. The row itself opens the lead the submission filed |
| A goal | Met, Drop; or Reopen |

The web leaves out what it cannot do yet: Rename… on a subject, Meet about this and Link GitHub repository…. Keep vault on the web is a handoff to Mac and iPhone, never a vault. A decision row has no menu, as on the Mac.

Task and issue lists share one native filter scope: status and search stay visible, facet choices open from **Filters**, and sorting remains separate. Task facets are responsible party, assignee and due date; issue facets are labels, assignee and milestone. On the web, you can read details and activity, and take the same actions with repository pickers. A direct task link opens that task's details; **Edit task** opens its editor.

On Free, a second project is refused with "Free includes one project." An
admin also sees **Upgrade**, which opens the pricing page; anybody else reads
"Ask an admin to upgrade." A project the plan holds read-only says so at the
top, on the Mac, the iPhone and the web, and refuses every write.

## Leads to

A subject's Talk is the conversation on it; a person in it opens [team](team.md). A document opens in [docs](docs.md).

A chip under a line in Talk opens what the line is about, and reads as a link when it does: a task or an issue opens in place; a decision opens History and a goal opens Tasks (both open Overview on iPhone and iPad); a pull request, commit, CI run or release opens on GitHub. A meeting's chip is a label.

## The attention queue and Inbox

The attention queue is the set of pending questions and decisions assigned
to you. Inbox shows those requests alongside other things that need attention,
such as unread conversations and document comments. **MINE** remains the
work you owe; **Activity** remains recent history.

An assigned question is the same request in chat, Home Inbox and Work
INBOX. Answering or dismissing it in one connected view resolves it in the
others. Opening it, reading its conversation or closing the question dialog
leaves it pending. A notification points you to it; clearing a notification is
not an answer. Answering a question supplies information and does not approve
an action. On Mac and iOS, Inbox answers it; their chat controls do not yet
refresh from the same request.

For the full behavior and current coverage, see
[User attention](../../USER_ATTENTION.md). This term describes the comms logic;
the controls retain their existing names.

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

## Offers

With **Offers** on, a lead's or an organization's Overview has an **Offers** group,
and **Catalog** sits at the top of Work's rail on the web and the Mac. On iPhone and
Android an Offers row opens the offer to read, share, duplicate and record. See
[Write an offer](/help/howto/write-an-offer).
