// Mirroring Core's markdown surfaces into Docs.
//
// Core already holds a great deal of finished writing — newsletter issues,
// reports, research pages, methodology chapters, work entries, signals briefs,
// CRM notes. None of it should have to be copied by hand to become part of the
// company's searchable corpus, and none of it should become editable here:
// Core stays authoritative for those bodies.
//
// So a mirrored document is a real row in `documents` — searchable,
// linkable, taggable, annotatable, shareable — with `editable = 0` and a
// `source_*` triple identifying the upstream object. Re-running a sweep
// updates in place; nothing duplicates.
//
// Authentication is the same HMAC handshake Meet uses to post meeting logs to
// Core, run in the opposite direction: `x-internal-timestamp` +
// `x-internal-signature` over `${timestamp}.${body}`.

import {
  MIRROR_CATEGORIES,
  MIRROR_FOLDERS,
  adoptBatchSchema,
  ingestBatchSchema,
  joinPath,
  slugify,
  type SourceKind,
} from '@docs/contracts';
import { constantTimeEqual, hmacSHA256Hex, sha256Hex, uuid } from './crypto';
import { AuthError, DocsError } from './errors';
import { ensureFolderPath } from './folders';
import { byteLength, projectSubjects, syncDerived, writeSubjects } from './documents';

/** Reject replayed or stale signatures. Matches Core's own window. */
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export async function assertInternalSignature(
  request: Request,
  env: Env,
  body: string,
  secretName: 'INTERNAL_REQUEST_SECRET' | 'DOCS_INTERNAL_SECRET' = 'INTERNAL_REQUEST_SECRET',
): Promise<void> {
  const secret = env[secretName]?.trim();
  if (!secret) throw new DocsError(`${secretName} is not configured.`, 503, 'not_configured');

  const timestamp = request.headers.get('x-internal-timestamp');
  const signature = request.headers.get('x-internal-signature');
  if (!timestamp || !signature) throw new AuthError('Missing internal signature.', 401, 'unauthorized');

  const age = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_WINDOW_MS) {
    throw new AuthError('Internal signature is stale.', 401, 'unauthorized');
  }

  const expected = await hmacSHA256Hex(secret, `${timestamp}.${body}`);
  if (!(await constantTimeEqual(expected, signature))) {
    throw new AuthError('Internal signature does not match.', 401, 'unauthorized');
  }
}

export interface IngestResult {
  written: number;
  unchanged: number;
  deleted: number;
  paths: string[];
}

export async function ingest(env: Env, input: unknown): Promise<IngestResult> {
  const parsed = ingestBatchSchema.parse(input);
  const result: IngestResult = { written: 0, unchanged: 0, deleted: 0, paths: [] };

  for (const document of parsed.documents) {
    const mirror = MIRROR_FOLDERS[document.source_kind as SourceKind];
    if (!mirror) throw new DocsError(`Unknown source kind ${document.source_kind}.`, 400, 'invalid_request');

    const existing = await env.DB.prepare(
      `SELECT id, path, content_hash, version, editable FROM documents
        WHERE source_system = ? AND source_kind = ? AND source_id = ?`,
    )
      .bind(parsed.source_system, document.source_kind, document.source_id)
      .first<{ id: string; path: string; content_hash: string; version: number; editable: number }>();

    // An adopted row is ours now. A sweep that still carries it must not put
    // Core's older body back over an edit made here.
    if (existing?.editable) {
      result.unchanged += 1;
      continue;
    }

    if (document.deleted) {
      if (existing) {
        await env.DB.prepare(`UPDATE documents SET status = 'deleted', updated_at = ? WHERE id = ?`)
          .bind(new Date().toISOString(), existing.id)
          .run();
        result.deleted += 1;
      }
      continue;
    }

    const hash = await sha256Hex(document.body_md);
    const now = document.updated_at ?? new Date().toISOString();

    if (existing) {
      if (existing.content_hash === hash) {
        await env.DB.prepare(`UPDATE documents SET source_synced_at = ? WHERE id = ?`)
          .bind(new Date().toISOString(), existing.id)
          .run();
        result.unchanged += 1;
        continue;
      }
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE documents
              SET title = ?, body_md = ?, byte_size = ?, content_hash = ?, frontmatter = ?,
                  source_url = ?, source_hash = ?, source_synced_at = ?, status = 'active',
                  version = ?, updated_at = ?, updated_by = 'core', updated_by_kind = 'system'
            WHERE id = ?`,
        ).bind(
          document.title,
          document.body_md,
          byteLength(document.body_md),
          hash,
          JSON.stringify(document.frontmatter),
          document.source_url ?? null,
          hash,
          new Date().toISOString(),
          existing.version + 1,
          now,
          existing.id,
        ),
        env.DB.prepare(
          `INSERT INTO document_versions
             (id, document_id, version, title, body_md, content_hash, byte_size, author, author_kind, message)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'core', 'system', 'mirror sync')`,
        ).bind(
          uuid(),
          existing.id,
          existing.version + 1,
          document.title,
          document.body_md,
          hash,
          byteLength(document.body_md),
        ),
      ]);
      await syncDerived(env, existing.id, document.body_md, document.tags, document.frontmatter);
      result.written += 1;
      result.paths.push(existing.path);
      continue;
    }

    const folder = await ensureFolderPath(env, mirror.path, {
      createdBy: 'system',
      sourceKey: `${parsed.source_system}:${document.source_kind}`,
      titles: { [mirror.path]: mirror.title },
    });
    const slug = await uniqueSlug(env, mirror.path, document.slug ?? slugify(document.title));
    const path = joinPath(mirror.path, slug);
    const id = uuid();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO documents
           (id, folder_id, slug, path, title, kind, body_md, byte_size, content_hash, frontmatter,
            visibility, category_id, source_system, source_kind, source_id, source_url, source_hash,
            source_synced_at, editable, created_at, updated_at, created_by, updated_by, updated_by_kind)
         VALUES (?, ?, ?, ?, ?, 'markdown', ?, ?, ?, ?, 'internal', (SELECT id FROM categories WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'core', 'core', 'system')`,
      ).bind(
        id,
        folder?.id ?? null,
        slug,
        path,
        document.title,
        document.body_md,
        byteLength(document.body_md),
        hash,
        JSON.stringify(document.frontmatter),
        MIRROR_CATEGORIES[document.source_kind as SourceKind] ?? null,
        parsed.source_system,
        document.source_kind,
        document.source_id,
        document.source_url ?? null,
        hash,
        new Date().toISOString(),
        mirror.editable ? 1 : 0,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO document_versions
           (id, document_id, version, title, body_md, content_hash, byte_size, author, author_kind, message)
         VALUES (?, ?, 1, ?, ?, ?, ?, 'core', 'system', 'mirror import')`,
      ).bind(uuid(), id, document.title, document.body_md, hash, byteLength(document.body_md)),
    ]);

    await syncDerived(env, id, document.body_md, document.tags, document.frontmatter);
    result.written += 1;
    result.paths.push(path);
  }

  const completedKind = parsed.source_kind ?? parsed.documents[0]?.source_kind;
  if (parsed.complete && completedKind) {
    const sourceKey = `${parsed.source_system}:${completedKind}`;
    // The caller reports run totals, because a sweep arrives as many batches
    // and this Worker holds no state between them. Falling back to the final
    // batch's own counts keeps the row populated for single-batch callers.
    await env.DB.prepare(
      `INSERT INTO sync_state (source_key, last_run_at, last_status, documents_seen, documents_written)
       VALUES (?, ?, 'ok', ?, ?)
       ON CONFLICT (source_key) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         last_status = 'ok',
         documents_seen = excluded.documents_seen,
         documents_written = excluded.documents_written,
         error = NULL`,
    )
      .bind(
        sourceKey,
        new Date().toISOString(),
        parsed.run_seen ?? parsed.documents.length,
        parsed.run_written ?? result.written,
      )
      .run();
  }

  return result;
}

export interface AdoptResult {
  adopted: number;
  created: number;
  unchanged: number;
  paths: string[];
}

/**
 * Turn mirrored rows into native documents, or create them native when the
 * mirror never saw them. The body sent here wins once — after that the row
 * is `editable` and every later sweep leaves it alone (see `ingest`).
 */
export async function adopt(env: Env, input: unknown): Promise<AdoptResult> {
  const parsed = adoptBatchSchema.parse(input);
  const result: AdoptResult = { adopted: 0, created: 0, unchanged: 0, paths: [] };

  for (const document of parsed.documents) {
    const existing = await env.DB.prepare(
      `SELECT id, path, content_hash, version, editable FROM documents
        WHERE source_system = ? AND source_kind = ? AND source_id = ?`,
    )
      .bind(parsed.source_system, document.source_kind, document.source_id)
      .first<{ id: string; path: string; content_hash: string; version: number; editable: number }>();

    if (existing?.editable) {
      result.unchanged += 1;
      continue;
    }

    const hash = await sha256Hex(document.body_md);
    const now = new Date().toISOString();
    const frontmatter = projectSubjects(
      { source: `${parsed.source_system}/${document.source_kind}`, source_id: document.source_id },
      document.subjects,
    );
    const folder = await ensureFolderPath(env, document.folder_path, { createdBy: 'system' });
    const slug = await uniqueSlug(env, document.folder_path, document.slug ?? slugify(document.title));
    const path = joinPath(document.folder_path, slug);

    if (existing) {
      const bodyChanged = existing.content_hash !== hash;
      const version = bodyChanged ? existing.version + 1 : existing.version;
      const statements = [
        env.DB.prepare(
          `UPDATE documents
              SET folder_id = ?, slug = ?, path = ?, title = ?, body_md = ?, byte_size = ?, content_hash = ?,
                  frontmatter = ?, source_url = NULL, editable = 1, status = 'active',
                  category_id = COALESCE(category_id, (SELECT id FROM categories WHERE id = ?)),
                  version = ?, updated_at = ?, updated_by = 'core', updated_by_kind = 'system'
            WHERE id = ?`,
        ).bind(
          folder?.id ?? null,
          slug,
          path,
          document.title,
          document.body_md,
          byteLength(document.body_md),
          hash,
          JSON.stringify(frontmatter),
          MIRROR_CATEGORIES[document.source_kind as SourceKind] ?? null,
          version,
          document.updated_at ?? now,
          existing.id,
        ),
      ];
      if (bodyChanged) {
        statements.push(
          env.DB.prepare(
            `INSERT INTO document_versions
               (id, document_id, version, title, body_md, content_hash, byte_size, author, author_kind, message)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'core', 'system', 'adopted from core')`,
          ).bind(uuid(), existing.id, version, document.title, document.body_md, hash, byteLength(document.body_md)),
        );
      }
      await env.DB.batch(statements);
      await writeSubjects(env, existing.id, document.subjects);
      await syncDerived(env, existing.id, document.body_md, document.tags, frontmatter);
      result.adopted += 1;
      result.paths.push(path);
      continue;
    }

    const id = uuid();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO documents
           (id, folder_id, slug, path, title, kind, body_md, byte_size, content_hash, frontmatter,
            visibility, category_id, source_system, source_kind, source_id, source_hash, source_synced_at,
            editable, created_at, updated_at, created_by, updated_by, updated_by_kind)
         VALUES (?, ?, ?, ?, ?, 'markdown', ?, ?, ?, ?, 'internal', (SELECT id FROM categories WHERE id = ?), ?, ?, ?, ?, ?, 1, ?, ?, 'core', 'core', 'system')`,
      ).bind(
        id,
        folder?.id ?? null,
        slug,
        path,
        document.title,
        document.body_md,
        byteLength(document.body_md),
        hash,
        JSON.stringify(frontmatter),
        MIRROR_CATEGORIES[document.source_kind as SourceKind] ?? null,
        parsed.source_system,
        document.source_kind,
        document.source_id,
        hash,
        now,
        document.created_at ?? now,
        document.updated_at ?? now,
      ),
      env.DB.prepare(
        `INSERT INTO document_versions
           (id, document_id, version, title, body_md, content_hash, byte_size, author, author_kind, message)
         VALUES (?, ?, 1, ?, ?, ?, ?, 'core', 'system', 'adopted from core')`,
      ).bind(uuid(), id, document.title, document.body_md, hash, byteLength(document.body_md)),
    ]);
    await writeSubjects(env, id, document.subjects);
    await syncDerived(env, id, document.body_md, document.tags, frontmatter);
    result.created += 1;
    result.paths.push(path);
  }

  return result;
}

/**
 * Mirrored slugs collide — two newsletter issues can share a title. Suffix
 * deterministically so a re-run maps to the same path rather than drifting to
 * `-3`, `-4`, `-5` on every sweep.
 */
async function uniqueSlug(env: Env, folderPath: string, base: string): Promise<string> {
  const candidate = slugify(base);
  const existing = await env.DB.prepare(`SELECT id FROM documents WHERE path = ?`)
    .bind(joinPath(folderPath, candidate))
    .first<{ id: string }>();
  if (!existing) return candidate;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const next = `${candidate}-${suffix}`;
    const taken = await env.DB.prepare(`SELECT id FROM documents WHERE path = ?`)
      .bind(joinPath(folderPath, next))
      .first<{ id: string }>();
    if (!taken) return next;
  }
  return `${candidate}-${crypto.randomUUID().slice(0, 8)}`;
}
