---
kind: contract
status: active
verified: 2026-10-11
summary: "ADR 0001: the internal room; accepted, built 2026-09-10"
owns: [services/control-plane/src/internal-rooms.ts]
---

# 0001 — The internal room

**Status:** accepted · built 2026-09-10 · **Date:** 2026-09-10

One permanent room whose audience is Envisioning, not the public. It exists so
the weekly Status call — the all-hands — has a door that is not a person's.

Amends [ROOM_ENTRY.md](../ROOM_ENTRY.md) decision 1. Vocabulary consequences for
[SURFACES.md](../SURFACES.md). Privacy questions in
[PRIVACY.md](../PRIVACY.md) remain open below.

---

## Context

Every room in Starlings is a person's. `OWNER_ROOM_MAP` is `email → slug` and *is*
the whole room list; a slug that is not in it 404s. The Durable Object stamps a
single `owner_email` on the room row, and `adoptOwner` re-points a slug at a new
Google subject only when the email matches — two people cannot own one slug
(`services/control-plane/src/room-coordinator.ts`).

So the org's recurring internal meeting has nowhere to happen except
`/room/<someone>`. Hosting it from a personal room is not the problem — the
host is happy to host. The problem is the **door**: `/room/mz` is a public
address with a waiting room behind it, and a knock can arrive in the middle of
an all-hands from anyone who knows the slug.

What is wanted is not a shared host. It is an **audience** on a room — the same
axis `threads` already carries as `audience: 'members' | 'everyone'`
([CHANNELS.md](../CHANNELS.md)).

## Decisions (locked)

| # | Decision |
| --- | --- |
| 1 | **Internal is a property of a slug, not of a session.** A room is internal or it is not, permanently, by configuration. A flag on a live meeting would make one public door behave differently by the hour, and a guest turned away mid-Status would learn something from *how* they were refused. A separate address cannot leak, because it is a separate address. |
| 2 | **Exactly one internal room, seeded.** Not one per series, and never user-created. This is the same constraint `CHANNELS.md` places on channels, for the same reason: sprawl is the failure mode, and `team` is already the single thread that hangs off nothing. |
| 3 | **The slug is `team`.** The address is `/room/team`. See the vocabulary rule below, which is load-bearing. |
| 4 | **Membership is the admission.** An internal room has no waiting room, because it has no one to admit. A verified Envisioning member walks in; everybody else gets the 404 an unmapped slug already gets. |
| 5 | **The host is an ordinary owner.** No shared host, no service account, no co-host. `/room/team` has one `owner_email` like every other room, and the host stays what `IOS_HOST.md` says it is: a device attribute of that owner. |

### Why this is mostly deletion

The knock path already reads `getOwnerSession` and lets a verified member skip
the queue, because that is what makes Call a call rather than a request
(`services/control-plane/src/index.ts`, `POST join-requests`). An internal room
is that behaviour with the other branch removed. The feature is a subtraction
from the guest path, not an addition to the host path — which is the reason to
build it rather than work around it.

## Vocabulary — the rule that keeps `team` usable

`SURFACES.md` already defines **Team** as the people surface, and `threads`
already uses `kind = 'team'` for the Everyone conversation. The room now makes
three. `SURFACES.md` is a contract; three meanings for one word is exactly how
it drifts. So:

| Written as | Means |
| --- | --- |
| **Team** | The people surface. Unchanged, and it is still not a room. |
| **Everyone** | The org-wide conversation (`threads.kind = 'team'` on the wire). Unchanged. |
| **`/room/team`** | The internal room. **Always written as the address, never as prose.** |

Never write "the team room". The room is `/room/team`, in docs, in UI strings,
and in commit messages. A sentence that needs to call it something calls it
**the internal room**.

## What "internal" closes

Each seam below is a place a guest exists today. An internal room closes all of
them or it closes none — a half-closed door is worse than an open one, because
it looks shut.

| Seam | Today | Internal room |
| --- | --- | --- |
| `GET /api/rooms/:slug` | Unauthenticated; returns `{slug, kind, owner_name}` for any permanent slug | 404 to a non-member. Not 403 — a refusal that distinguishes "no such room" from "not for you" is itself a disclosure |
| `POST join-requests` (the knock) | Anyone may knock; members skip the queue | Members are already in. Non-members 404. There is no lobby, so nothing can interrupt a meeting |
| `guest-presence` (on the page) | 15s heartbeat writes a pre-knock presence row | Not written. Nobody can reach the page |
| `abandon` sweep | Counts visitors who left before knocking | Not emitted — see open question 1 |
| `/book/<slug>` and `/room/<slug>/<token>` | Booking mints tokens against any permanent slug | Public rooms only. `schedule-proxy.ts` gates on `permanentRoomSlugs` in three places; those become a narrower set |
| Waiting room / admit queue UI | Mac lobby poll, `MobileLobbyWatch`, `guest-presence/:id/remove` | Never populated. Whether the controls are hidden or merely empty is an implementation choice, not a contract |

`permanentRoomSlugs` must remain the **union** of public and internal slugs — it
gates the 404 in six call sites, and narrowing it would 404 the internal room
for its own members.

## What this does not change

- **No new room kind in the media path.** LiveKit, the host, transcription, the
  outbox and artifact finalization are untouched. The room is ordinary once
  people are inside it.
- **`ROOM_ENTRY.md` decisions 2–8 stand.** Doors, not rooms; the token is a
  capability; the bare slug never reveals what is live. Decision 1 gains one
  clause: the room list is still exactly `OWNER_ROOM_MAP`, but it is no longer
  the case that every room in it is publicly reachable.
- **Starlings still never records.** [PRIVACY.md](../PRIVACY.md)'s position is
  unmoved and this ADR does not weaken it.

## The Status meeting is not this room

Worth stating because it is the thing the room is *for*, and it would be easy to
build the room and think the job is done. The weekly Status already has a home
that is not a room: `meeting_kind: status` in
[MEETING_LOG.md](../MEETING_LOG.md) carries series defaults, note templates and
digest routing, and stays off the Slack bridge; the Everyone channel carries the
trail. `/room/team` is the door for the hour. Continuity lives in the kind and
the channel.

## Answered, 2026-09-10

The six questions this ADR opened, closed by the person who asked for the room.

| # | Question | Answer |
| --- | --- | --- |
| 1 | Is the internal room in the usage funnel? | **No.** Anyone on the team just joins — there is no visitor, no knock and no abandon, so there is nothing for the funnel to measure. Enforced rather than filtered: the room writes no `guest_presence` rows at all, and the abandon sweep counts that table. |
| 2 | Consent for the meeting summary | **Not a room decision.** Starlings no longer collects transcript-email consent; finalized notes stay in the in-app artifact for participants with access. |
| 3 | Where the artifact goes | **Into the system, not anybody's inbox.** The summary belongs where the work already is; it is not emailed to the room. |
| 5 | What a mis-invited external attendee sees | **Moot — nobody outside the company is invited.** The 404 needs no softening copy, because no external address ever receives the link. |
| 6 | Does it show as live to a member who is not in it? | **Yes.** The no-leak rule was only ever about guests. **Not built here** — see below. |

Answers 2 and 3 together are why Room entry has nothing to ask a member: no
consent question. `you` on the room lookup carries the identity the session
already proved, and the member goes straight to Prejoin.

### Still open

**4. Retention.** How long an internal meeting's transcript is kept, and under
what basis. `PRIVACY.md`'s retention table is written per data category with a
legal basis beside each, and every row there is about guests and customers.
Internal transcripts are records of employees talking about their own work,
which is a different basis and plausibly a different period — it is the one
question of the six that is nobody's product preference and has to be a
deliberate answer. Until it is written down, the table has no row for this and
`PRIVACY.md` is unchanged.

### Decided but not built

**Answer 6** is a real feature rather than a flag: "live" would have to reach
Home and Team on three clients, and `loadRoomPresence` deliberately resolves
room presence through `OWNER_ROOM_MAP`, which is the *public* room list. It
wants its own change, and the door does not depend on it.

## Docs this lands in

`ROOM_ENTRY.md` (the amendment and a fourth address), `SURFACES.md` (the address
table and the vocabulary rule), `CONFIGURATION.md` (the new configuration),
`PRIVACY.md` (consent and retention, once 2 and 4 are answered), `ADMIN.md`
(funnel treatment, once 1 is answered), `FEATURE_COMPLETENESS.md` (a row),
`agents/CONTEXT.md` (glossary: **the internal room**).

## Amendment — leaving is not ending (2026-09-17)

Decision 5 stands: one host, no co-host. What changes is what the host's
way out does. In a personal room the host's End closes the SFU and everyone
drops, because the room and the meeting are the owner's. In `/room/team`
the room belongs to no one, so:

- **The host's button is Leave.** It ends the *record* — the host's lease
  stops, the transcript stops with the host, the notes cover the host's
  time — and the call stays up for whoever is still in it. `POST …/end`
  on the internal room does not close the LiveKit room; neither does
  `…/finalize`.
- **End for everyone is a separate act, any member may take it.** Mac: the
  Meeting menu's *End Meeting for Everyone*; iOS: *End for everyone* under
  More; both confirm with the count of people still in. On the wire it is
  `POST …/end` with `{ "everyone": true }`.
- **No hand-over without another Mac.** If no eligible Mac companion is present,
  Leave still ends the host's record and leaves the internal LiveKit room up
  for whoever remains. When another Mac is present, the host can
  leave the record open: a companion uses **Take host**, or takes host on its
  own once the host leaves; the current Mac mutes and drains its local
  transcriber, uploads pending text, and the Worker moves the host to the
  successor. If the old Mac has already left LiveKit, the connected companion
  takes over immediately. End for everyone remains the separate action above.
  (Until 5.8.9 the docs called the host device "the chair".)

Not built: a browser member ending for everyone (the browser never hosts),
and last-participant-out on the Worker's side (the SFU handles it).

## Amendment — the host can move to another member (2026-09-30)

Decision 5 changes in one respect, decided by MZ. A room still has one
owner, and the owner alone keeps room settings, End meeting for everyone,
and the record. The **host** — the one device that admits guests, renews the
lease and takes the notes — can now move to a device of another Envisioning
member, in any room, personal rooms included.

- The host chooses **Move host…** and picks a Mac, iPhone or iPad in the call. The Worker
  sends that device an offer. Another device of the same member takes the
  host at once. Another member sees *<Name> asked you to host* and answers.
- Accepting is signed with that member's own session, and the Worker checks
  that it is the address they knocked with. The Durable Object then lets
  that member host this one meeting: join as host, the lease, the handover,
  admission, moderation and the transcript. Nothing else in the room.
- The member's Mac leaves as a guest, rejoins as a companion, and takes
  host; the old host drains its transcriber and hands over as it does for a
  companion Mac. The transcript from then on is recognized on that member's
  device.
- The owner can take the host back at any time with **Take host**.
- An offer stands for 60 seconds. A decline, or no answer, leaves the host
  where it was.
- Every client shows the host: the Worker writes a `host` participant
  attribute on the device that hosts, and the Mac, iPhone and web tiles
  and rosters read it.


## Amendment: rooms in D1 (2026-10-11)

The public room list is no longer `OWNER_ROOM_MAP` alone. A member's room is
a row in the workspace's `rooms` table, made at sign-in, and the map is a
read fallback. `services/control-plane/src/member-rooms.ts` answers "is this a
public room" (`isPublicRoom`, `publicRoomSlugs`); `permanentRoomSlugs` in the
contracts reads the map only. `knownRoomSlugs` here is now the set of room
objects: the public rooms, the retired ones and the internal room, for the
sweeps, backups and moves. The internal room stays configuration
(`INTERNAL_ROOM_MAP`), and a new room never takes its slug.
