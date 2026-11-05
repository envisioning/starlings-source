import {
  type ControlErrorBody,
  type DocsAnnotationResponse,
  type DocsCategoriesResponse,
  type DocsCategoryRow,
  type DocsAnnotationsResponse,
  type DocsCreateDocumentResponse,
  type DocsDocumentResponse,
  type DocsDocumentsResponse,
  type DocsSearchResponse,
  type DocsSummaryResponse,
  type DocsTreeResponse,
  type DocsAccessEventsResponse,
  type DocsGrantResponse,
  type DocsGrantsResponse,
  type DocsHealthResponse,
  type DocsSignatureRequestResponse,
  type DocsSignatureRequestsResponse,
  docsGrantCreateSchema,
  docsSignatureRequestCreateSchema,
  docsAnnotationCreateSchema,
  docsAnnotationUpdateSchema,
  docsCategoryCreateSchema,
  docsCategoryIdSchema,
  docsCategoryOrderSchema,
  docsCategoryUpdateSchema,
  docsCreateDocumentSchema,
  DOCS_CREATE_BODY_MAX_BYTES,
  docsListQuerySchema,
  docsMoveDocumentSchema,
  docsSearchQuerySchema,
  docsSetSubjectsSchema,
  docsUpdateDocumentSchema,
} from '../contracts';
import { subjectAccessFor } from '../subject-access';
import { filterDocsCategories, filterDocsSearch, filterDocsSummary, filterDocsTree, filterDocuments, requireDocument, requireDocumentOfRow, requireWriteOnDocsSubjects } from '../subject-access-filters';
import {
  cancelDocsSignatureRequest,
  createDocsGrant,
  createDocsSignatureRequest,
  DocsError,
  docsHealth,
  listDocsAccessEvents,
  listDocsGrants,
  listDocsSignatureRequests,
  revokeDocsGrant,
  createDocsAnnotation,
  createDocsCategory,
  createDocsDocument,
  deleteDocsAnnotation,
  deleteDocsCategory,
  docsEnabled,
  docsSummary,
  docsTree,
  getDocsDocument,
  listDocsAnnotations,
  listDocsCategories,
  listDocsDocuments,
  moveDocsDocument,
  orderDocsCategories,
  refetchDocsLink,
  searchDocs,
  setDocsSubjects,
  updateDocsAnnotation,
  updateDocsCategory,
  updateDocsDocument,
} from '../docs';
import { assertUnderRateLimit, json, jsonConditional, readBoundedJSON } from '../http';
import { defineRoute, type Route } from '../route-types';

/** Docs is not configured on this deploy: every Docs route says so, after the session has been checked. */
export function docsUnavailable(env: Env): Response | null {
  return docsEnabled(env)
    ? null
    : json({ error: 'Docs is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
}

/**
 * Sharing a document is a write on it: a share link and a signer's link are
 * ways in, and the access log names who used them, so every route below
 * takes write access to the document's subjects (Docs gates them on
 * `grants:write` and `sign:manage` the same way).
 */
export async function requireShareable(env: Env, owner: Parameters<typeof requireDocument>[1], id: string): Promise<void> {
  await requireDocument(env, owner, id, 'write');
}

/** A transcript stays internal: no share link and no signer's link reaches it. */
export async function refuseTranscript(env: Env, ownerEmail: string, id: string): Promise<void> {
  if ((await getDocsDocument(env, ownerEmail, id)).transcript) {
    throw new DocsError('A transcript cannot be shared: it stays internal.', 400, 'invalid_request');
  }
}

/**
 * The Docs page on the web (docs/DOCS.md). Every read and write is
 * proxied: the browser holds no Docs token and Docs answers no CORS preflight
 * for Meet's origin. Members only, like the CRM family; the Worker's own token
 * for the owner is minted and cached in `docs.ts`.
 *
 * A method no row takes on one of these paths is a 404 like any other unrouted
 * path (it answered 405 while these were branches in `index.ts`).
 */
export const docsRoutes: readonly Route[] = [
  defineRoute({
    method: 'GET',
    path: '/api/docs/summary',
    gate: { kind: 'capability', capability: 'docs' },
    handler: async ({ request, env, owner }) => docsUnavailable(env)
      ?? jsonConditional(request, await filterDocsSummary(env, owner, await docsSummary(env, owner.email)) satisfies DocsSummaryResponse),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs/tree',
    gate: { kind: 'capability', capability: 'docs' },
    handler: async ({ request, env, owner }) => docsUnavailable(env)
      ?? jsonConditional(request, await filterDocsTree(env, owner, await docsTree(env, owner.email)) satisfies DocsTreeResponse),
  }),

  // Categories are the workspace's own rows (envisioning/docs migration
  // 0008): any member adds, renames, reorders and deletes them, in Docs or
  // here. Counts drop the documents on subjects this member cannot see, as
  // the summary's do.
  defineRoute({
    method: 'GET',
    path: '/api/docs/categories',
    gate: { kind: 'capability', capability: 'docs' },
    handler: async ({ request, env, owner }) => docsUnavailable(env)
      ?? jsonConditional(request, { categories: await filterDocsCategories(env, owner, await listDocsCategories(env, owner.email)) } satisfies DocsCategoriesResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs/categories',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const body = docsCategoryCreateSchema.parse(await readBoundedJSON(request));
      return json(await createDocsCategory(env, owner.email, body) satisfies DocsCategoryRow, 201);
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/docs/categories/order',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const body = docsCategoryOrderSchema.parse(await readBoundedJSON(request));
      return json({ categories: await filterDocsCategories(env, owner, await orderDocsCategories(env, owner.email, body)) } satisfies DocsCategoriesResponse);
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/docs/categories/:id',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = docsCategoryIdSchema.parse(decodeURIComponent(params.id!));
      const body = docsCategoryUpdateSchema.parse(await readBoundedJSON(request));
      return json(await updateDocsCategory(env, owner.email, id, body) satisfies DocsCategoryRow);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/docs/categories/:id',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      await deleteDocsCategory(env, owner.email, docsCategoryIdSchema.parse(decodeURIComponent(params.id!)));
      return new Response(null, { status: 204 });
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs/documents',
    gate: { kind: 'capability', capability: 'docs' },
    handler: async ({ request, env, url, owner }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const query = docsListQuerySchema.parse(Object.fromEntries(url.searchParams));
      const page = await listDocsDocuments(env, owner.email, query);
      return jsonConditional(request, filterDocuments(await subjectAccessFor(env, owner), owner, page) satisfies DocsDocumentsResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs/search',
    gate: { kind: 'capability', capability: 'docs' },
    handler: async ({ env, url, owner }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const query = docsSearchQuerySchema.parse(Object.fromEntries(url.searchParams));
      return json(await filterDocsSearch(env, owner, await searchDocs(env, owner.email, query.q, query.limit)) satisfies DocsSearchResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs/documents',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, url, owner }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      // A page from the browser can be long; the rest of the API keeps the small limit.
      const body = docsCreateDocumentSchema.parse(await readBoundedJSON(request, DOCS_CREATE_BODY_MAX_BYTES));
      // A link save reads the page: the reader's limiter applies, as it does
      // to a chat link card.
      await requireWriteOnDocsSubjects(env, owner, body.subjects);
      if (body.url) await assertUnderRateLimit(env.LINK_PREVIEW_LIMITER, request, 'link-preview');
      return json({ document: await createDocsDocument(env, owner.email, body, url.origin) } satisfies DocsCreateDocumentResponse, 201);
    },
  }),

  // Read a saved link again, through the same reader.
  defineRoute({
    method: 'POST',
    path: '/api/docs/documents/:id/refetch',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, url, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      await assertUnderRateLimit(env.LINK_PREVIEW_LIMITER, request, 'link-preview');
      const id = decodeURIComponent(params.id!);
      await requireDocument(env, owner, id, 'write');
      return json({ document: await refetchDocsLink(env, owner.email, id, url.origin) } satisfies DocsCreateDocumentResponse);
    },
  }),

  // Comments are Docs annotations, members only.
  defineRoute({
    method: 'GET',
    path: '/api/docs/documents/:id/annotations',
    gate: { kind: 'capability', capability: 'docs' },
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      await requireDocument(env, owner, id, 'read');
      return json({ annotations: await listDocsAnnotations(env, owner.email, id) } satisfies DocsAnnotationsResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs/documents/:id/annotations',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      await requireDocument(env, owner, id, 'write');
      const body = docsAnnotationCreateSchema.parse(await readBoundedJSON(request));
      return json({ annotation: await createDocsAnnotation(env, owner.email, id, body) } satisfies DocsAnnotationResponse, 201);
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/docs/annotations/:id',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      // A comment is checked against its document, as the native path does.
      await requireDocumentOfRow(env, owner, id, (documentId) => listDocsAnnotations(env, owner.email, documentId));
      const body = docsAnnotationUpdateSchema.parse(await readBoundedJSON(request));
      return json({ annotation: await updateDocsAnnotation(env, owner.email, id, body) } satisfies DocsAnnotationResponse);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/docs/annotations/:id',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      await requireDocumentOfRow(env, owner, id, (documentId) => listDocsAnnotations(env, owner.email, documentId));
      await deleteDocsAnnotation(env, owner.email, id);
      return new Response(null, { status: 204 });
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/docs/documents/:id/subjects',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      const body = docsSetSubjectsSchema.parse(await readBoundedJSON(request));
      await requireDocument(env, owner, id, 'write');
      await requireWriteOnDocsSubjects(env, owner, body.subjects);
      return json({ document: await setDocsSubjects(env, owner.email, id, body) } satisfies DocsDocumentResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs/documents/:id/move',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      const body = docsMoveDocumentSchema.parse(await readBoundedJSON(request));
      await requireDocument(env, owner, id, 'write');
      return json({ document: await moveDocsDocument(env, owner.email, id, body) } satisfies DocsDocumentResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs/documents/:id',
    gate: { kind: 'capability', capability: 'docs' },
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      await requireDocument(env, owner, id, 'read');
      return json({ document: await getDocsDocument(env, owner.email, id) } satisfies DocsDocumentResponse);
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/docs/documents/:id',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      const body = docsUpdateDocumentSchema.parse(await readBoundedJSON(request));
      await requireDocument(env, owner, id, 'write');
      return json({ document: await updateDocsDocument(env, owner.email, id, body) } satisfies DocsDocumentResponse);
    },
  }),

  // ---- sharing and signing ----------------------------
  // Docs web's staff actions, in Meet's /docs. Docs addresses a link and a
  // request by their own id; here each sits under its document, and the
  // Worker checks it belongs to that document before Docs acts on it.

  defineRoute({
    method: 'GET',
    path: '/api/docs/documents/:id/grants',
    gate: { kind: 'capability', capability: 'docs' },
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      await requireShareable(env, owner, id);
      return json({ grants: await listDocsGrants(env, owner.email, id) } satisfies DocsGrantsResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs/documents/:id/grants',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      const body = docsGrantCreateSchema.parse(await readBoundedJSON(request));
      await requireShareable(env, owner, id);
      await refuseTranscript(env, owner.email, id);
      return json({ grant: await createDocsGrant(env, owner.email, id, body) } satisfies DocsGrantResponse, 201);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/docs/documents/:id/grants/:grant',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      const grantId = decodeURIComponent(params.grant!);
      await requireShareable(env, owner, id);
      if (!(await listDocsGrants(env, owner.email, id)).some((grant) => grant.id === grantId)) {
        throw new DocsError('That share link is not on this document.', 404);
      }
      await revokeDocsGrant(env, owner.email, grantId);
      return new Response(null, { status: 204 });
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs/documents/:id/access-events',
    gate: { kind: 'capability', capability: 'docs' },
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      await requireShareable(env, owner, id);
      return json({ events: await listDocsAccessEvents(env, owner.email, id) } satisfies DocsAccessEventsResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/docs/documents/:id/signature-requests',
    gate: { kind: 'capability', capability: 'docs' },
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      await requireShareable(env, owner, id);
      return json({ requests: await listDocsSignatureRequests(env, owner.email, id) } satisfies DocsSignatureRequestsResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs/documents/:id/signature-requests',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      const body = docsSignatureRequestCreateSchema.parse(await readBoundedJSON(request));
      await requireShareable(env, owner, id);
      await refuseTranscript(env, owner.email, id);
      return json({ request: await createDocsSignatureRequest(env, owner.email, id, body) } satisfies DocsSignatureRequestResponse, 201);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/docs/documents/:id/signature-requests/:request/cancel',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      const unavailable = docsUnavailable(env);
      if (unavailable) return unavailable;
      const id = decodeURIComponent(params.id!);
      const requestId = decodeURIComponent(params.request!);
      await requireShareable(env, owner, id);
      if (!(await listDocsSignatureRequests(env, owner.email, id)).some((entry) => entry.id === requestId)) {
        throw new DocsError('That signature request is not on this document.', 404);
      }
      await cancelDocsSignatureRequest(env, owner.email, requestId);
      return new Response(null, { status: 204 });
    },
  }),

  // Whether Docs' hourly sync from Core is keeping up, for the line Docs web
  // drew over every page ("Not syncing from Core: …").
  defineRoute({
    method: 'GET',
    path: '/api/docs/health',
    gate: { kind: 'capability', capability: 'docs' },
    handler: async ({ env }) => docsUnavailable(env) ?? json(await docsHealth(env) satisfies DocsHealthResponse),
  }),
];
