---
kind: howto
status: active
verified: 2026-11-04
summary: "Forward an email into a project's channel, or to calendar@ to add the events it describes, from any mail app"
capabilities: [owner-calendar-from-email]
owns: [services/control-plane/src/inbound-email.ts, services/control-plane/src/calendar-extract.ts]
---

# Forward an email

Forward from the address you sign in with. Mail from anyone else is dropped
without a reply.

## Into a channel

On Envisioning, each project, lead and partner channel has an address, for
example `envisioning.acme-rollout@starlings.example`. Other workspaces do not
have channel addresses yet. To find it:

| Where | How |
| --- | --- |
| Web | Open the channel and press the envelope button in its header. The address is copied |
| Mac | Open the channel in Talk. The address is under EMAIL in the Work inspector, and in Talk's context menu |
| iPhone and iPad | Open the conversation menu and tap the address to copy it |

Forward the mail to that address. It lands in the channel as a message from
you, with the original sender, subject and date on top. Quoted replies are
left out. The whole mail is attached to the message, so you can open the original.

## To your calendar

Forward a booking confirmation, a ticket or an invitation to `calendar@` at
your workspace's own address, for example `calendar@envisioning.starlings.example`. Within a minute your Inbox shows each
event it describes under **Events from email**:

- **Add to calendar** puts it on your primary Google calendar. The people
  the mail names go in the description, not on the guest list.
- **Discard** removes the row.

Starlings answers each forward by email: how many events wait in your
Inbox, or that the mail held none. Your Mac, iPhone and open web tab also
show one notification, for example "2 events from your email". Click it to
open Inbox.

Anything you write above the forwarded mail is read as an instruction, for
example "only the outbound flight". The mail itself is read once and not
kept. A row you leave waits a week.

## If nothing arrives

- Forward from the address you sign in with to this workspace.
- Mail over 5 MB is dropped.
- A mail that describes no event adds no row. The answer says so.
- No answer at all means the mail never reached Starlings, or came from an
  address that is not a member.
