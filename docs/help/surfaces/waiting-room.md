---
kind: reference
status: active
verified: 2026-10-20
summary: "Waiting room: the knock is sent; the owner decides"
surface: waiting-room
capabilities: [entry-waiting, entry-lease]
owns: [web/src/App.tsx#WaitingRoom, web/src/guest-lobby-session.ts, iOS/JoinView.swift]
---

# Waiting room

**Knock sent.** The guest waits. The owner admits or declines. In the protocol, this state is the lobby.

| State | The guest sees |
| --- | --- |
| Waiting | Please wait; the owner's name |
| Admitted | Straight into [meeting](meeting.md) |
| Not admitted | Ask to join again |
| Owner away | The knock is refused outright; the page says so |
| Cancel | Withdraws the knock and returns to [prejoin](prejoin.md) |

This page has no Back. To leave, press Cancel. If the guest reconnects, they keep their place in the queue.

## Leads to

[meeting](meeting.md), or back to [prejoin](prejoin.md).
