---
kind: intent
status: proposed
verified: 2026-09-22
summary: "ADR 0003: how the format is owned by being given away — published contract, conformance suite, version authority; the act record as a signed hash chain; and why it is not on a blockchain"
---

# 0003 — The format and the act record

**Status:** proposed · **Date:** 2026-09-22 · **Decided by:** MZ, not yet.

STRATEGY (HQ Docs) §What a platform needs says the schema is the
lock-in, that formats win by being copied, and that publishing the contract
and selling the workspace are the same move. It does not say **how** a format
is owned while it is open, and it does not define the act record it names twice.
This ADR answers both, and answers the blockchain question so that nobody has
to answer it again in a hurry.

**Vocabulary, fixed after this ADR was drafted.** Two other things in this
repo are already called a ledger: the **account ledger** (`meetings_ledger`,
`usage_events`) and the meeting **artifact**. The thing this ADR chains and
signs is the **act record**. [../LEDGER.md](../LEDGER.md) holds the three-way
distinction; this file uses "act record" below, and the file name stays for
the link.

---

## Context

Three things already exist and are the material of this decision.

1. **The contract.** `packages/contracts` is the one wire shape: zod first,
   Swift generated from it, `pnpm verify` failing when a client drifts. It is
   `private: true` today and ships to nobody.
2. **The record, half-built.** `mcp_calls` (migration `0036_mcp.sql`) records every
   `tools/call`, `resources/read` and `prompts/get`: who acted, under whose
   authority, which grant, what outcome. `admin_audit` does the same for
   admin acts. Both store the actor's email rather than joining it, "because
   a row must still read after the rows it points at are gone". That is
   already act-record thinking.
3. **The licence.** The repo is Apache-2.0.

What is missing is the step from *a table the Admin page renders* to **a
record a second party can verify**. Federation is where that bites: two
workspaces, no trusted party between them, both claiming what was agreed on a
shared subject ([FEDERATION.md](../FEDERATION.md)).

## Part 1 — How you own a format you give away

The instinct is that open means unowned. It does not. Open formats have owners,
and the ownership sits in three places that a licence cannot touch.

### Decisions (proposed)

| # | Decision |
| --- | --- |
| 1 | **The contract is published, versioned and permissively licensed.** `packages/contracts` stops being private. Apache-2.0 for the code, the prose specification under a licence that permits reimplementation without permission. A format that needs a conversation before it can be implemented is not a format. |
| 2 | **Ownership is stewardship, and it rests on three levers.** The reference implementation, the conformance suite, and version authority. Each is named below. Nothing is held back from the spec to create leverage; leverage that comes from withholding produces a competitor's fork, not a standard. |
| 3 | **The reference implementation is the product.** Whoever writes the code that everyone tests against sets the meaning of every ambiguous sentence in the spec. This is the strongest lever and it is a consequence of shipping, not a clause. |
| 4 | **The conformance suite is public, executable and ours.** A second implementation that wants to claim the format runs our tests. Fixtures over prose: `fixtures/work-items.json` already pins `WorkStage` for two language ports, and that pattern becomes the public artifact. A suite is how "compatible" stops being a marketing claim. |
| 5 | **Version authority is explicit and slow.** One published version at a time, a stated compatibility rule, and a written process for proposing a change. Slow is the feature: implementers adopt a format they can predict. |
| 6 | **The registry is the fourth, softer lever.** Names — of subjects kinds, of capabilities, of agent identities — need somewhere to be allocated. Whoever runs the registry stays in the loop by being useful, not by charging. |
| 7 | **Sell the workspace, never the format.** BUSINESS (HQ Docs) prices the agent's standing inside a workspace. Nothing in the price model touches reading or writing the format, and nothing ever should. |

### What this rules out

- **Open core with the important half withheld.** Splitting the format so the
  useful part is licensed produces a fork with worse semantics and no owner.
- **A licence that restricts implementation.** SSPL-style terms defend a
  hosted business. Starlings's business is the workspace, which is not what a
  reimplementation takes.
- **A standards body, now.** Governance before adoption is a committee with no
  implementers. This becomes a real question at the second independent
  implementation, not before.

### The measurement

STRATEGY's signals are about usage. This adds one: **implementations that are
not ours, passing our suite.** One is the whole difference between a format and
a schema.

## Part 2 — The act record

### What it is

The act record is the workspace's record of **acts**, distinct from the record of
**content**. Content is the subject: tasks, documents, transcripts, decisions.
The act record is the answer to "who did that, under whose authority, and when",
for every act by a person or an agent.

| Field | Answers |
| --- | --- |
| actor | who or what performed the act |
| principal | whose authority it borrowed, and which grant |
| subject | which subject the act landed on |
| act | what changed, as a contract-typed shape |
| outcome | ok, refused, failed |
| time, previous | when, and which entry came before |

`mcp_calls` already carries the first five. What it lacks is the sixth, and
signatures.

### Decisions (proposed)

| # | Decision |
| --- | --- |
| 8 | **Append-only, never updated.** Revocation is a column, never a delete — `0036_mcp.sql` already states this rule for grants. The act record generalises it. |
| 9 | **Hash-chained.** Every entry carries the hash of the entry before it. A removed or altered entry breaks the chain at a point anyone can find. This is a hash column and a check, not a system. |
| 10 | **Signed by the workspace.** One signing key per workspace, so an entry can be verified by a party that does not trust the operator's database. The key material follows [KEEP.md](../KEEP.md)'s model — the device holds keys, the server holds sealed blobs — rather than inventing a second one. |
| 11 | **Counter-signed across a federation boundary.** When an act lands on a shared subject, both workspaces sign the entry and each keeps the other's signature. Two parties who each hold the other's signature can settle a dispute between themselves. This is the whole of the federation trust problem, and it needs no third party. |
| 12 | **The act record holds acts, never content.** It holds the shape of what changed and a hash of it, not the text. [PRIVACY.md](../PRIVACY.md) governs the content; the record must never become a second copy of it. |
| 13 | **The act record is part of the published format.** A workspace's record is verifiable by whoever it was shared with, using the public spec and suite. An unverifiable audit trail is a log. |

## Part 3 — Should it be on chain?

**No.** Not the act record, not the content, and no token. The reasoning is below
so that the question is closed rather than deferred.

### What a chain actually provides

Three properties, and only three: ordering without a trusted party, tamper
evidence, and availability against the operator's will.

### What Starlings needs

Tamper evidence and non-repudiation, between **known, authenticated
principals**, inside or between workspaces that each have an accountable
operator. Byzantine agreement among unknown parties is the problem a chain
solves, and Starlings does not have that problem at any point in
[FEDERATION.md](../FEDERATION.md). Admission is the boundary; every
participant is identified before it can act.

A hash chain plus a signature gives tamper evidence and non-repudiation. That
is decisions 9 to 11, and it is a column, a key and a verification function.

### What a chain would cost

| Cost | Why it is disqualifying |
| --- | --- |
| Publication | Every entry becomes public and permanent. The product's first claim is that a firm's conversations stay inside the workspace that holds them. |
| Erasure | A right to erasure and an immutable public record cannot both hold. Hashes of personal data are, on a defensible reading, still personal data. [PRIVACY.md](../PRIVACY.md) would have to be weakened, which STRATEGY lists as a non-goal. |
| Liveness | The workspace's core loop would depend on a third party's network being up and affordable. |
| Keys | Key custody moves to the customer, with unrecoverable loss as the failure mode. |
| Credibility | The buyer in STRATEGY §Who it is for — a small, client-facing firm — reads a chain as a reason to doubt, not a reason to trust. |

### The one honest counter-argument, and its cheaper answer

A regulated third party who trusts **neither** workspace might want proof that
a record existed at a time and has not changed since. That is a real
requirement and a chain is one way to meet it.

It is not the cheapest way. In order of what to try first:

1. **Witnessed append-only log.** Independent witnesses co-sign the chain head
   periodically. This is how certificate transparency achieves the same
   property, at no cost per write, with no public content.
2. **Public anchoring, if a customer actually asks.** Publish a periodic
   Merkle root of the chain head to any public, timestamped medium. It proves
   existence and integrity, reveals nothing, and costs one write per period.
   Anchoring is not migration: the record stays where it is.

**Reopen this ADR only when a named customer states a requirement that
witnessing cannot meet.** Not for branding, and not for a funding round.

### Decision

| # | Decision |
| --- | --- |
| 14 | **No blockchain, no token, no consensus mechanism.** The act record is a signed hash chain in the workspace's own storage. |
| 15 | **Anchoring is a later option, behind a customer requirement.** If it is ever built, it publishes a Merkle root and never content. |

## Build order

Each step is useful on its own, which is the test of the order.

1. `previous_hash` on the existing `mcp_calls` and `admin_audit` rows. One column, one check.
2. A workspace signing key, and a verification function in `packages/contracts`.
3. The act-record entry as a contract type, with fixtures.
4. The conformance suite made public, starting from the fixtures that already pin behaviour across the TypeScript and Swift ports.
5. `packages/contracts` published, under the Starlings name ([0004](0004-workspace-addresses.md)).
6. Counter-signing, with federation, not before.

## Open questions

1. **Retention against append-only.** `0001`'s open question 4 asks how long an internal transcript is kept. A record that never deletes meets a retention policy that must. The likely answer is that the entry survives and the content does not, but it has to be written.
2. **Where the workspace key lives**, and what happens when it rotates. Verification has to survive rotation.
3. **Licence for the prose spec**, as distinct from the code.
4. **Who may read the ledger.** Admin sees `mcp_calls` today. A member auditing their own agent is a different, and probably necessary, view.

## Related

| Doc | Relationship |
| --- | --- |
| STRATEGY (HQ Docs) | Why the format is the lock-in and the act record is the durable hold |
| [MCP.md](../MCP.md) | The door every act-record row is written at |
| [FEDERATION.md](../FEDERATION.md) | The only case with no trusted party, answered by counter-signing |
| [PRIVACY.md](../PRIVACY.md) | Why content never enters the record |
| [KEEP.md](../KEEP.md) | The key model the signing key follows |
| [LEDGER.md](../LEDGER.md) | The three ledgers, and the act record as built |
| [agents/project-status.md](../agents/project-status.md) | Reading status, which the act record does not answer |
| BUSINESS (HQ Docs) | What is sold, given that the format is not |
| [0002](0002-the-name.md) | The name the published package would carry |
