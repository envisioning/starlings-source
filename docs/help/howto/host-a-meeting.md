---
kind: howto
status: active
verified: 2026-11-03
summary: "Open your room, admit who knocks, end it; from the Mac, the phone, or the CLI"
capabilities: [owner-admit, owner-cli, collab-captions, owner-meet-about]
owns: [Sources/OwnerLaunchView.swift, iOS/MobileHostView.swift, CLI/StarlingsCLI.swift]
---

# Host a meeting

You need a member sign-in. Every member gets a room the first time they sign in. You cannot host from the browser.

1. Open Home. On the Mac that is ⌘1; on the phone, the Home tab.
2. Press **Start room** (⌘↩ on the Mac). The room opens and you are on the stage. On the Mac the room has its own window, a tab beside Home when Use tabs is on. Home stays open. If you close the room's window, the meeting continues, and **Open meeting** on Home brings it back.
3. Press **Copy room link** (⌘⇧C) and share the link. The link is `/room/<slug>` and does not change.
4. When a guest knocks, the stage banner shows their name. Press **Admit** (⌘⇧↩) or **Decline** (⌘⇧⌫). If more than one guest waits, use the WAITING ROOM block on the rail. From Launch, **Start & Admit** opens the room and admits in one step. Declared recording notetakers also wait for admission. Before you admit an unbooked notetaker, attribute it to a teammate. Set the standing notetaker policy in **Settings → Room**.
5. While you host, your device runs the captions. Only the transcript text leaves your device.
6. Press **End meeting** to end it for everyone. Starlings finalizes the transcript and notes and files them on the subject.

If you use two devices, the first device to host is the host and transcribes. The second device joins muted, as a companion.

From the CLI on the Mac: `starlings host <room>` after `starlings status --no-launch` and `starlings devices`. See docs/OPERATIONS.md.

To file the meeting record on a subject, start the meeting from Work with **Meet about this**.
