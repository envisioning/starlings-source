---
kind: reference
status: active
verified: 2026-11-04
summary: "Settings: account, room policy, calendar, audio, video, captions, Home layout, Inbox sources; ⌘,; `/settings`"
surface: settings
capabilities: [owner-settings, owner-profile-picture]
owns: [Sources/SettingsViewController.swift, Sources/SettingsRegistry.swift, iOS/MobileSettingsView.swift, web/src/SettingsPage.tsx, web/src/PeerAvatar.tsx, web/src/peer-face.tsx]
---

# Settings

App preferences. Settings is not a surface: it has no switcher entry and no tab. Open it with ⌘, on the Mac, or with the gear on Home on the phone and in the web header.

Settings lists its pages beside the open page. On the Mac that list is a sidebar, and on the iPad a split view. On the web the list has three groups, Account, Preferences and System, and becomes a row of buttons in a narrow window. On the web an admin also sees an Admin button beside the title; a member does not.

## Pages

| Page | Holds | Clients |
| --- | --- | --- |
| Account | Who you are, your picture, sign out of this workspace or of all of them (it stops a Mac recording and deletes the recordings not yet transcribed); the Other records connection with its action beside the status; Keep's unlock methods (Docs and Keep come with your sign-in and have no connection row); Connected agents (the MCP pairings, with Pause and Revoke, and the Connector name and Connector address to add to Claude, each with Copy, and How to connect Claude); Devices signed in | all |
| Calendar | Connect Google Calendar (a Google workspace only); calendar-only accounts; which calendars draw, whether hidden events show faded, and which subscriptions feed Home's UPCOMING; Booking hours: the days and hours guests book you in, your time zone, meeting length, slot step, gap, notice and horizon, and Take bookings | native selects, web connects; Booking hours on all |
| Gmail and Drive | Connect Gmail, connect Google Drive, Disconnect Gmail and Drive: one read-only Google grant for the imports. Hidden until the deployment has the connector's Google client. | web |
| Upcoming | The display policy for Home's UPCOMING: following meetings, density | all |
| Home | The modules available in this workspace, their order, on or off | all |
| Work | Sales on or off; which sources appear in Inbox | all |
| Room | Refuse declared recording notetakers at the door to your permanent room | Mac, iPhone/iPad |
| Video | Camera, background | native; web in the in-meeting Settings |
| Audio | Microphone, speaker, modes | native; web in the in-meeting Settings |
| Captions | Live captions on the hosting device, language | native |
| Notifications | Knock sound, Dock alerts, host wake protection | Mac |
| Appearance | Light, dark, system; grid texture; Use tabs on this Mac | all; tabs on Mac |
| About | Version, update, Privacy and Terms | native; the web keeps Privacy and Terms in the footer |
| Workspaces | The last section of Settings, signed in or not: every workspace on this iPhone, switch, Add workspace. On the Mac: the Starlings menu › Switch Workspace | iPhone; Mac in the app menu |

Settings → Home lists only the modules whose work modules are on in the
workspace. Moving a row skips hidden modules and preserves their saved
positions and visibility. Turning a work module back on restores its row.
Quick access stays last on every client.

The Worker stores Home, Upcoming and Work once, and every client uses them. Each device keeps its own video, audio and grid preferences.

On the Mac, Appearance → Use tabs is on by default. Turn it off to separate
Home, Calendar, Work, Team and Docs into windows immediately; turn it on to
group the open views into tabs. This preference stays on this Mac.

In Work, the Sales switch controls the lead pipeline and sales touches. Under
Inbox, choose which sources appear; sales touches follow the Sales switch.
The room's recording-notetaker policy is a standing room setting. A notetaker
that declares it records still waits for owner admission when refusal is off.

## Controls

| Control | Does | Shortcut |
| --- | --- | --- |
| Use tabs | Groups the Mac destination windows into tabs; turn off for separate windows | — |
| Refuse recording notetakers | Rejects declared recording notetakers at the door for your permanent room; when off, they still wait for your admission | — |

## Leads to

Nowhere. Close it.
