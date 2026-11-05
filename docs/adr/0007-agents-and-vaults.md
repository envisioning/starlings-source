---
kind: intent
status: active
verified: 2026-10-06
summary: "ADR 0007: agents and vault secrets. An agent's own keys sit in a machine vault and are used through a broker, so the agent never holds a value; a person's passwords and keys reach an agent only by an attended, time-limited release on a person's device; every vault and item shows who can use it, people and agents, with last use and Revoke — accepted, not built"
---

# 0007 — Agents and vault secrets

**Status:** accepted · not built · **Date:** 2026-10-06 · **Decided by:** MZ

How agents use passwords and keys that live in Keep, and how a person sees
which agents can use them. This accepts the design in
[AGENT_SECRETS.md](../AGENT_SECRETS.md) (2026-09-22), with one change:
decision 4 there (the agent fetches its keys into memory each turn) is
replaced by brokered use (decision 3 below).

---

## Context

- Keep (`envisioning/keep`, [KEEP.md](../KEEP.md)) is zero-knowledge. Every
  secret is sealed in a member's browser or app under keys the server never
  sees. A vault key is wrapped to each member's public key, and the unlocked
  private key lives only in the member's tab or app memory. Keep audits every
  reveal, one item and one row.
- Agents run unattended (Vocab, Comms and Status today, the `AGENT_ROSTER` in
  `services/control-plane/wrangler.jsonc`). Their own service keys live as
  environment variables in each bot's deployment. One of them is a
  Supabase service-role key with full read and write
  (the register, in HQ Docs: /company/operations/agent-secrets-envisioning).
- A prompt-injected turn can read the agent's own environment and print it
  into a thread. A secret the model holds is a secret the model can leak.
- MZ asked on 2026-10-06 that a vault show which agents can use its keys.

## Decisions

| # | Decision |
| --- | --- |
| 1 | **Two classes of secret, never mixed.** An agent's own service keys (used every turn) and a person's passwords and keys (used rarely) need opposite handling. They never share a vault. A person's secret never enters a machine vault. |
| 2 | **Each agent has one machine vault.** It holds only that agent's own keys. It is a Keep vault with a flag and exactly one member, the agent. Any member may add or remove a key (confirmed by MZ, 2026-10-06); the audit row names who did. Per-agent keys, never one key shared by several agents. |
| 3 | **Brokered use: the agent never holds a value.** A broker Worker makes the outbound call for the agent and adds the key itself. The agent sends the request and names the key; the broker checks that the key is in that agent's machine vault, that the destination is on the key's allowlist, and the rate limit, then makes the call and logs it. A compromised agent can still use a key through the broker, inside those limits, but cannot carry the key away. This replaces AGENT_SECRETS.md decision 4. |
| 4 | **The broker is its own Worker, not `keep-api`.** A machine vault is readable by the server: the broker holds the unwrap key. `keep-api` keeps its invariant that the Worker holds no key ([KEEP.md](../KEEP.md), keep `AGENTS.md`). The broker is the only place that holds an unwrap key, and only for machine vaults. One broker per workspace, like Docs and Keep. |
| 5 | **A person's secret reaches an agent only by an attended release.** The agent asks in a thread for one item, for one task. A member of that vault approves on their own device. That device unwraps the item and wraps it again to a key for that one agent session, with an expiry. The server never sees the value; the release is one item, one session, one expiry, and one audit row that names the person, the agent, the item and the task. Where the service allows it, the release is a scoped, expiring token made for the task, not the stored password. |
| 6 | **Short-lived and scoped beats long-lived.** A machine-vault key carries the narrowest vendor scope it supports (read-only, a spend cap, an allowlist). A key is rotated when an agent's deployment changes hands, and on Revoke. |
| 7 | **Every vault and item shows who can use it.** People (members), agents with standing access (a machine vault's member), and agents with an active release (item, approver, task, expiry). Each row has its last use, from the per-item audit, and Revoke. The label is "can use", not "has": with the broker, no agent holds a value. |
| 8 | **Each agent's page shows its keys.** In Starlings, an agent's detail view lists its machine vault's keys, who added each one, its last use, and Revoke, in the shape of Settings › Connected agents. |
| 9 | **An org admin has no authority inside Keep.** Admin sees no vault, human or machine (AGENT_SECRETS.md decision 7). |

## What must never happen

- An agent's key, or the broker's unwrap key, in an agent's environment
  variables or on disk in its sandbox.
- A person's password or key in a machine vault.
- One key shared by several agents.
- A release with no expiry, or one that covers more than one item.
- A vault an admin can open.

## The release on screen (MZ, 2026-10-06;)

| # | Decision |
| --- | --- |
| 10 | **A card in the task's thread.** The agent posts a request card in the thread of the task it works on: the item's name (never its value), the task, why, and the expiry. A member of the item's vault taps **Approve** on Mac or iPhone; Keep unlocks there, and that device wraps the item to the agent's session key. The card then shows who approved and when the release ends, and offers **End now**. |
| 11 | **15 minutes by default.** The approver may choose longer before approving. The maximum is 24 hours (confirmed by MZ, 2026-10-06). |
| 12 | **Any member of the vault may approve.** Anyone who can already open the item can release it. The audit row names the approver. |

## Open

| Question | Owner |
| --- | --- |
| Whether the broker can call every vendor the agents use today, or some keys must still be handed to the agent for a vendor SDK that signs its own requests. The register (HQ Docs: /company/operations/agent-secrets-envisioning) is the list to check. | Research (meet issue: broker coverage) |

## Consequences

- Keep needs an agent principal (a member that is not a person), vault
  flags, agent-scoped device tokens and release records.
- A new broker Worker per workspace joins the fleet and provisioning
  (#680), like Docs and Keep.
- The bots' service keys move out of their environment variables into
  machine vaults, one agent at a time, starting with the Supabase
  service-role key.
- Keep's one property, that a dump of the server yields nothing readable,
  still holds for human vaults. It does not hold for machine vaults, by
  decision 4. That is the reason the two classes never mix.
