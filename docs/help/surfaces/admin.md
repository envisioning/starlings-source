---
kind: reference
status: active
verified: 2026-11-05
summary: "Admin: the org by destination, opening on People, including measured client-reported RTP data; admins only"
surface: admin
owns: [web/src/AdminPage.tsx, web/src/AdminRecordsPage.tsx, web/src/AdminRecordsCommercial.tsx, services/control-plane/src/commercial-settings.ts, packages/contracts/src/commercial-settings.ts, web/src/AdminActivityPage.tsx, services/control-plane/src/work-activity.ts, packages/contracts/src/work-activity.ts, services/control-plane/src/subject-settings.ts, packages/contracts/src/subject-settings.ts, web/src/AdminNav.tsx, web/src/App.tsx, services/control-plane/src/admin.ts, services/control-plane/src/downstream-usage.ts, web/src/WorkspaceBrandSettings.tsx, web/src/WorkspaceDefaultsSettings.tsx, services/control-plane/src/workspace-defaults.ts, packages/contracts/src/workspace-defaults.ts, services/control-plane/src/workspace-privacy.ts, web/src/WorkspaceBackgroundSettings.tsx, services/control-plane/src/workspace-backgrounds.ts, services/control-plane/src/background-image.ts, packages/contracts/src/workspace-backgrounds.ts, web/src/AdminInvitations.tsx, services/control-plane/src/invitations.ts]
---

# Admin

The org account, for the workspace's admins. Open `/admin` on the web, or the Admin button at the top of Settings. It opens on People.

## Pages

Settings is about you. Admin is about the org. Devices and Connected agents appear on both: Settings shows yours, Admin shows the org's.

| Address | Holds | Changes |
| --- | --- | --- |
| `/admin`, `/admin/people` | **People**: Invite, the human roster, Changes and Workspace | invite, resend, revoke an invitation; visibility, role, access, devices; hide, restore, revoke; sign a device out; workspace name, accent, mark and backgrounds |
| `/admin/operations` | **Operations**: what is happening, the meetings hosted, the usage ledger and its thresholds, the failures the Worker counted about itself in the last seven days (refused signatures, Core's events gone quiet, a route answering 5xx, a deploy check that could not run), LiveKit participant-minutes, measured downstream RTP receive bytes with the latest client-report time, Connector calls: every MCP call, with client, tool, outcome and whether a retry replayed its first result, and, for org admins, model calls and tokens per day | read-only |
| `/admin/agents` | **Agents**: each agent's identity avatar, plus the last 30 days of handoffs, runtime acceptance or refusal, finalized replies observed by Starlings, delivery issues, watchdog reset outcomes, each configured endpoint's origin, and whether it is frozen, when and by whom | freeze, unfreeze |
| `/admin/connectors` | **Connectors**: the environment rows from the deploy at the top, then the available sources: Granola where the workspace has it, GitHub, Slack and the Mac recorder; each card opens its page at `/admin/connectors/<source>` | mappings, Sync now, backfill |
| `/admin/records` | **Records**: lead and contact characteristics and contact sources; below them payment terms, currencies, corporate entities, delivery conditions, offer links and policies once offers answer from Starlings. Until contacts and leads move to Starlings, the first part is read-only | add, rename, delete; a source's label and flags; a commercial setting's fields. A currency is turned off, not deleted |
| `/admin/activity` | **Activity**: each change to a contact, organization, lead, project, task, goal, decision or call stored in Starlings, with who made it, the fields and when. Filter by text, record type, action, person and dates. Only org admins can open it | read-only |
| `/admin/jobs` | **Jobs**: the one-off admin actions, each with what it touches and when it last ran | the jobs themselves |

Only an admin of the workspace can open these pages. A member sees no Admin button, and the pages refuse a member.

## Workspace defaults

In People → Workspace, an admin chooses the time-zone presets, languages
offered and default language, contact and privacy addresses, AI filing persona,
the name of the workspace's own project group, public events feed, and booking
slot grid. The choices are saved in the workspace and audited. Calendar and
Work read them on web, Mac and iPhone; an open web page uses them on its next
load, and the native apps refresh their workspace descriptor. Interface
language changes apply on reload or the next native launch. Personal language
choices win when that language remains offered. The personal Language picker
remains parked under the current localization policy.

A saved personal booking grid wins over the workspace fallback. Existing
workspaces keep their current values until an admin saves. An empty project
group name uses the workspace name, and an empty persona uses that workspace's
identity. An empty events feed turns off the public feed and clears previously
cached events on the clients' next refresh. New D1 workspaces
start without Envisioning's feed. A configured feed is a public HTTPS JSON
endpoint with the existing public-event projection (`events` array); it
receives only `startDate` and `endDate`, without credentials or redirects.
Private host-event reads and booking day closures retain their existing scope.

After defaults are saved, the workspace's `/privacy` page publishes its own
privacy and contact addresses and links to the product data policy. An unsaved
workspace keeps its existing redirect. Outbound workspace mail uses its contact
address for replies unless that message supplies a specific reply address.

The monthly downstream figure is the sum of RTP media bytes received by
browser, Mac and iOS clients. Clients report about once a minute, and Admin
refreshes automatically. It shows observed bytes only: it has no plan cap or
projection, omits data-channel and transport overhead, may miss clients that
have not reported, and can differ from LiveKit's billed total.

## Plan

`/admin/people` shows the workspace's plan: Free, Starter or Pro. A workspace
with no plan set is on Pro. Free holds one project, in any status. Only an
Envisioning root admin changes the plan. When a move to Free leaves more than
one project, every project but one is read-only; an org admin picks the one
that stays writable, once. Until then it is the most recently updated project.
## Invitations

In People, Invite takes one or more addresses and a role, Member or Admin.
Each address gets a mail from the workspace with the sign-in link. An
invitation is open for 14 days. Open and lapsed invitations show under the
form: Resend mails it again and opens it for another 14 days; Revoke closes
it. Only an admin sees this card.

The invited person signs in with Google or a mailed link, as that address.
They join with the invited role and their own room. An address on the
workspace's sign-in domains needs no invitation. Any other address needs
one; without it, or with a revoked or lapsed one, sign-in is refused. An
address that is already a member, revoked or an agent is not invited.

## Workspace backgrounds

In People → Workspace, Backgrounds offers derived tones from the workspace accent or six explicit colours (base and pattern for Dark, Accent and Bright). The nine previews show Pixels, Flock and Grid in each tone. Invisible pattern colours are refused. With no accent or explicit tones, Envisioning keeps Night, Lime and Ice.

Upload or replace one workspace picture (PNG, JPEG or WebP, up to 12 MB). The browser resizes it to 1280 × 720 and removes metadata before sending it. This picture is public branding in the workspace's file storage. Remove deletes it and clears an image default. Personal camera pictures remain on the device.

Default background offers no default, any gallery entry, or the uploaded workspace picture. Members and guests read these choices from the workspace descriptor on web, Mac and iOS. A person's saved choice, including Off, always wins.

## Setup checklist

In People, **Setup checklist** shows or hides the setup steps on everyone's Home. The card's own **Turn off for everyone** clears the same box. See [Set up your workspace](../howto/set-up-your-workspace.md).

## Booking NDA

In People, Booking NDA picks a document from Docs. Every booking page on the workspace then offers **Meet under NDA**. A guest who ticks it gets the document by email to sign, through Docs. Docs keeps the signature and its certificate. Remove clears it. A workspace without Docs does not show it.

## Controls

| Control | Does | Surface |
| --- | --- | --- |
| Tone colours | Derive from workspace accent or Set each colour | web Admin |
| Base colour / Pattern colour | Set the six colours; previews update as you type | web Admin |
| Default background | Choose the initial camera background for someone without a saved choice | web Admin |
| Save backgrounds | Save the palette and default | web Admin |
| Workspace picture | Preview the public picture; Upload…, Replace… or Remove | web Admin |

## Freezing an agent

**Freeze** on `/admin/agents` stops one agent from its next call, with no
deploy. A frozen agent gets no messages, cannot read Starlings and cannot post.
A person who writes to it sees a quiet line in the conversation saying it is
frozen. **Unfreeze** lets it back in. Admin's trail records who did each.

## Leads to

A meeting's transcript; a person in [team](team.md).
