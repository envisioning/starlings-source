---
kind: howto
status: active
verified: 2026-11-04
summary: "Pair a Claude with Starlings over MCP at `/connect`"
capabilities: [agent-meeting, owner-work, owner-schedule, cms-content]
owns: [web/src/ConnectPage.tsx, web/vite.config.ts]
---

# Connect Claude

Claude pairs with Starlings the way any MCP client does. [Connect an agent over MCP](connect-an-agent-over-mcp.md) says what the agent gets, what you see, and how to pause or revoke it. This page says where to add the connector in each Claude.

Only a member of this workspace can pair Claude. The pairing signs in as that member, and Claude reads only what the member can read.

1. Add Starlings as a connector in Claude. Settings → Account → **Connected agents** shows the **Connector name** and the **Connector address**, each with **Copy**, on the Mac, iPhone and web. The address is `<your Starlings origin>/mcp`, and the client registers itself. Each workspace has its own connector at its own address. Give each connector its workspace's name, for example **Starlings · HQ**; the server gives the same name, so two connected workspaces stay apart.
   - claude.ai or Claude Desktop: Settings → Connectors → **Add custom connector**.
   - Claude Code: run `claude mcp add --transport http --scope user starlings-<workspace> <your Starlings origin>/mcp`, for example `starlings-hq`, then open `/mcp` in a `claude` session, choose it and **Authenticate**. Claude Code names are one word, so use the workspace's name after `starlings-`.
2. The browser opens `/connect`. Sign in as yourself. To let Claude write, tick **Also write** before you allow the pairing. Without it, Claude only reads.
3. Ask Claude about a client, a call or a task. It starts with `search` or `now`.

A message Claude sends shows **via claude.ai**, or the name of the Claude you used, beside the time.
