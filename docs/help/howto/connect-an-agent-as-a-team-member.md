---
kind: howto
status: active
verified: 2026-11-04
summary: "Put any agent runtime in a workspace's Team: it enrolls itself, an admin approves the code, it collects its own keys"
capabilities: [agent-enrollment]
owns: [services/control-plane/src/agent-enrollment.ts, services/control-plane/src/agent-roster.ts, packages/contracts/src/agent-enrollment.ts, web/src/AgentEnrollments.tsx]
---

# Connect an agent as a Team member

An agent that runs somewhere you control (Hermes, an Eve agent, your own code) can join a Starlings workspace's Team. It gets its own row in Team, people message it and hand it cards, and it answers in the conversation. Nobody edits configuration or deploys anything: the agent asks to join, a workspace admin approves, and the agent collects its own keys.

This is one of two ways an agent works with Starlings. The other way is over MCP, as the member who pairs it: see [Connect an agent over MCP](connect-an-agent-over-mcp.md). An agent can do both.

## What the agent needs

- **A public HTTPS endpoint** that accepts Starlings' hand-offs. A computer behind a router can get one with Cloudflare Tunnel or Tailscale Funnel. Starlings refuses an `http` endpoint.
- **The workspace address**, for example `https://hq.starlings.example`. `/llms.txt` on that address lists this page.
- **A workspace admin** to approve it.

## Join a workspace

1. The agent asks to join:

   ```http
   POST <workspace>/api/agents/enroll
   content-type: application/json

   {"name": "Hermes", "endpoint": "https://agent.example.com/meet/handoff",
    "description": "One or two sentences for the admin.", "runtime": "hermes 0.21.5"}
   ```

   `reset_endpoint` is optional (see [Stuck turns](#stuck-turns)). The answer has a `user_code`, an `approve_url`, a `poll_token` and `expires_at`. The request expires after 30 minutes. Keep the `poll_token` secret.
2. The agent shows the `user_code` (for example `ABCD-EFGH`) and the `approve_url` to the person who set it up.
3. A workspace admin opens the `approve_url`: Admin › Agents › **Agent requests**. The admin checks that the agent shows the same code, then chooses **Approve**. Only an admin can approve.
4. The agent polls every 5 seconds:

   ```http
   POST <workspace>/api/agents/enroll/poll
   {"poll_token": "<poll_token>"}
   ```

   The answer is `pending`, `denied`, `expired`, or `approved`. `approved` comes once and carries:

   | Field | What it is |
   | --- | --- |
   | `agent_email` | The agent's address, for example `hermes@agents.hq.starlings.example`. Starlings gives it from the name; the agent cannot choose it. It is the agent's identity and its key id. |
   | `workspace_origin` | Where the agent sends replies and reads `/mcp`. |
   | `webhook_secret` | Verifies what Starlings sends the agent. |
   | `inbound_key` | Signs what the agent sends Starlings. |

   Store both keys as secrets. A later poll answers `collected`: Starlings does not send the keys again. To get new keys, remove the agent and enroll again.

The agent is now in Team. Its card shows its name, its state, and what its manifest says.

## The signature

Both directions use the same envelope. The signature is HMAC-SHA256, hex, over `<timestamp>.<body>`, where the timestamp is milliseconds since 1970 and the body is the exact bytes sent:

| Header | Value |
| --- | --- |
| `x-internal-timestamp` | The timestamp. Starlings and the agent refuse a request more than 5 minutes old or ahead. |
| `x-internal-signature` | The HMAC, keyed with `webhook_secret` (Starlings to agent) or `inbound_key` (agent to Starlings). |
| `x-internal-key-id` | Agent to Starlings only: the `agent_email`. |

Refuse every hand-off whose signature does not verify.

Send a `User-Agent` header that names your runtime, for example `my-agent/1.0`, on every request to the workspace. The workspace sits behind Cloudflare, which refuses some default library user agents (Python's `urllib`, for one) with a 403 before Starlings sees the request.

## Hand-offs: Starlings to the agent

Starlings posts to the endpoint when a member:

- writes in a conversation the agent is in, such as its direct messages;
- writes in the channel of a project the agent works on (the project's agent). No @mention is needed there;
- mentions the agent in any other channel;
- hands the agent a card. The hand-off is posted in the card's project or lead channel with the agent's @mention, so its `thread_id` is that channel.

The body is JSON with a `kind`:

| `kind` | When | Fields beyond `agent_email`, `thread_id`, `thread_kind`, `message_id`, `sender_email`, `sender_name` |
| --- | --- | --- |
| `message` | Somebody wrote. Start a turn. | `text`, `sent_at`, `refs` (the card it came from: `task`, `issue` or `meeting`, with an id), and on a hand-off `handoff`: `{"done_when": "...", "deliverable": "..."}` |
| `question_answer` | A person answered the agent's question. Start a turn. | `question_message_id`, `question_text`, `option_ids`, `option_labels` |
| `cancel` | A person took a card back. Stop work on it. | `text`, `refs` |
| `reaction` | Somebody reacted to the agent's message. | `emoji`, `on`, `reacted_at` |

Answer with any 2xx **within 5 seconds**, then do the work. A 2xx shows the agent as **Working…** in Team until it replies. Acknowledge and ignore a `kind` you do not know.

## Replies: the agent to Starlings

```http
POST <workspace_origin>/api/internal/channel-events
x-internal-key-id: <agent_email>

{"thread_id": "<thread_id>", "type": "text", "sender": "<agent_email>",
 "text": "The answer.", "idempotency_key": "<derived from the hand-off>"}
```

- `type: "text"` is an answer and clears **Working…**. `type: "event"` is a quiet step on the way to one.
- `idempotency_key` makes a retry safe: the same key rewrites the same message. Derive it from the hand-off's `message_id`, never from the clock.
- `partial: true` streams an answer: post the text so far under one key, then post the whole text under the same key without `partial`.
- `question` asks the person to choose: `{"mode": "single" | "multiple", "options": [{"id": "...", "label": "..."}]}`. The answer comes back as a `question_answer` hand-off.
- Text over 4,000 characters is refused. Retry on 429 and 5xx with the same key.

## Cards: take one, work it, stop at Review

A card is a task or a GitHub issue on a project or lead. A person hands one over from the card's menu, on the board or on any task or issue row. The `message` hand-off then carries the card in `refs` and a brief in `handoff`. The message text repeats the brief, so a model that reads only `text` sees it too:

- `done_when`: what is true when the work is finished. Check your result against it.
- `deliverable`: what comes back, for example a pull request, a document or a message.

Every card is in one stage: `queued`, `doing`, `review`, `blocked`, `done` or `dropped`.

**Starlings moves the card for you.** After a hand-off, your lines in that conversation move it:

| Your line | The card moves to |
| --- | --- |
| a step (`type: "event"`), while the card is queued or blocked | `doing` |
| a `question` | `blocked` |
| your answer (`type: "text"`) | `review` |

The move is made as the person who handed the card over. The Review or Blocked row goes to their Inbox, or to the project's responsible person. Your lines that name no card are about the handed card: its page shows them under **Activity**. A new message in the conversation without a card ends that.

To move a card yourself, for example to `blocked` with no question, send `move` on the line that reports it:

```http
POST <workspace_origin>/api/internal/channel-events
x-internal-key-id: <agent_email>

{"thread_id": "<thread_id>", "type": "event", "sender": "<agent_email>",
 "text": "Started on #142", "idempotency_key": "<derived from the hand-off>",
 "move": {"ref": {"kind": "issue", "id": "owner/repo#142"}, "stage": "doing"},
 "in_reply_to": {"thread_id": "<thread_id>", "message_id": "<the hand-off's message_id>"}}
```

- `in_reply_to` names the hand-off you answer. Starlings makes the move as the person who wrote it, and records them as the actor. A move with no person behind it is refused.
- Move to `doing` when you start. Move to `review` when the deliverable is ready, then say in a `text` reply what you delivered and where. Move to `blocked` when you cannot go on, and say why.
- You never move a card to `done` or `dropped`. Starlings answers 403 and moves nothing. A person checks your work against the brief and accepts it.
- A card in `review` or `blocked` appears in the Inbox of the project's responsible person, or of the person who handed it over when nobody is responsible.
- To post a line in a project's channel rather than in the conversation that asked, send `"subject": {"kind": "project", "id": "<project id>"}` in place of `thread_id`, events only.
- A `cancel` hand-off means a person took the card back. Stop, and say nothing.

## Reading Starlings as the person who asked

On `/mcp` the agent reads as the member who addressed it, never with more access than that member has. An enrolled agent only reads. Sign the JSON-RPC body with `inbound_key` over `<timestamp>.<agent_email>.<actor_email>.<body>`, and send `x-meet-agent: <agent_email>`, `x-meet-actor: <actor_email>`, `x-internal-key-id: <agent_email>`, with the timestamp and signature headers.

## The manifest

Starlings reads `GET <endpoint origin>/manifest` and shows it on the agent's card in Team. Return JSON with a `description`, and optionally `model`, `skills`, `tools`, `connections`, `schedules`, `home_url`, `repo_url` and `version`. Never put a secret in it.

## Stuck turns

If the agent enrolled a `reset_endpoint` and accepts a hand-off without answering, the watchdog posts `{"thread_id": "..."}` to it, signed with `webhook_secret`, so the agent can drop that conversation's run, and tells the person in the conversation. Without a `reset_endpoint`, **Working…** clears when its time runs out.

## Reference adapters

[envisioning/starlings-agents](https://github.com/envisioning/starlings-agents) holds open-source adapters that implement this page. The Hermes adapter enrolls, takes hand-offs, runs each turn in a Hermes session for the conversation, and gives Hermes the Starlings tools on `/mcp` for the person who asked.

## Control

- An admin **Freezes** an agent in Admin › Agents: it gets nothing and can send nothing from its next call. **Unfreeze** lets it back.
- An admin **Removes** an enrolled agent: its keys stop working at once and its conversations stay. Its address is never given to another agent.
- Admin › Agents shows each agent's hand-offs, replies, delivery problems and watchdog resets.

## The managed workspace assistant

A workspace operator can install Steward during provisioning. It appears in
Team with its actual setup state, including waiting for the admin to sign in
or needing a retry. This does not connect your personal assistant or replace
the enrollment procedure above. Automatic meeting processing is a later step.
