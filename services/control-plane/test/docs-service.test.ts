// The Mac and iPhone reach Docs through the Worker (meet#893, docs/ACCESS.md):
// `/api/docs-service/*` mirrors Docs' own paths, and a document on a subject
// the member cannot see is left out of every list and answers 404 itself.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docsDocument, docsDocumentDetail } from './core-rows';
import { signOwnerSessionToken } from '../src/auth';
import { resetDocsTokenCache } from '../src/docs';
import { recordOwnerSignIn } from '../src/usage';
import worker from '../src/index';

const SECRET = 'meet-docs-shared-secret-at-least-32-chars';
const docsEnv = { ...env, DOCS_INTERNAL_SECRET: SECRET } as Env;
const PREFIX = 'http://local/api/docs-service';

const member = { email: 'docsvc-member@example.com', name: 'Docs Member' };
const HIDDEN_PROJECT = 'c0ffee00-0000-4000-8000-0000000089a1';
const OPEN_PROJECT = 'c0ffee00-0000-4000-8000-0000000089a2';
const VISIBLE = '00000000-0000-4000-8000-00000000a001';
const HIDDEN = '00000000-0000-4000-8000-00000000a002';
const PRIVATE = '00000000-0000-4000-8000-00000000a003';
const VISIBLE_NOTE = '00000000-0000-4000-8000-00000000b001';
const HIDDEN_NOTE = '00000000-0000-4000-8000-00000000b002';
const HIDDEN_GRANT = '00000000-0000-4000-8000-00000000c002';
const HIDDEN_REQUEST = '00000000-0000-4000-8000-00000000d002';
const VISIBLE_REQUEST = '00000000-0000-4000-8000-00000000d001';

const on = (project: string) => [{ system: 'core', kind: 'project', subject_id: project }];
const visibleRow = docsDocument({ id: VISIBLE, path: '/work/open', title: 'Open', folder_id: 'folder-open', subjects: on(OPEN_PROJECT), extra_field: 'kept' });
const hiddenRow = docsDocument({ id: HIDDEN, path: '/work/secret/plan', title: 'Secret plan', folder_id: 'folder-secret', category: 'brief', subjects: on(HIDDEN_PROJECT) });
const privateRow = docsDocument({ id: PRIVATE, path: '/links/save', title: 'Saved page', source_kind: 'link', private: true });

const annotation = (id: string, document: string) => ({
  id, document_id: document, document_version: 1, thread_id: id, parent_id: null, author: member.email, author_name: null,
  author_kind: 'staff', body_md: 'A note', anchor: null, status: 'open', resolved_by: null, resolved_at: null,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
});
const signatureRequest = (id: string, document: string) => ({
  id, document_id: document, subject: null, ordered: false, status: 'pending', created_at: '2026-10-01T00:00:00.000Z', parties: [],
});

interface Seen { method: string; path: string; search: URLSearchParams; authorization: string | null }

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Docs as a stub: one hidden and one visible document, one private save, a comment and a request on each. */
function stubDocs(): Seen[] {
  const calls: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname, search: url.searchParams, authorization: request.headers.get('authorization') });
    const path = url.pathname;
    if (path === '/api/tokens/meet-exchange') {
      return answer({ token: 'evd_worker', scopes: ['docs:read', 'docs:write'], expires_at: '2099-01-01T00:00:00.000Z', email: member.email }, 201);
    }
    if (request.method === 'GET' && path === '/api/docs') {
      if (url.searchParams.get('status') === 'archived') return answer({ documents: [], total: 0 });
      const subject = url.searchParams.get('subject');
      if (subject === `core:project:${HIDDEN_PROJECT}`) return answer({ documents: [hiddenRow], total: 1 });
      if (subject) return answer({ documents: [], total: 0 });
      if (url.searchParams.get('source_kind') === 'link') return answer({ documents: [privateRow], total: 1 });
      return answer({ documents: [visibleRow, hiddenRow, privateRow], total: 3 });
    }
    if (path === '/api/docs/summary') {
      return answer({
        categories: [{ category: 'brief', label: 'Briefs', count: 1 }],
        folders: [{ path: '/work/secret', title: 'Secret', count: 1 }, { path: '/work', title: 'Work', count: 3 }],
        total: 3,
      });
    }
    if (path === '/api/tree') {
      const folder = (id: string, folderPath: string, count: number) => ({
        id, path: folderPath, slug: id, title: id, parent_id: null, depth: 1, icon: null, description: null, source_key: null, document_count: count,
      });
      return answer({ folders: [folder('folder-open', '/work/open', 1), folder('folder-secret', '/work/secret', 1)] });
    }
    if (path === '/api/categories') return answer({ categories: [{ id: 'brief', label: 'Briefs', position: 0, count: 1 }] });
    if (path === '/api/search') {
      const hit = (id: string, title: string) => ({ id, path: `/work/${id}`, title, kind: 'markdown', source_system: 'native', source_kind: null, snippet: '…', updated_at: '2026-10-01T00:00:00.000Z' });
      return answer({ hits: [hit(VISIBLE, 'Open'), hit(HIDDEN, 'Secret plan')] });
    }
    if (path === `/api/docs/${VISIBLE}`) {
      if (request.method === 'PATCH') return answer(docsDocumentDetail({ ...visibleRow, title: 'Renamed' }));
      return answer(docsDocumentDetail({ ...visibleRow, body_md: '# Open' }));
    }
    if (path === `/api/docs/${HIDDEN}`) return answer(docsDocumentDetail({ ...hiddenRow, body_md: '# Secret' }));
    if (path === `/api/docs/${PRIVATE}`) return answer(docsDocumentDetail({ ...privateRow, body_md: 'notes' }));
    if (path === `/api/docs/${VISIBLE}/annotations`) return answer([annotation(VISIBLE_NOTE, VISIBLE)]);
    if (path === `/api/docs/${HIDDEN}/annotations`) return answer([annotation(HIDDEN_NOTE, HIDDEN)]);
    if (path === `/api/docs/${PRIVATE}/annotations`) return answer([]);
    if (path === `/api/docs/${HIDDEN}/grants`) {
      return answer({ grants: [{ id: HIDDEN_GRANT, url: 'https://docs.invalid/g', email: null, role: 'viewer', created_at: '2026-10-01T00:00:00.000Z' }] });
    }
    if (path === `/api/signature-requests/${HIDDEN_REQUEST}`) return answer(signatureRequest(HIDDEN_REQUEST, HIDDEN));
    if (path === `/api/signature-requests/${VISIBLE_REQUEST}`) return answer(signatureRequest(VISIBLE_REQUEST, VISIBLE));
    if (path === `/api/annotations/${VISIBLE_NOTE}`) return request.method === 'DELETE' ? new Response(null, { status: 204 }) : answer(annotation(VISIBLE_NOTE, VISIBLE));
    if (path === `/api/docs/${VISIBLE}/link-image`) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    if (request.method === 'POST' && path === '/api/docs') return answer(docsDocumentDetail({ id: 'new-doc' }), 201);
    return answer({ error: 'No such route.', code: 'not_found' }, 404);
  });
  return calls;
}

async function memberToken(context: ExecutionContext): Promise<string> {
  const response = await worker.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(member),
  }), docsEnv, context);
  await recordOwnerSignIn(docsEnv, { sub: `dev:${member.email}`, ...member }, 'mac');
  return (await response.json<{ access_token: string }>()).access_token;
}

async function call(context: ExecutionContext, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${PREFIX}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  }), docsEnv, context);
}

beforeEach(async () => {
  await env.USAGE.prepare(`INSERT OR REPLACE INTO subject_visibility (kind, subject_id, visibility, updated_by, updated_at)
    VALUES ('project', ?1, 'restricted', 'test', ?2)`).bind(HIDDEN_PROJECT, Date.now()).run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetDocsTokenCache();
  await env.USAGE.prepare('DELETE FROM subject_visibility WHERE subject_id = ?1').bind(HIDDEN_PROJECT).run();
});

describe('/api/docs-service: Docs for the Mac and iPhone through the Worker', () => {
  it('needs an owner session, and answers only the paths it mirrors', async () => {
    const context = createExecutionContext();
    stubDocs();
    expect((await worker.fetch(new Request(`${PREFIX}/api/docs`), docsEnv, context)).status).toBe(401);
    const token = await memberToken(context);
    // Docs' own token list and sync are not mirrored: the router answers 404.
    for (const [method, path] of [['GET', '/api/tokens'], ['POST', '/api/sync/push'], ['DELETE', `/api/docs/${VISIBLE}`], ['GET', '/api/me']] as const) {
      const response = await call(context, token, path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    await waitOnExecutionContext(context);
  });

  it('leaves a document on a hidden subject out of the list, the tree, the summary, the categories and search', async () => {
    const context = createExecutionContext();
    const calls = stubDocs();
    const token = await memberToken(context);

    const list = await call(context, token, '/api/docs?limit=200&source=native&bogus=1');
    expect(list.status).toBe(200);
    const page = await list.json<{ documents: Array<{ id: string; extra_field?: string }>; total: number }>();
    expect(page.documents.map((row) => row.id)).toEqual([VISIBLE, PRIVATE]);
    expect(page.total).toBe(2);
    // Docs' own fields pass through; a query key DocsKit does not send is not forwarded.
    expect(page.documents[0]!.extra_field).toBe('kept');
    const forwarded = calls.find((seen) => seen.path === '/api/docs' && seen.search.get('source') === 'native')!;
    expect(forwarded.search.get('bogus')).toBeNull();
    expect(forwarded.authorization).toBe('Bearer evd_worker');

    const tree = await (await call(context, token, '/api/tree')).json<{ folders: Array<{ id: string }> }>();
    expect(tree.folders.map((folder) => folder.id)).toEqual(['folder-open']);

    const summary = await (await call(context, token, '/api/docs/summary')).json<{ total: number; categories: Array<{ count: number }>; folders: Array<{ path: string }> }>();
    expect(summary.total).toBe(2);
    expect(summary.categories[0]!.count).toBe(0);
    expect(summary.folders.map((folder) => folder.path)).toEqual(['/work']);

    const categories = await (await call(context, token, '/api/categories')).json<{ categories: Array<{ count: number }> }>();
    expect(categories.categories[0]!.count).toBe(0);

    const search = await (await call(context, token, '/api/search?q=plan&limit=30')).json<{ hits: Array<{ id: string }> }>();
    expect(search.hits.map((hit) => hit.id)).toEqual([VISIBLE]);
    await waitOnExecutionContext(context);
  });

  it('answers 404 for a hidden document and everything under it, and refuses a write to it', async () => {
    const context = createExecutionContext();
    const calls = stubDocs();
    const token = await memberToken(context);
    const reads = ['', '/annotations', '/images', '/link-image', '/grants', `/images/${VISIBLE_NOTE}`];
    for (const tail of reads) {
      const response = await call(context, token, `/api/docs/${HIDDEN}${tail}`);
      expect(response.status, tail || '(document)').toBe(404);
      expect(await response.json(), tail).toMatchObject({ code: 'subject_not_found' });
    }
    const writes: Array<[string, string, unknown]> = [
      ['PATCH', `/api/docs/${HIDDEN}`, { title: 'Mine now' }],
      ['PUT', `/api/docs/${HIDDEN}/subjects`, { subjects: [] }],
      ['POST', `/api/docs/${HIDDEN}/move`, { folder_path: '/work' }],
      ['POST', `/api/docs/${HIDDEN}/annotations`, { body_md: 'hi' }],
      ['POST', `/api/docs/${HIDDEN}/grants`, { role: 'viewer' }],
      ['POST', `/api/docs/${HIDDEN}/signature-requests`, { parties: [{ email: 'a@example.net' }] }],
      ['PATCH', `/api/annotations/${HIDDEN_NOTE}`, { status: 'resolved' }],
      ['DELETE', `/api/annotations/${HIDDEN_NOTE}`, undefined],
      ['DELETE', `/api/grants/${HIDDEN_GRANT}`, undefined],
      ['DELETE', `/api/docs/${HIDDEN}/images/${VISIBLE_NOTE}`, undefined],
    ];
    for (const [method, path, body] of writes) {
      const response = await call(context, token, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    // The web's own comment routes check the same way (meet#893, MZ 2026-10-12).
    for (const method of ['PATCH', 'DELETE']) {
      const web = await worker.fetch(new Request(`http://local/api/docs/annotations/${HIDDEN_NOTE}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'http://local' },
        ...(method === 'PATCH' ? { body: JSON.stringify({ status: 'resolved' }) } : {}),
      }), docsEnv, context);
      expect(web.status, `web ${method}`).toBe(404);
      expect(await web.json(), `web ${method}`).toMatchObject({ code: "subject_not_found" });
    }
    // Filing a new document onto the hidden subject is refused before Docs hears of it.
    const create = await call(context, token, '/api/docs', { method: 'POST', body: JSON.stringify({ title: 'New', body_md: '', subjects: [{ system: 'core', kind: 'project', subject_id: HIDDEN_PROJECT }] }) });
    expect(create.status).toBe(404);
    // A signature request on a hidden document is read, then held back.
    expect((await call(context, token, `/api/signature-requests/${HIDDEN_REQUEST}`)).status).toBe(404);

    // Nothing reached Docs as a write on the hidden document or its rows.
    const hiddenWrites = calls.filter((seen) => seen.method !== 'GET'
      && (seen.path.includes(HIDDEN) || seen.path.includes(HIDDEN_NOTE) || seen.path.includes(HIDDEN_GRANT) || seen.path === '/api/docs'));
    expect(hiddenWrites).toEqual([]);
    await waitOnExecutionContext(context);
  });

  it('passes a visible document, its comments and its writes through unchanged', async () => {
    const context = createExecutionContext();
    stubDocs();
    const token = await memberToken(context);

    const document = await call(context, token, `/api/docs/${VISIBLE}`);
    expect(document.status).toBe(200);
    expect(await document.json()).toEqual(docsDocumentDetail({ ...visibleRow, body_md: '# Open' }));

    const notes = await call(context, token, `/api/docs/${VISIBLE}/annotations`);
    expect(await notes.json()).toEqual([annotation(VISIBLE_NOTE, VISIBLE)]);

    const image = await call(context, token, `/api/docs/${VISIBLE}/link-image`);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const renamed = await call(context, token, `/api/docs/${VISIBLE}`, { method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }) });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: VISIBLE, title: 'Renamed' });

    expect((await call(context, token, `/api/annotations/${VISIBLE_NOTE}`, { method: 'DELETE' })).status).toBe(204);
    expect(await (await call(context, token, `/api/signature-requests/${VISIBLE_REQUEST}`)).json()).toEqual(signatureRequest(VISIBLE_REQUEST, VISIBLE));

    const created = await call(context, token, '/api/docs', { method: 'POST', body: JSON.stringify({ title: 'New', body_md: '', subjects: on(OPEN_PROJECT) }) });
    expect(created.status).toBe(201);
    // A link save goes through the Worker's own reader, never straight to Docs.
    const link = await call(context, token, '/api/docs', { method: 'POST', body: JSON.stringify({ url: 'https://example.com', title: 'x', body_md: '' }) });
    expect(link.status).toBe(400);
    await waitOnExecutionContext(context);
  });

  it('treats an agent acting as the member as the web routes do: no private save, no hidden subject', async () => {
    const context = createExecutionContext();
    stubDocs();
    await memberToken(context);
    const agentToken = await signOwnerSessionToken(
      { sub: `dev:${member.email}`, email: member.email, name: member.name },
      docsEnv, '5m', undefined, undefined, 'agent-docsvc',
    );
    const list = await (await call(context, agentToken, '/api/docs?limit=200')).json<{ documents: Array<{ id: string }> }>();
    expect(list.documents.map((row) => row.id)).toEqual([VISIBLE]);
    expect((await call(context, agentToken, `/api/docs/${PRIVATE}`)).status).toBe(404);
    expect((await call(context, agentToken, `/api/docs/${HIDDEN}`)).status).toBe(404);
    expect((await call(context, agentToken, `/api/docs/${VISIBLE}`)).status).toBe(200);
    await waitOnExecutionContext(context);
  });
});
