---
kind: reference
status: active
verified: 2026-10-20
summary: "Ended: the meeting is over, how long it lasted, why it ended"
surface: ended
capabilities: [collab-duration, media-remove-notice, collab-artifacts]
owns: [web/src/App.tsx#MeetingEnded, iOS/JoinView.swift]
---

# Ended

The page after a call. It says whether the owner ended the room, the session was lost, or you were removed. It also says how long the call lasted.

| Control | Does |
| --- | --- |
| Ask to join again | Back to [prejoin](prejoin.md), to knock again |
| Enter another room | Back to Home |
| Transcript and notes | For participants with artifact access, once finalized |

## Leads to

Home, or [prejoin](prejoin.md).
