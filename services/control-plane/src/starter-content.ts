// What provisioning seeds into a new workspace (docs/PROVISIONING.md
// "Starter content"): the workspace's own organisation (docs/ONBOARDING.md
// decision 11), one sample project filed under it, and a starter
// `/house/readme` in the workspace's Docs. scripts/provision-workspace.mjs
// writes them; the Worker reads the ids. Each workspace has its own D1, so a
// fixed id names the same row in every workspace and never collides.
//
// The copy went through the humanizer. It names no firm: the workspace edits it.

/** `organizations.id` of the workspace's own organisation, named as the workspace. */
export const WORKSPACE_ORGANIZATION_ID = 'f8ad8a6e-226b-4fe1-a08c-70e5f994cfe2';

/** `projects.id` of the sample project. The setup checklist's `project` step does not count it. */
export const SAMPLE_PROJECT_ID = '389f9f53-9d7d-4e5c-acd0-6530674d4b6a';

export const SAMPLE_PROJECT = {
  title: 'Sample project',
  description: 'This is a sample. A project collects the tasks, calls, notes and documents about one piece of work. Archive this one when you start your own.',
} as const;

/** The Docs folder of the house standards, and the page an agent opens first. */
export const HOUSE_FOLDER = '/house';
export const HOUSE_README_PATH = '/house/readme';

/** The /house documents the MCP instructions and the write_offer prompt may name, when they exist. */
export const HOUSE_DOCUMENTS = {
  readme: HOUSE_README_PATH,
  offerStyleGuide: '/house/offer-style-guide',
  voice: '/house/voice',
  humanizer: '/house/humanizer',
} as const;

export const STARTER_README = {
  title: 'House standards',
  body: `This page lists the standards for anything a person outside the team will read. Read it before you write one, then read the standard for the kind of document you are writing.

## Where each standard lives

| Kind of document | Standard |
| --- | --- |
| Offers and proposals | /house/offer-style-guide |
| Case studies | /house/case-studies |
| Website copy | /house/website |
| Anything else that goes outside | /house/voice |

A page in this list may not exist yet. Then there is no standard for that kind, and the rules below apply. To add a kind, add a row here and write its page in /house.

## Rules for every document

- Take names, prices and dates from the record. If you cannot find one, say so.
- Write short sentences in plain words.
- Make no claim the team cannot back up.
- Check the draft against its standard before you send it.

## Changing a standard

Anyone on the team can edit these pages. When you correct a draft, write the correction down as a rule in the right standard, so the next draft does not repeat it. Keep one rule per line.
`,
} as const;

// ---------------------------------------------------------------------------
// The seed statements. Plain SQL, so `wrangler d1 execute --command` runs them
// and the Worker tests run the same text against the migrations. Each one is
// safe to run again: a rerun or the backfill writes nothing that exists, and
// never undoes what an admin changed.

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * The workspace's own organisation, named as the workspace. A rerun does not
 * rename it (an admin may have), and does not bring it back after a merge
 * folded it into another organisation.
 */
export function workspaceOrganizationSQL(name: string, now: number): string {
  const id = sqlText(WORKSPACE_ORGANIZATION_ID);
  return `INSERT INTO organizations (id, name, created_at, updated_at)
SELECT ${id}, ${sqlText(name)}, ${Math.trunc(now)}, ${Math.trunc(now)}
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE id = ${id})
AND NOT EXISTS (SELECT 1 FROM record_merges WHERE entity = 'organizations' AND from_id = ${id});`;
}

/**
 * The sample project, filed under the workspace's organisation. A rerun
 * leaves an edited or archived sample as it is. With no organisation (merged
 * away) it is not written.
 */
export function sampleProjectSQL(now: number): string {
  const id = sqlText(SAMPLE_PROJECT_ID);
  const org = sqlText(WORKSPACE_ORGANIZATION_ID);
  return `INSERT INTO projects (id, organization_id, title, status, description, internal, created_at, updated_at)
SELECT ${id}, ${org}, ${sqlText(SAMPLE_PROJECT.title)}, 'Active', ${sqlText(SAMPLE_PROJECT.description)}, 1, ${Math.trunc(now)}, ${Math.trunc(now)}
WHERE EXISTS (SELECT 1 FROM organizations WHERE id = ${org})
AND NOT EXISTS (SELECT 1 FROM projects WHERE id = ${id});`;
}

/**
 * The starter readme, for the workspace's own Docs D1 (envisioning/docs
 * migration 0001: folders, documents, document_versions; FTS follows by
 * trigger). It writes the `/house` folder when missing, and the readme and
 * its first version only when no document holds the path, so a rerun never
 * overwrites an edited readme and leaves an archived one archived. `hash` is
 * the SHA-256 hex of the body's UTF-8 bytes and `bytes` their count, as Docs
 * stores them.
 */
export function houseReadmeSQL(ids: { folder: string; document: string; version: string }, hash: string, bytes: number): string {
  const path = sqlText(HOUSE_README_PATH);
  const document = sqlText(ids.document);
  const folder = `(SELECT id FROM folders WHERE path = ${sqlText(HOUSE_FOLDER)})`;
  const title = sqlText(STARTER_README.title);
  const body = sqlText(STARTER_README.body);
  return `INSERT INTO folders (id, parent_id, slug, path, title, depth, created_by)
VALUES (${sqlText(ids.folder)}, NULL, 'house', ${sqlText(HOUSE_FOLDER)}, 'House', 0, 'system')
ON CONFLICT (path) DO NOTHING;
INSERT INTO documents (id, folder_id, slug, path, title, kind, body_md, byte_size, content_hash, frontmatter, created_by, updated_by, updated_by_kind)
SELECT ${document}, ${folder}, 'readme', ${path}, ${title}, 'markdown', ${body}, ${Math.trunc(bytes)}, ${sqlText(hash)}, '{"status":"current"}', 'system', 'system', 'system'
WHERE NOT EXISTS (SELECT 1 FROM documents WHERE path = ${path});
INSERT INTO document_versions (id, document_id, version, title, body_md, content_hash, byte_size, author, author_kind, message)
SELECT ${sqlText(ids.version)}, ${document}, 1, ${title}, ${body}, ${sqlText(hash)}, ${Math.trunc(bytes)}, 'system', 'system', 'Starter readme, written by provisioning'
WHERE EXISTS (SELECT 1 FROM documents WHERE id = ${document})
ON CONFLICT (document_id, version) DO NOTHING;`;
}
