// Categories: what a document *is*, as rows a workspace owns (migration 0008).
//
// A new install has none. People add, rename, reorder and delete them; the
// id is a slug fixed at creation, so a rename never breaks `?category=<id>`.
// Deleting a category leaves its documents uncategorized (ON DELETE SET NULL).
//
// The transcript marker is not here. It lives in `documents.category` and
// `assertStaysInternal` reads it, so no edit to this table can share a
// transcript.

import {
  categoryCreateSchema,
  categoryOrderSchema,
  categoryUpdateSchema,
  slugify,
  type Category,
} from '@docs/contracts';
import { ConflictError, DocsError, NotFoundError } from './errors';
import { VISIBLE_CLAUSE, viewerKey, type Viewer } from './documents';

export interface CategoryRow {
  id: string;
  label: string;
  position: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/** Every category, in rail order, each with the active documents the reader can see. */
export async function listCategories(env: Env, viewer: Viewer): Promise<Category[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.label, c.position,
            (SELECT COUNT(*) FROM documents d
              WHERE d.category_id = c.id AND d.status = 'active' AND ${VISIBLE_CLAUSE}) AS count
       FROM categories c
      ORDER BY c.position, lower(c.label)`,
  )
    .bind(viewerKey(viewer))
    .all<Category>();
  return results;
}

export async function getCategory(env: Env, id: string): Promise<CategoryRow | null> {
  return env.DB.prepare(`SELECT * FROM categories WHERE id = ?`).bind(id).first<CategoryRow>();
}

/**
 * The category a write names, checked. Absent stays absent and `null`
 * clears. An id with no row is refused rather than dropped, so a client with
 * a stale list learns it.
 */
export async function resolveCategoryId(env: Env, id: string | null | undefined): Promise<string | null | undefined> {
  if (id === undefined || id === null) return id;
  if (await getCategory(env, id)) return id;
  throw new DocsError(`No category "${id}". Create it first, or pick another.`, 400, 'invalid_request');
}

export async function createCategory(env: Env, input: unknown, actor: string, viewer: Viewer): Promise<Category> {
  const parsed = categoryCreateSchema.parse(input);
  await assertLabelFree(env, parsed.label, null);
  let id = parsed.id;
  if (id) {
    if (await getCategory(env, id)) throw new ConflictError(`A category with the id "${id}" exists.`);
  } else {
    // A label in another script slugs to `untitled`; number the clash
    // rather than refuse it, since the person only typed a name.
    const base = slugify(parsed.label).slice(0, 56).replace(/-+$/u, '');
    id = base;
    for (let n = 2; await getCategory(env, id); n += 1) id = `${base}-${n}`;
  }
  const position =
    parsed.position ??
    ((await env.DB.prepare(`SELECT COALESCE(MAX(position) + 1, 0) AS n FROM categories`).first<{ n: number }>())?.n ?? 0);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO categories (id, label, position, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, parsed.label, position, now, now, actor)
    .run();
  return requireListed(env, id, viewer);
}

export async function updateCategory(env: Env, id: string, input: unknown, viewer: Viewer): Promise<Category> {
  const parsed = categoryUpdateSchema.parse(input);
  if (!(await getCategory(env, id))) throw new NotFoundError('No such category.');
  if (parsed.label !== undefined) await assertLabelFree(env, parsed.label, id);
  await env.DB.prepare(
    `UPDATE categories
        SET label = COALESCE(?, label), position = COALESCE(?, position), updated_at = ?
      WHERE id = ?`,
  )
    .bind(parsed.label ?? null, parsed.position ?? null, new Date().toISOString(), id)
    .run();
  return requireListed(env, id, viewer);
}

/** Every id, in the order given. An id left out keeps its place after them. */
export async function orderCategories(env: Env, input: unknown, viewer: Viewer): Promise<Category[]> {
  const { ids } = categoryOrderSchema.parse(input);
  if (new Set(ids).size !== ids.length) throw new DocsError('An id appears twice.', 400, 'invalid_request');
  const now = new Date().toISOString();
  const statements = ids.map((id, index) =>
    env.DB.prepare(`UPDATE categories SET position = ?, updated_at = ? WHERE id = ?`).bind(index, now, id),
  );
  statements.push(
    env.DB.prepare(
      `UPDATE categories SET position = position + ? WHERE id NOT IN (SELECT value FROM json_each(?))`,
    ).bind(ids.length, JSON.stringify(ids)),
  );
  await env.DB.batch(statements);
  return listCategories(env, viewer);
}

/** Documents in it become uncategorized; nothing else about them changes. */
export async function deleteCategory(env: Env, id: string): Promise<void> {
  const result = await env.DB.prepare(`DELETE FROM categories WHERE id = ?`).bind(id).run();
  if (!result.meta.changes) throw new NotFoundError('No such category.');
}

async function assertLabelFree(env: Env, label: string, except: string | null): Promise<void> {
  const clash = await env.DB.prepare(`SELECT id FROM categories WHERE lower(label) = lower(?) AND id IS NOT ?`)
    .bind(label, except)
    .first<{ id: string }>();
  if (clash) throw new ConflictError(`A category named "${label}" exists.`);
}

async function requireListed(env: Env, id: string, viewer: Viewer): Promise<Category> {
  const category = (await listCategories(env, viewer)).find((row) => row.id === id);
  if (!category) throw new DocsError('Category write failed.', 500, 'internal');
  return category;
}
