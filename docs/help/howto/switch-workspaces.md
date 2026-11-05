---
kind: howto
status: active
verified: 2026-11-04
summary: "Sign in from the list of your workspaces, add one by its address, switch, and sign out of or remove one on the Mac, iPhone or web"
capabilities: [entry-workspaces, entry-owner-auth]
owns: [Sources/WorkspaceSwitchMenu.swift, Sources/WorkspaceDoorViews.swift, iOS/MobileFirstRunCard.swift, web/src/WorkspaceDoor.tsx, web/src/WorkspaceSwitcher.tsx, web/src/AddWorkspaceDialog.tsx, Sources/StarlingsMenubarController.swift, iOS/MobileHomeView.swift, iOS/MobileWorkspacesSection.swift, Sources/WorkspaceSignOut.swift, Sources/LinkWorkspaceOffer.swift, Sources/AddWorkspaceFlow.swift, Sources/AddWorkspaceSheet.swift, Sources/AddWorkspaceViews.swift, web/src/WorkspacesSection.tsx, web/src/workspace-directory.ts, web/src/workspace-arrival.ts]
---

# Switch workspaces

One Mac or iPhone app holds every workspace you belong to. Each one keeps its own sign-in.

## Sign in

The sign-in screen lists every workspace you have signed in to on this device, with its mark, name and address. Choose **Sign in** on a row to sign in to it, or **Open** when you are still signed in. You do not need to remember the address.

On the web, the sign-in screen lists the other workspaces this browser has opened. Each row opens that workspace's own address.

## Add a workspace

1. On the sign-in screen, choose **Enter an address**. When you are signed in, open **Switch Workspace** › **Add Workspace…** in the **Starlings** menu or the menu bar item on the Mac. On iPhone, tap the workspace name at the top of **Home** › **Add workspace**. On the web, open the workspace name at the top of the page › **Add workspace**.
2. Type the workspace address, for example `acme`. The field adds `.starlings.example`. You can also paste the workspace's full address or an invite link.
3. The workspace's name and mark appear when it is found, with the accounts that can sign in. **No workspace at that address** means the address is wrong. **This workspace needs a newer version of Starlings** means the app is older than the workspace allows: update the app, then add the workspace again.
4. Choose **Continue to sign in** and sign in. The app switches to the workspace and says **You're in** and its name.

If the sign-in is cancelled, the account is not invited, or the network is down, the sheet says so in red. Choose **Retry**. You stay in the workspace you were in.

## Switch

Pick the workspace in **Switch Workspace** in the Mac's app menu or menu bar item. On iPhone, tap the workspace name at the top of **Home**, or use **Workspaces** at the end of **Settings**. Each workspace shows its mark, its address and the account you are signed in with, or **Signed out**. Picking a signed-out workspace signs you in to it first. The Mac app reopens on it. You cannot switch during a call.

On the web, the workspace name at the top of the page lists the workspaces you opened from this browser. Picking one opens its own address. **Manage workspaces** opens **Settings** › **Workspaces**.

Open a room link from another workspace and the app names that workspace. Choose **Open in <name>** to switch to it and join.

## Sign out or remove

**Sign Out** signs you out of the workspace you are in and moves to the next workspace you are signed in to. The workspace stays on the list, so signing in again is one tap. When more than one workspace is signed in, you can also sign out of all of them: on the Mac, hold Option to see **Sign Out of All Workspaces**; on iPhone, **Sign out of all workspaces** sits under **Sign out**.

To sign out of another workspace, or remove it from this device, you do not need to switch to it. On the Mac, open **Settings** › **Account** › **Other workspaces**. On iPhone, open **Settings** › **Workspaces** and swipe left on the workspace, or touch and hold it. **Remove** signs you out of it and takes it off the list.

On the web, each workspace is its own address with its own sign-in. **Settings** › **Workspaces** › **Remove** takes a workspace off this browser's list.
