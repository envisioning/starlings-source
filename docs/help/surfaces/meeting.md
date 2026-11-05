---
kind: reference
status: active
verified: 2026-11-05
summary: "Meeting: the stage, the rail and the control row while a call is live"
surface: meeting
capabilities: [media-mic, media-camera, media-devices, media-stage, media-share-publish, media-background, media-self-view, collab-chat, collab-reactions, collab-captions, media-mute-moderate, media-remove, media-leave, owner-host-handoff, centaur-room]
owns: [Sources/RoomWindowController.swift, Sources/StarlingsRoomShellViewController.swift, Sources/WorkspaceBackgrounds.swift, Sources/BackgroundGallery.swift, web/src/workspace-backgrounds.ts, web/src/background-effects.ts, web/src/meet-media-preferences.ts, web/src/use-background-effect.tsx, Sources/MeetingViewController.swift, Sources/MeetingStageView.swift, Sources/MeetingQuality.swift, Sources/MeetingControlAPI.swift, Sources/MeetingSession.swift, Sources/LiveKitMeetingSession.swift, Sources/ContractsExtensions.swift, Sources/MeetingArtifactOutbox.swift, Sources/StageGridLayout.swift, Sources/MeetingStageOverlays.swift, Sources/MeetingChatPanelView.swift, Sources/SelfViewPlacement.swift, Sources/MainMenu.swift, iOS/MobileCallView.swift, iOS/MobileHostView.swift, iOS/MobileRoomHost.swift, iOS/MobileGuestSession.swift, iOS/MobileTranscriptPanel.swift, web/src/MeetingExperience.tsx#ConnectedMeeting, web/src/MeetingExperience.tsx#ScreenShareStage, web/src/MeetParticipantTile.tsx#MeetParticipantTile, web/src/MeetingSettings.tsx, web/src/stage-layout.ts, web/src/storage.ts, web/src/styles.css, web/src/meeting-reactions.tsx, web/src/meeting-chat.tsx, web/src/meeting-hands.tsx]
---

# Meeting

The live meeting. On the Mac it is the Room window, a tab beside Home when Use tabs is on. Home stays open during the meeting. On the phone it is a full-screen stage. In the browser it is the page after the waiting room.

## The stage

All tiles are the same size. A screen share becomes the main view. During a share, choose Automatic, Over the share, or Beside or below. Automatic floats a short camera row when it fits and gives a larger group a fixed-size, scrollable rail beside or under the share. That device remembers the choice. There is no pin. In every client, camera thumbnails in the screen-share rail omit their visible name and connection-strength badge; both remain available to assistive technology. Other state badges stay visible. On the Mac, your own camera is a small self-view in one of six positions, in one of three sizes. Participant count and elapsed time sit in a pill at the top-left. Other tiles show connection strength as a bar count; the exact quality remains available to assistive technology.

## Controls

Mute and camera turn red when off.

| Control | Does | Mac shortcut |
| --- | --- | --- |
| Mute | Microphone on or off; the chevron picks the device | ⌘⇧A |
| Camera | Camera on or off; the chevron picks the device | ⌘⇧V |
| Background | Blur, your own image, a Workspace picture if configured, or Pixels, Flock and Grid in workspace tones (Night, Lime and Ice at Envisioning); your saved choice wins over the workspace default; segmentation runs on the device | menu |
| You | Hide me, Float me, Put me in the corner, Size | menu |
| Share screen | A display or a window; the browser also offers a tab. Not on iOS | ⌘⇧S |
| Screen share layout | Automatic, Over the share, or Beside or below; in the row on Mac/web and More on iPhone | — |
| Chat | The in-meeting text panel, with reactions on messages | ⌘⇧H |
| Take host | A Mac companion asks the current Mac host to hand over. When the host leaves or drops, a companion Mac takes host on its own | Meeting menu |
| Move host… | The host picks another Mac, iPhone or iPad in the call: another of yours takes it at once; a colleague's is asked first. The new host admits guests and takes the notes. The room owner can take it back | Meeting menu on Mac; More on iPhone |
| Host badge | *Host* beside a name marks the device that admits guests and takes the notes | Tiles and roster |
| Leave / End meeting | Companions leave; a Mac host can leave without ending the meeting when another Mac is present; End meeting still closes everyone out | Meeting menu / ⌘⇧W |
| Choose who sent this notetaker | Attribute an unbooked notetaker to a teammate before admitting it | — |

## The rail (Mac) and More (iPhone)

On iPhone, Screen share layout is in More.

| Item | Does | Mac shortcut |
| --- | --- | --- |
| People | Who is in the meeting, with mic, camera and share state; recording notetakers are marked, with their sender when known. Host actions: mute, stop share, remove | — |
| Waiting room | The queue; declared recording notetakers identify themselves and wait for admission. Attribute an unbooked notetaker before admitting it. A knock is also answered on the stage banner. The room-wide notetaker policy lives in Settings → Room | ⌘⇧↩ / ⌘⇧⌫ |
| Live Transcript | Captions from the hosting device; caption text only | menu |
| Share transcript | For the room owner, beside the Live transcript heading. The link to the meeting's page, the system share with that link, and the record itself: Copy transcript and Download Markdown or Text on the Mac, the share sheet and Copy transcript on iPhone. It copies the record, with struck lines gone and renamed speakers, not the captions | — |
| Raise hand / Lower All Hands | — | menu |
| Mute Everyone Else | Closes microphones; opens none | menu |
| Copy Invite Link | `/room/<slug>` | ⌘⇧C |
| Hide Meeting Panel | The stage takes the window; End moves to the control row | ⌥⌘S |
| Focus | Rail closed and transcript collapsed in one press | ⌥⌘F |
| Enter Full Screen | macOS hides the chrome | ⌃⌘F |

Reactions float on the stage. Starlings does not store them.

## What leaves the device

Only caption text leaves, through the outbox. Starlings never stores audio or video. An admitted third-party notetaker may record through its own service. When the meeting ends, Starlings finalizes the transcript and the notes and files them on the subject. Participants with artifact access can read them.

## Leads to

[ended](ended.md) when the room closes or you leave.
