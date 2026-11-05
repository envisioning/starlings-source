# Envisioning Docs

`docs.workers.org.example` — everything Envisioning knows, in one place,
writable by people and by agents, shareable with people who have no account.

The premise: it is easier to rebuild the parts of Obsidian we actually use on top
of our own data than to make Obsidian work as company infrastructure. So the
database is the source of truth, the vault becomes a mirror, and every agent gets
a real API instead of a folder on someone's laptop.

## What it does

**One corpus.** Obsidian vaults, Core's newsletter archive, reports, research
pages, methodology chapters, signals briefs, FAQs and CRM notes all live in the
same table, in the same folder tree, behind the same search. A 2019 newsletter
issue is as findable, linkable and annotatable as a proposal drafted this
morning.

**What a document is about.** A document lives at a path, and is *about*
zero or more CRM subjects — an organization, a contact, an offer, a lead, a
project. `?subject=core:organization:<id>` answers "everything about Acme"
whatever shelf the file sits on. Meet writes documents this way from the
subject page.

**Two kinds of document.** *Native* documents are born here and are editable.
*Mirrored* documents are projections of Core rows — the body stays authoritative
upstream and is read-only here, but comments, tags, share links and signatures
attach to them exactly as they do to anything else.

**Three kinds of caller.**

| | Who | How | Reach |
| --- | --- | --- | --- |
| staff | verified `@org.example` Google account | session cookie | everything |
| guest | anyone holding a share link | states an email, sometimes proves it | exactly what the link names |
| agent | a token belonging to a staff member | `Bearer evd_…` | its scopes, optionally one subtree |

Everyone at Envisioning reads and writes everything. That is a decision, not an
oversight — per-folder permissions are the thing that makes internal wikis rot.

**Annotation and signature.** Select a passage and comment on it; anchors are
stored as quotes with context, so an edit orphans a comment visibly instead of
silently moving it onto unrelated text. Upload a PDF and send it for signature:
each signer gets their own link, proves their email with a mailed code, and signs
a specific `content_hash`. The result is an append-only, HMAC-sealed record and a
human-readable audit certificate.

## Using it

### The web app

Staff read, write, share and send for signature in the workspace's Meet
`/docs`; this app's staff pages redirect there. It keeps the pages a guest
opens from a share link, signing, signature certificates, and `/tokens`.

### The CLI

```bash
docsctl login                          # store a token and a mirror directory
docsctl search "packaging foresight"
docsctl cat /published/newsletter/143-this-is-fine
echo "# Finding" | docsctl new /agents/hermes/finding-1 --title "Finding 1"

docsctl import ~/Envisioning --prefix /vault    # repeatable, hash-based
docsctl status                                  # what differs, local vs remote
docsctl pull                                    # remote → local mirror
docsctl push                                    # local → remote, reporting conflicts

docsctl workset pull --prefix /strategy --dir ./docs-workset
docsctl workset push --dir ./docs-workset       # preview; --apply writes
docsctl workset audit --dir ./docs-workset      # unresolved and isolated links
```

`import` and `push` are idempotent: unchanged files are recognized by content
hash and skipped, so re-running over an unchanged vault writes nothing. Open the
mirror directory in Obsidian if you like — the database still wins.

Use [`docsctl workset`](cli/README.md) for bulk edits to curated native notes.
It keeps a checkout-time hash per note, previews diffs, and applies body-only
writes with optimistic concurrency. It does not need a Worker deployment.

### For agents

Mint a token in the app with the scopes it needs, and optionally confine it to a
subtree:

```bash
export DOCS_TOKEN=evd_…
curl -H "authorization: Bearer $DOCS_TOKEN" \
     "https://docs.workers.org.example/api/search?q=xenotech"
```

Scopes: `docs:read` `docs:write` `folders:write` `annotations:read`
`annotations:write` `grants:write` `sign:manage` `sync:write`.

A token confined to `/agents/hermes` can write there and nowhere else. Every
write is attributed to the owning person *and* the agent name, and lands in the
version history with a message — so "who wrote this and why" survives.

Writes take `if_content_hash`. Send the hash you read, and a concurrent edit
comes back as `hash_mismatch` instead of quietly losing a paragraph.

## How it is built

Cloudflare Workers, following the pattern `meet.org.example` already
established: one Worker, Google OAuth to an HS256 session, a Vite SPA served
from the `ASSETS` binding.

That includes the hosting arrangement. org.example's DNS lives at Gandi, so
the app is served on `docs.workers.org.example`. That host is the real
origin — cookies, the OAuth redirect, and share links all use it. The vanity
name `docs.org.example` has no DNS record and does not resolve; a Gandi web
forward would give it one, the way `meet.org.example` has.

- **D1** — documents, folders, versions, links, tags, grants, annotations,
  signatures, audit trail. FTS5 for search, fed by triggers.
- **R2** — PDFs and drawn signature images.
- **Postmark** — verification codes and signature invitations.

`contracts` is the single wire contract: the Worker parses with those
zod schemas, and the SPA and CLI type against those interfaces.

See [AGENTS.md](AGENTS.md) for commands, invariants and traps.

## Status

The vertical slice is complete and tested: auth for all three principals, folder
and document CRUD with versioning, full-text search, the wikilink graph,
annotations, share links with email gating, PDF upload, the signature flow with
sealed audit certificates, the CLI, and the Core mirror.

PDFs are extracted on upload, so a signed contract is findable by its contents
— parsing runs off the request path, and a scanned or encrypted PDF stores
normally rather than failing.

See [BACKLOG.md](BACKLOG.md) for what is next and what is only half-built. The
short version: semantic search is the next real feature; reorganizing files has
an API but no UI; and `public` visibility is currently dead code.
