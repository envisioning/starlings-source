---
kind: intent
status: superseded
verified: 2026-10-03
summary: "ADR 0002: the product is named for the record, not the room; Quorum proposed, Dossier the fallback — superseded: the product is Starlings (ADR 0004)"
---

# 0002 — The name

**Status:** superseded by [0004](0004-workspace-addresses.md) · **Date:** 2026-09-22 · **Decided by:** MZ, 2026-10-02: the product is **Starlings**, not Quorum or Dossier. Meet retires as a product name: Envisioning's copy is the workspace "Envisioning" on Starlings (MZ, 2026-10-02, STARLINGS (HQ Docs)). Kept for the argument; decisions 3 and 4 below did not land.

This ADR exists because the naming argument was made in conversation and
would otherwise be lost. It does not rename anything. Nothing in the repo,
the domain, [SURFACES.md](../SURFACES.md) or the App Store changes until the
status of this file says accepted.

---

## Context

STRATEGY (HQ Docs) makes two claims that bear on the name.

1. **The room is the wedge and the commodity.** The defensible thing is the
   record model and the authority ledger. Every competitor has a room.
2. **The agent is the distribution channel.** Agents type this name and people
   say it to assistants out loud, constantly. The name is an interface.

"Meet" contradicts both. It names the commodity, and it is a command word: in
a prompt, *meet with the client* and *in Meet* collide. Google Meet also holds
the term in the one market Meet sells against.

The name is not urgent. It is written down now because renaming gets more
expensive with every surface, and because the argument for the name is the
same argument as the strategy.

## Decisions (proposed)

| # | Decision |
| --- | --- |
| 1 | **Name the record or the standing. Never the room.** A name that points at the meeting anchors the product to the part it plans to outgrow. This rule outlives whichever word wins. |
| 2 | **The name must survive four tests.** An agent types it. A person says it aloud to an assistant on a bad line. It works as a handle, `you@name`. It is not a verb a model will misparse. |
| 3 | **Proposed: Quorum.** A quorum is the body with standing to decide, and the record of what it decided. It covers people and agents holding standing, it includes outsiders by construction (the federation case), and it is a place, never a verb. |
| 4 | **Fallback: Dossier.** It names the unit of work most literally — one dossier per project, lead, partner or event, across time. "Open the Grundfos dossier" parses the same way for a person and for an agent. |
| 5 | **Meet stays the name of the room.** Whatever the product is called, the video surface can still be called the room, and the wedge can still be described as meetings. A rename is a product name, not a vocabulary purge. |

### Why Quorum, in one line each

- **Standing** is the differentiator, and it is the word's meaning.
- It implies the record, not the call.
- It is institutional, which suits a product whose pitch is "on the record".
- Two syllables, spells itself, no plural trap.

### Ruled out, with the reason

| Rejected | Reason |
| --- | --- |
| Room, Call, Session, Convene | Names the commodity. Decision 1. |
| Work, Flow, Sync, Loop | Every one is a verb, and every one is five products already. |
| Ledger | Correct meaning, held hard by the hardware wallet. |
| Invented Latinate words | The pitch is that the thing is institutional. An invented name spends its first year proving it is not a toy. |

## The risk this ADR does not close

**Trademark.** Quorum Analytics and Quorum Software both operate in enterprise
software. The mark is contested, not clear. That is a legal search, and it has
to happen before decision 3 moves from proposed to accepted. Dossier and the
rule in decision 1 are what remains if the search fails.

## What a rename would touch

Listed so the cost is visible rather than discovered.

| Surface | What changes |
| --- | --- |
| [SURFACES.md](../SURFACES.md) | The product name, everywhere it is prose. The surface names (Home, Work, Team, Docs) do not. |
| `packages/contracts` | The package scope, `@starlings/*`. See [0003](0003-the-ledger.md) — the published format carries the name into other people's code, so the name has to settle before the format is published. |
| Domain, mail, OAuth | The workspace domain, every redirect URI, the MCP `instructions` string |
| Apple | Bundle identifiers, App Store listing, the signing identity |
| `web/marketing/src/WhyPage.tsx`, `/pricing` | Public copy |
| `CLI/MeetCLI.swift` | `meetctl` |

## Sequence

The name settles before [0003](0003-the-ledger.md) publishes the contract, and
not before the trademark search. Those are the only two orderings that matter.

## Related

| Doc | Relationship |
| --- | --- |
| STRATEGY (HQ Docs) | Why the room is the commodity, and why agents make the name an interface |
| [0003](0003-the-ledger.md) | The format that would carry the name into other people's code |
| [SURFACES.md](../SURFACES.md) | The vocabulary contract a rename has to respect |
