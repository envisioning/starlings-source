---
kind: reference
status: active
verified: 2026-11-05
summary: "Team: who in the workspace is around, and reaching them; ⌘4; `/team`"
surface: team
capabilities: [owner-question-inbox, owner-team-presence, owner-direct-messages, owner-group-dms, owner-profile-picture, owner-call, owner-answer-call, owner-agent-interactive-questions, owner-work]
owns: [Sources/TeamWindowController.swift, Sources/MainWindowController.swift, Sources/ThreadPaneView.swift, Sources/ThreadTranscriptViews.swift, Sources/ThreadComposerView.swift, Sources/MeetingControlAPI.swift, Sources/MeetingTaskEditor.swift, Sources/WorkInspectorViewController.swift, Sources/WorkPersonPanelView.swift, Sources/WorkListRowView.swift, Sources/PeerPresence.swift, Sources/StarlingsPersonAvatarView.swift, Sources/WorkLoungeView.swift, Sources/WorkSidebarRowView.swift, Sources/WorkRowActions.swift, iOS/MobileTeamView.swift, iOS/MobileTeamStore.swift, iOS/MobilePeerInfoView.swift, iOS/MobileThreadView.swift, iOS/MobileThreadStore.swift, iOS/StarlingsAPI.swift, iOS/PeerRosterViews.swift#PeerAvatar, iOS/WorkSidebarRow.swift, packages/contracts/src/index.ts, packages/contracts/src/wire.ts, packages/contracts/src/work-actions.ts, web/src/TeamPage.tsx, web/src/ConversationTeam.tsx#peerMenuItems, web/src/PeerAvatar.tsx#PeerAvatar, web/src/ThreadPane.tsx, web/src/team-presence.ts, web/src/row-menu-items.tsx, web/src/FavoriteToggle.tsx, web/src/SurfaceShell.tsx, web/src/SiteChrome.tsx]
---

# Team

The people and the agents, who is around, and the four ways to reach a person.

## Where

| Client | Reach it |
| --- | --- |
| Mac | ⌘4 |
| iPhone and iPad | The Team tab |
| Web | `/team` |

On Mac, the Team tab includes the open person or conversation in its title, such as `Team — Alex`.

## Shape

When signed out on web, the page shows a centered card with the Team heading and one sign-in action.

The rail: the **Lounge** row (the way back to who is around), **YOU** (your own row and status), **Groups** (Everyone pinned, then the private groups, newest message first), **PEOPLE**, **AGENTS**; whoever you have a conversation with first, latest message first. An unread conversation shows a dot and bold text. A video mark on a person's avatar means they are in a meeting. The column shows the lounge or the open conversation. The inspector shows the person. Their open tasks and, when they have connected GitHub, assigned open issues appear as separate clickable cards; issue cards include their GitHub labels. On Mac, selecting a task opens its editor in the inspector, with a way back to the person. On iPhone and iPad, task and issue cards open their existing detail screens. On the web, tasks open in Work and GitHub issues open in GitHub. **New task** opens a searchable project or lead picker and then the usual task editor; a new team task defaults to the person creating it. On a web phone, the person's details open as a sheet over the conversation; after you close it, press the person's name in the conversation head to reopen it.

## Their schedule

The person's panel shows today's busy and free blocks from their Google Calendar, never titles or guests. When Google will not show their day, the panel says why instead of showing an error: **Their calendar isn’t shared with you** when their calendar is not shared with your account (a colleague on another Google Workspace domain often is not), **Connect Google Calendar in Settings** when you have not connected yours, and **Google Calendar access expired** when you need to reconnect. A real failure shows **Couldn’t load their calendar** with Copy (web and iPhone and iPad), and the copied text carries the cause, the Worker's code and its request id.

## Reaching a person

| Gesture | Asks for | Effect on them |
| --- | --- | --- |
| Message | Nothing now; it waits in a thread | Nothing |
| Wave | Their attention | One chime. The wave expires after 45 s. Best-effort: only a running client plays it |
| Call | Into their room | A knock if a meeting is running; an ask (Open room / Not now) if they are only available. A room opened this way does not transcribe |
| Join room | Into their room while a meeting is running | Opens the room's ordinary lobby and admission flow |
| Hand off | An agent to take a card | The agent starts a run. You hand off from Work, not here |

You can message an agent. You cannot wave or call it.

Wave and Call are actions in the person row menu. The row has no inline Wave or
Call buttons. When the roster says a person is in a meeting, the menu offers
**Join room**; otherwise a callable person has **Call**.

While an agent is working, its latest step appears beneath the timer as a
one-line preview with Markdown marks hidden. The completed reply is a normal
message and keeps its Markdown formatting.

## Formatted messages

On iPhone and iPad the message field grows line by line up to a cap, then scrolls inside itself.

Open **Format message** beside the composer to format a draft. Select text for
inline styles; with no selection, inline styles and links insert starter text
you can edit. Lists and quotes apply to the current line or selected lines.
The menu offers **Bold**, **Italic**,
**Strikethrough**, **Inline code**, **Link**, **Bulleted list**,
**Numbered list**, **Quote**, and **Code block**. Sent messages keep this
formatting when they appear in the conversation on Mac, iPhone and iPad, and
web. A Link starts with an example address you can replace before sending.

## Controls

| Control | Does |
| --- | --- |
| Message | Opens or continues the thread with that person, group or agent |
| Format message | Opens Markdown formatting for the selected text or current line |
| Star / Unstar | Keeps a person, agent or conversation in Home's QUICK ACCESS list; a top-left star badge marks starred rows, and the row menu changes it |
| Wave | Sends the nudge; Starlings confirms it with a toast |
| Call | Knocks on their room, or asks them to open it |
| Join room | Opens a person's live room through the ordinary lobby and admission flow |
| New task | Choose a project or lead, then create a task in the usual editor; new team tasks default to you |
| New group… | A private conversation with up to twelve people; the people are the name |
| More actions | Opens the row or message menu; available actions depend on the item |
| Status | Available, Focused; Unavailable always with an end |
| Add a picture / Change picture | Your picture, shown everywhere you appear. Without one, Starlings shows your initials |
| Everyone | The org-wide conversation |
| Submit answer | Questions show who asked and offer full-width choice buttons. Sends the selected options for a multiple-select question. A single choice is sent when selected. Questions gather information; they do not approve an action |
| Show Right Sidebar / Hide Right Sidebar | Show or hide the selected person's or conversation's context panel; the web defaults to closed and remembers an open panel per surface | header on web; toolbar on Mac |

## Row menus (web)

Every person, agent and conversation row has a menu, including the People and Agents cards in the web Lounge, and so does every message. Open it with the `…` on the row, a right-click, or ⇧F10. The `…` shows when the pointer is over the row or the row has focus; on a touch screen it is always there. A top-left star badge marks a favorite; Star / Unstar stays in the row menu.

| Row | Menu |
| --- | --- |
| A person | Message, Wave, Call or Join room / Copy email / Star |
| An agent | Message / Copy email / Star |
| You | Notes to self / your status / Star |
| A conversation | Star |
| A message | Reactions / Copy, Reply, Decide / Save as Quick Note, Edit, Withdraw when yours |

Wave and Call show only when the person can take them; Join room appears while their meeting is live. You can react to any message, including your own. On your own text messages, **Save as Quick Note** makes a private copy in Work's Quick Notes; the message stays in the conversation, and you can triage the copy there with the usual **File…** action. Edit and Withdraw are also for your own messages. A message a member's connected Claude sent shows **via** and the client's name beside the time. The same person menu is on the TEAM and AGENTS rows beside a conversation. In Work's person panel, use the person row menu for Wave, Call or Join room.

Team Room, `/room/team`, is not this surface. Team's card opens it with you as host. Members enter directly. There is no waiting room.

## Leads to

A person's room through Call or Join room, into [meeting](meeting.md). A subject a person mentions opens in [work](work.md).

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

## Managed meeting assistant

When the workspace operator installs Steward, its Team inspector on Mac, iPhone,
iPad and web explains its purpose and current setup state. It can be setting up,
checking the runtime, waiting for the workspace admin to sign in, or needing a
retry. A verified, ready installation processes eligible finalized meetings and
proposes tasks. Removal, freezing and pause take precedence over readiness.
Steward does not count as connecting your personal assistant. Read its notes
and proposals in the existing meeting record; tasks and decisions still need
human review. Contextual conversations about those notes remain a later step.
