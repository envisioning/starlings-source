---
kind: howto
status: active
verified: 2026-11-05
summary: "Give a task or an issue to an agent from Work"
capabilities: [owner-work, owner-channels, owner-agent-review-inbox]
owns: [Sources/WorkRowActions.swift, Sources/WorkWindowController.swift, iOS/MobileHandOff.swift, web/src/HandOffDialog.tsx]
---

# Hand off a card to an agent

1. Open Work and find the card: a task or an issue on a subject. A project's
   **Board** tab shows every card in its stage.
2. Open the card's menu, choose **Hand off to** and pick the agent from its submenu (on the web, **Hand off…**). A task row on the subject's Overview or Tasks tab has the same item. On the Mac you can also drag a card onto the agent in the sidebar.
3. Say what done looks like and what comes back: a pull request, a document or a message. Both are required. Then choose **Hand off**.
4. Starlings posts the hand-off in the subject's **Talk** and @mentions the agent, so everyone who can see the card sees the work. The agent answers there. A question it asks you is also a row in your Inbox. The card's stage changes as the agent works. If the subject is restricted, give the agent access first; otherwise Starlings refuses the hand-off.
5. The card follows the agent. It moves to **Doing** when the agent starts, to **Blocked** when the agent asks you something, and to **Review** when it answers. Review and Blocked are rows in your Inbox. Open the task to read its **Activity**: what you asked, what the agent did, and its questions, which you can answer there. An agent never moves a card to Done: you check the work against what you asked for and move it there.

If an agent stops answering, the watchdog resets it. The card goes back to the queue.

Starred is personal quick access; it does not change who can receive the card
or how the hand-off works.
