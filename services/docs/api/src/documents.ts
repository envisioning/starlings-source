// Documents: create, read, write, version, link, search.
//
// Two rules run through all of it:
//
//   1. `content_hash` is the hash of exactly what is stored. Signatures and
//      optimistic concurrency both hang off it, so it is computed on write and
//      never re-derived from a re-serialization on read.
//   2. Mirrored documents (`editable = 0`) reject body writes from people and
//      agents, but accept them from the ingest path. That is the only
//      asymmetry — everything else treats a 2019 newsletter issue exactly like
//      a proposal drafted this morning.

import {
  documentCreateSchema,
  documentUpdateSchema,
  joinPath,
  listQuerySchema,
  parentPath,
  searchQuerySchema,
  segments,
  slugify,
  sourceSystemSchema,
  subjectRef,
  subjectsSchema,
  LINK_SOURCE_KIND,
  TRANSCRIPT_MARKER,
  type DocsSummary,
  type DocumentCreateInput,
  type DocumentDetail,
  type DocumentKind,
  type DocumentSubject,
  type DocumentSummary,
  type LinkFetchStatus,
  type LinkSave,
  type NativeSourceKind,
  type SearchHit,
  type SourceKind,
  type SourceSystem,
  type Visibility,
} from '@docs/contracts';
import { listCategories, resolveCategoryId } from './categories';
import { sha256Hex, uuid } from './crypto';
import { ConflictError, DocsError, NotFoundError } from './errors';
import { ensureFolderPath, getFolderById, getFolderByPath } from './folders';
import { listImages } from './images';
import { excerpt, extractTags, extractWikilinks, toMatchQuery } from './markdown';

export interface DocumentRow {
  id: string;
  folder_id: string | null;
  slug: string;
  path: string;
  title: string;
  kind: DocumentKind;
  body_md: string | null;
  r2_key: string | null;
  extracted_text: string | null;
  byte_size: number;
  content_hash: string;
  frontmatter: string;
  /**
   * The transcript marker, and nothing else since migration 0008: 'transcript'
   * keeps the row staff-only. The category a person picks is `category_id`.
   */
  category: typeof TRANSCRIPT_MARKER | null;
  category_id: string | null;
  status: 'active' | 'archived' | 'deleted';
  visibility: Visibility;
  source_system: SourceSystem;
  source_kind: SourceKind | NativeSourceKind | null;
  source_id: string | null;
  source_url: string | null;
  source_hash: string | null;
  source_synced_at: string | null;
  editable: number;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  updated_by_kind: 'human' | 'agent' | 'system';
  /** The one address that may read the row; NULL for everyone (migration 0007). */
  private_to: string | null;
}

export interface Writer {
  actor: string;
  kind: 'human' | 'agent' | 'system';
  agentName?: string | null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Who is reading, for the owner-private rule. A staff member or an
 * agent reads as a person's address; `null` is a guest or a system caller,
 * who never owns a private row.
 */
export type Viewer = string | null;

/** The viewer's address as `private_to` stores it. */
export function viewerKey(viewer: Viewer): string {
  return viewer?.trim().toLowerCase() ?? '';
}

/**
 * The owner-private rule as a WHERE fragment over `documents d`, with one
 * bind (`viewerKey`): a row is visible when it is not private, or private to
 * this viewer. Every collection read carries it — list, counts, search, the
 * tree, the sync manifest. A single row goes through `canView`.
 */
export const VISIBLE_CLAUSE = '(d.private_to IS NULL OR d.private_to = ?)';

export function canView(row: Pick<DocumentRow, 'private_to'>, viewer: Viewer): boolean {
  return row.private_to === null || row.private_to === viewerKey(viewer);
}

export async function getDocumentById(env: Env, id: string): Promise<DocumentRow | null> {
  return env.DB.prepare(`SELECT * FROM documents WHERE id = ?`).bind(id).first<DocumentRow>();
}

export type FavoriteDocumentAccessRow = Pick<DocumentRow, 'id' | 'path' | 'title' | 'kind' | 'category' | 'status' | 'visibility' | 'private_to'>;

/** Read stable Docs ids in bounded queries; callers apply the normal read gate before returning them. */
export async function favoriteDocumentsByIds(env: Env, ids: string[]): Promise<FavoriteDocumentAccessRow[]> {
  const documents: FavoriteDocumentAccessRow[] = [];
  for (const chunk of chunks(ids)) {
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, path, title, kind, category, status, visibility, private_to
         FROM documents WHERE id IN (${placeholders}) AND status <> 'deleted'`,
    )
      .bind(...chunk)
      .all<FavoriteDocumentAccessRow>();
    documents.push(...results);
  }
  return documents;
}

export async function getDocumentByPath(env: Env, path: string): Promise<DocumentRow | null> {
  return env.DB.prepare(`SELECT * FROM documents WHERE path = ?`).bind(path).first<DocumentRow>();
}

/**
 * The document behind a the share reader's `/private/docs/<uuid>` link. The
 * uuid is either a Docs id or, for a note adopted from Core, the note's old
 * id (`source_id`), so links mailed out before the adoption keep resolving.
 * Only `link` and `public` rows answer; an `internal` one is "no such
 * document", the same as a missing id, so uuids cannot be probed.
 */
export async function getLinkReadableDocument(env: Env, id: string): Promise<DocumentRow | null> {
  return env.DB.prepare(
    `SELECT * FROM documents
      WHERE status = 'active' AND visibility IN ('link', 'public') AND private_to IS NULL
        AND COALESCE(category, '') <> 'transcript'
        AND (id = ? OR (source_system = 'core' AND source_kind = 'note' AND source_id = ?))
      LIMIT 1`,
  )
    .bind(id, id)
    .first<DocumentRow>();
}

/**
 * A transcript is people's own words — guests', clients', a colleague's
 * aside — and it is staff-only, full stop: never `link`, never `public`, never
 * behind a grant. The rule lives here so create, update and the share routes
 * cannot disagree about it.
 */
export function assertStaysInternal(marker: string | null | undefined, visibility: string | null | undefined): void {
  if (marker === TRANSCRIPT_MARKER && visibility && visibility !== 'internal') {
    throw new DocsError('A transcript cannot be shared: it stays internal.', 400, 'invalid_request');
  }
}

/**
 * What a write's `category` means. `'transcript'` is the marker an older
 * caller sends (Meet files transcripts that way); it also files the document
 * in a category with that id when the workspace has one. Anything else is a
 * category id that must exist.
 */
async function categoryWrite(
  env: Env,
  value: string | null | undefined,
  transcript: boolean | undefined,
): Promise<{ marker: typeof TRANSCRIPT_MARKER | null; id: string | null | undefined }> {
  if (value === TRANSCRIPT_MARKER) {
    const row = await env.DB.prepare(`SELECT id FROM categories WHERE id = ?`).bind(value).first<{ id: string }>();
    return { marker: TRANSCRIPT_MARKER, id: row ? row.id : undefined };
  }
  return { marker: transcript ? TRANSCRIPT_MARKER : null, id: await resolveCategoryId(env, value) };
}

/** Accepts a UUID or a `/slash/path`, because both are ergonomic in a CLI. */
export async function resolveDocument(env: Env, reference: string): Promise<DocumentRow> {
  const document = reference.startsWith('/')
    ? await getDocumentByPath(env, reference)
    : await getDocumentById(env, reference);
  if (!document || document.status === 'deleted') throw new NotFoundError('No such document.');
  return document;
}

/**
 * What "unfiled" means, as a WHERE fragment over `documents d`
 * with one bind, the link-save kind: native, not a link save, no category,
 * no subject, and directly in `/` or `/work` — the folders a document lands
 * in when nobody chose one. Shared by the list and the summary.
 */
const UNFILED_CLAUSE = `d.source_system = 'native'
  AND COALESCE(d.source_kind, '') != ?
  AND d.category_id IS NULL
  AND d.category IS NULL
  AND NOT EXISTS (SELECT 1 FROM document_subjects s WHERE s.document_id = d.id)
  AND (d.path NOT LIKE '/%/%' OR (d.path LIKE '/work/%' AND d.path NOT LIKE '/work/%/%'))`;

export async function listDocuments(env: Env, query: unknown, viewer: Viewer): Promise<{ documents: DocumentSummary[]; total: number }> {
  const parsed = listQuerySchema.parse(query);

  const where: string[] = ['d.status = ?', VISIBLE_CLAUSE];
  const binds: unknown[] = [parsed.status, viewerKey(viewer)];

  if (parsed.folder) {
    const folder = await getFolderByPath(env, parsed.folder);
    if (!folder) return { documents: [], total: 0 };
    where.push('d.folder_id = ?');
    binds.push(folder.id);
  }
  if (parsed.prefix) {
    where.push("(d.path = ? OR d.path LIKE ? || '/%')");
    binds.push(parsed.prefix, parsed.prefix);
  }
  if (parsed.source) {
    where.push(`d.source_system IN (${parsed.source.map(() => '?').join(', ')})`);
    binds.push(...parsed.source);
  }
  if (parsed.source_kind) {
    where.push('d.source_kind = ?');
    binds.push(parsed.source_kind);
  }
  if (parsed.kind) {
    where.push('d.kind = ?');
    binds.push(parsed.kind);
  }
  if (parsed.updated_since) {
    where.push('d.updated_at > ?');
    binds.push(parsed.updated_since);
  }
  if (parsed.tag) {
    where.push('EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id = d.id AND t.tag = ?)');
    binds.push(parsed.tag);
  }
  if (parsed.category) {
    where.push('d.category_id = ?');
    binds.push(parsed.category);
  }
  if (parsed.has_source !== undefined) {
    // `json_extract` rather than LIKE on the blob: a document whose *body*
    // mentions `source:` is not a document that has one.
    where.push("json_extract(d.frontmatter, '$.source') IS NOT NULL");
    if (parsed.has_source) {
      where.push("json_extract(d.frontmatter, '$.source') LIKE ? || '%'");
      binds.push(parsed.has_source);
    }
  }
  if (parsed.unfiled) {
    where.push(`(${UNFILED_CLAUSE})`);
    binds.push(LINK_SOURCE_KIND);
  }
  if (parsed.open_annotations) {
    where.push("EXISTS (SELECT 1 FROM annotations a WHERE a.document_id = d.id AND a.status = 'open' AND a.deleted_at IS NULL)");
  }
  if (parsed.subject) {
    where.push(
      'EXISTS (SELECT 1 FROM document_subjects s WHERE s.document_id = d.id AND s.system = ? AND s.kind = ? AND s.subject_id = ?)',
    );
    binds.push(parsed.subject.system, parsed.subject.kind, parsed.subject.subject_id);
  }

  const clause = where.join(' AND ');
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM documents d WHERE ${clause}`)
    .bind(...binds)
    .first<{ n: number }>();

  const { results } = await env.DB.prepare(
    `SELECT d.* FROM documents d
      WHERE ${clause}
      ORDER BY d.updated_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(...binds, parsed.limit, parsed.offset)
    .all<DocumentRow>();

  const documents = await withRelations(env, results);
  return { documents, total: total?.n ?? 0 };
}

/** One request for a sidebar: how many of each category, how many under each shelf. */
export async function summary(env: Env, viewer: Viewer): Promise<DocsSummary> {
  const key = viewerKey(viewer);
  const [bySource, categories, byFolder, total, links, unfiled] = await Promise.all([
    env.DB.prepare(
      `SELECT d.source_system, c.id AS category, c.label, COUNT(*) AS n
         FROM documents d JOIN categories c ON c.id = d.category_id
        WHERE d.status = 'active' AND ${VISIBLE_CLAUSE}
        GROUP BY d.source_system, c.id
        ORDER BY c.position, lower(c.label)`,
    ).bind(key).all<{ source_system: SourceSystem; category: string; label: string; n: number }>(),
    listCategories(env, viewer),
    env.DB.prepare(
      `SELECT f.path, f.title, COUNT(d.id) AS n
         FROM folders f
         LEFT JOIN documents d ON d.status = 'active' AND ${VISIBLE_CLAUSE}
                              AND (d.path = f.path OR d.path LIKE f.path || '/%')
        WHERE f.depth = 0
        GROUP BY f.id ORDER BY f.sort_order, f.title`,
    ).bind(key).all<{ path: string; title: string; n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM documents d WHERE d.status = 'active' AND ${VISIBLE_CLAUSE}`)
      .bind(key)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM documents d
        WHERE d.status = 'active' AND d.source_system = 'native' AND d.source_kind = ? AND ${VISIBLE_CLAUSE}`,
    )
      .bind(LINK_SOURCE_KIND, key)
      .first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM documents d WHERE d.status = 'active' AND ${UNFILED_CLAUSE} AND ${VISIBLE_CLAUSE}`)
      .bind(LINK_SOURCE_KIND, key)
      .first<{ n: number }>(),
  ]);
  // Category order (the rows arrive in it), then source order within it:
  // stable for a rail to walk.
  const sourceRank = new Map(sourceSystemSchema.options.map((source, index) => [source, index]));
  const categoryRank = new Map(categories.map((category, index) => [category.id, index]));
  const bySourceRows = bySource.results
    .map((row) => ({ source: row.source_system, category: row.category, label: row.label, count: row.n }))
    .sort((a, b) => {
      const byCategory = (categoryRank.get(a.category) ?? 0) - (categoryRank.get(b.category) ?? 0);
      return byCategory !== 0 ? byCategory : (sourceRank.get(a.source) ?? 0) - (sourceRank.get(b.source) ?? 0);
    });
  return {
    // Every category, an empty one too: a person who just made one expects to see it.
    categories: categories.map((category) => ({ category: category.id, label: category.label, count: category.count })),
    by_source: bySourceRows,
    folders: byFolder.results.map((row) => ({ path: row.path, title: row.title, count: row.n })),
    links: links?.n ?? 0,
    unfiled: unfiled?.n ?? 0,
    total: total?.n ?? 0,
  };
}

export async function getDocumentDetail(env: Env, row: DocumentRow): Promise<DocumentDetail> {
  const [tags, subjects, linkSaves, images, links, backlinks, open] = await Promise.all([
    tagsFor(env, [row.id]),
    subjectsFor(env, [row.id]),
    linkSavesFor(env, [row]),
    listImages(env, row.id),
    env.DB.prepare(
      // A private save is nobody else's link target or backlink: it is
      // named on another document's page to nobody.
      `SELECT l.target_text,
              CASE WHEN d.private_to IS NULL THEN l.to_id END AS to_id,
              CASE WHEN d.private_to IS NULL THEN d.path END AS to_path
         FROM document_links l
         LEFT JOIN documents d ON d.id = l.to_id
        WHERE l.from_id = ?`,
    )
      .bind(row.id)
      .all<{ target_text: string; to_id: string | null; to_path: string | null }>(),
    env.DB.prepare(
      `SELECT d.id, d.path, d.title
         FROM document_links l
         JOIN documents d ON d.id = l.from_id
        WHERE l.to_id = ? AND d.status = 'active' AND d.private_to IS NULL
        ORDER BY d.title
        LIMIT 200`,
    )
      .bind(row.id)
      .all<{ id: string; path: string; title: string }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM annotations
        WHERE document_id = ? AND status = 'open' AND deleted_at IS NULL`,
    )
      .bind(row.id)
      .first<{ n: number }>(),
  ]);

  return {
    ...toSummary(row, tags.get(row.id) ?? [], subjects.get(row.id) ?? [], linkSaves.get(row.id)),
    body_md: row.body_md,
    frontmatter: safeJSON(row.frontmatter),
    links: links.results.map((link) => ({
      target: link.target_text,
      to_id: link.to_id,
      to_path: link.to_path,
    })),
    backlinks: backlinks.results,
    open_annotations: open?.n ?? 0,
    images,
  };
}

export async function search(env: Env, query: unknown, viewer: Viewer): Promise<SearchHit[]> {
  const parsed = searchQuerySchema.parse(query);
  const match = toMatchQuery(parsed.q);
  if (!match) return [];

  const where: string[] = ["d.status = 'active'", VISIBLE_CLAUSE];
  const binds: unknown[] = [match, viewerKey(viewer)];
  if (parsed.prefix) {
    where.push("(d.path = ? OR d.path LIKE ? || '/%')");
    binds.push(parsed.prefix, parsed.prefix);
  }
  if (parsed.source) {
    where.push(`d.source_system IN (${parsed.source.map(() => '?').join(', ')})`);
    binds.push(...parsed.source);
  }
  if (parsed.source_kind) {
    where.push('d.source_kind = ?');
    binds.push(parsed.source_kind);
  }

  const { results } = await env.DB.prepare(
    `SELECT d.id, d.path, d.title, d.kind, d.source_system, d.source_kind, d.updated_at,
            snippet(documents_fts, 1, '<mark>', '</mark>', '…', 24) AS snippet,
            bm25(documents_fts, 8.0, 1.0, 2.0) AS rank
       FROM documents_fts
       JOIN documents d ON d.id = documents_fts.document_id
      WHERE documents_fts MATCH ?
        AND ${where.join(' AND ')}
      ORDER BY rank
      LIMIT ?`,
  )
    .bind(...binds, parsed.limit)
    .all<SearchHit>();

  return results;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createDocument(env: Env, input: unknown, writer: Writer): Promise<DocumentDetail> {
  const parsed = documentCreateSchema.parse(input);
  if (parsed.url) throw new DocsError('A link save goes through saveLink.', 500, 'internal');
  return insertDocument(env, { ...parsed, title: parsed.title! }, writer);
}

/**
 * The write behind every native create. `source` is set only by callers
 * inside the Worker (a link save marks its row); the wire cannot reach it.
 */
export async function insertDocument(
  env: Env,
  parsed: DocumentCreateInput & { title: string },
  writer: Writer,
  source: { kind: NativeSourceKind; url: string } | null = null,
): Promise<DocumentDetail> {
  const explicit = parsed.path;
  const folderPath = explicit ? parentPath(explicit) : (parsed.folder_path ?? '/');
  const slug = explicit ? segments(explicit).at(-1)! : (parsed.slug ?? slugify(parsed.title));
  const path = explicit ?? joinPath(folderPath, slug);

  if (await getDocumentByPath(env, path)) throw new ConflictError(`A document already exists at ${path}.`);
  const category = await categoryWrite(env, parsed.category, parsed.transcript);
  assertStaysInternal(category.marker, parsed.visibility);

  const folder = await ensureFolderPath(env, folderPath, { createdBy: writer.actor });
  const body = parsed.body_md ?? '';
  const hash = await sha256Hex(body);
  const id = uuid();
  // A caller may give the document its own date — a transcript belongs to the
  // day of the meeting, not to the afternoon the import ran.
  const now = parsed.created_at ? new Date(parsed.created_at).toISOString() : new Date().toISOString();
  const frontmatter = projectSubjects(parsed.frontmatter, parsed.subjects);

  await env.DB.prepare(
    `INSERT INTO documents
       (id, folder_id, slug, path, title, kind, body_md, byte_size, content_hash,
        frontmatter, visibility, category, category_id, source_kind, source_url,
        created_at, updated_at, created_by, updated_by, updated_by_kind, private_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      folder?.id ?? null,
      slug,
      path,
      parsed.title,
      parsed.kind,
      parsed.kind === 'markdown' ? body : null,
      byteLength(body),
      hash,
      JSON.stringify(frontmatter),
      parsed.visibility,
      category.marker,
      category.id ?? null,
      source?.kind ?? null,
      source?.url ?? null,
      now,
      now,
      writer.actor,
      writer.actor,
      writer.kind,
      // A loose link save is its author's. One saved on a subject
      // is filed from birth, and an internal row like any other.
      source?.kind === LINK_SOURCE_KIND && parsed.subjects.length === 0 ? viewerKey(writer.actor) : null,
    )
    .run();

  await recordVersion(env, { id, version: 1, title: parsed.title, body, hash, writer, message: parsed.message });
  if (parsed.subjects.length) await writeSubjects(env, id, parsed.subjects);
  await syncDerived(env, id, body, parsed.tags, frontmatter);
  // A new document can satisfy links written against its name before it
  // existed — the vault is full of those, and they must bind on arrival.
  await resolveLinksTo(env, parsed.title);

  const row = await getDocumentById(env, id);
  if (!row) throw new DocsError('Document creation failed.', 500, 'internal');
  return getDocumentDetail(env, row);
}

export async function updateDocument(
  env: Env,
  row: DocumentRow,
  input: unknown,
  writer: Writer,
): Promise<DocumentDetail> {
  const parsed = documentUpdateSchema.parse(input);
  const touchesBody = parsed.body_md !== undefined;

  if (touchesBody && !row.editable) {
    throw new DocsError(
      `This document mirrors ${row.source_system}${row.source_kind ? `/${row.source_kind}` : ''} — edit it at the source.`,
      409,
      'read_only',
    );
  }
  if (touchesBody && row.kind !== 'markdown') {
    throw new DocsError('Only markdown documents have an editable body.', 409, 'read_only');
  }
  if (parsed.if_content_hash && parsed.if_content_hash !== row.content_hash) {
    throw new ConflictError(
      'The document changed since you read it. Re-read, merge, and write again.',
      'hash_mismatch',
    );
  }

  const category = await categoryWrite(env, parsed.category, false);
  // The marker only ever goes on: no edit turns a transcript into something shareable.
  const marker = row.category ?? category.marker;
  assertStaysInternal(marker, parsed.visibility ?? row.visibility);

  const body = touchesBody ? (parsed.body_md ?? '') : (row.body_md ?? '');
  const hash = touchesBody ? await sha256Hex(body) : row.content_hash;
  const title = parsed.title ?? row.title;
  // A caller replacing frontmatter is not editing subjects — the table is
  // truth, and the projection is re-applied so a vault round-trip cannot
  // silently drop a link.
  const frontmatter = parsed.frontmatter
    ? projectSubjects(parsed.frontmatter, (await subjectsFor(env, [row.id])).get(row.id) ?? [])
    : safeJSON(row.frontmatter);
  const nextVersion = touchesBody && hash !== row.content_hash ? row.version + 1 : row.version;
  // Re-dating carries `updated_at` with it: a document that belongs to a day
  // in 2024 must not sort as today's work because a machine rewrote it.
  const dated = parsed.created_at ? new Date(parsed.created_at).toISOString() : null;
  const now = dated ?? new Date().toISOString();

  await env.DB.prepare(
    `UPDATE documents
        SET title = ?, body_md = ?, byte_size = ?, content_hash = ?, frontmatter = ?,
            visibility = COALESCE(?, visibility), status = COALESCE(?, status),
            category = ?,
            category_id = CASE WHEN ? THEN ? ELSE category_id END,
            created_at = COALESCE(?, created_at),
            version = ?, updated_at = ?, updated_by = ?, updated_by_kind = ?
      WHERE id = ?`,
  )
    .bind(
      title,
      row.kind === 'markdown' ? body : row.body_md,
      touchesBody ? byteLength(body) : row.byte_size,
      hash,
      JSON.stringify(frontmatter),
      parsed.visibility ?? null,
      parsed.status ?? null,
      marker,
      // `null` clears it; absent leaves it. A CASE keeps the two apart.
      category.id !== undefined ? 1 : 0,
      category.id ?? null,
      dated,
      nextVersion,
      now,
      writer.actor,
      writer.kind,
      row.id,
    )
    .run();
  // Sharing on a link or to the world is the owner making it not private.
  if (parsed.visibility === 'link' || parsed.visibility === 'public') await promote(env, row, writer, 'shared');

  if (nextVersion !== row.version) {
    await recordVersion(env, {
      id: row.id,
      version: nextVersion,
      title,
      body,
      hash,
      writer,
      message: parsed.message,
    });
  }

  if (touchesBody || parsed.tags) {
    // `tags` replaces the list; absent leaves it. `document_tags` does not
    // record where a tag came from, so the explicit ones are whatever the old
    // body and frontmatter do not produce. Without this, a body-only write
    // drops every tag that was set by hand.
    let explicitTags = parsed.tags;
    if (explicitTags === undefined) {
      const derived = new Set(extractTags(row.body_md ?? '', safeJSON(row.frontmatter)));
      explicitTags = ((await tagsFor(env, [row.id])).get(row.id) ?? []).filter((tag) => !derived.has(tag));
    }
    await syncDerived(env, row.id, body, explicitTags, frontmatter);
  }

  const updated = await getDocumentById(env, row.id);
  if (!updated) throw new NotFoundError('No such document.');
  return getDocumentDetail(env, updated);
}

export async function moveDocument(
  env: Env,
  row: DocumentRow,
  input: { folder_path?: string; slug?: string; title?: string },
  writer: Writer,
): Promise<DocumentDetail> {
  const folderPath = input.folder_path ?? parentPath(row.path);
  const slug = input.slug ?? row.slug;
  const path = joinPath(folderPath, slug);

  if (path !== row.path && (await getDocumentByPath(env, path))) {
    throw new ConflictError(`A document already exists at ${path}.`);
  }

  const folder = await ensureFolderPath(env, folderPath, { createdBy: writer.actor });
  await env.DB.prepare(
    `UPDATE documents
        SET folder_id = ?, slug = ?, path = ?, title = COALESCE(?, title),
            updated_at = ?, updated_by = ?, updated_by_kind = ?
      WHERE id = ?`,
  )
    .bind(folder?.id ?? null, slug, path, input.title ?? null, new Date().toISOString(), writer.actor, writer.kind, row.id)
    .run();

  // A move changes the wikilink target this document answers to, so anything
  // that pointed at the old name may now resolve — or stop resolving.
  await resolveLinksTo(env, row.title);
  await resolveLinksTo(env, input.title ?? row.title);

  const updated = await getDocumentById(env, row.id);
  if (!updated) throw new NotFoundError('No such document.');
  return getDocumentDetail(env, updated);
}

/** Soft delete. Nothing here ever hard-deletes a document a person can see. */
export async function deleteDocument(env: Env, row: DocumentRow, writer: Writer): Promise<void> {
  await env.DB.prepare(
    `UPDATE documents SET status = 'deleted', updated_at = ?, updated_by = ?, updated_by_kind = ? WHERE id = ?`,
  )
    .bind(new Date().toISOString(), writer.actor, writer.kind, row.id)
    .run();
}

/**
 * Remove a document outright: the row, every version, its annotations, links,
 * subjects and access record (all `ON DELETE CASCADE`), and the search index
 * (trigger). `deleteDocument` only hides a row and keeps its body; this is
 * for text that must not stay anywhere — a meeting filed as personal. A
 * document carrying signature evidence is refused: that record outlives it.
 */
export async function purgeDocument(env: Env, row: DocumentRow): Promise<void> {
  const signed = await env.DB.prepare(`SELECT 1 FROM signature_requests WHERE document_id = ? LIMIT 1`)
    .bind(row.id)
    .first();
  if (signed) throw new ConflictError('This document carries signature evidence and cannot be purged.');
  await env.DB.prepare(`DELETE FROM documents WHERE id = ?`).bind(row.id).run();
}

/**
 * Replace a document's subjects. Small lists, so replace-all is the whole API:
 * a client sends what it wants to be true and never has to diff. The
 * frontmatter projection is refreshed in the same step so the Obsidian mirror
 * sees the links too; the table stays the thing queries run against.
 */
export async function setSubjects(
  env: Env,
  row: DocumentRow,
  input: unknown,
  writer: Writer,
): Promise<DocumentDetail> {
  const subjects = subjectsSchema.parse(input);
  const frontmatter = projectSubjects(safeJSON(row.frontmatter), subjects);
  await writeSubjects(env, row.id, subjects);
  // Linking is not editing: the body did not change, so `updated_at` and
  // `updated_by` stay as they were. They moved once, and it cost the date on
  // every filed meeting transcript — Meet writes the transcript with the
  // meeting's date and files it on its subject in the next breath, and this
  // statement put all 688 back on the afternoon of the import.
  await env.DB.prepare(
    `UPDATE documents SET frontmatter = ? WHERE id = ?`,
  )
    .bind(JSON.stringify(frontmatter), row.id)
    .run();
  // Filing a private save on a subject is the promotion rule.
  if (subjects.length > 0) await promote(env, row, writer, 'filed');

  const updated = await getDocumentById(env, row.id);
  if (!updated) throw new NotFoundError('No such document.');
  return getDocumentDetail(env, updated);
}

/**
 * Make a private save workspace-internal. The one rule: a save
 * stops being private when its owner files it on a subject, grants someone
 * access, or sets visibility `link` or `public`. Taking the subject away
 * again does not make it private; a promotion is not undone. Recorded in
 * the access log, so a promotion is auditable.
 */
export async function promote(
  env: Env,
  row: Pick<DocumentRow, 'id' | 'private_to'>,
  writer: Writer,
  reason: 'filed' | 'shared',
): Promise<void> {
  if (row.private_to === null) return;
  await env.DB.batch([
    env.DB.prepare(`UPDATE documents SET private_to = NULL WHERE id = ? AND private_to IS NOT NULL`).bind(row.id),
    env.DB.prepare(
      `INSERT INTO access_events (id, document_id, actor, actor_kind, kind, detail)
       VALUES (?, ?, ?, ?, 'share', ?)`,
      // `kind` carries a CHECK that cannot widen, so a promotion is a
      // `share` whose detail says so.
    ).bind(uuid(), row.id, writer.actor, writer.kind === 'agent' ? 'agent' : 'staff', `promote:${reason}`),
  ]);
}

export async function writeSubjects(env: Env, documentId: string, subjects: DocumentSubject[]): Promise<void> {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM document_subjects WHERE document_id = ?`).bind(documentId),
  ];
  const seen = new Set<string>();
  for (const subject of subjects) {
    const ref = subjectRef(subject);
    if (seen.has(ref)) continue;
    seen.add(ref);
    statements.push(
      env.DB.prepare(
        `INSERT INTO document_subjects (document_id, system, kind, subject_id) VALUES (?, ?, ?, ?)`,
      ).bind(documentId, subject.system, subject.kind, subject.subject_id),
    );
  }
  await env.DB.batch(statements);
}

/** `subjects:` in frontmatter is a projection of the table — never read back from it. */
export function projectSubjects(frontmatter: Record<string, unknown>, subjects: DocumentSubject[]): Record<string, unknown> {
  const { subjects: _ignored, ...rest } = frontmatter;
  if (!subjects.length) return rest;
  // Same order the table reads back in, so the projection and the relation
  // never disagree about anything but existence.
  const refs = [...new Set(subjects.map(subjectRef))].sort((a, b) => {
    const [, ak, ai] = a.split(':');
    const [, bk, bi] = b.split(':');
    return ak!.localeCompare(bk!) || ai!.localeCompare(bi!);
  });
  return { ...rest, subjects: refs };
}

// ---------------------------------------------------------------------------
// Derived state: versions, tags, links
// ---------------------------------------------------------------------------

async function recordVersion(
  env: Env,
  input: {
    id: string;
    version: number;
    title: string;
    body: string;
    hash: string;
    writer: Writer;
    message?: string | undefined;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO document_versions
       (id, document_id, version, title, body_md, content_hash, byte_size, author, author_kind, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (document_id, version) DO NOTHING`,
  )
    .bind(
      uuid(),
      input.id,
      input.version,
      input.title,
      input.body,
      input.hash,
      byteLength(input.body),
      input.writer.actor,
      input.writer.kind,
      input.message ?? (input.writer.agentName ? `via ${input.writer.agentName}` : null),
    )
    .run();
}

/**
 * Rebuild tags and outbound links for a document.
 *
 * Tags are the union of explicit input, frontmatter, and inline `#tag`s.
 * Links resolve by title first, then by path — the two ways an Obsidian
 * `[[wikilink]]` is written in practice. Unresolved targets are kept, because
 * a link to a note that does not exist yet is a to-do, not an error.
 */
export async function syncDerived(
  env: Env,
  documentId: string,
  body: string,
  explicitTags: string[] | undefined,
  frontmatter: Record<string, unknown>,
): Promise<void> {
  const tags = new Set<string>(explicitTags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean) ?? []);
  for (const tag of extractTags(body, frontmatter)) tags.add(tag);

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM document_tags WHERE document_id = ?`).bind(documentId),
    env.DB.prepare(`DELETE FROM document_links WHERE from_id = ?`).bind(documentId),
  ];

  for (const tag of [...tags].slice(0, 64)) {
    statements.push(
      env.DB.prepare(`INSERT OR IGNORE INTO document_tags (document_id, tag) VALUES (?, ?)`).bind(documentId, tag),
    );
  }

  for (const target of extractWikilinks(body).slice(0, 500)) {
    const resolved = await resolveWikilinkTarget(env, target);
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO document_links (id, from_id, to_id, target_text, kind)
         VALUES (?, ?, ?, ?, 'wikilink')`,
      ).bind(uuid(), documentId, resolved, target),
    );
  }

  await env.DB.batch(statements);
}

async function resolveWikilinkTarget(env: Env, target: string): Promise<string | null> {
  const trimmed = target.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) {
    const byPath = await getDocumentByPath(env, trimmed);
    if (byPath) return byPath.id;
  }
  // Obsidian links by note name, and names are not unique across a vault.
  // Deterministic tie-break by path keeps re-imports stable.
  const byTitle = await env.DB.prepare(
    `SELECT id FROM documents WHERE title = ? AND status = 'active' ORDER BY path LIMIT 1`,
  )
    .bind(trimmed)
    .first<{ id: string }>();
  if (byTitle) return byTitle.id;

  const bySlug = await env.DB.prepare(
    `SELECT id FROM documents WHERE slug = ? AND status = 'active' ORDER BY path LIMIT 1`,
  )
    .bind(slugify(trimmed))
    .first<{ id: string }>();
  return bySlug?.id ?? null;
}

/** Late-bind links that were written before their target existed. */
export async function resolveLinksTo(env: Env, title: string): Promise<void> {
  const target = await env.DB.prepare(
    `SELECT id FROM documents WHERE title = ? AND status = 'active' ORDER BY path LIMIT 1`,
  )
    .bind(title)
    .first<{ id: string }>();
  if (!target) return;
  await env.DB.prepare(`UPDATE document_links SET to_id = ? WHERE target_text = ? AND to_id IS NULL`)
    .bind(target.id, title)
    .run();
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

export function toSummary(
  row: DocumentRow,
  tags: string[],
  subjects: DocumentSubject[] = [],
  link?: LinkSave,
): DocumentSummary {
  return {
    id: row.id,
    path: row.path,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    folder_id: row.folder_id,
    visibility: row.visibility,
    private: row.private_to !== null,
    status: row.status,
    source_system: row.source_system,
    source_kind: row.source_kind,
    source_url: row.source_url,
    editable: row.editable === 1,
    version: row.version,
    byte_size: row.byte_size,
    content_hash: row.content_hash,
    tags,
    category: row.category_id ?? null,
    transcript: row.category === TRANSCRIPT_MARKER,
    subjects,
    created_at: row.created_at,
    updated_at: row.updated_at,
    written_at: writtenAt(row),
    updated_by: row.updated_by,
    excerpt: excerpt(row.body_md ?? row.extracted_text ?? ''),
    // Where the document was copied from, when it records one. A summary
    // carries it so `docsctl drift` can check a thousand documents without
    // fetching a thousand bodies.
    ...(sourceOf(row) ? { source: sourceOf(row)! } : {}),
    ...(link ? { link } : {}),
  };
}

/** `frontmatter.date` as an ISO instant when it is a date, else `created_at`. */
export function writtenAt(row: Pick<DocumentRow, 'frontmatter' | 'created_at'>): string {
  const value = safeJSON(row.frontmatter).date;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(value)) {
    const instant = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
    if (!Number.isNaN(instant.getTime())) return instant.toISOString();
  }
  return row.created_at;
}

function sourceOf(row: DocumentRow): string | null {
  const value = safeJSON(row.frontmatter).source;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function withRelations(env: Env, rows: DocumentRow[]): Promise<DocumentSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [tags, subjects, links] = await Promise.all([tagsFor(env, ids), subjectsFor(env, ids), linkSavesFor(env, rows)]);
  return rows.map((row) => toSummary(row, tags.get(row.id) ?? [], subjects.get(row.id) ?? [], links.get(row.id)));
}

export interface LinkSaveRow {
  document_id: string;
  url: string;
  canonical_url: string;
  site_name: string | null;
  description: string | null;
  image_r2_key: string | null;
  image_type: string | null;
  fetch_status: LinkFetchStatus;
  fetch_error: string | null;
  fetched_at: string | null;
  created_by: string;
  created_at: string;
}

export function toLinkSave(row: LinkSaveRow, images: { count: number; first: string | null } = { count: 0, first: null }): LinkSave {
  return {
    url: row.url,
    canonical_url: row.canonical_url,
    site_name: row.site_name,
    description: row.description,
    has_image: row.image_r2_key !== null,
    image_count: images.count,
    first_image_id: images.first,
    fetch_status: row.fetch_status,
    fetch_error: row.fetch_error,
    fetched_at: row.fetched_at,
  };
}

/** Only rows marked as saves are asked about, so a list of proposals costs no query. */
async function linkSavesFor(env: Env, rows: DocumentRow[]): Promise<Map<string, LinkSave>> {
  const map = new Map<string, LinkSave>();
  const ids = rows.filter((row) => row.source_kind === LINK_SOURCE_KIND).map((row) => row.id);
  for (const chunk of chunks(ids)) {
    const placeholders = chunk.map(() => '?').join(',');
    // The attached images ride along: a card shows how many, and the first
    // is its cover when the page gave none. One grouped read per chunk.
    const [saves, images] = await Promise.all([
      env.DB.prepare(`SELECT * FROM link_saves WHERE document_id IN (${placeholders})`).bind(...chunk).all<LinkSaveRow>(),
      env.DB.prepare(
        `SELECT i.document_id, COUNT(*) AS n,
                (SELECT f.id FROM document_images f
                  WHERE f.document_id = i.document_id AND f.deleted_at IS NULL
                  ORDER BY f.created_at LIMIT 1) AS first_id
           FROM document_images i
          WHERE i.document_id IN (${placeholders}) AND i.deleted_at IS NULL
          GROUP BY i.document_id`,
      )
        .bind(...chunk)
        .all<{ document_id: string; n: number; first_id: string | null }>(),
    ]);
    const byDocument = new Map(images.results.map((row) => [row.document_id, { count: row.n, first: row.first_id }]));
    for (const row of saves.results) map.set(row.document_id, toLinkSave(row, byDocument.get(row.document_id)));
  }
  return map;
}

async function subjectsFor(env: Env, ids: string[]): Promise<Map<string, DocumentSubject[]>> {
  const map = new Map<string, DocumentSubject[]>();
  for (const chunk of chunks(ids)) {
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT document_id, system, kind, subject_id FROM document_subjects
        WHERE document_id IN (${placeholders}) ORDER BY kind, subject_id`,
    )
      .bind(...chunk)
      .all<{ document_id: string } & DocumentSubject>();
    for (const { document_id, ...subject } of results) {
      const list = map.get(document_id) ?? [];
      list.push(subject);
      map.set(document_id, list);
    }
  }
  return map;
}

/** D1 allows 100 bound variables per statement; a list may hold 200 rows. */
const IN_CHUNK = 90;

function chunks<T>(values: T[], size: number = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

async function tagsFor(env: Env, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const chunk of chunks(ids)) {
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT document_id, tag FROM document_tags WHERE document_id IN (${placeholders}) ORDER BY tag`,
    )
      .bind(...chunk)
      .all<{ document_id: string; tag: string }>();
    for (const row of results) {
      const list = map.get(row.document_id) ?? [];
      list.push(row.tag);
      map.set(row.document_id, list);
    }
  }
  return map;
}

export function safeJSON(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
