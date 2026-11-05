# `docsctl workset`

Use a workset when an agent or person needs to curate several native Docs notes
as one reviewable change. It exports clean Markdown bodies, remembers the exact
`content_hash` read for each note, and writes each changed body through the
existing hash-guarded document API. It does not send frontmatter, tags, or CRM
subjects back to Docs.

```bash
docsctl workset pull --prefix /strategy --dir ./docs-workset
# Edit the Markdown files under ./docs-workset.
docsctl workset status --dir ./docs-workset
docsctl workset push --dir ./docs-workset                 # preview unified diffs
docsctl workset push --dir ./docs-workset --apply \
  --message "Connect strategy notes"
docsctl workset audit --dir ./docs-workset
```

`--prefix` is required for `pull`; begin with a deliberate subtree such as
`/strategy` or `/method`. The workset includes active, editable native Markdown
documents. Mirrored pages, private link saves, and other link saves are skipped.
Each document is saved to a path-shaped `.md` file. `.docs-workset.json` stores
the Docs id and starting hash/version; `.docs-workset/baseline/` stores the body
used for diff and comparison. Keep both with the workset while editing.

`pull` protects local changes. It refreshes a tracked file only when that file
still matches its previous baseline. It stops before writing if a new export
would overwrite an unrelated local file. A missing, archived, or moved remote
note is retained in the workset instead of being silently removed.

`status` reports local edits and remote changes against the saved baseline.
`push` is preview-only unless `--apply` is present. The preview shows line
diffs. On apply, each changed note is sent with its saved `if_content_hash`;
the API rejects a stale write, and successful notes update the local baseline
immediately so a partially completed batch can resume safely. A missing local
file is never interpreted as a delete.

`audit` reports unresolved wikilinks, documents with no resolved incoming or
outgoing links, and the ten most-linked workset notes. It is a review aid: an
isolated note can still be valuable, and a resolved edge does not prove that
it is useful.

## Link curation rules

- Link when it helps answer the reader's likely next question: background,
  method, example, application, consequence, or a meaningful alternative.
- Write the relationship in the sentence. The graph stores a wikilink edge but
  does not type that edge, so prose such as “uses the method in …” carries the
  meaning for readers and agents.
- Prefer canonical absolute Docs paths, with a readable alias when useful:
  `[[/method/interviewing|interviewing method]]`. A slash-prefixed target
  resolves by exact path and avoids duplicate-title ambiguity.
- Add an inbound link when it makes the target easier to find from a natural
  starting point. Reciprocal links are not mandatory; do not add one just to
  make the graph look symmetric.
- Avoid linking every repeated phrase, duplicating a folder tree in prose, or
  appending a generic “related pages” list. A link should give a reader a useful
  next step.
- Review the preview and audit output together. Resolve broken targets, then
  inspect isolated notes and high-traffic hubs for actual navigation value.

The existing `docsctl pull` and `docsctl push` commands remain the byte-preserving
mirror workflow for source trees such as `/vault`. Use `workset` for curated
native Docs notes; the two formats have different metadata ownership.

This is a CLI change, not a Worker feature. From a Docs checkout, build it with
`pnpm build:cli` and run it as `node cli/dist/index.js ...` if the `docsctl`
binary on your machine has not been updated. The Worker deploy command does
not publish the CLI.
