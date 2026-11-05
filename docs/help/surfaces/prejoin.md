---
kind: reference
status: active
verified: 2026-10-20
summary: "Prejoin: before you join, the camera and microphone check, then Ask to join"
surface: prejoin
capabilities: [entry-prejoin]
owns: [web/src/MeetingExperience.tsx#Prejoin, web/src/PrejoinDevices.tsx, iOS/JoinView.swift]
---

# Prejoin

The camera and microphone check before you knock. Every client labels it **Before you join**.

| Control | Does |
| --- | --- |
| Camera, Microphone | On or off; pick the device |
| Preview | Your own picture. The camera does not capture while nobody is looking at the page |
| Ask to join | Sends the knock. The owner sees the request. Starlings issues no media token until the owner admits you |
| Back | To [room-entry](room-entry.md) |

The owner's Launch shows the guest as **Checking camera** while they are here.

## Leads to

[waiting-room](waiting-room.md).

The workspace can provide gallery tones, a public picture and an initial background. A saved personal background, including Off, takes precedence. Personal pictures stay on the device.
