import { env } from 'cloudflare:workers';
import { docsDocument, docsDocumentDetail } from './core-rows';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetCoreGate } from '../src/core-gate';
import { DocsError, exchangeDocsToken, resetDocsTokenCache } from '../src/docs';
import worker from '../src/index';

const SECRET = 'meet-docs-shared-secret-at-least-32-chars';
const secretEnv = { ...env, DOCS_INTERNAL_SECRET: SECRET } as Env;

function docsAnswer(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const issued = {
  token: 'evd_0123456789abcdef',
  scopes: ['docs:read', 'docs:write', 'annotations:read', 'annotations:write', 'grants:write'],
  expires_at: '2026-12-10T09:00:00.000Z',
  email: 'rosa@example.com',
};

afterEach(() => {
  vi.restoreAllMocks();
  // The web proxy caches its minted token per owner for the isolate; every
  // test below counts fetches from a cold cache.
  resetDocsTokenCache();
});

describe('Docs token exchange', () => {
  it('signs a lowercased email and the device name against the served Docs origin', async () => {
    const seen: { url: string; headers: Headers; body: string }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({ url: request.url, headers: request.headers, body: await request.text() });
      return docsAnswer(issued);
    });

    const result = await exchangeDocsToken(secretEnv, 'ROSA@example.com', 'mini');

    expect(seen).toHaveLength(1);
    // workers.dev, not the Gandi redirect: a redirected POST arrives as a GET.
    expect(seen[0]!.url).toBe('https://docs.invalid/api/tokens/meet-exchange');
    expect(JSON.parse(seen[0]!.body)).toEqual({ email: 'rosa@example.com', device_name: 'mini' });

    const timestamp = seen[0]!.headers.get('x-internal-timestamp')!;
    const signature = seen[0]!.headers.get('x-internal-signature')!;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const expected = [...new Uint8Array(await crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(`${timestamp}.${seen[0]!.body}`),
    ))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(signature).toBe(expected);

    expect(result).toEqual({ ...issued, origin: 'https://docs.invalid' });
  });

  it('goes over the DOCS service binding when one is bound, never the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let seen: Request | undefined;
    const bound = {
      ...secretEnv,
      DOCS: { fetch: async (request: Request) => { seen = request; return docsAnswer(issued); } },
    } as unknown as Env;
    const result = await exchangeDocsToken(bound, 'rosa@example.com', 'mini');
    expect(result).toEqual({ ...issued, origin: 'https://docs.invalid' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen?.url).toBe('https://docs.invalid/api/tokens/meet-exchange');
    expect(seen?.headers.get('x-internal-signature')).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('names the device "Meet" when the client sends nothing, since Docs requires one', async () => {
    let body: unknown;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      body = await new Request(input, init).json();
      return docsAnswer(issued);
    });
    await exchangeDocsToken(secretEnv, 'rosa@example.com', '  ');
    expect(body).toEqual({ email: 'rosa@example.com', device_name: 'Meet' });
  });

  it('turns any Docs refusal into a 502, and an unusable answer into a DocsError', async () => {
    vi.stubGlobal('fetch', async () => docsAnswer({ error: 'forbidden' }, 403));
    await expect(exchangeDocsToken(secretEnv, 'rosa@example.com', undefined))
      .rejects.toMatchObject({ status: 502 });

    vi.stubGlobal('fetch', async () => docsAnswer({ token: '' }));
    await expect(exchangeDocsToken(secretEnv, 'rosa@example.com', undefined)).rejects.toThrow(DocsError);
  });

  it('is off without the shared secret', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(exchangeDocsToken({ ...env, DOCS_INTERNAL_SECRET: '' } as Env, 'rosa@example.com', undefined))
      .rejects.toMatchObject({ status: 503, code: 'not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/docs/token', () => {
  // meet#893: the apps reach Docs through /api/docs-service; no device token is minted.
  // meet#1162: apps before 6.9.2 still call it, so it says to update, not "Not found.".
  it('is retired: it answers 410 client_update_required and Docs is never asked', async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }), secretEnv, context);
    const token = (await response.json<{ access_token: string }>()).access_token;
    const fetched = vi.spyOn(globalThis, 'fetch');
    const answer = await worker.fetch(new Request('http://local/api/docs/token', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    }), secretEnv, context);
    expect(answer.status).toBe(410);
    expect(await answer.json()).toEqual({ error: 'Update Starlings to open Docs.', code: 'client_update_required' });
    expect(fetched).not.toHaveBeenCalled();
    await waitOnExecutionContext(context);
  });
});

describe('POST /api/docs/documents', () => {
  async function ownerSession(configured: Env, context: ExecutionContext): Promise<string> {
    const response = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }), configured, context);
    return (await response.json<{ access_token: string }>()).access_token;
  }

  it('requires an owner session', async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('http://local/api/docs/documents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Note', body_md: 'Hello' }),
    }), secretEnv, context);
    expect(response.status).toBe(401);
    await waitOnExecutionContext(context);
  });

  it('exchanges a token for the session, writes the document, and hands back its id and path', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    const calls: Array<{ path: string; authorization: string | null; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        body: await request.json(),
      });
      if (calls.length === 1) return docsAnswer(issued);
      return docsAnswer(docsDocumentDetail({ id: 'doc-1', path: '/work/note', title: 'Note' }));
    });
    const response = await worker.fetch(new Request('http://local/api/docs/documents', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Note', body_md: 'Hello' }),
    }), secretEnv, context);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ document: docsDocumentDetail({ id: 'doc-1', path: '/work/note', title: 'Note' }) });
    expect(calls[1]).toMatchObject({
      path: '/api/docs',
      authorization: `Bearer ${issued.token}`,
      body: { title: 'Note', body_md: 'Hello', folder_path: '/work' },
    });
    await waitOnExecutionContext(context);
  });

  describe('a page from the browser', () => {
    const PARAGRAPH = 'Only a subscriber reads this far: the committee agreed the plan, and the cost, and who pays for it. ';
    // The paywall markup is there for a subscriber too; the browser's copy is whole.
    const pageHTML = `<!doctype html><html><head><title>Story</title>
      <script type="application/ld+json">{"isAccessibleForFree":false}</script></head>
      <body><article><h1>Story</h1><p>${PARAGRAPH.repeat(1000)}</p></article></body></html>`;

    function mockDocs(saveStatus: number, saved: Record<string, unknown>) {
      const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === '/api/tokens/meet-exchange') return docsAnswer(issued);
        calls.push({ method: request.method, path: url.pathname, body: await request.json<Record<string, unknown>>() });
        if (request.method === 'PATCH') return docsAnswer(docsDocumentDetail({ ...saved, body_md: calls.at(-1)!.body!.body_md }), 200);
        return docsAnswer(docsDocumentDetail(saved), saveStatus);
      });
      return calls;
    }

    async function save(body: Record<string, unknown>) {
      const context = createExecutionContext();
      const token = await ownerSession(secretEnv, context);
      const response = await worker.fetch(new Request('http://local/api/docs/documents', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), secretEnv, context);
      await waitOnExecutionContext(context);
      return response;
    }

    it('saves the article it drew, past the usual API body limit, without fetching the page', async () => {
      const calls = mockDocs(201, { id: 'doc-1', path: '/work/links/story', title: 'Story' });
      const body = { url: 'https://news.example.com/story', page_html: pageHTML, body_md: 'Read for Monday.' };
      expect(JSON.stringify(body).length).toBeGreaterThan(65_536);
      const response = await save(body);
      expect(response.status).toBe(201);
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/docs']);
      const saved = calls[0]!.body!;
      expect(saved).toMatchObject({ url: 'https://news.example.com/story', title: 'Story', link: { fetch_status: 'ok' } });
      expect(saved.body_md).toMatch(/^Read for Monday\.\n\n---\n\n\*Saved from news\.example\.com on \d{4}-\d{2}-\d{2}\.\*\n\n/u);
      expect(saved.body_md).toContain('Only a subscriber reads this far');
      expect(saved.body_md).not.toContain('Paywalled');
      expect(saved).not.toHaveProperty('page_html');
    });

    it('replaces the article of an earlier save and keeps its notes', async () => {
      const earlier = 'My first notes.\n\n---\n\n*Saved from news.example.com on 2026-10-01.*\n\n> Paywalled. Saved what the page shows without a subscription.\n\nThe teaser.';
      const calls = mockDocs(200, { id: 'doc-1', path: '/work/links/story', title: 'Story', body_md: earlier });
      const response = await save({ url: 'https://news.example.com/story', page_html: pageHTML, body_md: 'And now the rest.' });
      expect(response.status).toBe(201);
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/docs', 'PATCH /api/docs/doc-1']);
      const body = calls[1]!.body!.body_md as string;
      expect(body).toMatch(/^My first notes\.\n\nAnd now the rest\.\n\n---\n\n\*Saved from news\.example\.com on /u);
      expect(body).not.toContain('The teaser.');
      expect(body).not.toContain('Paywalled');
    });

    it('needs the url the page came from', async () => {
      mockDocs(201, {});
      expect((await save({ title: 'Story', page_html: pageHTML })).status).toBe(400);
    });
  });
});

/**
 * The web's Docs page reads and writes through these (docs/DOCS.md, meet#148).
 * Every route mints one token for the owner and keeps it, so a page that
 * opens the rail, a list and a document costs one exchange, not four.
 */
describe('GET/PATCH /api/docs/* for the web', () => {
  async function ownerSession(configured: Env, context: ExecutionContext): Promise<string> {
    const response = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }), configured, context);
    return (await response.json<{ access_token: string }>()).access_token;
  }

  interface Seen { method: string; path: string; search: string; authorization: string | null; body: unknown }

  /** Docs as a stub: the exchange first, then whatever `answer` says per path. */
  function stubDocs(answer: (seen: Seen) => Response): Seen[] {
    const calls: Seen[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const seen: Seen = {
        method: request.method,
        path: url.pathname,
        search: url.search,
        authorization: request.headers.get('authorization'),
        body: request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.json(),
      };
      calls.push(seen);
      if (seen.path === '/api/tokens/meet-exchange') return docsAnswer(issued);
      return answer(seen);
    });
    return calls;
  }

  it('requires an owner session on every read', async () => {
    const context = createExecutionContext();
    for (const path of ['/api/docs/summary', '/api/docs/tree', '/api/docs/documents', '/api/docs/search?q=x', '/api/docs/documents/doc-1']) {
      const response = await worker.fetch(new Request(`http://local${path}`), secretEnv, context);
      expect(response.status, path).toBe(401);
    }
    await waitOnExecutionContext(context);
  });

  it('answers not_configured without the shared secret', async () => {
    const context = createExecutionContext();
    const unconfigured = { ...env, DOCS_INTERNAL_SECRET: '' } as Env;
    const token = await ownerSession(unconfigured, context);
    const response = await worker.fetch(new Request('http://local/api/docs/summary', {
      headers: { authorization: `Bearer ${token}` },
    }), unconfigured, context);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'not_configured' });
    await waitOnExecutionContext(context);
  });

  it('mints one token for the owner and reuses it across the rail, a list and a document', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    const summary = { categories: [{ category: 'note', label: 'Notes', count: 2 }], folders: [], total: 2 };
    const calls = stubDocs((seen) => {
      if (seen.path === '/api/docs/summary') return docsAnswer(summary, 200);
      if (seen.path === '/api/tree') return docsAnswer({ folders: [] }, 200);
      if (seen.path === '/api/docs') return docsAnswer({ documents: [], total: 0 }, 200);
      if (seen.path === '/api/docs/doc-1') return docsAnswer(docsDocumentDetail({ id: 'doc-1', path: '/work/note', title: 'Note', body_md: '# Hi' }), 200);
      return docsAnswer({ error: 'no such route', code: 'not_found' }, 404);
    });
    const headers = { authorization: `Bearer ${token}` };

    const rail = await worker.fetch(new Request('http://local/api/docs/summary', { headers }), secretEnv, context);
    expect(rail.status).toBe(200);
    expect(await rail.json()).toEqual(summary);
    expect(rail.headers.get('etag')).toMatch(/^W\//u);

    const tree = await worker.fetch(new Request('http://local/api/docs/tree', { headers }), secretEnv, context);
    expect(await tree.json()).toEqual({ folders: [] });

    const list = await worker.fetch(new Request('http://local/api/docs/documents?category=note&prefix=/work&limit=20', { headers }), secretEnv, context);
    expect(await list.json()).toEqual({ documents: [], total: 0 });

    // A rail's LIBRARY half is one request: a comma list of sources goes to
    // Docs as is; a system Docs does not know is refused here.
    const library = await worker.fetch(new Request('http://local/api/docs/documents?category=brief&source=core,obsidian', { headers }), secretEnv, context);
    expect(library.status).toBe(200);
    const bogus = await worker.fetch(new Request('http://local/api/docs/documents?source=core,meet', { headers }), secretEnv, context);
    expect(bogus.status).toBe(400);

    const document = await worker.fetch(new Request('http://local/api/docs/documents/doc-1', { headers }), secretEnv, context);
    expect(await document.json()).toEqual({ document: docsDocumentDetail({ id: 'doc-1', path: '/work/note', title: 'Note', body_md: '# Hi' }) });

    expect(calls.filter((call) => call.path === '/api/tokens/meet-exchange')).toHaveLength(1);
    expect(calls.map((call) => call.path)).toEqual(['/api/tokens/meet-exchange', '/api/docs/summary', '/api/tree', '/api/docs', '/api/docs', '/api/docs/doc-1']);
    // Every Docs call carries the minted token; the list query is forwarded whole.
    expect(calls.slice(1).every((call) => call.authorization === `Bearer ${issued.token}`)).toBe(true);
    expect(calls[3]!.search).toBe('?category=note&prefix=%2Fwork&limit=20');
    expect(calls[4]!.search).toBe('?category=brief&source=core%2Cobsidian&limit=100');
    await waitOnExecutionContext(context);
  });

  it('answers 304 to a list the browser already holds', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    stubDocs(() => docsAnswer({ documents: [docsDocument({ id: 'doc-1' })], total: 1 }, 200));
    const first = await worker.fetch(new Request('http://local/api/docs/documents', {
      headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);
    const etag = first.headers.get('etag')!;
    const second = await worker.fetch(new Request('http://local/api/docs/documents', {
      headers: { authorization: `Bearer ${token}`, 'if-none-match': etag },
    }), secretEnv, context);
    expect(second.status).toBe(304);
    await waitOnExecutionContext(context);
  });

  it('rejects a malformed category id or an empty search before calling Docs', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    const calls = stubDocs(() => docsAnswer({}, 200));
    const headers = { authorization: `Bearer ${token}` };
    const badCategory = await worker.fetch(new Request('http://local/api/docs/documents?category=Not%20a%20slug', { headers }), secretEnv, context);
    expect(badCategory.status).toBe(400);
    const emptySearch = await worker.fetch(new Request('http://local/api/docs/search?q=%20', { headers }), secretEnv, context);
    expect(emptySearch.status).toBe(400);
    expect(calls.filter((call) => call.path !== '/api/tokens/meet-exchange')).toHaveLength(0);
    await waitOnExecutionContext(context);
  });

  it('wraps Docs’ bare search array as {hits}', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    const hit = { id: 'doc-1', path: '/work/note', title: 'Note', kind: 'markdown', source_system: 'native', source_kind: null, snippet: 'a <mark>note</mark>', rank: 1, updated_at: '2026-09-14T09:00:00.000Z' };
    const calls = stubDocs(() => docsAnswer([hit], 200));
    const response = await worker.fetch(new Request('http://local/api/docs/search?q=note&limit=5', {
      headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);
    expect(await response.json()).toEqual({ hits: [hit] });
    expect(calls[1]).toMatchObject({ path: '/api/search', search: '?q=note&limit=5' });
    await waitOnExecutionContext(context);
  });

  it('passes a hash_mismatch through as 409 with its code, so the editor can show both bodies', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    const calls = stubDocs(() => docsAnswer({ error: 'The document changed since it was read.', code: 'hash_mismatch' }, 409));
    const response = await worker.fetch(new Request('http://local/api/docs/documents/doc-1', {
      method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body_md: 'mine', if_content_hash: 'a'.repeat(64) }),
    }), secretEnv, context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'hash_mismatch', error: 'The document changed since it was read.' });
    expect(calls[1]).toMatchObject({ method: 'PATCH', path: '/api/docs/doc-1', body: { body_md: 'mine', if_content_hash: 'a'.repeat(64) } });
    await waitOnExecutionContext(context);
  });

  it('mints a fresh token and retries exactly once when Docs says the cached one is dead', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    let reads = 0;
    const calls = stubDocs(() => {
      reads += 1;
      return reads === 1
        ? docsAnswer({ error: 'unauthorized', code: 'unauthorized' }, 401)
        : docsAnswer({ categories: [], folders: [], total: 0 }, 200);
    });
    const response = await worker.fetch(new Request('http://local/api/docs/summary', {
      headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.path)).toEqual(['/api/tokens/meet-exchange', '/api/docs/summary', '/api/tokens/meet-exchange', '/api/docs/summary']);
    await waitOnExecutionContext(context);
  });

  it('mints for itself when another request’s mint never settles (meet#613)', async () => {
    // The first request is cancelled mid-exchange: it settles nothing, so the
    // shared mint hangs. The second request waits the bound, then mints.
    resetCoreGate({ sharedWaitMs: 50 });
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    let exchanges = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/api/tokens/meet-exchange') {
        exchanges += 1;
        if (exchanges === 1) return new Promise<Response>(() => undefined);
        return docsAnswer(issued);
      }
      return docsAnswer({ categories: [], folders: [], total: 0 }, 200);
    });
    const headers = { authorization: `Bearer ${token}` };

    void worker.fetch(new Request('http://local/api/docs/summary', { headers }), secretEnv, createExecutionContext());
    await vi.waitFor(() => expect(exchanges).toBe(1));
    const second = await worker.fetch(new Request('http://local/api/docs/summary', { headers }), secretEnv, context);
    expect(second.status).toBe(200);
    expect(exchanges).toBe(2);
    await waitOnExecutionContext(context);
  });

  it('replaces the subjects and moves the document through their own routes', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    const calls = stubDocs((seen) => docsAnswer(docsDocumentDetail({ id: 'doc-1', path: seen.path.endsWith('/move') ? '/work/project/bff/note' : '/work/note', title: 'Note' }), 200));
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const subjects = await worker.fetch(new Request('http://local/api/docs/documents/doc-1/subjects', {
      method: 'PUT', headers, body: JSON.stringify({ subjects: [{ kind: 'project', subject_id: 'p1' }] }),
    }), secretEnv, context);
    expect(subjects.status).toBe(200);
    expect(calls[1]).toMatchObject({ method: 'PUT', path: '/api/docs/doc-1/subjects', body: { subjects: [{ system: 'core', kind: 'project', subject_id: 'p1' }] } });

    const moved = await worker.fetch(new Request('http://local/api/docs/documents/doc-1/move', {
      method: 'POST', headers, body: JSON.stringify({ folder_path: '/work/project/bff' }),
    }), secretEnv, context);
    expect(await moved.json()).toMatchObject({ document: { path: '/work/project/bff/note' } });
    expect(calls[2]).toMatchObject({ method: 'POST', path: '/api/docs/doc-1/move', body: { folder_path: '/work/project/bff' } });

    const badKind = await worker.fetch(new Request('http://local/api/docs/documents/doc-1/subjects', {
      method: 'PUT', headers, body: JSON.stringify({ subjects: [{ kind: 'planet', subject_id: 'p1' }] }),
    }), secretEnv, context);
    expect(badKind.status).toBe(400);
    await waitOnExecutionContext(context);
  });

  it('lists, posts, resolves and deletes comments as Docs annotations', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    const annotation = {
      id: 'a1', document_id: 'doc-1', document_version: 3, thread_id: 'a1', parent_id: null,
      author: 'rosa@example.com', author_name: null, author_kind: 'staff', body_md: 'Tighten this.',
      anchor: { type: 'text', quote: 'the core ask', prefix: 'define ', suffix: ' is' }, status: 'open',
      resolved_by: null, resolved_at: null, created_at: '2026-09-15T08:00:00.000Z', updated_at: '2026-09-15T08:00:00.000Z',
    };
    const calls = stubDocs((seen) => {
      if (seen.method === 'DELETE') return new Response(null, { status: 204 });
      if (seen.method === 'GET') return docsAnswer([annotation], 200);
      if (seen.method === 'PATCH') return docsAnswer({ ...annotation, status: 'resolved' }, 200);
      return docsAnswer(annotation, 201);
    });
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const list = await worker.fetch(new Request('http://local/api/docs/documents/doc-1/annotations', { headers }), secretEnv, context);
    expect(await list.json()).toEqual({ annotations: [annotation] });

    const posted = await worker.fetch(new Request('http://local/api/docs/documents/doc-1/annotations', {
      method: 'POST', headers, body: JSON.stringify({ body_md: 'Tighten this.', anchor: annotation.anchor }),
    }), secretEnv, context);
    expect(posted.status).toBe(201);
    expect(calls[2]).toMatchObject({ method: 'POST', path: '/api/docs/doc-1/annotations', body: { body_md: 'Tighten this.', anchor: annotation.anchor } });

    const resolved = await worker.fetch(new Request('http://local/api/docs/annotations/a1', {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'resolved' }),
    }), secretEnv, context);
    expect(await resolved.json()).toMatchObject({ annotation: { status: 'resolved' } });
    expect(calls[3]).toMatchObject({ method: 'PATCH', path: '/api/annotations/a1' });

    const deleted = await worker.fetch(new Request('http://local/api/docs/annotations/a1', { method: 'DELETE', headers }), secretEnv, context);
    expect(deleted.status).toBe(204);
    expect(calls[4]).toMatchObject({ method: 'DELETE', path: '/api/annotations/a1' });

    // A PDF anchor is not something Meet writes; the schema refuses it here.
    const pdf = await worker.fetch(new Request('http://local/api/docs/documents/doc-1/annotations', {
      method: 'POST', headers, body: JSON.stringify({ body_md: 'x', anchor: { type: 'pdf', page: 1, rects: [[0, 0, 1, 1]] } }),
    }), secretEnv, context);
    expect(pdf.status).toBe(400);
    await waitOnExecutionContext(context);
  });

  it('shares, signs and reads the access log through Docs, each id checked against its document', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    const grant = {
      id: 'g1', document_id: 'doc-1', folder_id: null, url: 'https://docs.example/d/tok', email: null, role: 'commenter',
      label: null, require_verification: false, created_by: 'rosa@example.com', created_at: '2026-10-06T08:00:00.000Z',
      expires_at: null, revoked_at: null, last_used_at: null, use_count: 2,
    };
    const request = {
      id: 'r1', document_id: 'doc-1', document_path: '/work/note', document_title: 'Note', document_version: 3,
      content_hash: 'a'.repeat(64), requested_by: 'rosa@example.com', subject: 'Please sign: Note', message: null,
      ordered: false, status: 'pending', created_at: '2026-10-06T08:00:00.000Z', expires_at: null, completed_at: null,
      parties: [{ id: 'p1', email: 'ada@example.net', name: null, role: 'signer', sequence: 0, status: 'pending', signed_at: null, url: 'https://docs.example/d/sig' }],
      signatures: [],
    };
    const event = { id: 'e1', actor: 'ada@example.net', actor_kind: 'guest', kind: 'view', ip: '203.0.113.9', referrer: null, timezone: 'Europe/Lisbon', language: 'pt', created_at: '2026-10-06T08:05:00.000Z' };
    const calls = stubDocs((seen) => {
      if (seen.path === '/api/docs/transcript-1') return docsAnswer(docsDocumentDetail({ id: 'transcript-1', transcript: true }), 200);
      if (seen.path === '/api/docs/doc-1') return docsAnswer(docsDocumentDetail({ id: 'doc-1', path: '/work/note', title: 'Note' }), 200);
      if (seen.path === '/api/docs/doc-1/grants') return seen.method === 'GET' ? docsAnswer({ grants: [grant] }, 200) : docsAnswer(grant, 201);
      if (seen.path === '/api/grants/g1' || seen.path === '/api/signature-requests/r1/cancel') return new Response(null, { status: 204 });
      if (seen.path === '/api/docs/doc-1/access-events') return docsAnswer({ events: [event] }, 200);
      if (seen.path === '/api/docs/doc-1/signature-requests') return seen.method === 'GET' ? docsAnswer({ requests: [request] }, 200) : docsAnswer(request, 201);
      return docsAnswer({ error: 'no such route', code: 'not_found' }, 404);
    });
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`http://local${path}`, { headers, ...init }), secretEnv, context);

    const links = await call('/api/docs/documents/doc-1/grants');
    expect(await links.json()).toEqual({ grants: [grant] });

    const created = await call('/api/docs/documents/doc-1/grants', { method: 'POST', body: JSON.stringify({ email: 'Ada@Example.net', role: 'commenter' }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ grant });
    expect(calls.find((seen) => seen.method === 'POST' && seen.path === '/api/docs/doc-1/grants')?.body).toEqual({ email: 'ada@example.net', role: 'commenter' });

    // A transcript stays internal: refused here, before Docs is asked.
    const transcript = await call('/api/docs/documents/transcript-1/grants', { method: 'POST', body: JSON.stringify({ role: 'viewer' }) });
    expect(transcript.status).toBe(400);
    const signTranscript = await call('/api/docs/documents/transcript-1/signature-requests', { method: 'POST', body: JSON.stringify({ parties: [{ email: 'ada@example.net' }] }) });
    expect(signTranscript.status).toBe(400);
    expect(calls.some((seen) => seen.method === 'POST' && seen.path.startsWith('/api/docs/transcript-1/'))).toBe(false);

    const revoked = await call('/api/docs/documents/doc-1/grants/g1', { method: 'DELETE' });
    expect(revoked.status).toBe(204);
    expect(calls.some((seen) => seen.method === 'DELETE' && seen.path === '/api/grants/g1')).toBe(true);
    // A link that is not this document's is never revoked through it.
    const foreign = await call('/api/docs/documents/doc-1/grants/g2', { method: 'DELETE' });
    expect(foreign.status).toBe(404);
    expect(calls.some((seen) => seen.path === '/api/grants/g2')).toBe(false);

    // The visitor's IP stays on Docs.
    const activity = await call('/api/docs/documents/doc-1/access-events');
    expect(await activity.json()).toEqual({ events: [Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'ip'))] });

    const requests = await call('/api/docs/documents/doc-1/signature-requests');
    expect(await requests.json()).toMatchObject({ requests: [{ id: 'r1', parties: [{ email: 'ada@example.net', url: 'https://docs.example/d/sig' }] }] });

    const sent = await call('/api/docs/documents/doc-1/signature-requests', {
      method: 'POST', body: JSON.stringify({ subject: 'Please sign: Note', ordered: true, parties: [{ email: 'ada@example.net', sequence: 0 }, { email: 'bob@example.net', sequence: 1 }] }),
    });
    expect(sent.status).toBe(201);
    expect(await sent.json()).toMatchObject({ request: { id: 'r1', status: 'pending' } });
    const noSigner = await call('/api/docs/documents/doc-1/signature-requests', { method: 'POST', body: JSON.stringify({ parties: [] }) });
    expect(noSigner.status).toBe(400);

    const cancelled = await call('/api/docs/documents/doc-1/signature-requests/r1/cancel', { method: 'POST' });
    expect(cancelled.status).toBe(204);
    const foreignRequest = await call('/api/docs/documents/doc-1/signature-requests/r9/cancel', { method: 'POST' });
    expect(foreignRequest.status).toBe(404);
    expect(calls.some((seen) => seen.path === '/api/signature-requests/r9/cancel')).toBe(false);
    await waitOnExecutionContext(context);
  });

  it('reads Docs’ health without a token and answers an unhealthy mirror as data, not a 503', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    const calls = stubDocs((seen) => seen.path === '/api/health'
      ? docsAnswer({ ok: false, service: 'docs', unhealthy: ['core:work'], mirror: [] }, 503)
      : docsAnswer({ error: 'no such route' }, 404));
    const response = await worker.fetch(new Request('http://local/api/docs/health', { headers: { authorization: `Bearer ${token}` } }), secretEnv, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, unhealthy: ['core:work'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/api/health', authorization: null });
    await waitOnExecutionContext(context);
  });
});
