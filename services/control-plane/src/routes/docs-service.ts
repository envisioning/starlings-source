import {
  type ControlErrorBody,
  type DocsCategoryRow,
  type DocsDocumentsResponse,
  type DocsSearchResponse,
  type DocsSummaryResponse,
  type DocsTreeResponse,
  DOCS_CREATE_BODY_MAX_BYTES,
  docsCategoriesResponseSchema,
  docsCategoryIdSchema,
  docsDocumentsResponseSchema,
  docsSearchHitSchema,
  docsSummaryResponseSchema,
  docsTreeResponseSchema,
} from '../contracts';
import {
  docsServiceCreateBodySchema,
  docsServiceDocumentIdSchema,
  docsServiceImageQuerySchema,
  docsServiceListQuerySchema,
  docsServiceRowIdSchema,
  docsServiceSearchQuerySchema,
  docsServiceSetSubjectsBodySchema,
  docsServiceWriteBodySchema,
} from '@starlings/contracts/docs-service';
import { z } from 'zod';
import type { RoleSession } from '../capabilities';
import { DocsError, docsServiceFetch, listDocsAnnotations, listDocsGrants } from '../docs';
import { json, readBoundedBytes } from '../http';
import { defineRoute, PARAMS, type Route } from '../route-types';
import { subjectAccessFor } from '../subject-access';
import {
  filterDocsCategories,
  filterDocsSearch,
  filterDocsSummary,
  filterDocsTree,
  filterDocuments,
  requireDocument,
  requireDocumentOfRow,
  requireWriteOnDocsSubjects,
} from '../subject-access-filters';
import { parseUpstream } from '../upstream';
import { docsUnavailable, refuseTranscript, requireShareable } from './docs';

// The Mac and iPhone read and write Docs through here (docs/ACCESS.md).
//
// DocsKit's `DocsClient` (core-kit) calls Docs' own paths. Its base URL is
// `<api>/docs-service` and its bearer the member's owner session, so each
// row below is one Docs path under `DOCS_SERVICE_PREFIX`, method for method.
// The rows are the allow-list: a path or a method no row takes is a 404 from
// the router. Each row checks the member's subject access with the helpers
// the web's Docs routes use (subject-access-filters.ts), then sends the
// request to Docs with the Worker's own token for the member (docs.ts) and
// relays Docs' answer:
//
// - a list, the tree, the summary, the categories and search leave out what
//   the member cannot see;
// - a document, and everything under it, answers 404 when it sits on a
//   hidden subject, and a write to it is refused;
// - a comment or share link Docs addresses by its own id is checked against
//   the document it sits on (`requireDocumentOfRow`).
//
// The body is Docs' own, so DocsKit decodes it as before. The Worker reads
// only what the check needs, and never logs a body or a token.

const DOCS_GATE = { kind: 'capability', capability: 'docs' } as const;
const DOCS_WRITE_GATE = { kind: 'capability', capability: 'docs', origin: 'trusted' } as const;

/** Docs takes images up to 10 MB (DocsKit `DocsImagePrep.maxBytes`). */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Every other JSON write: a comment, a share link, a move. A document body has its own limit. */
const WRITE_MAX_BYTES = 256 * 1024;

const RELAYED_HEADERS = ['content-type', 'content-length', 'etag', 'last-modified'] as const;

type DocsServiceMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface ServiceRequest {
  method: DocsServiceMethod;
  path: string;
  searchParams?: Record<string, string | undefined>;
  bytes?: { data: Uint8Array; contentType: string };
}

function docId(params: Readonly<Record<string, string>>): string {
  return docsServiceDocumentIdSchema.parse(decodeURIComponent(params.id!));
}

function rowId(value: string | undefined): string {
  return docsServiceRowIdSchema.parse(decodeURIComponent(value ?? ''));
}

const documentPath = (id: string, tail = '') => `/api/docs/${encodeURIComponent(id)}${tail}`;

/**
 * Docs' answer, relayed. A 401 from Docs is about the Worker's token, not
 * the member's session, so it is a 502 here: a 401 would make the app renew
 * a session that is fine.
 */
function relay(response: Response): Response {
  if (response.status === 401) {
    return json({ error: 'Docs did not accept the Worker’s token.' } satisfies ControlErrorBody, 502);
  }
  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const name of RELAYED_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

async function send(env: Env, owner: RoleSession, request: ServiceRequest): Promise<Response> {
  return docsServiceFetch(env, owner.email, request.method, request.path, {
    ...(request.searchParams ? { searchParams: request.searchParams } : {}),
    ...(request.bytes ? { bytes: request.bytes } : {}),
  });
}

/**
 * A JSON body, read within `maxBytes` and checked against `schema`, as the
 * bytes Docs gets: what the Worker read is what Docs reads.
 */
async function jsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes = WRITE_MAX_BYTES,
): Promise<{ data: Uint8Array; body: z.output<S> }> {
  const data = await readBoundedBytes(request, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new DocsError('Request body must be valid JSON.', 400, 'invalid_request');
  }
  return { data, body: schema.parse(parsed) };
}

const asJSON = (data: Uint8Array) => ({ data, contentType: 'application/json' });

/**
 * A Docs answer the Worker filters: read whole, checked against the shape
 * the web's routes read, and handed to `filter` as Docs sent it. A refusal
 * is relayed untouched.
 */
async function filtered<T>(
  response: Response,
  schema: z.ZodType,
  route: string,
  filter: (body: T) => Promise<T> | T,
): Promise<Response> {
  if (!response.ok) return relay(response);
  let body: unknown = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  if (body === null) throw new DocsError('Docs returned an invalid response.', 502);
  parseUpstream(schema, body, { source: 'docs', route, error: DocsError });
  return json((await filter(body as T)) satisfies T);
}

/** A read under one document: the document first, then Docs. */
async function underDocument(
  env: Env,
  owner: RoleSession,
  id: string,
  need: 'read' | 'write',
  request: ServiceRequest,
): Promise<Response> {
  await requireDocument(env, owner, id, need);
  return relay(await send(env, owner, request));
}

const searchHitsSchema = z.union([z.array(docsSearchHitSchema), z.looseObject({ hits: z.array(docsSearchHitSchema) })]);
const signatureRequestDocumentSchema = z.looseObject({ document_id: z.string().min(1) });

export const docsServiceRoutes: readonly Route[] = [
  // ---- lists: what the member cannot see is left out -------------------------

  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/docs/summary',
    gate: DOCS_GATE,
    handler: async ({ env, owner }) => docsUnavailable(env)
      ?? filtered<DocsSummaryResponse>(
        await send(env, owner, { method: 'GET', path: '/api/docs/summary' }),
        docsSummaryResponseSchema, 'GET /api/docs/summary',
        (body) => filterDocsSummary(env, owner, body),
      ),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/tree',
    gate: DOCS_GATE,
    handler: async ({ env, owner }) => docsUnavailable(env)
      ?? filtered<DocsTreeResponse>(
        await send(env, owner, { method: 'GET', path: '/api/tree' }),
        docsTreeResponseSchema, 'GET /api/tree',
        (body) => filterDocsTree(env, owner, body),
      ),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/docs',
    gate: DOCS_GATE,
    handler: async ({ env, url, owner }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const query = docsServiceListQuerySchema.parse(Object.fromEntries(url.searchParams));
      const view = await subjectAccessFor(env, owner);
      return filtered<DocsDocumentsResponse>(
        await send(env, owner, { method: 'GET', path: '/api/docs', searchParams: query }),
        docsDocumentsResponseSchema, 'GET /api/docs',
        (body) => filterDocuments(view, owner, body),
      );
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/search',
    gate: DOCS_GATE,
    handler: async ({ env, url, owner }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const query = docsServiceSearchQuerySchema.parse(Object.fromEntries(url.searchParams));
      // Docs answers `{hits}`, or a bare array from an older deploy; the
      // answer keeps the shape it came in.
      return filtered<DocsSearchResponse['hits'] | DocsSearchResponse>(
        await send(env, owner, { method: 'GET', path: '/api/search', searchParams: query }),
        searchHitsSchema, 'GET /api/search',
        async (body) => {
          const hits = Array.isArray(body) ? body : body.hits;
          const kept = (await filterDocsSearch(env, owner, { hits })).hits;
          return Array.isArray(body) ? kept : { ...body, hits: kept };
        },
      );
    },
  }),

  // ---- categories: the workspace's own rows, counts filtered -----------------

  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/categories',
    gate: DOCS_GATE,
    handler: async ({ env, owner }) => docsUnavailable(env)
      ?? filtered<{ categories: DocsCategoryRow[] }>(
        await send(env, owner, { method: 'GET', path: '/api/categories' }),
        docsCategoriesResponseSchema, 'GET /api/categories',
        async (body) => ({ ...body, categories: await filterDocsCategories(env, owner, body.categories) }),
      ),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs-service/api/categories',
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, owner }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const { data } = await jsonBody(request, docsServiceWriteBodySchema);
      return relay(await send(env, owner, { method: 'POST', path: '/api/categories', bytes: asJSON(data) }));
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/docs-service/api/categories/order',
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, owner }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const { data } = await jsonBody(request, docsServiceWriteBodySchema);
      return filtered<{ categories: DocsCategoryRow[] }>(
        await send(env, owner, { method: 'PUT', path: '/api/categories/order', bytes: asJSON(data) }),
        docsCategoriesResponseSchema, 'PUT /api/categories/order',
        async (body) => ({ ...body, categories: await filterDocsCategories(env, owner, body.categories) }),
      );
    },
  }),

  defineRoute({
    method: ['PATCH', 'DELETE'],
    path: '/api/docs-service/api/categories/:id',
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docsCategoryIdSchema.parse(decodeURIComponent(params.id!));
      const path = `/api/categories/${encodeURIComponent(id)}`;
      if (request.method === 'DELETE') return relay(await send(env, owner, { method: 'DELETE', path }));
      const { data } = await jsonBody(request, docsServiceWriteBodySchema);
      return relay(await send(env, owner, { method: 'PATCH', path, bytes: asJSON(data) }));
    },
  }),

  // ---- a new document ---------------------------------------------------------

  defineRoute({
    method: 'POST',
    path: '/api/docs-service/api/docs',
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, owner }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const { data, body } = await jsonBody(request, docsServiceCreateBodySchema, DOCS_CREATE_BODY_MAX_BYTES);
      await requireWriteOnDocsSubjects(env, owner, body.subjects);
      return relay(await send(env, owner, { method: 'POST', path: '/api/docs', bytes: asJSON(data) }));
    },
  }),

  // ---- comments, share links and signature requests by their own id ---------

  defineRoute({
    method: ['PATCH', 'DELETE'],
    path: '/api/docs-service/api/annotations/:annotation',
    params: { annotation: PARAMS.uuid },
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = rowId(params.annotation);
      await requireDocumentOfRow(env, owner, id, (documentId) => listDocsAnnotations(env, owner.email, documentId));
      const path = `/api/annotations/${encodeURIComponent(id)}`;
      if (request.method === 'DELETE') return relay(await send(env, owner, { method: 'DELETE', path }));
      const { data } = await jsonBody(request, docsServiceWriteBodySchema);
      return relay(await send(env, owner, { method: 'PATCH', path, bytes: asJSON(data) }));
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/docs-service/api/grants/:grant',
    params: { grant: PARAMS.uuid },
    gate: DOCS_WRITE_GATE,
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = rowId(params.grant);
      await requireDocumentOfRow(env, owner, id, (documentId) => listDocsGrants(env, owner.email, documentId));
      return relay(await send(env, owner, { method: 'DELETE', path: `/api/grants/${encodeURIComponent(id)}` }));
    },
  }),

  // Docs answers the request with its document's id; the answer is held
  // until that document checks out, so a hidden one is a 404 like any other.
  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/signature-requests/:request',
    params: { request: PARAMS.uuid },
    gate: DOCS_GATE,
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = rowId(params.request);
      const response = await send(env, owner, { method: 'GET', path: `/api/signature-requests/${encodeURIComponent(id)}` });
      return filtered<{ document_id: string }>(
        response, signatureRequestDocumentSchema, 'GET /api/signature-requests/:id',
        async (body) => {
          await requireShareable(env, owner, body.document_id);
          return body;
        },
      );
    },
  }),

  // ---- one document and what is under it --------------------------------------

  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/docs/:id',
    gate: DOCS_GATE,
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      return underDocument(env, owner, id, 'read', { method: 'GET', path: documentPath(id) });
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/docs-service/api/docs/:id',
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      const { data, body } = await jsonBody(request, docsServiceWriteBodySchema, DOCS_CREATE_BODY_MAX_BYTES);
      await requireDocument(env, owner, id, 'write');
      await requireWriteOnDocsSubjects(env, owner, body.subjects);
      return relay(await send(env, owner, { method: 'PATCH', path: documentPath(id), bytes: asJSON(data) }));
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/docs-service/api/docs/:id/subjects',
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      const { data, body } = await jsonBody(request, docsServiceSetSubjectsBodySchema);
      await requireDocument(env, owner, id, 'write');
      await requireWriteOnDocsSubjects(env, owner, body.subjects);
      return relay(await send(env, owner, { method: 'PUT', path: documentPath(id, '/subjects'), bytes: asJSON(data) }));
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs-service/api/docs/:id/move',
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      const { data } = await jsonBody(request, docsServiceWriteBodySchema);
      return underDocument(env, owner, id, 'write', { method: 'POST', path: documentPath(id, '/move'), bytes: asJSON(data) });
    },
  }),

  // Sharing is a write on the document, as on the web (routes/docs.ts).
  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/docs/:id/grants',
    gate: DOCS_GATE,
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      return underDocument(env, owner, id, 'write', { method: 'GET', path: documentPath(id, '/grants') });
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs-service/api/docs/:id/grants',
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      const { data } = await jsonBody(request, docsServiceWriteBodySchema);
      await requireShareable(env, owner, id);
      await refuseTranscript(env, owner.email, id);
      return relay(await send(env, owner, { method: 'POST', path: documentPath(id, '/grants'), bytes: asJSON(data) }));
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs-service/api/docs/:id/signature-requests',
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      const { data } = await jsonBody(request, docsServiceWriteBodySchema);
      await requireShareable(env, owner, id);
      await refuseTranscript(env, owner.email, id);
      return relay(await send(env, owner, { method: 'POST', path: documentPath(id, '/signature-requests'), bytes: asJSON(data) }));
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/docs/:id/annotations',
    gate: DOCS_GATE,
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      return underDocument(env, owner, id, 'read', { method: 'GET', path: documentPath(id, '/annotations') });
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs-service/api/docs/:id/annotations',
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      const { data } = await jsonBody(request, docsServiceWriteBodySchema);
      return underDocument(env, owner, id, 'write', { method: 'POST', path: documentPath(id, '/annotations'), bytes: asJSON(data) });
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/docs/:id/link-image',
    gate: DOCS_GATE,
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      return underDocument(env, owner, id, 'read', { method: 'GET', path: documentPath(id, '/link-image') });
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/docs/:id/images',
    gate: DOCS_GATE,
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      return underDocument(env, owner, id, 'read', { method: 'GET', path: documentPath(id, '/images') });
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs-service/api/docs/:id/images',
    gate: DOCS_WRITE_GATE,
    handler: async ({ request, env, url, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      const query = docsServiceImageQuerySchema.parse(Object.fromEntries(url.searchParams));
      const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!contentType.startsWith('image/')) throw new DocsError('An image upload needs an image content type.', 400, 'invalid_request');
      await requireDocument(env, owner, id, 'write');
      const data = await readBoundedBytes(request, IMAGE_MAX_BYTES);
      return relay(await send(env, owner, {
        method: 'POST',
        path: documentPath(id, '/images'),
        searchParams: { caption: query.caption },
        bytes: { data, contentType },
      }));
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs-service/api/docs/:id/images/:image',
    params: { image: PARAMS.uuid },
    gate: DOCS_GATE,
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      return underDocument(env, owner, id, 'read', { method: 'GET', path: documentPath(id, `/images/${encodeURIComponent(rowId(params.image))}`) });
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/docs-service/api/docs/:id/images/:image',
    params: { image: PARAMS.uuid },
    gate: DOCS_WRITE_GATE,
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docId(params);
      return underDocument(env, owner, id, 'write', { method: 'DELETE', path: documentPath(id, `/images/${encodeURIComponent(rowId(params.image))}`) });
    },
  }),
];
