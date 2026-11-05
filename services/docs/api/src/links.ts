// Link saves: a URL a person dropped, filed as a native
// document with `source_kind = 'link'`. The body is their notes; `link_saves`
// holds what the page said about itself. Reads live in documents.ts beside
// tags and subjects; this file is the writes and the cover image.
//
// Docs never fetches a URL (decision 13). Meet's Worker reads the page with
// the one reader the estate has (`link-preview.ts`) and sends the metadata
// and the cover's bytes here.

import {
  documentCreateSchema,
  linkMetadataSchema,
  slugify,
  LINK_FOLDER,
  LINK_IMAGE_MAX_BYTES,
  LINK_SOURCE_KIND,
  type DocumentDetail,
  type LinkMetadata,
} from '@docs/contracts';
import { DocsError } from './errors';
import {
  getDocumentById,
  getDocumentDetail,
  insertDocument,
  type DocumentRow,
  type LinkSaveRow,
  type Writer,
} from './documents';
import { readBoundedBytes } from './http';
import { sniff } from './images';

/** Query parameters that only say who sent the click. Dropped for dedupe. */
const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src)$/iu;

/** The dedupe form: lower-case host, no fragment, no default port, no tracking parameters. */
export function normalizeURL(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}

/**
 * Save a URL with what the caller read about it. The same person saving the
 * same page again gets their earlier save back (`created: false`); an
 * archived one comes back active.
 */
export async function saveLink(env: Env, input: unknown, writer: Writer): Promise<{ document: DocumentDetail; created: boolean }> {
  const parsed = documentCreateSchema.parse(input);
  if (!parsed.url) throw new DocsError('A link save needs a url.', 400, 'invalid_request');
  const link: LinkMetadata = parsed.link ?? { fetch_status: 'skipped' };
  const canonical = normalizeURL(link.canonical_url ?? parsed.url);

  for (const key of new Set([normalizeURL(parsed.url), canonical])) {
    const earlier = await findSave(env, writer.actor, key);
    if (earlier) return { document: await reopen(env, earlier, writer), created: false };
  }

  const title = parsed.title ?? new URL(parsed.url).hostname.replace(/^www\./u, '');
  const document = await insertDocument(
    env,
    {
      ...parsed,
      title,
      folder_path: parsed.path ? undefined : (parsed.folder_path ?? LINK_FOLDER),
      // A title is no identity: two pages called "Home" must both fit in the folder.
      slug: parsed.path ? undefined : (parsed.slug ?? `${slugify(title).slice(0, 80)}-${crypto.randomUUID().slice(0, 8)}`),
      category: undefined,
    },
    writer,
    { kind: LINK_SOURCE_KIND, url: canonical },
  );

  await env.DB.prepare(
    `INSERT INTO link_saves
       (document_id, url, canonical_url, site_name, description, image_r2_key, image_type,
        fetch_status, fetch_error, fetched_at, created_by)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
  )
    .bind(
      document.id,
      parsed.url,
      canonical,
      link.site_name ?? null,
      link.description ?? null,
      link.fetch_status,
      link.fetch_error ?? null,
      new Date().toISOString(),
      writer.actor,
    )
    .run();

  const row = await getDocumentById(env, document.id);
  if (!row) throw new DocsError('Link save failed.', 500, 'internal');
  return { document: await getDocumentDetail(env, row), created: true };
}

/**
 * `PUT /api/docs/:id/link`: the page read again. The title stays — the
 * person may have edited it — and the metadata is replaced.
 */
export async function updateLink(env: Env, row: DocumentRow, input: unknown): Promise<DocumentDetail> {
  const save = await saveRow(env, row);
  const link = linkMetadataSchema.parse(input);
  const canonical = normalizeURL(link.canonical_url ?? save.url);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE link_saves
          SET canonical_url = ?, site_name = ?, description = ?, fetch_status = ?, fetch_error = ?, fetched_at = ?
        WHERE document_id = ?`,
    ).bind(canonical, link.site_name ?? null, link.description ?? null, link.fetch_status, link.fetch_error ?? null,
      new Date().toISOString(), row.id),
    env.DB.prepare(`UPDATE documents SET source_url = ? WHERE id = ?`).bind(canonical, row.id),
  ]);
  return getDocumentDetail(env, (await getDocumentById(env, row.id)) ?? row);
}

/**
 * `PUT /api/docs/:id/link-image`: the cover, raw bytes, typed by their magic
 * number like every other image here. It replaces the last one.
 */
export async function putLinkImage(env: Env, request: Request, row: DocumentRow): Promise<DocumentDetail> {
  await saveRow(env, row);
  const bytes = await readBoundedBytes(request, LINK_IMAGE_MAX_BYTES);
  if (bytes.byteLength === 0) throw new DocsError('The upload is empty.', 400, 'invalid_request');
  const type = sniff(bytes);
  if (!type) throw new DocsError('That file is not a PNG, JPEG, WebP or GIF image.', 400, 'invalid_request');
  const key = coverKey(row.id);
  await env.DOCS_FILES.put(key, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare(`UPDATE link_saves SET image_r2_key = ?, image_type = ? WHERE document_id = ?`)
    .bind(key, type, row.id)
    .run();
  return getDocumentDetail(env, row);
}

/** `DELETE /api/docs/:id/link-image`: the page no longer has one. */
export async function clearLinkImage(env: Env, row: DocumentRow): Promise<void> {
  await saveRow(env, row);
  await env.DB.prepare(`UPDATE link_saves SET image_r2_key = NULL, image_type = NULL WHERE document_id = ?`)
    .bind(row.id)
    .run();
}

/** The cover, from R2. Private: the caller has passed `assertCanRead`. */
export async function serveLinkImage(env: Env, row: DocumentRow): Promise<Response> {
  const save = await saveRow(env, row);
  if (!save.image_r2_key) throw new DocsError('This save has no image.', 404, 'not_found');
  const object = await env.DOCS_FILES.get(save.image_r2_key);
  if (!object) throw new DocsError('The image is missing from storage.', 404, 'not_found');
  return new Response(object.body, {
    headers: {
      'content-type': save.image_type ?? 'application/octet-stream',
      'content-length': String(object.size),
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      etag: object.httpEtag,
    },
  });
}

// ---------------------------------------------------------------------------

function coverKey(documentId: string): string {
  return `links/${documentId}/cover`;
}

async function saveRow(env: Env, row: DocumentRow): Promise<LinkSaveRow> {
  if (row.source_kind !== LINK_SOURCE_KIND) throw new DocsError('Not a link save.', 404, 'not_found');
  const save = await env.DB.prepare(`SELECT * FROM link_saves WHERE document_id = ?`).bind(row.id).first<LinkSaveRow>();
  if (!save) throw new DocsError('Not a link save.', 404, 'not_found');
  return save;
}

async function findSave(env: Env, author: string, canonical: string): Promise<DocumentRow | null> {
  return env.DB.prepare(
    `SELECT d.* FROM link_saves l
       JOIN documents d ON d.id = l.document_id
      WHERE l.created_by = ? AND l.canonical_url = ? AND d.status <> 'deleted'
      ORDER BY d.created_at DESC
      LIMIT 1`,
  )
    .bind(author, canonical)
    .first<DocumentRow>();
}

async function reopen(env: Env, row: DocumentRow, writer: Writer): Promise<DocumentDetail> {
  if (row.status === 'archived') {
    await env.DB.prepare(
      `UPDATE documents SET status = 'active', updated_at = ?, updated_by = ?, updated_by_kind = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), writer.actor, writer.kind, row.id)
      .run();
  }
  return getDocumentDetail(env, (await getDocumentById(env, row.id)) ?? row);
}
