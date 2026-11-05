// Folder tree. Materialized `path` plus `parent_id`, so a read is one indexed
// lookup and a rename is one UPDATE ... LIKE over the subtree.
//
// There is no ACL here. Everyone at Envisioning sees the whole tree; the
// sharing model lives in grants.ts. Keeping folders dumb is what makes it
// cheap to reorganize the company's knowledge later.

import { folderCreateSchema, joinPath, parentPath, segments, slugify, type FolderSummary } from '@docs/contracts';
import { uuid } from './crypto';
import { ConflictError, DocsError, NotFoundError } from './errors';

export interface FolderRow {
  id: string;
  parent_id: string | null;
  slug: string;
  path: string;
  title: string;
  depth: number;
  sort_order: number;
  icon: string | null;
  description: string | null;
  source_key: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export async function getFolderByPath(env: Env, path: string): Promise<FolderRow | null> {
  if (path === '/') return null;
  return env.DB.prepare(`SELECT * FROM folders WHERE path = ?`).bind(path).first<FolderRow>();
}

export async function getFolderById(env: Env, id: string): Promise<FolderRow | null> {
  return env.DB.prepare(`SELECT * FROM folders WHERE id = ?`).bind(id).first<FolderRow>();
}

/** Resolve stable folder ids to their current materialized paths. */
export async function favoriteFoldersByIds(env: Env, ids: string[], viewer: string): Promise<FolderSummary[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT f.*, (
       SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.status = 'active' AND (d.private_to IS NULL OR d.private_to = ?)
     ) AS document_count
       FROM folders f WHERE f.id IN (${placeholders})`,
  )
    .bind(viewer, ...ids)
    .all<FolderRow & { document_count: number }>();
  return results.map(toSummary);
}

export async function requireFolderByPath(env: Env, path: string): Promise<FolderRow> {
  const folder = await getFolderByPath(env, path);
  if (!folder) throw new NotFoundError(`No folder at ${path}.`);
  return folder;
}

/**
 * Create every missing folder along `path` and return the deepest one.
 * Idempotent — importers and mirror syncs call this on every document, so it
 * has to be cheap and safe to repeat.
 */
export async function ensureFolderPath(
  env: Env,
  path: string,
  options: { createdBy: string; sourceKey?: string | null; titles?: Record<string, string> } = { createdBy: 'system' },
): Promise<FolderRow | null> {
  if (path === '/' || path === '') return null;

  const parts = segments(path);
  let parentId: string | null = null;
  let current = '';
  let folder: FolderRow | null = null;

  for (const [index, part] of parts.entries()) {
    current = `${current}/${part}`;
    const existing = await getFolderByPath(env, current);
    if (existing) {
      parentId = existing.id;
      folder = existing;
      continue;
    }
    const id = uuid();
    const title = options.titles?.[current] ?? titleize(part);
    await env.DB.prepare(
      `INSERT INTO folders (id, parent_id, slug, path, title, depth, source_key, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (path) DO NOTHING`,
    )
      .bind(id, parentId, part, current, title, index, options.sourceKey ?? null, options.createdBy)
      .run();

    // ON CONFLICT means a concurrent writer may have won the race; re-read
    // rather than trusting the id we generated.
    const created = await getFolderByPath(env, current);
    if (!created) throw new DocsError(`Could not create folder ${current}.`, 500, 'internal');
    parentId = created.id;
    folder = created;
  }

  return folder;
}

/**
 * `viewer` is the reader's address in `private_to` form (documents.ts
 * `viewerKey`): a private save counts in its owner's folder only.
 */
export async function listFolders(env: Env, parentPathValue: string | null, viewer: string): Promise<FolderSummary[]> {
  const parent = parentPathValue && parentPathValue !== '/' ? await getFolderByPath(env, parentPathValue) : null;
  if (parentPathValue && parentPathValue !== '/' && !parent) throw new NotFoundError(`No folder at ${parentPathValue}.`);

  const statement = parent
    ? env.DB.prepare(
        `SELECT f.*, (
           SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.status = 'active' AND (d.private_to IS NULL OR d.private_to = ?)
         ) AS document_count
         FROM folders f WHERE f.parent_id = ? ORDER BY f.sort_order, f.title`,
      ).bind(viewer, parent.id)
    : env.DB.prepare(
        `SELECT f.*, (
           SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.status = 'active' AND (d.private_to IS NULL OR d.private_to = ?)
         ) AS document_count
         FROM folders f WHERE f.parent_id IS NULL ORDER BY f.sort_order, f.title`,
      ).bind(viewer);

  const { results } = await statement.all<FolderRow & { document_count: number }>();
  return results.map(toSummary);
}

/** The whole tree in one query — small enough to ship to the browser at once. */
export async function fullTree(env: Env, viewer: string): Promise<FolderSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT f.*, (
       SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.status = 'active' AND (d.private_to IS NULL OR d.private_to = ?)
     ) AS document_count
     FROM folders f ORDER BY f.path`,
  ).bind(viewer).all<FolderRow & { document_count: number }>();
  return results.map(toSummary);
}

export async function createFolder(
  env: Env,
  input: unknown,
  createdBy: string,
): Promise<FolderSummary> {
  const parsed = folderCreateSchema.parse(input);

  const explicit = parsed.path;
  const parent = explicit ? parentPath(explicit) : (parsed.parent_path ?? '/');
  const slug = explicit ? segments(explicit).at(-1)! : (parsed.slug ?? slugify(parsed.title));
  const path = explicit ?? joinPath(parent, slug);

  if (await getFolderByPath(env, path)) throw new ConflictError(`A folder already exists at ${path}.`);

  const parentFolder = parent === '/' ? null : await ensureFolderPath(env, parent, { createdBy });
  const id = uuid();

  await env.DB.prepare(
    `INSERT INTO folders (id, parent_id, slug, path, title, depth, sort_order, icon, description, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      parentFolder?.id ?? null,
      slug,
      path,
      parsed.title,
      segments(path).length - 1,
      parsed.sort_order,
      parsed.icon ?? null,
      parsed.description ?? null,
      createdBy,
    )
    .run();

  const created = await getFolderById(env, id);
  if (!created) throw new DocsError('Folder creation failed.', 500, 'internal');
  return toSummary({ ...created, document_count: 0 });
}

/**
 * Rename or move a folder, rewriting every descendant path.
 *
 * D1 has no transactions across statements, so this uses `batch`, which is
 * atomic. Order matters: descendants are rewritten from the old prefix, so the
 * folder's own row must be updated in the same batch, not before it.
 */
export async function moveFolder(
  env: Env,
  id: string,
  input: { parent_path?: string; slug?: string; title?: string; sort_order?: number },
): Promise<FolderSummary> {
  const folder = await getFolderById(env, id);
  if (!folder) throw new NotFoundError('No such folder.');

  const newSlug = input.slug ?? folder.slug;
  const newParentPath = input.parent_path ?? parentPath(folder.path);
  const newPath = joinPath(newParentPath, newSlug);

  if (newPath !== folder.path) {
    if (newPath === folder.path || newPath.startsWith(`${folder.path}/`)) {
      throw new ConflictError('A folder cannot be moved inside itself.');
    }
    if (await getFolderByPath(env, newPath)) throw new ConflictError(`A folder already exists at ${newPath}.`);
  }

  const parentFolder = newParentPath === '/' ? null : await ensureFolderPath(env, newParentPath, { createdBy: 'system' });
  const now = new Date().toISOString();
  const oldPrefix = `${folder.path}/`;
  const depthShift = segments(newPath).length - segments(folder.path).length;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE folders
          SET parent_id = ?, slug = ?, path = ?, title = ?, sort_order = ?,
              depth = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(
      parentFolder?.id ?? null,
      newSlug,
      newPath,
      input.title ?? folder.title,
      input.sort_order ?? folder.sort_order,
      segments(newPath).length - 1,
      now,
      id,
    ),
    env.DB.prepare(
      `UPDATE folders
          SET path = ? || substr(path, ?), depth = depth + ?, updated_at = ?
        WHERE path LIKE ? || '%'`,
    ).bind(`${newPath}/`, oldPrefix.length + 1, depthShift, now, oldPrefix),
    env.DB.prepare(
      `UPDATE documents
          SET path = ? || substr(path, ?), updated_at = ?
        WHERE path LIKE ? || '%'`,
    ).bind(`${newPath}/`, oldPrefix.length + 1, now, oldPrefix),
  ]);

  const updated = await getFolderById(env, id);
  if (!updated) throw new DocsError('Folder move failed.', 500, 'internal');
  return toSummary({ ...updated, document_count: 0 });
}

/** Refuses to delete anything non-empty — no recursive surprise. */
export async function deleteFolder(env: Env, id: string): Promise<void> {
  const folder = await getFolderById(env, id);
  if (!folder) throw new NotFoundError('No such folder.');

  const children = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM folders WHERE parent_id = ?) AS folders,
       (SELECT COUNT(*) FROM documents WHERE folder_id = ? AND status <> 'deleted') AS documents`,
  )
    .bind(id, id)
    .first<{ folders: number; documents: number }>();

  if ((children?.folders ?? 0) > 0 || (children?.documents ?? 0) > 0) {
    throw new ConflictError('Move or delete the contents first — this folder is not empty.');
  }

  await env.DB.prepare(`DELETE FROM folders WHERE id = ?`).bind(id).run();
}

function toSummary(row: FolderRow & { document_count?: number }): FolderSummary {
  return {
    id: row.id,
    path: row.path,
    slug: row.slug,
    title: row.title,
    parent_id: row.parent_id,
    depth: row.depth,
    icon: row.icon,
    description: row.description,
    source_key: row.source_key,
    document_count: row.document_count ?? 0,
  };
}

function titleize(slug: string): string {
  return slug
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}
