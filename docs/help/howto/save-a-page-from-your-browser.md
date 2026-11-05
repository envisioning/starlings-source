---
kind: howto
status: active
verified: 2026-10-11
summary: "Save any web page to Docs from your browser or from Safari on iPhone, article included"
capabilities: [owner-docs]
owns: [web/src/SavePage.tsx, web/src/page-capture.ts, iOSShare/ShareViewController.swift, iOSShare/ShareSheet.swift, iOSShare/PageCapture.js, iOS/ShareOutbox.swift]
---

# Save a page from your browser

A bookmarklet saves the page you are reading to Docs. It keeps the link, the article as text, and a note from you. It works in Chrome, Edge, Arc and Safari on a computer.

## Add the bookmarklet

1. On the web, open **Settings**. **Save from your browser** is in **Account**.
2. Show your bookmarks bar. Drag the **Save to <workspace>** button onto it.

Each workspace has its own button. If you belong to two workspaces, add both.

## Save a page

1. On the page, click **Save to <workspace>** in your bookmarks bar. A small window opens.
2. Change the title if you want, and add a note.
3. Click **Save**.

The save goes to **Links** in Docs. Only you can see it until you file it on a client or project.

If the window does not open, allow pop-ups for the page and click again.

## Save a page on iPhone or iPad

1. In Safari, tap **Share**, then **Starlings**. If it is not in the row, tap **More** and turn it on.
2. Change the title if you want, and add a note.
3. Tap **Save**.

The page waits on your phone until you next open Starlings, which then saves it to the workspace named under the note. Sign in to Starlings on the phone first.

## Pages behind a sign-in or a paywall

The bookmarklet and the iPhone share sheet send the page as your browser shows it. A page you can read because you are signed in or subscribed is saved whole.

A link saved another way (pasted on the Mac or iPhone, or saved by an agent) is read by Starlings, which is not signed in anywhere. A paywalled page then keeps only what it shows without a subscription, and the save says so. Save the same page again from your browser or Safari to replace that text with the whole article. Your notes stay.
