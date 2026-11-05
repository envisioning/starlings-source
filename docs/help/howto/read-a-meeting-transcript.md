---
kind: howto
status: active
verified: 2026-11-05
summary: "Find the transcript and notes of a meeting that ended"
capabilities: [collab-artifacts, ai-summary, crm-ingest]
owns: [web/src/TranscriptPage.tsx, web/src/transcript-parts.tsx, Sources/WorkInteractionsView.swift, services/control-plane/src/mcp.ts, packages/contracts/src/transcript-export.ts, Sources/TranscriptExport.swift, Sources/TranscriptShareMenu.swift]
---

# Read a meeting transcript

Starlings does not email the transcript. After Starlings finalizes the meeting, participants with artifact access read the transcript and notes in Starlings.

- From the subject: Work → the subject → **History**. The meeting is an interaction; open it.
- From Home: the meeting on UPCOMING once it has ended, or QUICK ACCESS.
- From an agent: the `transcript` tool, or the `starlings://meeting/{room}/{meeting_id}` resource.

For the `transcript` tool, get `room` and `meeting_id` from a meeting row returned by `search`, `now` or `open`, or from a `meeting` item in `starlings://changes/{cursor}?kinds=meeting`.

The record has the notes and the transcript text. When the workspace operator
has installed and verified Steward, it processes finalized meetings that lasted
at least five minutes and proposes the notes, tasks and decisions here. An
unavailable or paused assistant keeps essential artifacts available with
clearly system-authored fallback notes. On the web, **Decisions** under the notes lists what the notes proposed as settled, each with its line. **Record** writes the decision on the meeting's project or lead, with the meeting as its source. **Dismiss** removes it from the list. An unfiled meeting offers Dismiss only. Each participant consented to captions separately. Starlings filters the record by that consent.

A meeting captured on the Mac without hosting (docs/AMBIENT_CAPTURE.md) files the same way.

## Share it, copy it, download it

The meeting's page is `/meetings/<room>/<meeting id>`. Its top shows the title, the date, who attended and the subject the meeting is filed on.

| Control | Does |
| --- | --- |
| Copy link | Puts the page's address on the clipboard. The address always uses `https://envisioning.starlings.example` |
| Share… | Opens the browser's share sheet with the link, where the browser has one |
| Copy transcript | Puts the whole transcript on the clipboard as plain text |
| Download .md | The transcript as Markdown: a header with the title, date, attendees, subject and link, then `**Speaker** (hh:mm:ss): text` for each line |
| Download .txt | The same header and lines as plain text, `[hh:mm:ss] Speaker: text` |

The link has no token and grants nothing. A person who opens it signs in, and then reads the meeting only if they could read it already. Everyone else sees the not-allowed notice. Starlings has no public or anonymous transcript links.

A copy or a download is the record as it stands. Lines you struck are not in it. A renamed speaker appears under the new name. Every client writes the same file.

While a meeting runs, the room owner gets the same choices from the live transcript: on the Mac, the share button beside the Live transcript heading; on iPhone, the share button in the transcript sheet. They copy the record, not the captions on screen.

## Delete the meeting

The room owner sees **Delete meeting** at the bottom of the meeting's page on the web. It deletes the meeting for everyone who was in it: the notes, the transcript, its Docs document and its place in the subject's History. Tasks and decisions from the meeting stay. Backups keep it for 30 days. It cannot be undone.

The page then shows the receipt: each copy, and whether it was deleted. If a copy failed, **Retry** finishes it. In a shared team room, ask an admin. The Mac and iPhone apps do not have this yet.

