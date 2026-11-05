---
kind: howto
status: active
verified: 2026-11-05
summary: "Pair any MCP client (Claude, Hermes or your own agent) with Starlings at `/mcp`, acting as you"
capabilities: [agent-meeting, owner-work, owner-schedule, cms-content]
owns: [services/control-plane/src/mcp.ts, services/control-plane/src/mcp-auth.ts, services/control-plane/src/crm-actions.ts#actorName, packages/contracts/src/mcp.ts, web/agent-surface.ts]
---

# Connect an agent over MCP

Any agent that is an MCP client can work in Starlings as you. Claude, Claude Code and Hermes are examples. The agent connects to your workspace's `/mcp` address, you sign in once, and from then on it reads what you can read and writes only if you allow it.

This is one of two ways an agent works with Starlings:

- **Over MCP, as you.** Your own agent connects with your access. What it writes is yours and says which client wrote it. This page.
- **As a Team agent.** A shared agent has its own row in Team, gets messages and cards handed to it, and replies in the thread. Any runtime can join this way: see [Connect an agent as a Team member](connect-an-agent-as-a-team-member.md).

Only a member of this workspace can pair an agent. Starlings has no self-serve workspace yet. The public Starlings site publishes the help pages; use your workspace address for pairing, including `/connect` and `/mcp`.

## What the client needs

Starlings uses the standard MCP authorization: OAuth 2.1 with discovery, dynamic client registration and PKCE. A client that does these on its own needs only the address.

| | |
| --- | --- |
| Endpoint | `<your Starlings origin>/mcp`, Streamable HTTP |
| Discovery | `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`. A call without a token gets `401` with a `WWW-Authenticate` header that names the first one. |
| Registration | `/oauth/register` (RFC 7591). The client registers itself. Starlings issues no client secret; PKCE (S256) is the proof. |
| Redirect | `https://claude.ai`, `https://claude.com`, or loopback: `localhost`, `127.0.0.1`, `[::1]`. Starlings refuses any other redirect host. |
| Scopes | `read`, and `write` when you tick **Also write** on `/connect`. What the client asks for does not grant `write`. |
| Name | The `client_name` the client registers with. Starlings shows it on `/connect`, in Settings, and beside everything the agent writes. |

A client that cannot do OAuth cannot pair. Starlings has no API keys for MCP.

## Pair a client

1. Add your workspace's `/mcp` address to the client as an MCP server. Settings → Account → **Connected agents** shows the address and the name, each with **Copy**. Give the server its workspace's name, for example **Starlings · HQ**, or `starlings-hq` where the client takes one word; the server gives the same name, so two connected workspaces stay apart.
2. The client opens `/connect` in a browser. Sign in as yourself. To let the agent write, tick **Also write** before you allow the pairing. Without it, the agent only reads.
3. The client gets its tokens and lists the Starlings tools.

### Claude

claude.ai, Claude Desktop and Claude Code each pair this way. See [Connect Claude](connect-claude.md) for where to add the connector in each.

### Hermes

Hermes is an agent runtime that you run yourself. Add Starlings to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  starlings-hq:
    url: "<your Starlings origin>/mcp"
    auth: oauth
    oauth:
      client_name: "Hermes"
```

Then run `hermes mcp login starlings-hq`, with your workspace's name in place of `hq`. Hermes prints the authorize address and waits for the callback on a loopback port.

### An agent on another computer

The redirect goes to loopback: the computer the agent runs on. When that is a server or a Raspberry Pi and your browser is on a different computer, do one of these:

- **Paste back.** Open the authorize address in your browser and allow the pairing. The browser then fails to load a `127.0.0.1` address. That is expected. Copy the full address from the address bar and paste it where the agent asks for it. Hermes accepts this.
- **Forward the port.** Run `ssh -N -L <port>:127.0.0.1:<port> <user>@<host>` with the port the agent listens on, then open the authorize address. The callback reaches the agent through the tunnel.

## What the agent gets

The tools: `search`, `open`, `now`, `transcript`, `schedule`, `start_meeting`, `send_message`, `task`, `create_issue`, `record_decision`, `ask_decision`, `set_goal`, `cms`, `docs_write`, and the offer tools: `offer_get`, `offer_options`, `offer_create`, `offer_add_line`, `offer_update_line`, `offer_remove_line`, `offer_update`, `offer_duplicate`, `offer_send`, `offer_record_decision`, `offer_partner_discount`, `service_list`, `service_create`, `service_update`. A read-only pairing lists only the read tools. A workspace that keeps its own records instead of Envisioning's Core does not list `cms`, and lists `create_issue` only when Meet's GitHub App is set up for it. A workspace whose offers are still in Core does not list the offer tools. See [Write an offer](/help/howto/write-an-offer). The agent also gets the resources and prompts, and an index of the product at `/llms.txt`.

Start with `search` or `now`. Every row has a `door`; pass it to `open`.

- `ask_decision` puts a question in your decision queue when you are not in the conversation (a background or scheduled run). While you are talking with the agent, it asks you there. You answer it from INBOX ([Answer a decision](answer-a-decision.md)).
- `task` also creates a lead or a project: pass `action: "create_lead"` or `action: "create_project"` and a title. A lead also needs its organization, by id or by name; a project may name one or none. A name finds the organization with exactly that name, or creates it. The agent gets the new door and its channel; on a lead, Core posts **New Lead Created**. The agent can set a lead's five qualification checks, on create or later with `update_lead`. It cannot delete a lead.
- The agent reads your Quick Notes through `now` and files one by passing its id as `quick_note` to `task`, `create_issue`, `send_message` or `docs_write`; the note is marked filed there, as **File…** does. It cannot delete a note.
- The agent files one of a project's tasks on GitHub by passing it as `task` to `create_issue`. The task and the issue stay one card, as **File on GitHub** does.
- When you ask, the agent can share a document under `/work` by link with `docs_write`: the answer is a link on org.example that the people you send it to can read after they confirm their email. It cannot share a document in another folder, or make one public; share those from Docs.
- The agent can merge duplicate contacts or organizations in Core with `cms` and `merge`: Core keeps the oldest, moves everything from the others onto it, and records the merge. The agent names the survivor to you first.

For the full list of what an agent can reach, and what only a person can do, see `/workspace/status`.

## House standards

Before the agent writes something for people outside your company, such as an offer, a proposal, a case study or website copy, it reads your house standards in Docs: `/house/readme` and the guide that it names for that kind of document. When you correct the draft, the agent proposes the correction as a new rule in that guide. It edits the guide only after you say yes. After that, every member's agent follows the new rule. The **write_offer** prompt does this for an offer. A new workspace starts with a short `/house/readme` for your team to edit. The agent only names house documents your workspace has.

## What you see

- A message the agent sends with `send_message` is yours, and shows a quiet **via** and the client's name beside the time, so the people reading it can tell. A line the agent leaves in a channel reads, for example, *Rosa via Hermes recorded a decision*.
- When Starlings refuses a call, or the call fails, the agent gets the reason and a suggested next step. A read-only pairing refuses every write. To allow writes, **Revoke** the pairing and pair again with **Also write** ticked.
- Starlings records every call. See yours under Settings → Account → **Connected agents**, which lists every MCP client, or all of them on Admin. **Revoke** ends the pairing.
- **Pause** stops an agent at its next call and keeps the pairing. Starlings refuses each call and tells the agent that you paused it. **Resume** lets the next call through. You do not pair again.

## Have an agent start a meeting

Ask the agent to start a meeting. It calls `start_meeting`. This puts the meeting on the calendar, in your own room, and asks your devices to open the room.

Each of your running clients shows **Open room** or **Not now**. You have 45 seconds to answer, the same limit as a Wave. The room opens only when you choose **Open room**. If you do not answer, the meeting stays on the calendar and the room stays closed.

Starlings **transcribes** a room opened this way, because it is a convened meeting with a title and attendees. Starlings does not transcribe a room opened from a colleague's Call.

For an ordinary calendar event, use `schedule`. It does not ask your devices and does not open a room.
