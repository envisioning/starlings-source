---
kind: howto
status: active
verified: 2026-10-15
summary: "Map a GitHub repository to a project at `/admin/connectors/github`"
capabilities: [owner-issues]
owns: [web/src/GithubConnectorPage.tsx]
---

# Connect a repository

Starlings reads GitHub through the Starlings GitHub App. Each workspace installs it on its own GitHub account.

1. Open `/admin/connectors/github`: Admin → Connectors → the GitHub card. Only an org admin can make changes.
2. The first time, press **Connect GitHub**. GitHub asks which account to install the App on and which repositories it can read, then asks you to authorize Starlings. You come back to the same page. Your GitHub account must have access to that installation.
3. Find the repository. Map it to the project.
4. Press **Sync now**. The row shows `Synced · n pulls`.
5. Open the project in Work. Issues and pull requests are on the Issues pane; **New Issue** creates an issue through the App.

Any member can also link a repository from Work, on the Mac or iPhone: **Edit details** on the project, then **Repository**, or **Link GitHub repository…** on the project's context menu. This link writes the same mapping. Starlings refuses a repository that is already linked to another subject.

A project shows the Issues pane only once a repository is linked.

To unmap, reverse the mapping on the same row.

**Disconnect** on the same page stops Starlings from reading GitHub for this workspace. The App stays installed on your account until you remove it on GitHub. Removing or suspending it on GitHub disconnects the workspace too.

A GitHub account connects to one workspace. Starlings refuses an account that another workspace already connected.
