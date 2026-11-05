// Bulk sync — how `docsctl` and agents move many documents at once.
//
// The model is git-shaped without being git: the client sends the hash it
// believes is stored (`base_hash`), and the server writes only if that still
// matches. A mismatch comes back as a conflict rather than a silent overwrite,
// so two agents editing the same note produce an error someone can act on
// instead of a lost paragraph.
//
// `GET /api/sync/manifest` is the other half: path → hash for a whole subtree,
// cheap enough to diff a 7,000-note vault on every pull.

import {
  MARKDOWN_MAX_BYTES,
  syncPushSchema,
  type SyncManifestEntry,
  type SyncPushResult,
} from '@docs/contracts';
import { sha256Hex, uuid } from './crypto';
import { DocsError } from './errors';
import { ensureFolderPath } from './folders';
import { byteLength, canView, getDocumentByPath, syncDerived, type Writer } from './documents';
import { parentPath, segments } from '@docs/contracts';

export async function manifest(
  env: Env,
  options: { prefix?: string; since?: string; limit?: number },
  viewer: string,
): Promise<{ entries: SyncManifestEntry[]; truncated: boolean }> {
  const limit = Math.min(options.limit ?? 5000, 20_000);
  // A private save is in its owner's manifest only.
  const where: string[] = ["status = 'active'", '(private_to IS NULL OR private_to = ?)'];
  const binds: unknown[] = [viewer];

  if (options.prefix && options.prefix !== '/') {
    where.push("(path = ? OR path LIKE ? || '/%')");
    binds.push(options.prefix, options.prefix);
  }
  if (options.since) {
    where.push('updated_at > ?');
    binds.push(options.since);
  }

  const { results } = await env.DB.prepare(
    `SELECT path, content_hash, updated_at, version, kind, editable
       FROM documents
      WHERE ${where.join(' AND ')}
      ORDER BY path
      LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<{
      path: string;
      content_hash: string;
      updated_at: string;
      version: number;
      kind: 'markdown' | 'pdf';
      editable: number;
    }>();

  const truncated = results.length > limit;
  return {
    entries: results.slice(0, limit).map((row) => ({
      path: row.path,
      content_hash: row.content_hash,
      updated_at: row.updated_at,
      version: row.version,
      kind: row.kind,
      editable: row.editable === 1,
    })),
    truncated,
  };
}

export async function push(env: Env, input: unknown, writer: Writer): Promise<SyncPushResult> {
  const parsed = syncPushSchema.parse(input);
  const result: SyncPushResult = { written: [], skipped: [], conflicts: [] };

  // Dry pass first when the caller asked for atomicity: nothing is written
  // unless every document in the batch would land cleanly.
  if (parsed.atomic) {
    for (const document of parsed.documents) {
      const existing = await getDocumentByPath(env, document.path);
      if (existing && document.base_hash && existing.content_hash !== document.base_hash) {
        result.conflicts.push({
          path: document.path,
          expected: document.base_hash,
          actual: existing.content_hash,
        });
      }
      if (existing && !existing.editable) {
        result.skipped.push({ path: document.path, reason: 'read_only' });
      }
    }
    if (result.conflicts.length) return result;
  }

  for (const document of parsed.documents) {
    if (byteLength(document.body_md) > MARKDOWN_MAX_BYTES) {
      throw new DocsError(`${document.path} is too large.`, 413, 'invalid_request');
    }

    const hash = await sha256Hex(document.body_md);
    const existing = await getDocumentByPath(env, document.path);

    if (existing) {
      // Someone else's private save is not there for this writer.
      if (!canView(existing, writer.actor)) {
        result.skipped.push({ path: document.path, reason: 'read_only' });
        continue;
      }
      if (!existing.editable) {
        if (!result.skipped.some((entry) => entry.path === document.path)) {
          result.skipped.push({ path: document.path, reason: 'read_only' });
        }
        continue;
      }
      if (document.base_hash && existing.content_hash !== document.base_hash) {
        result.conflicts.push({
          path: document.path,
          expected: document.base_hash,
          actual: existing.content_hash,
        });
        continue;
      }
      if (existing.content_hash === hash && existing.title === document.title) {
        result.skipped.push({ path: document.path, reason: 'unchanged' });
        continue;
      }

      const version = existing.version + 1;
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE documents
              SET title = ?, body_md = ?, byte_size = ?, content_hash = ?, frontmatter = ?,
                  version = ?, updated_at = ?, updated_by = ?, updated_by_kind = ?
            WHERE id = ?`,
        ).bind(
          document.title,
          document.body_md,
          byteLength(document.body_md),
          hash,
          JSON.stringify(document.frontmatter),
          version,
          now,
          writer.actor,
          writer.kind,
          existing.id,
        ),
        env.DB.prepare(
          `INSERT INTO document_versions
             (id, document_id, version, title, body_md, content_hash, byte_size, author, author_kind, message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          uuid(),
          existing.id,
          version,
          document.title,
          document.body_md,
          hash,
          byteLength(document.body_md),
          writer.actor,
          writer.kind,
          parsed.message ?? null,
        ),
      ]);

      await syncDerived(env, existing.id, document.body_md, document.tags, document.frontmatter);
      result.written.push({ path: document.path, id: existing.id, version, content_hash: hash });
      continue;
    }

    const folder = await ensureFolderPath(env, parentPath(document.path), { createdBy: writer.actor });
    const id = uuid();
    const slug = segments(document.path).at(-1)!;
    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO documents
           (id, folder_id, slug, path, title, kind, body_md, byte_size, content_hash,
            frontmatter, created_at, updated_at, created_by, updated_by, updated_by_kind)
         VALUES (?, ?, ?, ?, ?, 'markdown', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        folder?.id ?? null,
        slug,
        document.path,
        document.title,
        document.body_md,
        byteLength(document.body_md),
        hash,
        JSON.stringify(document.frontmatter),
        now,
        now,
        writer.actor,
        writer.actor,
        writer.kind,
      ),
      env.DB.prepare(
        `INSERT INTO document_versions
           (id, document_id, version, title, body_md, content_hash, byte_size, author, author_kind, message)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uuid(),
        id,
        document.title,
        document.body_md,
        hash,
        byteLength(document.body_md),
        writer.actor,
        writer.kind,
        parsed.message ?? null,
      ),
    ]);

    await syncDerived(env, id, document.body_md, document.tags, document.frontmatter);
    result.written.push({ path: document.path, id, version: 1, content_hash: hash });
  }

  // New documents can satisfy links written earlier against a name that did
  // not exist yet — resolve those now so the graph is correct after an import.
  for (const written of result.written) {
    const document = parsed.documents.find((entry) => entry.path === written.path);
    if (document) await resolvePending(env, document.title, written.id);
  }

  return result;
}

async function resolvePending(env: Env, title: string, documentId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE document_links SET to_id = ? WHERE to_id IS NULL AND target_text = ?`,
  )
    .bind(documentId, title)
    .run();
}
