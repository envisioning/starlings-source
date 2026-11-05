---
kind: reference
status: active
verified: 2026-10-20
summary: "Room entry: a guest at `/room/<slug>`, with a name, an email and two doors"
surface: room-entry
capabilities: [entry-room, entry-identity, invite-token-context]
owns: [web/src/App.tsx#RoomEntry, web/src/guest-presence.ts, iOS/JoinView.swift]
---

# Room entry

The first page a guest sees. `/room/<slug>` is the bare room; `/room/<slug>/<token>` adds the booking's title, time and subject to the card.

## What is on it

| Element | Note |
| --- | --- |
| Owner and room | Who this room belongs to |
| Booking card | Only with a valid token |
| Name, Email | Email is required. No account |
| Continue | To [prejoin](prejoin.md) |
| Book a time | On a bare room, to [schedule](schedule.md) |

A signed-in member who opens somebody else's link enters that room as a visitor. The link opens the room, not the member's own Home. An owner on their own room gets a link back to Your room.

On Mac and iPhone, a link from another workspace does not open here. The app names that workspace and offers to open the link there.

While the guest is here, the owner's Launch already shows them as **On the page**.

## Leads to

[prejoin](prejoin.md) or [schedule](schedule.md).
