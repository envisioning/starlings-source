---
kind: howto
status: active
verified: 2026-10-20
summary: "Set up a new workspace as its first admin: the steps on Home, on the Mac, iPhone and web, and what ticks each one"
capabilities: [owner-setup]
owns: [packages/contracts/src/setup-steps.ts, services/control-plane/src/setup.ts, web/src/SetupCard.tsx, web/src/SetupChecklistSettings.tsx, Sources/SetupChecklist.swift, iOS/MobileSetupCard.swift]
---

# Set up your workspace

When you sign in to a new workspace as its first admin, Home shows **Get started** under the clock: the steps that are left, on the Mac, iPhone, iPad and web. Each step ticks itself when the thing exists. You never tick a box.

1. Open Home. The first step you can do now is the one that stands out.
2. Click a step. It opens where that step is done: Settings, Work, Admin, or the download page.
3. Come back to Home. A step you finished shows as done.

The steps for an admin:

<!-- setup-steps:admin:start -->
| Step | Done when | Optional |
| --- | --- | --- |
| **Check your workspace’s look** | An admin saved the name, the accent or the mark. |  |
| **Choose who can join** | Who can join was chosen at signup, or the workspace signs people in by their email domain. |  |
| **Invite your team** | Someone has an invitation, or a second person signed in. |  |
| **Start your first project** | The workspace has a project. |  |
| **Connect your calendar** | Your calendar is connected. |  |
| **Connect your agent** | You connected an agent over MCP. |  |
| **Add your first agent** | The workspace has an agent besides the one Starlings runs. |  |
| **Hold a call** | The workspace held its first call. | Optional |
| **Get the apps** | You signed in on the Mac or iPhone app. | Optional |
<!-- setup-steps:admin:end -->

A new workspace comes with a sample project in Work. It does not count for **Start your first project**. Archive it when you no longer need it.

Every member sees their own steps:

<!-- setup-steps:member:start -->
| Step | Done when | Optional |
| --- | --- | --- |
| **Add your photo** | Your profile has a picture. |  |
| **Connect your calendar** | Your calendar is connected. |  |
| **Connect your agent** | You connected an agent over MCP. |  |
| **Get the apps** | You signed in on the Mac or iPhone app. | Optional |
<!-- setup-steps:member:end -->

A step that cannot be done yet says why, and who can change that. **Choose who can join** is done by what you chose on the signup page.

**Connect your agent** is done when any MCP client is paired as you: Claude, Claude Code, Hermes, or your own agent. See [Connect an agent over MCP](connect-an-agent-over-mcp.md).

**Skip** clears a step you do not want, for example a calendar you will not connect. It goes from your card on the Mac, iPhone and web, and a skipped step no longer holds the card open.

**Hide** puts the card away until you next open the app or the page. It comes back while a required step is open. **Turn off for everyone** takes it away for the whole workspace; turn it back on in Admin › People › **Setup checklist**. When every required step is done, Home says so once. A workspace that was in use before the checklist existed starts with it off; an admin can turn it on there.

On day 3, if a required step is still open, each admin gets one mail with their next step.

## For an agent

A connected agent reads the same steps at `starlings://setup` ([Connect an agent over MCP](connect-an-agent-over-mcp.md)): each step's title, whether it is done, what makes it done, and the page where it is done. It can offer to help with what is left.
