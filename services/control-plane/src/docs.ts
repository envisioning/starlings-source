// Docs — the Worker's line to this workspace's Docs.
//
// The Worker proves the signed-in owner to Docs over a shared HMAC secret,
// Docs mints a token for that owner, and the Worker keeps it per isolate
// (`docsToken` below). Nothing here hands a token to a device. The web's
// Docs page (`/api/docs/*`, routes/docs.ts) and the Mac and iPhone
// (`/api/docs-service/*`, routes/docs-service.ts) both reach Docs
// through here, and those routes apply subject access to each read and write: no
// browser tab and no device holds a Docs token. See docs/DOCS.md.
//
// The hop itself goes over the `DOCS` service binding when there is one: a
// Worker cannot fetch a sibling Worker in the same account over workers.dev
// (Cloudflare answers the subrequest itself, as a 404), and the binding is
// faster besides. Local dev has no binding and falls back to DOCS_ORIGIN.

import {
  docsAnnotationSchema,
  docsCategoriesResponseSchema,
  docsCategoryRowSchema,
  docsDocumentDetailSchema,
  docsDocumentsResponseSchema,
  docsSearchHitSchema,
  docsSummaryResponseSchema,
  docsTreeResponseSchema,
  docsAccessEventsResponseSchema,
  docsGrantSchema,
  docsGrantsResponseSchema,
  docsSignatureRequestSchema,
  docsSignatureRequestsResponseSchema,
  type DocsAccessEvent,
  type DocsGrant,
  type DocsGrantCreateInput,
  type DocsHealthResponse,
  type DocsSignatureRequest,
  type DocsSignatureRequestCreateInput,
  type DocsAnnotation,
  type DocsAnnotationCreateInput,
  DocsAnnotationUpdateInput,
  type DocsCategoryCreateInput,
  type DocsCategoryOrderInput,
  type DocsCategoryRow,
  type DocsCategoryUpdateInput,
  type DocsCreateDocumentInput,
  type DocsDocumentDetail,
  type DocsDocumentsResponse,
  type DocsListQuery,
  type DocsMoveDocumentInput,
  type DocsSetSubjectsInput,
  type DocsSearchResponse,
  type DocsSummaryResponse,
  type DocsTokenResponse,
  type DocsTreeResponse,
  type DocsUpdateDocumentInput,
} from '@starlings/contracts';
import { awaitBounded } from './core-gate';
import { hmacSHA256Hex } from './crypto';
import { z } from 'zod';
import { ControlError } from './errors';
import { extractArticle, fetchPageHTML, type LinkArticle } from './link-article';
import { assertUnfurlable, LinkPreviewError, parseLinkPreview } from './link-preview';
import { previewImageBytes } from './link-preview-image';
import { parseUpstream, readRefusal, type UpstreamRead } from './upstream';
import type { MeetingLogMaterial } from './room-coordinator';

const EXCHANGE_PATH = '/api/tokens/meet-exchange';
const REQUEST_TIMEOUT_MS = 10_000;

export class DocsError extends ControlError {}

/** Where a Docs read is from, for the `upstream.shape` log. The path has no query values. */
function docsRead(route: string): UpstreamRead {
  return { source: 'docs', route, error: DocsError };
}

/**
 * A comment as Docs answers it. The anchor is checked as the clients decode
 * it: a `type` and whatever else that type carries, so a kind of anchor Meet
 * does not write (a later one) never fails the whole thread. The Worker never
 * reads the anchor, so the type stays the contract's.
 */
const docsAnnotationRow = docsAnnotationSchema.extend({
  anchor: z.looseObject({ type: z.string() }).nullable(),
}) as unknown as z.ZodType<DocsAnnotation>;
const docsAnnotationList = z.union([z.array(docsAnnotationRow), z.looseObject({ annotations: z.array(docsAnnotationRow) })]);

/** What Meet's own transcript and archive writes read back: where the document now lives. */
const docsWrittenRow = z.looseObject({ id: z.string(), path: z.string() });

/**
 * This workspace's own Docs. There is no default: a Worker without
 * DOCS_ORIGIN has no Docs, and never reaches Envisioning's.
 */
function configuredDocsOrigin(env: Env): string | null {
  return env.DOCS_ORIGIN?.trim().replace(/\/$/, '') || null;
}

function docsOrigin(env: Env): string {
  const origin = configuredDocsOrigin(env);
  if (!origin) throw new DocsError('DOCS_ORIGIN is not configured.', 503, 'not_configured');
  return origin;
}

/** The staff SPA opens a document at its path. Null when this workspace has no Docs. */
export function docsDocumentURL(env: Env, path: string): string | null {
  const origin = configuredDocsOrigin(env);
  return origin ? `${origin}${path}` : null;
}

/** Off until the shared secret and the origin are configured, so dev and tests never call out. */
export function docsEnabled(env: Env): boolean {
  return Boolean(env.DOCS_INTERNAL_SECRET?.trim() && configuredDocsOrigin(env));
}

export async function exchangeDocsToken(
  env: Env,
  ownerEmail: string,
  deviceName: string | undefined,
): Promise<DocsTokenResponse> {
  const secret = env.DOCS_INTERNAL_SECRET?.trim();
  if (!secret) throw new DocsError('DOCS_INTERNAL_SECRET is not configured.', 503, 'not_configured');
  const body = JSON.stringify({
    email: ownerEmail.trim().toLowerCase(),
    device_name: deviceName?.trim() || 'Meet',
  });
  const timestamp = String(Date.now());
  const signature = await hmacSHA256Hex(secret, `${timestamp}.${body}`);
  const request = new Request(`${docsOrigin(env)}${EXCHANGE_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // `DOCS` is typed as always present because wrangler.jsonc declares it, but
  // the test and local configs do not bind it.
  const binding = (env as { DOCS?: Fetcher }).DOCS;
  const response = await (binding ? binding.fetch(request) : fetch(request));
  const answer: unknown = await response.json().catch(() => null);
  if (!response.ok || answer === null) {
    throw new DocsError(`Docs declined to issue a token (${response.status}).`, 502);
  }
  const data = parseUpstream(z.looseObject({
    token: z.string().min(1),
    expires_at: z.string(),
    // A scope that is not a string is dropped, as before, rather than refused.
    scopes: z.array(z.unknown()).nullish(),
    email: z.string().nullish(),
  }), answer, docsRead(`POST ${EXCHANGE_PATH}`));
  return {
    token: data.token,
    scopes: (data.scopes ?? []).filter((scope): scope is string => typeof scope === 'string'),
    expires_at: data.expires_at,
    email: data.email ? data.email : ownerEmail.trim().toLowerCase(),
    origin: docsOrigin(env),
  };
}

/**
 * The Worker's own Docs token for the web, so every read and write from a
 * browser goes through here — Docs answers no CORS preflight for Meet's
 * origin, and a Docs token in a tab is a token in a tab. The apps use the
 * same token through `/api/docs-service`.
 *
 * Minting on every call would be worse than wasteful: Docs revokes the prior
 * token of the same device name on every mint, so two overlapping calls for
 * the same owner were never independent — the second mint could revoke the
 * first token out from under an in-flight read. `docsTokenCache` and
 * `docsTokenMints` cache the minted token per owner until just before it
 * expires and dedupe concurrent mints onto one in-flight exchange, the same
 * shape as `corePat` in `crm.ts`. Isolate-local, so `docsFetch` also retries
 * once on an actual 401 rather than trusting the cache alone.
 */
const WEB_DEVICE_NAME = 'Meet web';
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 10_000;

interface CachedDocsToken {
  token: string;
  expiresAt: number;
}

let docsTokenCache = new Map<string, CachedDocsToken>();
let docsTokenMints = new Map<string, Promise<CachedDocsToken>>();

export function resetDocsTokenCache(): void {
  docsTokenCache = new Map();
  docsTokenMints = new Map();
}

function docsTokenKey(ownerEmail: string): string {
  return ownerEmail.trim().toLowerCase();
}

async function docsToken(env: Env, ownerEmail: string): Promise<string> {
  const key = docsTokenKey(ownerEmail);
  const cached = docsTokenCache.get(key);
  if (cached && cached.expiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  const inFlight = docsTokenMints.get(key);
  if (inFlight) {
    // Another request's mint. That request can be cancelled and then this
    // promise never settles, so wait a bounded time, then mint here.
    const shared = await awaitBounded(inFlight);
    if (shared) return shared.value.token;
  }

  // Set before the first await: with no mint in flight, nothing yields between
  // `.get` above and `.set` here, so a concurrent caller sees this promise and
  // does not start a mint of its own. Only a mint that outlived the bounded
  // wait gets a second.
  const minted = exchangeDocsToken(env, ownerEmail, WEB_DEVICE_NAME)
    .then((result) => {
      const entry: CachedDocsToken = { token: result.token, expiresAt: Date.parse(result.expires_at) };
      docsTokenCache.set(key, entry);
      return entry;
    })
    .finally(() => {
      // A stuck mint's late settle must not drop the mint that replaced it.
      if (docsTokenMints.get(key) === minted) docsTokenMints.delete(key);
    });
  docsTokenMints.set(key, minted);
  return (await minted).token;
}

interface DocsFetchInit {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  searchParams?: Record<string, string | undefined>;
  body?: unknown;
  /** A binary body instead of JSON: an image. */
  bytes?: { data: Uint8Array; contentType: string };
}

/** One request to Docs as the owner, over the binding when there is one. */
async function docsFetch(env: Env, ownerEmail: string, path: string, init: DocsFetchInit): Promise<Response> {
  const url = new URL(`${docsOrigin(env)}${path}`);
  for (const [key, value] of Object.entries(init.searchParams ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  const binding = (env as { DOCS?: Fetcher }).DOCS;
  const send = (token: string) => {
    const request = new Request(url, {
      method: init.method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.bytes ? { 'content-type': init.bytes.contentType }
          : init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.bytes ? { body: init.bytes.data as unknown as BodyInit }
        : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return binding ? binding.fetch(request) : fetch(request);
  };

  const response = await send(await docsToken(env, ownerEmail));
  if (response.status !== 401) return response;

  // Revoked from outside this cache's control — another isolate, a cold
  // start. Mint fresh and try exactly once more.
  docsTokenCache.delete(docsTokenKey(ownerEmail));
  return send(await docsToken(env, ownerEmail));
}

/**
 * One request to Docs as the owner for the Mac and iPhone pass-through
 * (`routes/docs-service.ts`), with the Worker's token for the owner. The
 * answer is Docs' own; the route checks it before it relays it.
 */
export function docsServiceFetch(
  env: Env,
  ownerEmail: string,
  method: DocsFetchInit['method'],
  path: string,
  init: Pick<DocsFetchInit, 'searchParams' | 'bytes'> = {},
): Promise<Response> {
  return docsFetch(env, ownerEmail, path, { method, ...init });
}

/**
 * Docs' answer as JSON, or a `DocsError` the browser can branch on. A
 * client-caused refusal keeps Docs' status and prose (404, 400, 409
 * `hash_mismatch`, 429); anything else Docs says is a 502 from here, because
 * the browser was talking to Meet.
 */
async function docsJSON<S extends z.ZodType>(response: Response, schema: S, route: string, fallback: string): Promise<z.output<S>> {
  const data: unknown = await response.json().catch(() => null);
  if (response.ok && data !== null) return parseUpstream(schema, data, docsRead(route));
  const refusal = readRefusal(data);
  const message = refusal.error ?? fallback;
  const code = refusal.code;
  if (response.status === 409 && code === 'hash_mismatch') throw new DocsError(message, 409, 'hash_mismatch');
  // A name or id taken: a category's label clash. Docs' prose says which.
  if (response.status === 409) throw new DocsError(message, 409);
  if (response.status === 429) throw new DocsError(message, 429, 'rate_limited');
  if (response.status === 400) throw new DocsError(message, 400, 'invalid_request');
  if (response.status === 404) throw new DocsError(message, 404);
  throw new DocsError(`${fallback} (${response.status}).`, 502);
}

export async function docsSummary(env: Env, ownerEmail: string): Promise<DocsSummaryResponse> {
  const response = await docsFetch(env, ownerEmail, '/api/docs/summary', { method: 'GET' });
  return docsJSON(response, docsSummaryResponseSchema, 'GET /api/docs/summary', 'Docs could not summarize the corpus');
}

// ---- categories -------------------------------------------------------------
// The workspace's own list (envisioning/docs migration 0008): rows people add,
// rename, reorder and delete. Changing it takes `folders:write` on Docs, a
// scope the exchanged token carries.

export async function listDocsCategories(env: Env, ownerEmail: string): Promise<DocsCategoryRow[]> {
  const response = await docsFetch(env, ownerEmail, '/api/categories', { method: 'GET' });
  return (await docsJSON(response, docsCategoriesResponseSchema, 'GET /api/categories', 'Docs could not list its categories')).categories;
}

/**
 * Each category's label by id, for a row that names a document's category
 * (search, favorites). Best effort: a Docs older than the list, or one that
 * fails, leaves the rows to say where the document came from.
 */
export async function docsCategoryLabels(env: Env, ownerEmail: string): Promise<Map<string, string>> {
  try {
    return new Map((await listDocsCategories(env, ownerEmail)).map((category) => [category.id, category.label]));
  } catch {
    return new Map();
  }
}

export async function createDocsCategory(env: Env, ownerEmail: string, input: DocsCategoryCreateInput): Promise<DocsCategoryRow> {
  const response = await docsFetch(env, ownerEmail, '/api/categories', { method: 'POST', body: input });
  return docsJSON(response, docsCategoryRowSchema, 'POST /api/categories', 'Docs declined to add the category');
}

export async function updateDocsCategory(env: Env, ownerEmail: string, id: string, input: DocsCategoryUpdateInput): Promise<DocsCategoryRow> {
  const response = await docsFetch(env, ownerEmail, `/api/categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: input });
  return docsJSON(response, docsCategoryRowSchema, 'PATCH /api/categories/:id', 'Docs declined to change the category');
}

export async function orderDocsCategories(env: Env, ownerEmail: string, input: DocsCategoryOrderInput): Promise<DocsCategoryRow[]> {
  const response = await docsFetch(env, ownerEmail, '/api/categories/order', { method: 'PUT', body: input });
  return (await docsJSON(response, docsCategoriesResponseSchema, 'PUT /api/categories/order', 'Docs declined the new order')).categories;
}

/** Its documents become uncategorized; Docs changes nothing else about them. */
export async function deleteDocsCategory(env: Env, ownerEmail: string, id: string): Promise<void> {
  const response = await docsFetch(env, ownerEmail, `/api/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (response.ok) return;
  await docsJSON(response, z.unknown(), 'DELETE /api/categories/:id', 'Docs declined to delete the category');
}

export async function docsTree(env: Env, ownerEmail: string): Promise<DocsTreeResponse> {
  const response = await docsFetch(env, ownerEmail, '/api/tree', { method: 'GET' });
  return docsJSON(response, docsTreeResponseSchema, 'GET /api/tree', 'Docs could not list its folders');
}

/**
 * `status` is the Worker's own: a check that must also find archived
 * documents (`requireDocumentOfRow`) asks for them. No client sends it.
 */
export async function listDocsDocuments(
  env: Env,
  ownerEmail: string,
  query: DocsListQuery,
  status?: 'archived',
): Promise<DocsDocumentsResponse> {
  const response = await docsFetch(env, ownerEmail, '/api/docs', {
    method: 'GET',
    searchParams: {
      ...(status ? { status } : {}),
      category: query.category,
      source: query.source,
      prefix: query.prefix,
      folder: query.folder,
      subject: query.subject,
      source_kind: query.source_kind,
      ...(query.open_annotations ? { open_annotations: '1' } : {}),
      ...(query.unfiled ? { unfiled: '1' } : {}),
      limit: String(query.limit),
      ...(query.offset ? { offset: String(query.offset) } : {}),
    },
  });
  return docsJSON(response, docsDocumentsResponseSchema, 'GET /api/docs', 'Docs could not list documents');
}

export async function searchDocs(env: Env, ownerEmail: string, q: string, limit: number): Promise<DocsSearchResponse> {
  const response = await docsFetch(env, ownerEmail, '/api/search', {
    method: 'GET',
    searchParams: { q, limit: String(limit) },
  });
  // Docs answers the hits as a bare array; the browser reads an object, so a
  // later field (total, next page) is an addition and not a reshape.
  const hits = await docsJSON(response, z.union([z.array(docsSearchHitSchema), z.looseObject({ hits: z.array(docsSearchHitSchema) })]), 'GET /api/search', 'Docs could not search');
  return { hits: Array.isArray(hits) ? hits : hits.hits };
}

export async function getDocsDocument(env: Env, ownerEmail: string, id: string): Promise<DocsDocumentDetail> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}`, { method: 'GET' });
  return docsJSON(response, docsDocumentDetailSchema, 'GET /api/docs/:id', 'Docs could not read the document');
}

export async function updateDocsDocument(
  env: Env,
  ownerEmail: string,
  id: string,
  input: DocsUpdateDocumentInput,
): Promise<DocsDocumentDetail> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
  return docsJSON(response, docsDocumentDetailSchema, 'PATCH /api/docs/:id', 'Docs declined to update the document');
}

/** Archive a document Meet filed — a discarded meeting's transcript. A 404 is fine: already gone. */
export async function archiveDocsDocument(
  env: Env,
  ownerEmail: string,
  id: string,
  message = 'Discarded from Starlings: the meeting ran under five minutes',
): Promise<void> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { status: 'archived', message },
  });
  if (response.status === 404) return;
  await docsJSON(response, z.unknown(), 'PATCH /api/docs/:id', 'Docs declined to archive the transcript');
}

/**
 * Remove a document outright — the row and every version (Docs `?purge=1`).
 * For a transcript that must not stay readable anywhere: a meeting filed as
 * personal. A 404 is fine: already gone.
 */
export async function purgeDocsDocument(env: Env, ownerEmail: string, id: string): Promise<void> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    searchParams: { purge: '1' },
  });
  if (response.status === 404 || response.status === 204) return;
  await docsJSON(response, z.unknown(), 'DELETE /api/docs/:id', 'Docs declined to purge the transcript');
}

export async function setDocsSubjects(
  env: Env,
  ownerEmail: string,
  id: string,
  input: DocsSetSubjectsInput,
): Promise<DocsDocumentDetail> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}/subjects`, {
    method: 'PUT',
    body: input,
  });
  return docsJSON(response, docsDocumentDetailSchema, 'PUT /api/docs/:id/subjects', 'Docs declined to change the subjects');
}

export async function moveDocsDocument(
  env: Env,
  ownerEmail: string,
  id: string,
  input: DocsMoveDocumentInput,
): Promise<DocsDocumentDetail> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}/move`, {
    method: 'POST',
    body: input,
  });
  return docsJSON(response, docsDocumentDetailSchema, 'POST /api/docs/:id/move', 'Docs declined to move the document');
}

// Comments are Docs annotations. Docs answers a bare array on
// the list; the browser reads an object, like search.
export async function listDocsAnnotations(env: Env, ownerEmail: string, id: string): Promise<DocsAnnotation[]> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}/annotations`, { method: 'GET' });
  const body = await docsJSON(response, docsAnnotationList, 'GET /api/docs/:id/annotations', 'Docs could not list the comments');
  return Array.isArray(body) ? body : body.annotations;
}

export async function createDocsAnnotation(
  env: Env,
  ownerEmail: string,
  id: string,
  input: DocsAnnotationCreateInput,
): Promise<DocsAnnotation> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}/annotations`, {
    method: 'POST',
    body: input,
  });
  return docsJSON(response, docsAnnotationRow, 'POST /api/docs/:id/annotations', 'Docs declined the comment');
}

export async function updateDocsAnnotation(
  env: Env,
  ownerEmail: string,
  id: string,
  input: DocsAnnotationUpdateInput,
): Promise<DocsAnnotation> {
  const response = await docsFetch(env, ownerEmail, `/api/annotations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
  return docsJSON(response, docsAnnotationRow, 'PATCH /api/annotations/:id', 'Docs declined to change the comment');
}

export async function deleteDocsAnnotation(env: Env, ownerEmail: string, id: string): Promise<void> {
  const response = await docsFetch(env, ownerEmail, `/api/annotations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (response.ok) return;
  await docsJSON(response, z.unknown(), 'DELETE /api/annotations/:id', 'Docs declined to delete the comment');
}

/**
 * Write one document on the owner's behalf: a Quick Note filed as a Doc, or
 * New on the Docs page. Docs answers the whole detail; the browser keeps it.
 */
export async function createDocsDocument(
  env: Env,
  ownerEmail: string,
  input: DocsCreateDocumentInput,
  origin = '',
): Promise<DocsDocumentDetail> {
  if (input.url) return saveDocsLink(env, ownerEmail, input, origin);
  const response = await docsFetch(env, ownerEmail, '/api/docs', {
    method: 'POST',
    body: {
      title: input.title,
      body_md: input.body_md,
      folder_path: input.folder_path ?? '/work',
      ...(input.category ? { category: input.category } : {}),
      ...(input.subjects?.length ? { subjects: input.subjects } : {}),
      ...(input.frontmatter ? { frontmatter: input.frontmatter } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      message: input.message ?? 'Created from Starlings',
    },
  });
  return docsJSON(response, docsDocumentDetailSchema, 'POST /api/docs', 'Docs declined to create the document');
}

/**
 * A link save. The page is read here, by the Worker's one reader
 * (`link-preview.ts`, the same one behind every chat link card), and Docs is
 * told what it said: Docs never fetches a URL (decision 13). The article goes
 * in the body under the person's notes (`link-article.ts`); a paywalled page
 * keeps what it shows without a subscription and says so. The cover goes up
 * after, as bytes. A page that cannot be read still saves; the URL is the
 * thing kept.
 *
 * `page_html` is the page as the person's browser drew it (the bookmarklet):
 * no fetch, and a page behind a sign-in or a subscription saves whole.
 * Saving a page the owner saved before answers that save, unchanged — unless
 * the browser sent the page: then its article replaces the saved one and the
 * notes stay.
 */
async function saveDocsLink(env: Env, ownerEmail: string, input: DocsCreateDocumentInput, origin: string): Promise<DocsDocumentDetail> {
  const page = await readPageForSave(env, origin, input.url!, input.page_html);
  const body = linkSaveBody(input.body_md, page.article);
  const response = await docsFetch(env, ownerEmail, '/api/docs', {
    method: 'POST',
    body: {
      url: input.url,
      link: page.link,
      ...(input.title ?? page.title ? { title: input.title ?? page.title } : {}),
      ...(body ? { body_md: body } : {}),
      ...(input.folder_path ? { folder_path: input.folder_path } : {}),
      ...(input.frontmatter ? { frontmatter: input.frontmatter } : {}),
      ...(input.subjects?.length ? { subjects: input.subjects } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      message: input.message ?? 'Saved from Starlings',
    },
  });
  let saved = await docsJSON(response, docsDocumentDetailSchema, 'POST /api/docs', 'Docs declined to save the link');
  // 200 is Docs' "you saved this before".
  if (response.status === 200 && input.page_html !== undefined && page.article) {
    const notes = [linkSaveNotes(saved.body_md ?? ''), input.body_md.trim()].filter(Boolean).join('\n\n');
    saved = await updateDocsDocument(env, ownerEmail, saved.id, {
      body_md: linkSaveBody(notes, page.article),
      message: 'Saved again from the browser',
    });
  }
  if (!page.image || saved.link?.has_image) return saved;
  return putLinkCover(env, ownerEmail, saved, page.image);
}

/**
 * The line that opens the article in a save's body: where it came from and
 * when. Everything above it is the person's notes, which is how a later save
 * from the browser replaces the article and keeps them.
 */
const ARTICLE_LINE = /^\*Saved from \S+ on \d{4}-\d{2}-\d{2}\.\*$/mu;
const PAYWALL_LINE = '> Paywalled. Saved what the page shows without a subscription.';

/** The person's notes, then the article under a rule. */
export function linkSaveBody(notes: string | undefined, article: LinkArticle | undefined, today = new Date()): string {
  const parts = [notes?.trim() ?? ''];
  if (article) {
    parts.push([
      `*Saved from ${article.host} on ${today.toISOString().slice(0, 10)}.*`,
      ...(article.paywalled ? [PAYWALL_LINE] : []),
      article.markdown,
    ].join('\n\n'));
  }
  return parts.filter(Boolean).join('\n\n---\n\n');
}

/** A save's body without its article: the notes `linkSaveBody` put on top. */
export function linkSaveNotes(body: string): string {
  const match = ARTICLE_LINE.exec(body);
  if (!match) return body.trim();
  return body.slice(0, match.index).replace(/\n*-{3,}\s*$/u, '').trim();
}

/**
 * Read again: the site was down, or it changed. The title stays (the person
 * may have edited it); the metadata and the cover are replaced.
 */
export async function refetchDocsLink(env: Env, ownerEmail: string, id: string, origin: string): Promise<DocsDocumentDetail> {
  const current = await getDocsDocument(env, ownerEmail, id);
  if (!current.link) throw new DocsError('That document is not a saved link.', 404);
  const page = await readPageForSave(env, origin, current.link.url);
  const path = `/api/docs/${encodeURIComponent(current.id)}`;
  const updated = await docsJSON(
    await docsFetch(env, ownerEmail, `${path}/link`, { method: 'PUT', body: page.link }),
    docsDocumentDetailSchema, 'PUT /api/docs/:id/link', 'Docs declined to update the link',
  );
  if (page.image) return putLinkCover(env, ownerEmail, updated, page.image);
  if (page.link.fetch_status === 'ok' && updated.link?.has_image) {
    // The page no longer names a picture: the old one is not its cover.
    await docsFetch(env, ownerEmail, `${path}/link-image`, { method: 'DELETE' });
    return getDocsDocument(env, ownerEmail, current.id);
  }
  return updated;
}

async function putLinkCover(
  env: Env,
  ownerEmail: string,
  saved: DocsDocumentDetail,
  image: { bytes: Uint8Array; contentType: string },
): Promise<DocsDocumentDetail> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(saved.id)}/link-image`, {
    method: 'PUT',
    bytes: { data: image.bytes, contentType: image.contentType },
  });
  // A cover Docs refused is not a failed save: the save stands without it.
  if (!response.ok) return saved;
  return docsJSON(response, docsDocumentDetailSchema, 'PUT /api/docs/:id/link-image', 'Docs declined the cover');
}

interface PageForSave {
  title?: string;
  link: {
    canonical_url?: string;
    site_name?: string | null;
    description?: string | null;
    fetch_status: 'ok' | 'failed' | 'skipped';
    fetch_error?: string | null;
  };
  image?: { bytes: Uint8Array; contentType: string };
  article?: LinkArticle;
}

/**
 * What the reader found, in the words Docs stores. Never throws. `html` is
 * the page as the person's browser drew it; without it the Worker fetches.
 */
async function readPageForSave(env: Env, origin: string, url: string, html?: string): Promise<PageForSave> {
  try {
    // One read for both: the card's metadata from the head, the article from the rest.
    const page = html === undefined ? await fetchPageHTML(url) : { html, url: assertUnfurlable(url) };
    const preview = await parseLinkPreview(
      new Response(page.html, { headers: { 'content-type': 'text/html' } }),
      page.url,
      { env, origin: origin || 'https://meet.invalid' },
    );
    const image = preview.image_url ? await previewImageBytes(env, preview.image_url) : null;
    // The browser drew the page for its reader: a subscriber's copy is whole,
    // whatever the page's paywall markup says.
    const read = extractArticle(page.html, page.url);
    const article = read && html !== undefined ? { ...read, paywalled: false } : read;
    return {
      ...(preview.title ? { title: preview.title } : {}),
      link: {
        canonical_url: preview.url,
        site_name: preview.site_name,
        description: preview.description,
        fetch_status: 'ok',
      },
      ...(image ? { image } : {}),
      ...(article ? { article } : {}),
    };
  } catch (error) {
    const message = error instanceof LinkPreviewError ? error.message : 'That link could not be read.';
    // 415 is the reader's "not a page" (a PDF, an image): nothing to read, not a failure.
    const skipped = error instanceof LinkPreviewError && error.status === 415;
    return { link: { fetch_status: skipped ? 'skipped' : 'failed', fetch_error: message } };
  }
}

// ---- sharing and signing -----------------------------
// The staff actions Docs web had, for Meet's /docs. The exchanged token holds
// `grants:write` and `sign:manage`; Docs attributes every link and request to
// the person. Revoke and cancel are addressed by their own id on Docs, so the
// route checks the id belongs to the document it names (routes/docs.ts).

export async function listDocsGrants(env: Env, ownerEmail: string, id: string): Promise<DocsGrant[]> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}/grants`, { method: 'GET' });
  return (await docsJSON(response, docsGrantsResponseSchema, 'GET /api/docs/:id/grants', 'Docs could not list the share links')).grants;
}

/** A transcript cannot be shared: Docs answers 400 with its reason, which passes through. */
export async function createDocsGrant(env: Env, ownerEmail: string, id: string, input: DocsGrantCreateInput): Promise<DocsGrant> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}/grants`, { method: 'POST', body: input });
  return docsJSON(response, docsGrantSchema, 'POST /api/docs/:id/grants', 'Docs declined to create the share link');
}

export async function revokeDocsGrant(env: Env, ownerEmail: string, grantId: string): Promise<void> {
  const response = await docsFetch(env, ownerEmail, `/api/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
  if (response.ok) return;
  await docsJSON(response, z.unknown(), 'DELETE /api/grants/:id', 'Docs declined to revoke the share link');
}

export async function listDocsAccessEvents(env: Env, ownerEmail: string, id: string): Promise<DocsAccessEvent[]> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}/access-events`, { method: 'GET' });
  const { events } = await docsJSON(response, docsAccessEventsResponseSchema, 'GET /api/docs/:id/access-events', 'Docs could not read the access log');
  // An upstream read keeps fields it does not name, so the visitor's IP is
  // left out here by hand: it stays on Docs.
  return events.map((event) => ({
    id: event.id,
    actor: event.actor,
    actor_kind: event.actor_kind,
    kind: event.kind,
    ...(event.referrer !== undefined ? { referrer: event.referrer } : {}),
    ...(event.timezone !== undefined ? { timezone: event.timezone } : {}),
    ...(event.language !== undefined ? { language: event.language } : {}),
    created_at: event.created_at,
  }));
}

/** The certificate stays a page of the Docs app; Meet links to it. */
function withCertificate(env: Env, request: DocsSignatureRequest): DocsSignatureRequest {
  return { ...request, certificate_url: docsDocumentURL(env, `/certificate/${encodeURIComponent(request.id)}`) };
}

export async function listDocsSignatureRequests(env: Env, ownerEmail: string, id: string): Promise<DocsSignatureRequest[]> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}/signature-requests`, { method: 'GET' });
  const { requests } = await docsJSON(response, docsSignatureRequestsResponseSchema, 'GET /api/docs/:id/signature-requests', 'Docs could not list the signature requests');
  return requests.map((request) => withCertificate(env, request));
}

export async function createDocsSignatureRequest(
  env: Env,
  ownerEmail: string,
  id: string,
  input: DocsSignatureRequestCreateInput,
): Promise<DocsSignatureRequest> {
  const response = await docsFetch(env, ownerEmail, `/api/docs/${encodeURIComponent(id)}/signature-requests`, { method: 'POST', body: input });
  return withCertificate(env, await docsJSON(response, docsSignatureRequestSchema, 'POST /api/docs/:id/signature-requests', 'Docs declined the signature request'));
}

/** Only a pending request can be cancelled: Docs answers 409 otherwise, which passes through. */
export async function cancelDocsSignatureRequest(env: Env, ownerEmail: string, requestId: string): Promise<void> {
  const response = await docsFetch(env, ownerEmail, `/api/signature-requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', body: {} });
  if (response.ok) return;
  await docsJSON(response, z.unknown(), 'POST /api/signature-requests/:id/cancel', 'Docs declined to cancel the signature request');
}

const docsHealthBody = z.looseObject({
  ok: z.boolean(),
  unhealthy: z.array(z.string()).optional(),
});

/**
 * Docs' own health: the Core surfaces its hourly sync is not keeping up
 * with. Public on Docs, so no token. Docs answers 503 when a surface is
 * unhealthy; that is the answer here, not a failure.
 */
export async function docsHealth(env: Env): Promise<DocsHealthResponse> {
  const request = new Request(`${docsOrigin(env)}/api/health`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const binding = (env as { DOCS?: Fetcher }).DOCS;
  const response = await (binding ? binding.fetch(request) : fetch(request));
  const data: unknown = await response.json().catch(() => null);
  if ((!response.ok && response.status !== 503) || data === null) {
    throw new DocsError(`Docs could not report its health (${response.status}).`, 502);
  }
  const health = parseUpstream(docsHealthBody, data, docsRead('GET /api/health'));
  return { ok: health.ok, unhealthy: health.unhealthy ?? [] };
}

// ---- meeting transcripts --------------------------------------------------

/** Where Meet files a meeting's transcript. */
const TRANSCRIPT_FOLDER = '/work/meetings';
const TRANSCRIPT_MAX_BYTES = 1_500_000;

/** `**Alice** (00:01:12): …` — offsets from meeting start, one block a segment. */
export function transcriptMarkdown(material: MeetingLogMaterial): string {
  const people = material.participants.map((p) => p.name.trim() || p.email).filter(Boolean).join(', ');
  return transcriptDocumentBody({
    head: `Meeting in /${material.roomSlug} on ${new Date(material.startedAt).toISOString().slice(0, 10)}.`,
    people,
    transcript: material.transcript,
  });
}

/** The transcript document's body, for whichever source captured it. */
export function transcriptDocumentBody(input: {
  head: string;
  people: string;
  transcript: Array<{ speaker_name: string; starts_at_ms: number; text: string }>;
}): string {
  const lines = input.transcript.map((segment) => {
    const total = Math.floor(segment.starts_at_ms / 1000);
    const clock = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
      .map((part) => String(part).padStart(2, '0'))
      .join(':');
    const speaker = segment.speaker_name.trim() || 'Speaker';
    return `**${speaker}** (${clock}): ${segment.text.trim()}`;
  });
  const head = [
    input.head,
    input.people ? `Participants: ${input.people}.` : null,
    'Audio and video were not recorded.',
  ].filter(Boolean).join(' ');
  return `${head}\n\n## Transcript\n\n${lines.join('\n\n')}`.slice(0, TRANSCRIPT_MAX_BYTES);
}

/**
 * File the meeting's transcript in Docs as the owner: a `transcript` document
 * under /work/meetings, about the lead or project the meeting was filed on.
 * A meeting that already has one gets its body replaced (a retried job, or a
 * re-categorized meeting), never a second document. Core keeps the pointer.
 */
export async function fileTranscript(
  env: Env,
  material: MeetingLogMaterial,
): Promise<{ id: string; path: string }> {
  return fileTranscriptDocument(env, material.ownerEmail, {
    title: `${material.title?.trim() || `Starlings · ${material.roomSlug}`} — transcript`,
    body_md: transcriptMarkdown(material),
    existingId: material.transcriptDocumentId,
    subjects: transcriptSubjects(material.meetingKind, material.leadId, material.projectId, null, material.partnerOrganizationId),
    message: 'from Starlings',
    occurredAt: new Date(material.startedAt).toISOString(),
  });
}

/** The Docs subject a filed meeting's transcript is about, if any. */
export function transcriptSubjects(
  meetingKind: string | null,
  leadId: string | null,
  projectId: string | null,
  eventId: string | null = null,
  partnerOrganizationId: string | null = null,
): Array<{ kind: string; subject_id: string }> {
  if (meetingKind === 'lead' && leadId) return [{ kind: 'lead', subject_id: leadId }];
  if (meetingKind === 'project' && projectId) return [{ kind: 'project', subject_id: projectId }];
  if (meetingKind === 'event' && eventId) return [{ kind: 'event', subject_id: eventId }];
  if (meetingKind === 'partner' && partnerOrganizationId) return [{ kind: 'partner', subject_id: partnerOrganizationId }];
  return [];
}

/**
 * A transcript's own path segment. The title alone collided: a company holds
 * many meetings called "Status", the second one 409'd on the first one's path,
 * and because the create never succeeded Core never learned a document id — so
 * every later import tried to create it again and failed the same way. The
 * meeting's day disambiguates them, and the minute, then a random tail, cover
 * the rest.
 */
function transcriptSlugs(title: string, occurredAt: string): string[] {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/['\u2019]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100) || 'transcript';
  const when = new Date(occurredAt);
  const day = when.toISOString().slice(0, 10);
  const minute = when.toISOString().slice(11, 16).replace(':', '');
  const random = Math.random().toString(36).slice(2, 8);
  return [`${base}-${day}`, `${base}-${day}-${minute}`, `${base}-${day}-${random}`];
}

/**
 * One transcript document, whichever source captured the meeting. Replaces
 * the body of `existingId` when it still exists; files a new one otherwise.
 */
export async function fileTranscriptDocument(
  env: Env,
  ownerEmail: string,
  input: {
    title: string;
    body_md: string;
    existingId: string | null;
    subjects: Array<{ kind: string; subject_id: string }>;
    /** "from Meet", "from Granola" — the commit message's tail. */
    message: string;
    /**
     * When the meeting happened. Docs dates the document by it rather than by
     * the write, so a history imported in one afternoon — Granola's goes back
     * to 2024 — reads as history wherever Docs sorts by date.
     */
    occurredAt: string;
  },
): Promise<{ id: string; path: string }> {
  const title = input.title.slice(0, 200);
  const created_at = new Date(input.occurredAt).toISOString();
  if (input.existingId) {
    const response = await docsFetch(env, ownerEmail, `/api/docs/${input.existingId}`, {
      method: 'PATCH',
      body: { title, body_md: input.body_md, created_at, message: `Transcript updated ${input.message}` },
    });
    if (response.status !== 404) {
      const updated = await docsJSON(response, docsWrittenRow, 'PATCH /api/docs/:id', 'Docs declined to update the transcript');
      if (input.subjects.length) {
        await docsFetch(env, ownerEmail, `/api/docs/${updated.id}/subjects`, {
          method: 'PUT',
          body: { subjects: input.subjects },
        });
      }
      return { id: updated.id, path: updated.path };
    }
    // Archived or deleted since: file a fresh one below.
  }

  // A 409 is the path being taken, not a refusal to file: try the next slug.
  let response: Response | null = null;
  for (const slug of transcriptSlugs(title, created_at)) {
    response = await docsFetch(env, ownerEmail, '/api/docs', {
      method: 'POST',
      body: {
        title,
        slug,
        body_md: input.body_md,
        folder_path: TRANSCRIPT_FOLDER,
        category: 'transcript',
        subjects: input.subjects,
        created_at,
        message: `Transcript filed ${input.message}`,
      },
    });
    if (response.status !== 409) break;
  }
  const created = await docsJSON(response!, docsWrittenRow, 'POST /api/docs', 'Docs declined to file the transcript');
  return { id: created.id, path: created.path };
}
