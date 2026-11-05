---
kind: howto
status: active
verified: 2026-10-20
summary: "Wave for attention, or Call into their room"
capabilities: [owner-team-presence, owner-call, owner-answer-call]
owns: [Sources/PeerPresence.swift, web/src/team-presence.ts]
---

# Call a colleague

There are two ways to get a colleague's attention: **Wave** and **Call**.

**Wave**: press **Wave** on their row in Team. When their status is Active, the row has no inline Wave button; choose **Wave** from the row menu or person profile. A client they have running plays one chime. The wave expires after 45 seconds. They do not have to answer.

**Call**: choose **Call** from their row menu in Team, or from their name in the menu bar.

- If they are in a meeting, you knock on the room they are in and go in. That is their own room, or a colleague's when they are a guest there. **Join room** in their row menu does the same.
- If they are available but not in a meeting, they see **Open room / Not now**. If they open the room, you go in. If they do not answer within a minute, they are away.
- If Call cannot reach them, you see why: for example, they are offline or they do not have a room yet.
- If you are in a meeting already, Call does not knock. Leave that meeting first.

Starlings does not transcribe a room that a call opened. If the call becomes a meeting, turn captions on during the call.

You cannot wave or call an agent. Send it a message.
