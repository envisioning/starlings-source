---
kind: reference
status: active
verified: 2026-11-05
summary: "Docs: the whole corpus, with a linked graph view; save links and articles from iOS, Mac and the browser; ⌘5; `/docs`"
surface: docs
capabilities: [owner-docs, owner-docs-graph]
owns: [Sources/DocsWindowController.swift, Sources/FloatingDocumentWindowController.swift, Sources/MacDocsViews.swift, Sources/DocsRailView.swift, Sources/DocsBrowser.swift, Sources/DocsDiagnostics.swift, Sources/DocsGraph.swift, iOS/MobileDocsView.swift, web/src/DocsPage.tsx, web/src/DocsShareDialog.tsx, web/src/DocsGraph.tsx, web/src/docs-graph-layout.ts, web/src/docs-graph-layout.test.ts, web/src/docs.ts, web/src/docs-list.tsx, web/src/FavoriteToggle.tsx, packages/contracts/src/docs-graph-config.json, fixtures/docs-graph.json, Tests/DocsGraphFixtureTests.swift, project.yml, web/src/SurfaceShell.tsx, web/src/SiteChrome.tsx]
---

# Docs

Every document written in the workspace or from Starlings, in one place.

Docs is the company's shared knowledge base, or **company second brain**:
standards, playbooks, research and working documents that people and authorized
agents can refer to. Link a document to the project or other subject it informs
so knowledge stays connected to work. The phrase describes its role; the area
and its controls are still named Docs.

## Where

| Client | Reach it |
| --- | --- |
| Mac | ⌘5 |
| iPhone and iPad | The Docs tab |
| Web | `/docs` |

On Mac, opening a document adds its title to the Docs tab, such as `Docs — Proposal`.

On iPhone and iPad, use **Save link** in the Docs tab, or from a subject's Documents view to file the link on that subject. The Links row lists saved links. A saved link keeps the URL, the page metadata and the article as text, under your notes. A paywalled page keeps only what it shows without a subscription, and says so. To save a page from your browser, with the article as you see it, see [Save a page from your browser](../howto/save-a-page-from-your-browser.md). A saved link is yours alone until you file it on a subject or share it; the web marks it **Only you**. A link saved from a subject's Documents view is filed from the start.

Docs comes with your sign-in. There is nothing to connect. If Docs cannot connect, the surface shows why and a **Connect Docs** button to try again.

## Shape

When signed out on web, the page shows a centered card with the Docs heading and one sign-in action.

The rail has Graph, Recent, Unfiled, one row per category, By project, By lead, Folders (the top-level folders) and Library (the mirrored writing). Each block folds, and the fold is remembered on that device; the order and the blocks that hide while empty are the same on Mac, iPhone, iPad and web. The list sits in the middle and the editor in the inspector. **Documents** on a subject in Work shows the same documents for that one subject.

Graph shows up to the 5,000 most recent accessible documents as nodes, with a line for each resolved wikilink. Folder colors and grouping are shared across Mac, iPhone, iPad and web; links pull related documents together within their folder groups. Toggle a folder to focus on the remaining groups. Select a node to open its document. The layout is live: it unfolds as the graph loads, links pull documents into place as document details arrive, and it comes to rest on its own. Drag a node to pull its linked documents along; point at one to light up its links and fade the rest. Titles appear as you zoom in, sooner for well-linked documents. The view follows Fit until you pan or zoom, and Fit hands it back. Zoom ranges from 25% to 400% of Fit on every surface.

Categories belong to the workspace. A new workspace has none. On the web, **Edit categories** at the top of the rail adds, renames, reorders and deletes them; deleting one leaves its documents uncategorized.

When Docs falls behind, the web page says **Not syncing** and names the parts that stopped.

Unfiled lists documents with no category and no project or lead that still sit in the default folder. The row shows only while there is something to file.

On the Mac, ⌘-click adds a row to the selection and ⇧-click selects a range. Drag documents onto a rail row to file them there: a folder moves them, a project or lead links them, a category sets it.

## Floating (Mac)

A document can open in its own small window. You can keep it in view and edit it while you work in other apps. A pinned window stays on top of every app and on every Space. An unpinned window is an ordinary window. When Starlings starts again, it reopens a floating document where it was. To put it away, close its window.

You edit a document in one place at a time. While it floats, the inspector on it offers **Bring to Front** instead of a second editor.

On the web, paste or drop a PNG, JPEG, WebP or GIF image of up to 10 MB into the text while you edit, and it uploads into the document. A document with two or more top-level headings shows an outline under its title; select a heading to jump to it. While you edit, the bar shows a word count.

## Editing (Mac)

While you edit on the Mac, ⌘B and ⌘I wrap the selection in bold or italic, and ⌘K makes it a link (a URL on the clipboard fills the address). Pasting a URL over selected text also makes a link. ⌘S saves without waiting, and ⌘F opens the find bar for the document. Return continues a list item or a quote; Return on an empty one ends it. Tab and ⇧Tab indent and outdent list items.

The outline button lists the document's headings, and a click scrolls to one; on a narrow bar it sits in ⋯. While you edit, the bar counts words.

Paste or drop an image into the text and it uploads into the document, written as `![caption](docs-image:<id>)` where the cursor is. A wikilink, `[[Title]]` or `[[Title|label]]`, opens that document in Docs when Docs knows it and reads muted when it does not. Typing `[[` suggests titles.

## Saving (Mac)

Edits save on their own a moment after you stop typing, and the bar says **Saving…** until they land. Every edit also goes to a draft on the Mac at once. Quitting saves every open document first; a save that does not land keeps its draft. The next time the document opens, the draft comes back with its title and category and the bar says **Restored unsaved changes.** If someone saved the document since, the two versions show side by side and you pick one. A document open in the Docs window and in Work at once is one editor, so the two never collide. Renaming or archiving a document from a list reaches its open editor and its window.

## Controls

| Control | Does | Shortcut |
| --- | --- | --- |
| New document… | A document in the open folder | ⇧⌘N |
| Save link | Saves an HTTPS URL with its page metadata and the article as text, under your notes | — |
| Edit / Done | A document opens to read. Edit shows its markdown; Done goes back to the formatted text. On the web and the Mac the markdown is styled as you type, in one pane at the reader's width, and Done returns to the place you were reading. An empty document opens to write | ⌘E; Esc leaves editing on Mac, iPhone and iPad |
| More | The ⋯ button. On Mac, iPhone and iPad: the document’s path, Send for Signature and Open in Browser | — |
| File | In a row's menu: Folder, Category, Project, Lead. A tick means the document is already filed there. Pick a ticked project or lead to take it off. On the Mac it applies to every selected row | — |
| Star / Unstar | Keeps a document or folder in Home's QUICK ACCESS list | document row menu or editor; folder row menu. A top-left star badge marks starred rows |
| Category | Sets the row's category | — |
| Add a project, lead or partner | Links the document to a subject. The folder is where the document is stored. The subject is what it is about | — |
| Show Right Sidebar / Hide Right Sidebar | Passage comments for the open document. On the web, one header control toggles a column on a wide window or a side sheet on a narrower one; it defaults to closed and remembers an open panel per surface | header on web |
| Copy link | The document's address | — |
| Share | On the web, in the document bar: share links, signature requests and who opened the document. On Envisioning it also has **Share on org.example**. A transcript cannot be shared | — |
| Create link | A share link for anyone with the link, or for one email, as Can comment or Read only | — |
| Revoke | Turns a share link off. It stays in the list as Revoked | — |
| Send for signature | Mails each signer their own link. With **Sign in order**, each signer gets theirs after the one before signs | — |
| Cancel request | Stops a signature request that is still waiting | — |
| Certificate | On a signature request: its audit certificate, in the Docs app | — |
| Move to… | In a row's menu or the document's menu on the web: pick a folder from the list; type to filter it | — |
| Rename… | In a row's menu: a new title for the document | — |
| Archive | In a row's menu or the document's menu: the document leaves every list; Docs keeps it | — |
| Bold / Italic / Link | While editing on the web: wraps the selection. Pasting a URL over words makes them a link. Typing `[[` offers document titles, and in the reader such a link opens that document | ⌘B / ⌘I / ⌘K, `[[` |
| Keep mine / Take theirs | Resolving a save that collided with another editor's. Take theirs asks first, because it replaces your text | — |
| Hide the rail and the list | The editor alone | — |
| Graph | Opens the Docs graph: documents as nodes, wikilinks as connections, folder groups as colors | — |
| Zoom in / Zoom out / Fit | Changes the graph scale or frames the visible nodes | scroll or pinch to zoom at the pointer on web; pinch to zoom on Mac, iPhone and iPad; drag the background to pan and a node to move it on every surface |
| Open in Floating Window | In a row's menu: the document in a window of its own (Mac) | — |
| Float Document | The document open in the inspector, in a window of its own (Mac) | ⇧⌘F |
| Keep on Top / Unpin from Top | The floating window's pin: above every app, or an ordinary window | — |
| Bring to Front | In the inspector, for a document that already floats | — |

Mirrored bodies (newsletters, reports, research) are read-only, with **Open source** to where they live.

## Row menus (web)

Every Docs row has a menu. Open it with the `…` on the row, a right-click, or ⇧F10. The `…` shows when the pointer is over the row or the row has focus; on a touch screen it is always there. A top-left star badge marks a starred document or folder; Star / Unstar stays in the row menu.

| Row | Menu |
| --- | --- |
| A document, in the list or a subject's Documents pane | Open, Open page (a saved link), Copy link / Rename…, Move to… / Archive / Star |
| The open document's menu | The same, without Open and Star |
| A rail view, project or lead | Open, Copy link |
| A folder | Open, Copy link / Star |

A mirrored document has no Rename…, Move to… or Archive. A saved link copies the page it points at. The web has no menu for more than one selected row yet.

## Leads to

The subject a document is about, in [work](work.md).
