// Images on a document ( slice 2): screenshots a person
// attaches, on a link save first. Reads for lists live in documents.ts beside
// tags and subjects; this file is upload, serve and remove.

import { IMAGE_MAX_BYTES, IMAGES_PER_DOCUMENT_MAX, type DocumentImage } from '@docs/contracts';
import { sha256Hex, uuid } from './crypto';
import { DocsError, NotFoundError } from './errors';
import type { DocumentRow, Writer } from './documents';
import { readBoundedBytes } from './http';

export interface DocumentImageRow {
  id: string;
  document_id: string;
  r2_key: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  caption: string | null;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
}

export function toImage(row: DocumentImageRow): DocumentImage {
  return {
    id: row.id,
    content_type: row.content_type,
    byte_size: row.byte_size,
    caption: row.caption,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

/**
 * The type the bytes say they are. The header is not trusted: an SVG or an
 * HTML page labelled image/png is refused, since it would be served back to
 * a viewer.
 */
export function sniff(bytes: Uint8Array): string | null {
  const at = (offset: number, magic: number[]) => magic.every((byte, index) => bytes[offset + index] === byte);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

export async function listImages(env: Env, documentId: string): Promise<DocumentImage[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM document_images WHERE document_id = ? AND deleted_at IS NULL ORDER BY created_at`,
  )
    .bind(documentId)
    .all<DocumentImageRow>();
  return results.map(toImage);
}

/** `POST /api/docs/:id/images`, the raw bytes as the body; `?caption=` optional. */
export async function uploadImage(
  env: Env,
  request: Request,
  document: DocumentRow,
  writer: Writer,
  caption: string | null,
): Promise<DocumentImage> {
  if (document.editable !== 1) throw new DocsError('This document is read-only.', 409, 'read_only');
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM document_images WHERE document_id = ? AND deleted_at IS NULL`,
  )
    .bind(document.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= IMAGES_PER_DOCUMENT_MAX) {
    throw new DocsError(`A document holds at most ${IMAGES_PER_DOCUMENT_MAX} images.`, 409, 'conflict');
  }

  const bytes = await readBoundedBytes(request, IMAGE_MAX_BYTES);
  if (bytes.byteLength === 0) throw new DocsError('The upload is empty.', 400, 'invalid_request');
  const type = sniff(bytes);
  if (!type) throw new DocsError('That file is not a PNG, JPEG, WebP or GIF image.', 400, 'invalid_request');

  const id = uuid();
  const key = `documents/${document.id}/images/${id}`;
  const hash = await sha256Hex(bytes);
  await env.DOCS_FILES.put(key, bytes, {
    httpMetadata: { contentType: type },
    customMetadata: { document_id: document.id, sha256: hash },
  });
  const trimmed = caption?.trim().slice(0, 500) || null;
  await env.DB.prepare(
    `INSERT INTO document_images (id, document_id, r2_key, content_type, byte_size, sha256, caption, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, document.id, key, type, bytes.byteLength, hash, trimmed, writer.actor)
    .run();
  const row = await imageRow(env, document.id, id);
  return toImage(row);
}

/** The bytes. Private: the caller has passed `assertCanRead`. */
export async function serveImage(env: Env, documentId: string, imageId: string): Promise<Response> {
  const row = await imageRow(env, documentId, imageId);
  const object = await env.DOCS_FILES.get(row.r2_key);
  if (!object) throw new DocsError('The image is missing from storage.', 404, 'not_found');
  return new Response(object.body, {
    headers: {
      'content-type': row.content_type,
      'content-length': String(row.byte_size),
      'cache-control': 'private, max-age=86400, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      etag: `"${row.sha256}"`,
    },
  });
}

/** Soft: the row gets `deleted_at`, the object stays. */
export async function removeImage(env: Env, document: DocumentRow, imageId: string): Promise<void> {
  if (document.editable !== 1) throw new DocsError('This document is read-only.', 409, 'read_only');
  await imageRow(env, document.id, imageId);
  await env.DB.prepare(`UPDATE document_images SET deleted_at = ? WHERE id = ? AND document_id = ?`)
    .bind(new Date().toISOString(), imageId, document.id)
    .run();
}

async function imageRow(env: Env, documentId: string, imageId: string): Promise<DocumentImageRow> {
  const row = await env.DB.prepare(
    `SELECT * FROM document_images WHERE id = ? AND document_id = ? AND deleted_at IS NULL`,
  )
    .bind(imageId, documentId)
    .first<DocumentImageRow>();
  if (!row) throw new NotFoundError('No such image.');
  return row;
}
