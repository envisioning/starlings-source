// Annotations, comments and feedback — one table, three shapes:
//
//   anchored to a text quote  → a margin comment on a passage
//   anchored to PDF rects     → a highlight on a page
//   no anchor                 → document-level feedback
//
// Anchors store a quote with surrounding context rather than character
// offsets, because the document underneath keeps changing. When the quote no
// longer appears, the annotation is marked `orphaned` on read instead of
// being silently repositioned onto unrelated text.

import {
  annotationCreateSchema,
  annotationUpdateSchema,
  type Annotation,
  type Anchor,
  type Principal,
} from '@docs/contracts';
import { uuid } from './crypto';
import { AuthError, DocsError, NotFoundError } from './errors';
import type { DocumentRow } from './documents';

interface AnnotationRow {
  id: string;
  document_id: string;
  document_version: number;
  thread_id: string;
  parent_id: string | null;
  author: string;
  author_name: string | null;
  author_kind: 'staff' | 'guest' | 'agent';
  body_md: string;
  anchor: string | null;
  status: 'open' | 'resolved';
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listAnnotations(env: Env, document: DocumentRow): Promise<Annotation[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM annotations
      WHERE document_id = ? AND deleted_at IS NULL
      ORDER BY created_at`,
  )
    .bind(document.id)
    .all<AnnotationRow>();

  const body = document.body_md ?? document.extracted_text ?? '';
  return results.map((row) => toAnnotation(row, body));
}

export async function createAnnotation(
  env: Env,
  document: DocumentRow,
  input: unknown,
  principal: Principal,
): Promise<Annotation> {
  const parsed = annotationCreateSchema.parse(input);
  assertMayComment(principal);

  const author = authorOf(principal);
  const id = uuid();

  // A reply inherits its parent's thread; a new comment starts its own.
  let threadId = id;
  if (parsed.parent_id) {
    const parent = await env.DB.prepare(
      `SELECT thread_id, document_id FROM annotations WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(parsed.parent_id)
      .first<{ thread_id: string; document_id: string }>();
    if (!parent || parent.document_id !== document.id) {
      throw new NotFoundError('No such comment to reply to.');
    }
    threadId = parent.thread_id;
  }

  await env.DB.prepare(
    `INSERT INTO annotations
       (id, document_id, document_version, thread_id, parent_id, author, author_name,
        author_kind, body_md, anchor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      document.id,
      document.version,
      threadId,
      parsed.parent_id ?? null,
      author.email,
      parsed.author_name ?? author.name ?? null,
      author.kind,
      parsed.body_md,
      parsed.anchor ? JSON.stringify(parsed.anchor) : null,
    )
    .run();

  const row = await env.DB.prepare(`SELECT * FROM annotations WHERE id = ?`).bind(id).first<AnnotationRow>();
  if (!row) throw new DocsError('Comment creation failed.', 500, 'internal');
  return toAnnotation(row, document.body_md ?? '');
}

export async function updateAnnotation(
  env: Env,
  id: string,
  input: unknown,
  principal: Principal,
): Promise<Annotation> {
  const parsed = annotationUpdateSchema.parse(input);
  const row = await env.DB.prepare(`SELECT * FROM annotations WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<AnnotationRow>();
  if (!row) throw new NotFoundError('No such comment.');

  const author = authorOf(principal);
  const isOwner = row.author === author.email;
  const isStaff = principal.kind === 'staff';

  // Anyone on staff may resolve a thread; only the author may rewrite words.
  if (parsed.body_md !== undefined && !isOwner) {
    throw new AuthError('Only the author can edit a comment.', 403, 'forbidden');
  }
  if (parsed.status !== undefined && !isOwner && !isStaff) {
    throw new AuthError('Only staff or the author can resolve a comment.', 403, 'forbidden');
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE annotations
        SET body_md = COALESCE(?, body_md),
            status = COALESCE(?, status),
            resolved_by = CASE WHEN ? = 'resolved' THEN ? WHEN ? = 'open' THEN NULL ELSE resolved_by END,
            resolved_at = CASE WHEN ? = 'resolved' THEN ? WHEN ? = 'open' THEN NULL ELSE resolved_at END,
            updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      parsed.body_md ?? null,
      parsed.status ?? null,
      parsed.status ?? '',
      author.email,
      parsed.status ?? '',
      parsed.status ?? '',
      now,
      parsed.status ?? '',
      now,
      id,
    )
    .run();

  const updated = await env.DB.prepare(`SELECT * FROM annotations WHERE id = ?`).bind(id).first<AnnotationRow>();
  if (!updated) throw new NotFoundError('No such comment.');

  const document = await env.DB.prepare(`SELECT body_md FROM documents WHERE id = ?`)
    .bind(updated.document_id)
    .first<{ body_md: string | null }>();
  return toAnnotation(updated, document?.body_md ?? '');
}

export async function deleteAnnotation(env: Env, id: string, principal: Principal): Promise<void> {
  const row = await env.DB.prepare(`SELECT author FROM annotations WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<{ author: string }>();
  if (!row) throw new NotFoundError('No such comment.');

  const author = authorOf(principal);
  if (row.author !== author.email && principal.kind !== 'staff') {
    throw new AuthError('Only staff or the author can delete a comment.', 403, 'forbidden');
  }

  // Soft delete: replies keep their parent, and the audit trail keeps the fact
  // that something was said and withdrawn.
  await env.DB.prepare(`UPDATE annotations SET deleted_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), id)
    .run();
}

function assertMayComment(principal: Principal): void {
  if (principal.kind === 'guest' && principal.guest.role === 'viewer') {
    throw new AuthError('This link is read-only.', 403, 'forbidden');
  }
  if (principal.kind === 'agent' && !principal.agent.scopes.includes('annotations:write')) {
    throw new AuthError('This token is missing the `annotations:write` scope.', 403, 'forbidden');
  }
}

function authorOf(principal: Principal): { email: string; name: string | null; kind: 'staff' | 'guest' | 'agent' } {
  switch (principal.kind) {
    case 'staff':
      return { email: principal.staff.email, name: principal.staff.name, kind: 'staff' };
    case 'guest':
      return { email: principal.guest.email, name: principal.guest.name ?? null, kind: 'guest' };
    case 'agent':
      return { email: principal.agent.owner, name: principal.agent.agentName, kind: 'agent' };
  }
}

function toAnnotation(row: AnnotationRow, body: string): Annotation {
  const anchor = parseAnchor(row.anchor);
  return {
    id: row.id,
    document_id: row.document_id,
    document_version: row.document_version,
    thread_id: row.thread_id,
    parent_id: row.parent_id,
    author: row.author,
    author_name: row.author_name,
    author_kind: row.author_kind,
    body_md: row.body_md,
    anchor,
    status: row.status,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    orphaned: anchor?.type === 'text' ? !body.includes(anchor.quote) : false,
  };
}

function parseAnchor(value: string | null): Anchor | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Anchor;
  } catch {
    return null;
  }
}
