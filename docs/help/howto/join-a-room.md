---
kind: howto
status: active
verified: 2026-10-20
summary: "Enter a room as a guest: the link, your name and email, the check, the knock"
capabilities: [entry-room, entry-identity, entry-prejoin, entry-waiting]
owns: [web/src/App.tsx#RoomEntry, web/src/MeetingExperience.tsx#Prejoin, iOS/JoinView.swift, CLI/StarlingsCLI.swift]
---

# Join a room

No account needed.

1. Open the link: `/room/<slug>`, or `/room/<slug>/<token>` from a booking. On the Mac and the phone, press **Join** on Home and enter the slug.
2. Enter your name and email. Press **Continue**.
3. Check your camera and microphone. Press **Ask to join**.
4. Wait for the owner to admit you. If the owner is away, the page says so. Do not wait.
5. Press **Leave** when you are done.

A signed-in member who joins a colleague's room follows the same steps, but does not wait in the queue.

From the CLI on the Mac: `starlings join <room> --name <name> [--email <email>]`.
