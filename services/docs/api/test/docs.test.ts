import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { signStaffSession } from '../src/auth';
import { hmacSHA256Hex } from '../src/crypto';
import { runMirror, allSurfaces, NOTES_SURFACE } from '../src/mirror';
import { noteDocuments } from '../src/adopt-notes';

const ORIGIN = 'http://localhost:8788';

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`${ORIGIN}${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function staffToken(): Promise<string> {
  return signStaffSession({ sub: 'g-1', email: 'rosa@org.example', name: 'Rosa Ortiz' }, env);
}

async function asStaff(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${await staffToken()}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return call(path, { ...init, headers });
}

/** A workspace starts with no categories (migration 0008); a test makes the ones it files into. */
async function ensureCategory(id: string, label: string): Promise<void> {
  const response = await asStaff('/api/categories', { method: 'POST', body: JSON.stringify({ id, label }) });
  expect([201, 409]).toContain(response.status);
}

async function makeDocument(body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await asStaff('/api/docs', { method: 'POST', body: JSON.stringify(body) });
  expect(response.status).toBe(201);
  return response.json();
}

describe('auth', () => {
  it('rejects an anonymous request', async () => {
    const response = await call('/api/docs');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('serves health without a session, and fails when a surface is not healthy', async () => {
    const response = await call('/api/health');
    // Nothing has swept in a fresh Worker, so every surface is unhealthy and
    // the endpoint says so in its status code — the point being that a check
    // which is always 200 cannot be monitoring anything. `core:work` reported
    // `ok: true` through seven months of failing hourly.
    expect(response.status).toBe(503);
    const body = await response.json<{ ok: boolean; unhealthy: string[]; mirror: Array<Record<string, unknown>> }>();
    expect(body.ok).toBe(false);
    // core:work's project (CMS) is configured here; CRM is not, so core:note
    // is not reported: a deployment without a Core project has nothing of it
    // to sweep.
    expect(body.unhealthy).toContain('core:work');
    expect(body.unhealthy).not.toContain('core:note');
    // A surface with no row at all is reported rather than silently absent.
    expect(body.mirror.find((row) => row.source_key === 'core:work')).toMatchObject({
      healthy: false,
      stale: true,
      error: 'Has never run.',
    });
  });

  it('calls a surface stale when it stopped running, however it last ended', async () => {
    await env.DB.prepare(
      `INSERT INTO sync_state (source_key, last_run_at, last_status, documents_seen, documents_written)
       VALUES ('core:faq', ?, 'ok', 29, 0)
       ON CONFLICT (source_key) DO UPDATE SET last_run_at = excluded.last_run_at, last_status = 'ok'`,
    )
      .bind(new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString())
      .run();

    const body = await (await call('/api/health')).json<{ mirror: Array<Record<string, unknown>> }>();
    // Last run succeeded; it is still not healthy, because it was five hours
    // ago and the sweep is hourly. A scheduler that stops reads as perfect.
    expect(body.mirror.find((row) => row.source_key === 'core:faq')).toMatchObject({
      last_status: 'ok',
      stale: true,
      healthy: false,
    });

    await env.DB.prepare(`UPDATE sync_state SET last_run_at = ? WHERE source_key = 'core:faq'`)
      .bind(new Date().toISOString())
      .run();
    const fresh = await (await call('/api/health')).json<{ mirror: Array<Record<string, unknown>> }>();
    expect(fresh.mirror.find((row) => row.source_key === 'core:faq')).toMatchObject({ healthy: true, stale: false });
  });

  it('lets a guest bearer token win over a staff cookie', async () => {
    // Someone at Envisioning opening a signing link in their normal browser
    // must act as the signer, not as staff — otherwise they cannot sign.
    const doc = await makeDocument({ path: '/contracts/own-browser', title: 'Own browser', body_md: 'text' });
    const grant = await (
      await asStaff(`/api/docs/${doc.id}/grants`, { method: 'POST', body: JSON.stringify({ role: 'commenter' }) })
    ).json<{ url: string }>();
    const claim = await (
      await call('/api/access/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: grant.url.split('/d/')[1], email: 'rosa@org.example' }),
      })
    ).json<{ token: string }>();

    const me = await (
      await call('/api/me', {
        headers: {
          cookie: `docs_session=${await staffToken()}`,
          authorization: `Bearer ${claim.token}`,
        },
      })
    ).json<{ kind: string }>();
    expect(me.kind).toBe('guest');
  });

  it('rejects a bogus bearer rather than falling back to the cookie', async () => {
    const response = await call('/api/docs', {
      headers: { cookie: `docs_session=${await staffToken()}`, authorization: 'Bearer not-a-real-token' },
    });
    expect(response.status).toBe(401);
  });

  it('rejects a session for a non-Envisioning address', async () => {
    // A well-formed JWT is not enough — the domain check is re-run on read.
    const token = await signStaffSession({ sub: 'g-2', email: 'someone@gmail.com', name: 'Outsider' }, env);
    const response = await call('/api/docs', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(401);
  });
});

describe('documents', () => {
  it('creates a document, materializes its folder, and finds it by search', async () => {
    const created = await makeDocument({
      path: '/clients/greiner/proposal-2026',
      title: 'Greiner proposal 2026',
      body_md: '# Greiner\n\nA proposal about packaging foresight.\n\n#packaging',
    });

    expect(created.path).toBe('/clients/greiner/proposal-2026');
    expect(created.version).toBe(1);
    expect(created.editable).toBe(true);
    expect(created.tags).toContain('packaging');

    const tree = await (await asStaff('/api/tree')).json<{ folders: Array<{ path: string }> }>();
    expect(tree.folders.map((folder) => folder.path)).toEqual(
      expect.arrayContaining(['/clients', '/clients/greiner']),
    );

    const search = await (await asStaff('/api/search?q=packaging+foresight')).json<{ hits: Array<{ path: string }> }>();
    expect(search.hits.map((hit) => hit.path)).toContain('/clients/greiner/proposal-2026');
  });

  it('bumps the version and hash only when the body actually changes', async () => {
    const created = await makeDocument({ path: '/notes/alpha', title: 'Alpha', body_md: 'one' });

    const renamed = await (
      await asStaff(`/api/docs/${created.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Alpha renamed' }) })
    ).json<Record<string, any>>();
    expect(renamed.version).toBe(1);
    expect(renamed.content_hash).toBe(created.content_hash);

    const edited = await (
      await asStaff(`/api/docs/${created.id}`, { method: 'PATCH', body: JSON.stringify({ body_md: 'two' }) })
    ).json<Record<string, any>>();
    expect(edited.version).toBe(2);
    expect(edited.content_hash).not.toBe(created.content_hash);
  });

  it('keeps explicit tags on a body-only write, and clears them on tags: []', async () => {
    const created = await makeDocument({
      path: '/house/readme-tags',
      title: 'Readme',
      body_md: 'one #inline',
      tags: ['index', 'standards'],
    });
    expect(created.tags).toEqual(['index', 'inline', 'standards']);

    // Meet's docs_write sent body, base hash and message only, and the tags
    // went to []. Absent `tags` leaves them; an inline tag removed from the
    // body goes with it.
    const edited = await (
      await asStaff(`/api/docs/${created.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body_md: 'two', if_content_hash: created.content_hash, message: 'edit' }),
      })
    ).json<Record<string, any>>();
    expect(edited.tags).toEqual(['index', 'standards']);

    const cleared = await (
      await asStaff(`/api/docs/${created.id}`, { method: 'PATCH', body: JSON.stringify({ body_md: 'three', tags: [] }) })
    ).json<Record<string, any>>();
    expect(cleared.tags).toEqual([]);
  });

  it('refuses a write whose base hash is stale', async () => {
    const created = await makeDocument({ path: '/notes/beta', title: 'Beta', body_md: 'first' });
    await asStaff(`/api/docs/${created.id}`, { method: 'PATCH', body: JSON.stringify({ body_md: 'second' }) });

    const response = await asStaff(`/api/docs/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body_md: 'third', if_content_hash: created.content_hash }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'hash_mismatch' });
  });

  it('resolves wikilinks into backlinks, including ones written before the target existed', async () => {
    await makeDocument({ path: '/notes/source', title: 'Source note', body_md: 'See [[Target note]].' });
    const target = await makeDocument({ path: '/notes/target', title: 'Target note', body_md: 'I am the target.' });

    const detail = await (await asStaff(`/api/docs/${target.id}`)).json<{ backlinks: Array<{ path: string }> }>();
    expect(detail.backlinks.map((link) => link.path)).toContain('/notes/source');
  });

  it('keeps favorite document and folder refs resolvable after a folder move', async () => {
    const document = await makeDocument({ path: '/old/deep/doc', title: 'Deep doc', body_md: 'x' });
    const tree = await (await asStaff('/api/tree')).json<{ folders: Array<{ id: string; path: string }> }>();
    const old = tree.folders.find((folder) => folder.path === '/old');
    expect(old).toBeDefined();

    const before = await (
      await asStaff('/api/favorites/resolve', {
        method: 'POST',
        body: JSON.stringify({ documents: [document.id], folders: [old!.id] }),
      })
    ).json<{ documents: Array<{ target_ref: string; destination: string }>; folders: Array<{ target_ref: string; path: string; destination: string }> }>();
    expect(before.documents[0]).toMatchObject({ target_ref: document.id, destination: '/doc/old/deep/doc' });
    expect(before.folders[0]).toMatchObject({ target_ref: old!.id, path: '/old', destination: `/folder/${old!.id}` });

    const moved = await asStaff(`/api/folders/${old!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ slug: 'new' }),
    });
    expect(moved.status).toBe(200);

    const after = await (
      await asStaff('/api/favorites/resolve', {
        method: 'POST',
        body: JSON.stringify({ documents: [document.id], folders: [old!.id] }),
      })
    ).json<{ documents: Array<{ target_ref: string; path: string; destination: string }>; folders: Array<{ target_ref: string; path: string; destination: string }> }>();
    expect(after.documents[0]).toMatchObject({ target_ref: document.id, path: '/new/deep/doc', destination: '/doc/new/deep/doc' });
    expect(after.folders[0]).toMatchObject({ target_ref: old!.id, path: '/new', destination: `/folder/${old!.id}` });

    const list = await (await asStaff('/api/docs?prefix=/new')).json<{ documents: Array<{ path: string }> }>();
    expect(list.documents.map((doc) => doc.path)).toContain('/new/deep/doc');
  });

  it('omits missing targets and rejects oversized favorite resolution batches', async () => {
    const missing = 'f2d54d12-2180-49c8-a4cc-17ab972e69d1';
    const empty = await (
      await asStaff('/api/favorites/resolve', {
        method: 'POST',
        body: JSON.stringify({ documents: [missing], folders: [missing] }),
      })
    ).json<{ documents: unknown[]; folders: unknown[] }>();
    expect(empty).toEqual({ documents: [], folders: [] });

    const tooMany = await asStaff('/api/favorites/resolve', {
      method: 'POST',
      body: JSON.stringify({ documents: Array(51).fill(missing), folders: Array(50).fill(missing) }),
    });
    expect(tooMany.status).toBe(400);
  });
});

describe('mirrored documents from Core', () => {
  async function ingest(body: unknown): Promise<Response> {
    const payload = JSON.stringify(body);
    const timestamp = String(Date.now());
    return call('/api/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': await hmacSHA256Hex(env.INTERNAL_REQUEST_SECRET, `${timestamp}.${payload}`),
      },
      body: payload,
    });
  }

  const issue = {
    source_system: 'core',
    documents: [
      {
        source_kind: 'newsletter_issue',
        source_id: 'issue-142',
        title: 'Artificial Insights #142',
        body_md: '# Artificial Insights 142\n\nModels are getting cheaper.',
        source_url: 'https://www.org.example/newsletter/142',
      },
    ],
  };

  it('rejects an unsigned request', async () => {
    const response = await call('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(issue),
    });
    expect(response.status).toBe(401);
  });

  it('mirrors a newsletter issue into the tree and makes it searchable', async () => {
    expect((await ingest(issue)).status).toBe(200);

    const hits = await (await asStaff('/api/search?q=cheaper')).json<{ hits: Array<{ path: string; source_kind: string }> }>();
    expect(hits.hits[0]?.path).toBe('/published/newsletter/artificial-insights-142');
    expect(hits.hits[0]?.source_kind).toBe('newsletter_issue');
  });

  it('updates in place on re-sync rather than duplicating', async () => {
    await ingest(issue);
    await ingest({
      ...issue,
      documents: [{ ...issue.documents[0], body_md: '# Artificial Insights 142\n\nRevised text.' }],
    });

    const list = await (await asStaff('/api/docs?source=core')).json<{ documents: unknown[]; total: number }>();
    expect(list.total).toBe(1);
  });

  it('counts a category per source, and lists the library in one request', async () => {
    // A brief Core published and a brief a person wrote share a category;
    // the rail's halves come from source, not from the category's name.
    // The mirror files into the category only because the workspace has it.
    await ensureCategory('brief', 'Briefs');
    await ingest({
      source_system: 'core',
      documents: [{
        source_kind: 'signals_brief',
        source_id: 'brief-1',
        title: 'Travel Under New Rules',
        body_md: 'Borders and algorithms.',
        source_url: 'https://signals.org.example/briefs/travel',
      }],
    });
    await makeDocument({ path: '/work/organization/initech/brief', title: 'Initech brief', body_md: 'x', category: 'brief' });

    const summary = await (await asStaff('/api/docs/summary')).json<{
      categories: Array<{ category: string; count: number }>;
      by_source: Array<{ source: string; category: string; label: string; count: number }>;
    }>();
    expect(summary.categories.find((c) => c.category === 'brief')?.count).toBe(2);
    expect(summary.by_source.filter((row) => row.category === 'brief')).toEqual([
      { source: 'native', category: 'brief', label: 'Briefs', count: 1 },
      { source: 'core', category: 'brief', label: 'Briefs', count: 1 },
    ]);

    const library = await (await asStaff('/api/docs?source=core,obsidian&category=brief')).json<{ documents: Array<{ source_system: string }> }>();
    expect(library.documents.map((doc) => doc.source_system)).toEqual(['core']);
    const bogus = await asStaff('/api/docs?source=core,meet');
    expect(bogus.status).toBe(400);
  });

  it('refuses a body edit, because Core owns that text', async () => {
    await ingest(issue);
    const list = await (await asStaff('/api/docs?source=core')).json<{ documents: Array<{ id: string }> }>();
    const id = list.documents[0]!.id;

    const response = await asStaff(`/api/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ body_md: 'nope' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'read_only' });
  });

  it('records run completion, including from a document-free trailing call', async () => {
    await ingest(issue);
    const response = await ingest({
      source_system: 'core',
      source_kind: 'newsletter_issue',
      documents: [],
      complete: true,
      run_seen: 144,
      run_written: 144,
    });
    expect(response.status).toBe(200);

    const state = await env.DB.prepare(`SELECT * FROM sync_state WHERE source_key = ?`)
      .bind('core:newsletter_issue')
      .first<{ last_status: string; documents_seen: number; documents_written: number }>();
    expect(state?.last_status).toBe('ok');
    expect(state?.documents_seen).toBe(144);
    expect(state?.documents_written).toBe(144);
  });

  it('still accepts annotations on mirrored text', async () => {
    await ingest(issue);
    const list = await (await asStaff('/api/docs?source=core')).json<{ documents: Array<{ id: string }> }>();
    const response = await asStaff(`/api/docs/${list.documents[0]!.id}/annotations`, {
      method: 'POST',
      body: JSON.stringify({ body_md: 'Worth revisiting for the packaging brief.' }),
    });
    expect(response.status).toBe(201);
  });
});

describe('adopting Core notes', () => {
  async function signed(path: string, body: unknown): Promise<Response> {
    const payload = JSON.stringify(body);
    const timestamp = String(Date.now());
    return call(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': await hmacSHA256Hex(env.INTERNAL_REQUEST_SECRET, `${timestamp}.${payload}`),
      },
      body: payload,
    });
  }
  const mirrored = { source_kind: 'note', source_id: 'n1', title: 'Kickoff notes', body_md: 'Mirrored body.' };
  const adoption = {
    source_kind: 'note',
    source_id: 'n1',
    title: 'Kickoff notes',
    body_md: 'Mirrored body.',
    folder_path: '/work/organization/globex',
    subjects: [{ kind: 'organization', subject_id: 'org-globex' }],
    created_at: '2026-03-01T10:00:00.000Z',
    updated_at: '2026-03-02T10:00:00.000Z',
  };

  it('turns a mirrored note into an editable document under its subject', async () => {
    expect((await signed('/api/ingest', { source_system: 'core', documents: [mirrored] })).status).toBe(200);
    const before = await (await asStaff('/api/docs/%2Fcrm%2Fnotes%2Fkickoff-notes')).json<{ id: string; editable: boolean }>();
    expect(before.editable).toBe(false);

    const response = await signed('/api/adopt', { source_system: 'core', documents: [adoption] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ adopted: 1, created: 0, unchanged: 0 });

    const after = await (await asStaff(`/api/docs/${before.id}`)).json<{
      path: string; editable: boolean; version: number; source_url: string | null; subjects: unknown[]; frontmatter: Record<string, unknown>;
    }>();
    expect(after.path).toBe('/work/organization/globex/kickoff-notes');
    expect(after.editable).toBe(true);
    expect(after.version).toBe(1);
    expect(after.source_url).toBeNull();
    expect(after.subjects).toEqual([{ system: 'core', kind: 'organization', subject_id: 'org-globex' }]);
    expect(after.frontmatter.subjects).toEqual(['core:organization:org-globex']);

    // Ours now: it can be edited here, and a later mirror sweep does not
    // put Core's body back.
    const edited = await asStaff(`/api/docs/${before.id}`, { method: 'PATCH', body: JSON.stringify({ body_md: 'Edited in Meet.' }) });
    expect(edited.status).toBe(200);
    const sweep = await (await signed('/api/ingest', { source_system: 'core', documents: [mirrored] })).json<{ unchanged: number; written: number }>();
    expect(sweep).toMatchObject({ unchanged: 1, written: 0 });
    const kept = await (await asStaff(`/api/docs/${before.id}`)).json<{ body_md: string }>();
    expect(kept.body_md).toBe('Edited in Meet.');

    const again = await (await signed('/api/adopt', { source_system: 'core', documents: [adoption] })).json();
    expect(again).toMatchObject({ adopted: 0, created: 0, unchanged: 1 });
  });

  it('maps notes to folders by their first named link, and skips the empty ones', () => {
    const labels = new Map([
      ['organization:org-globex', 'Globex'],
      ['project:proj-7', 'Radar 2027'],
      ['contact:c-9', '   '],
    ]);
    const documents = noteDocuments(
      [
        { id: 'n1', title: 'Kickoff', content_md: 'Body.', linked_org_id: 'org-globex', linked_project_id: 'proj-7' },
        { id: 'n2', title: 'Loose', content_md: 'Body.' },
        // A link whose row has no usable name falls through to the next one.
        { id: 'n3', title: 'Named later', content_md: 'Body.', linked_contact_id: 'c-9', linked_project_id: 'proj-7' },
        // An empty note is not a document.
        { id: 'n4', title: 'Blank', content_md: '   ' },
      ],
      labels,
    );

    expect(documents.map((d) => d.folder_path)).toEqual([
      '/work/organization/globex',
      '/notes',
      '/work/project/radar-2027',
    ]);
    // Filed under one subject, but related to every link.
    expect(documents[0]?.subjects).toEqual([
      { kind: 'organization', subject_id: 'org-globex' },
      { kind: 'project', subject_id: 'proj-7' },
    ]);
    expect(documents[1]?.title).toBe('Loose');
  });

  it('adopts only what is not already ours, so a later pass cannot flatten an edit', async () => {
    const first = await (await signed('/api/adopt', {
      source_system: 'core',
      documents: [{ ...adoption, source_id: 'n5', title: 'Recurring note', folder_path: '/notes', subjects: [] }],
    })).json<{ created: number }>();
    expect(first).toMatchObject({ created: 1 });

    const doc = await (await asStaff('/api/docs/%2Fnotes%2Frecurring-note')).json<{ id: string }>();
    await asStaff(`/api/docs/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ body_md: 'Rewritten here.' }) });

    // The hour after: Core still sends its own older body, and is ignored.
    const second = await (await signed('/api/adopt', {
      source_system: 'core',
      documents: [{ ...adoption, source_id: 'n5', title: 'Recurring note', folder_path: '/notes', subjects: [] }],
    })).json();
    expect(second).toMatchObject({ adopted: 0, created: 0, unchanged: 1 });
    expect((await (await asStaff(`/api/docs/${doc.id}`)).json<{ body_md: string }>()).body_md).toBe('Rewritten here.');
  });

  it('creates a native document for a note the mirror never saw', async () => {
    const response = await signed('/api/adopt', {
      source_system: 'core',
      documents: [{ ...adoption, source_id: 'n2', title: 'Loose thought', folder_path: '/notes', subjects: [] }],
    });
    expect(await response.json()).toMatchObject({ adopted: 0, created: 1 });
    const doc = await (await asStaff('/api/docs/%2Fnotes%2Floose-thought')).json<{ editable: boolean; source_kind: string; subjects: unknown[] }>();
    expect(doc.editable).toBe(true);
    expect(doc.source_kind).toBe('note');
    expect(doc.subjects).toEqual([]);
  });
});

describe('documents that record where they were copied from', () => {
  it('filters on has_source and carries the source on the summary', async () => {
    await makeDocument({
      path: '/method/copied',
      title: 'Copied',
      body_md: 'Body.',
      frontmatter: { source: 'vault:Research-Methodology/01-Strategic-Foresight.md', status: 'current' },
    });
    await makeDocument({
      path: '/method/from-a-repo',
      title: 'From a repo',
      body_md: 'Body.',
      frontmatter: { source: 'repo:envisioning/meet:docs/PRIVACY.md' },
    });
    // Written here, not copied from anywhere — and a body that says the word
    // must not be mistaken for a document that records one.
    await makeDocument({ path: '/method/original', title: 'Original', body_md: 'source: not frontmatter' });

    const all = await (await asStaff('/api/docs?prefix=/method&has_source=')).json<{
      documents: Array<{ path: string; source?: string }>;
    }>();
    expect(all.documents.map((d) => d.path).sort()).toEqual(['/method/copied', '/method/from-a-repo']);
    expect(all.documents.find((d) => d.path === '/method/copied')?.source).toBe(
      'vault:Research-Methodology/01-Strategic-Foresight.md',
    );

    const vaultOnly = await (await asStaff('/api/docs?prefix=/method&has_source=vault:')).json<{
      documents: Array<{ path: string }>;
    }>();
    expect(vaultOnly.documents.map((d) => d.path)).toEqual(['/method/copied']);
  });
});

describe('the hourly sweep', () => {
  it('runs notes as a surface of its own, and says so when CRM is not configured', async () => {
    expect(allSurfaces()).toContain(NOTES_SURFACE);

    // The test Worker has no CRM credentials. A surface that cannot be read
    // has to be a visible error, never a silent skip — that is the whole
    // point of sync_state.
    const runs = await runMirror(env, [NOTES_SURFACE]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.surface).toBe(NOTES_SURFACE);
    expect(runs[0]?.error).toMatch(/CRM is not configured/u);

    const health = await (await call('/api/health')).json<{ mirror: Array<{ source_key: string; last_status: string }> }>();
    expect(health.mirror.find((row) => row.source_key === 'core:note')?.last_status).toBe('error');
  });
});

describe('the www share reader', () => {
  async function signedGet(path: string): Promise<Response> {
    const timestamp = String(Date.now());
    return call(path, {
      headers: {
        'x-internal-timestamp': timestamp,
        'x-internal-signature': await hmacSHA256Hex(env.INTERNAL_REQUEST_SECRET, `${timestamp}.`),
      },
    });
  }

  it('resolves a link-visible document by its id or by the Core note id it was adopted from', async () => {
    const doc = await makeDocument({ path: '/notes/shared', title: 'Shared', body_md: 'Hello.', visibility: 'link' });
    const byId = await signedGet(`/api/internal/documents/${doc.id}`);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject({ id: doc.id, title: 'Shared', body_md: 'Hello.' });

    const noteId = '11111111-2222-4333-8444-555555555555';
    const timestamp = String(Date.now());
    const payload = JSON.stringify({
      source_system: 'core',
      documents: [{ source_kind: 'note', source_id: noteId, title: 'Old note', body_md: 'From Core.', folder_path: '/notes', subjects: [] }],
    });
    await call('/api/adopt', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': await hmacSHA256Hex(env.INTERNAL_REQUEST_SECRET, `${timestamp}.${payload}`),
      },
      body: payload,
    });
    // Adoption files a note as internal; migration 0004 reopens the ones that
    // exist. A note adopted after it needs the same flip.
    await env.DB.prepare(`UPDATE documents SET visibility = 'link' WHERE source_id = ?`).bind(noteId).run();
    const bySource = await signedGet(`/api/internal/documents/${noteId}`);
    expect(bySource.status).toBe(200);
    expect(await bySource.json()).toMatchObject({ title: 'Old note', body_md: 'From Core.' });
  });

  it('answers 404 for an internal document and 401 for an unsigned request', async () => {
    const doc = await makeDocument({ path: '/contracts/quiet', title: 'Quiet', body_md: 'Staff only.' });
    expect((await signedGet(`/api/internal/documents/${doc.id}`)).status).toBe(404);
    expect((await call(`/api/internal/documents/${doc.id}`)).status).toBe(401);
  });
});

describe('the hourly mirror', () => {
  const issue = { id: 'n-77', title: 'Packaging', slug: 'packaging', body: 'On packaging.', edition_number: 77, status: 'published', updated_at: '2026-09-01T00:00:00.000Z' };

  it('reads Core over PostgREST, ingests in-process, and reports per surface', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      const rows = url.pathname.endsWith('/newsletter_issue') ? [issue] : [];
      return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
    });
    try {
      const runs = await runMirror(env, ['newsletter_issue', 'faq']);
      expect(seen).toEqual(['/rest/v1/newsletter_issue', '/rest/v1/faq']);
      expect(runs).toEqual([
        { surface: 'newsletter_issue', seen: 1, written: 1, unchanged: 0 },
        { surface: 'faq', seen: 0, written: 0, unchanged: 0 },
      ]);
      const doc = await (await asStaff('/api/docs/%2Fpublished%2Fnewsletter%2Fpackaging')).json<{ editable: boolean; title: string }>();
      expect(doc.editable).toBe(false);
      expect(doc.title).toBe('Packaging (#77)');

      const again = await runMirror(env, ['newsletter_issue']);
      expect(again[0]).toMatchObject({ written: 0, unchanged: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('records a surface that cannot be read and carries on, and health says so', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/work')) return new Response('{"code":"42501"}', { status: 403 });
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    });
    try {
      const runs = await runMirror(env, ['work', 'faq']);
      expect(runs[0]?.error).toContain('42501');
      expect(runs[1]).toEqual({ surface: 'faq', seen: 0, written: 0, unchanged: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
    const health = await (await call('/api/health')).json<{ mirror: Array<{ source_key: string; last_status: string }> }>();
    expect(health.mirror.find((row) => row.source_key === 'core:work')?.last_status).toBe('error');
    expect(health.mirror.find((row) => row.source_key === 'core:faq')?.last_status).toBe('ok');
  });
});

describe('the document\'s own date', () => {
  it('takes a date on creation and re-dates on a write', async () => {
    // A meeting captured in 2024 and imported today belongs to 2024 — on
    // both timestamps, since every list sorts on one or the other.
    const doc = await makeDocument({
      path: '/work/meetings/historic-transcript',
      title: 'Historic — transcript',
      body_md: 'text',
      category: 'transcript',
      created_at: '2024-03-04T09:30:00.000Z',
    });
    expect(doc.created_at).toBe('2024-03-04T09:30:00.000Z');
    expect(doc.updated_at).toBe('2024-03-04T09:30:00.000Z');

    // The import runs again with a longer transcript: still 2024.
    const rewritten = await (await asStaff(`/api/docs/${doc.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body_md: 'text, and more', created_at: '2024-03-04T09:30:00.000Z' }),
    })).json<Record<string, string>>();
    expect(rewritten.created_at).toBe('2024-03-04T09:30:00.000Z');
    expect(rewritten.updated_at).toBe('2024-03-04T09:30:00.000Z');

    // A person editing it says nothing about the date, and the edit is today.
    const edited = await (await asStaff(`/api/docs/${doc.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body_md: 'edited by hand' }),
    })).json<Record<string, string>>();
    expect(edited.created_at).toBe('2024-03-04T09:30:00.000Z');
    expect(new Date(String(edited.updated_at)).getUTCFullYear()).toBeGreaterThan(2024);
  });

  it('keeps the date when the document is filed on a subject', async () => {
    // Meet writes the transcript with the meeting's date and links it to the
    // project in the next call. The link must not restamp the document.
    const doc = await makeDocument({
      path: '/work/meetings/filed-transcript',
      title: 'Filed — transcript',
      body_md: 'text',
      category: 'transcript',
      created_at: '2024-06-11T14:00:00.000Z',
    });
    const linked = await (await asStaff(`/api/docs/${doc.id}/subjects`, {
      method: 'PUT',
      body: JSON.stringify({ subjects: [{ kind: 'project', subject_id: 'p-1' }] }),
    })).json<Record<string, unknown>>();
    expect(linked.subjects).toHaveLength(1);
    expect(linked.created_at).toBe('2024-06-11T14:00:00.000Z');
    expect(linked.updated_at).toBe('2024-06-11T14:00:00.000Z');
  });

  it('refuses a date that is not a timestamp', async () => {
    const response = await asStaff('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ path: '/work/meetings/bad-date', title: 'Bad date', created_at: '2024-03-04' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('categories', () => {
  it('starts empty, and is a list the workspace edits', async () => {
    const empty = await (await asStaff('/api/categories')).json<{ categories: Array<{ id: string }> }>();
    expect(empty.categories.some((c) => c.id === 'proposal')).toBe(false);

    const created = await asStaff('/api/categories', { method: 'POST', body: JSON.stringify({ label: 'Proposals' }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 'proposals', label: 'Proposals', count: 0 });
    const twin = await asStaff('/api/categories', { method: 'POST', body: JSON.stringify({ label: 'proposals' }) });
    expect(twin.status).toBe(409);
    await ensureCategory('nda', 'NDAs');

    const proposal = await makeDocument({ path: '/work/organization/initech/proposal', title: 'Initech proposal', body_md: 'x', category: 'proposals' });
    await makeDocument({ path: '/work/organization/initech/nda', title: 'Initech NDA', body_md: 'x', category: 'nda' });
    expect(proposal.category).toBe('proposals');
    expect(proposal.transcript).toBe(false);

    const bogus = await asStaff('/api/docs', { method: 'POST', body: JSON.stringify({ path: '/work/bad', title: 'Bad', category: 'memo' }) });
    expect(bogus.status).toBe(400);

    const proposals = await (await asStaff('/api/docs?category=proposals')).json<{ documents: Array<{ id: string }> }>();
    expect(proposals.documents.map((d) => d.id)).toEqual([proposal.id]);

    // A rename keeps the id, so filters and bookmarks survive it.
    const renamed = await asStaff('/api/categories/proposals', { method: 'PATCH', body: JSON.stringify({ label: 'Offers' }) });
    expect(await renamed.json()).toMatchObject({ id: 'proposals', label: 'Offers', count: 1 });

    const ordered = await (await asStaff('/api/categories/order', { method: 'PUT', body: JSON.stringify({ ids: ['nda', 'proposals'] }) }))
      .json<{ categories: Array<{ id: string }> }>();
    expect(ordered.categories.slice(0, 2).map((c) => c.id)).toEqual(['nda', 'proposals']);

    const summary = await (await asStaff('/api/docs/summary')).json<{
      categories: Array<{ category: string; label: string; count: number }>;
      folders: Array<{ path: string; count: number }>;
      total: number;
    }>();
    expect(summary.categories.find((c) => c.category === 'proposals')).toMatchObject({ label: 'Offers', count: 1 });
    expect(summary.folders.find((f) => f.path === '/work')?.count).toBeGreaterThanOrEqual(2);

    // Absent leaves it; null clears it.
    const kept = await (await asStaff(`/api/docs/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Initech proposal v2' }) })).json<{ category: string | null }>();
    expect(kept.category).toBe('proposals');
    const cleared = await (await asStaff(`/api/docs/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ category: null }) })).json<{ category: string | null }>();
    expect(cleared.category).toBeNull();

    // Deleting a category uncategorizes its documents and nothing more.
    expect((await asStaff('/api/categories/nda', { method: 'DELETE' })).status).toBe(204);
    const nda = await (await asStaff('/api/docs/%2Fwork%2Forganization%2Finitech%2Fnda')).json<{ category: string | null; title: string }>();
    expect(nda).toMatchObject({ category: null, title: 'Initech NDA' });
  });
});

describe('long lists', () => {
  it('lists more than a hundred documents in one page (D1 binds at most 100 variables)', async () => {
    for (let index = 0; index < 120; index += 1) {
      await makeDocument({ path: `/bulk/doc-${index}`, title: `Bulk ${index}`, body_md: 'x', tags: ['bulk'] });
    }
    const page = await (await asStaff('/api/docs?prefix=/bulk&limit=200')).json<{ documents: Array<{ tags: string[] }>; total: number }>();
    expect(page.total).toBe(120);
    expect(page.documents).toHaveLength(120);
    expect(page.documents.every((d) => d.tags.includes('bulk'))).toBe(true);
  });
});

describe('pdf documents', () => {
  /**
   * A minimal, valid, uncompressed PDF with a real text layer. Built here
   * rather than committed as a binary so the thing under test — "does the text
   * layer reach the search index" — is legible in the test itself.
   */
  function makePDF(text: string): Uint8Array {
    const content = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`;
    const objects = [
      '<</Type/Catalog/Pages 2 0 R>>',
      '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
      `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
      '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    ];

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;

    const bytes = new Uint8Array(pdf.length);
    for (let index = 0; index < pdf.length; index += 1) bytes[index] = pdf.charCodeAt(index) & 0xff;
    return bytes;
  }

  async function uploadPDF(documentId: string, bytes: Uint8Array): Promise<Response> {
    return asStaff(`/api/docs/${documentId}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: bytes,
    });
  }

  it('extracts the text layer so the PDF is findable by its contents', async () => {
    const placeholder = await makeDocument({ path: '/contracts/greiner-brief', title: 'Greiner brief', kind: 'pdf' });
    const response = await uploadPDF(placeholder.id, makePDF('Mycelium substrates reach shelf in Greiner packaging'));
    expect(response.status).toBe(200);

    const hits = await (await asStaff('/api/search?q=mycelium')).json<{ hits: Array<{ path: string }> }>();
    expect(hits.hits.map((hit) => hit.path)).toContain('/contracts/greiner-brief');
  });

  it('stores a PDF whose text cannot be read, rather than failing the upload', async () => {
    // A scanned or encrypted PDF has no text layer. It must still be stored,
    // viewable and signable — just invisible to search.
    const placeholder = await makeDocument({ path: '/contracts/scanned', title: 'Scanned', kind: 'pdf' });
    const header = new TextEncoder().encode('%PDF-1.4\nthis is not a parseable document\n%%EOF\n');
    const response = await uploadPDF(placeholder.id, header);
    expect(response.status).toBe(200);

    const detail = await (await asStaff('/api/docs/%2Fcontracts%2Fscanned')).json<{ kind: string; content_hash: string }>();
    expect(detail.kind).toBe('pdf');
    expect(detail.content_hash).toHaveLength(64);
  });

  it('rejects a file that is not a PDF whatever the content-type claims', async () => {
    const placeholder = await makeDocument({ path: '/contracts/fake', title: 'Fake', kind: 'pdf' });
    const response = await uploadPDF(placeholder.id, new TextEncoder().encode('PK actually a zip'));
    expect(response.status).toBe(400);
  });
});

describe('guest access', () => {
  it('lets a guest read the shared document and nothing beside it', async () => {
    const shared = await makeDocument({ path: '/clients/acme/brief', title: 'Acme brief', body_md: 'Shared.' });
    const secret = await makeDocument({ path: '/clients/acme/internal', title: 'Internal', body_md: 'Not shared.' });

    const grant = await (
      await asStaff(`/api/docs/${shared.id}/grants`, { method: 'POST', body: JSON.stringify({ role: 'commenter' }) })
    ).json<{ url: string }>();
    const token = grant.url.split('/d/')[1]!;

    const claim = await (
      await call('/api/access/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, email: 'client@acme.test' }),
      })
    ).json<{ status: string; token: string }>();
    expect(claim.status).toBe('ready');

    const auth = { authorization: `Bearer ${claim.token}` };

    const allowed = await call(`/api/docs/${shared.id}`, { headers: auth });
    expect(allowed.status).toBe(200);

    // The neighbour is not merely forbidden — it is indistinguishable from
    // a document that does not exist.
    const denied = await call(`/api/docs/${secret.id}`, { headers: auth });
    expect(denied.status).toBe(404);

    const listing = await call('/api/docs', { headers: auth });
    expect(listing.status).toBe(403);
  });

  it('lets a commenter comment but not a viewer', async () => {
    const doc = await makeDocument({ path: '/clients/acme/note', title: 'Note', body_md: 'Body.' });

    async function guestFor(role: string): Promise<string> {
      const grant = await (
        await asStaff(`/api/docs/${doc.id}/grants`, { method: 'POST', body: JSON.stringify({ role }) })
      ).json<{ url: string }>();
      const claim = await (
        await call('/api/access/claim', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: grant.url.split('/d/')[1], email: `${role}@acme.test` }),
        })
      ).json<{ token: string }>();
      return claim.token;
    }

    const comment = (token: string) =>
      call(`/api/docs/${doc.id}/annotations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ body_md: 'A thought.', anchor: { type: 'text', quote: 'Body.' } }),
      });

    expect((await comment(await guestFor('commenter'))).status).toBe(201);
    expect((await comment(await guestFor('viewer'))).status).toBe(403);
  });

  it('refuses a grant addressed to someone else', async () => {
    const doc = await makeDocument({ path: '/clients/acme/named', title: 'Named', body_md: 'x' });
    const grant = await (
      await asStaff(`/api/docs/${doc.id}/grants`, {
        method: 'POST',
        body: JSON.stringify({ role: 'viewer', email: 'right@acme.test' }),
      })
    ).json<{ url: string }>();

    const response = await call('/api/access/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: grant.url.split('/d/')[1], email: 'wrong@acme.test' }),
    });
    expect(response.status).toBe(403);
  });

  it('lists only documents with an open thread when asked (envisioning/meet#190)', async () => {
    const quiet = await makeDocument({ path: '/notes/quiet', title: 'Quiet', body_md: 'Nothing said.' });
    const talked = await makeDocument({ path: '/notes/talked', title: 'Talked', body_md: 'Something said.' });
    const resolved = await makeDocument({ path: '/notes/resolved', title: 'Resolved', body_md: 'Settled.' });
    await asStaff(`/api/docs/${talked.id}/annotations`, {
      method: 'POST',
      body: JSON.stringify({ body_md: 'Open', anchor: { type: 'text', quote: 'Something' } }),
    });
    const settled = await (await asStaff(`/api/docs/${resolved.id}/annotations`, {
      method: 'POST',
      body: JSON.stringify({ body_md: 'Done', anchor: { type: 'text', quote: 'Settled' } }),
    })).json<{ id: string }>();
    await asStaff(`/api/annotations/${settled.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });

    const list = await (await asStaff('/api/docs?prefix=/notes&open_annotations=1')).json<{ documents: Array<{ id: string }>; total: number }>();
    expect(list.documents.map((document) => document.id)).toEqual([talked.id]);
    expect(list.total).toBe(1);
    const all = await (await asStaff('/api/docs?prefix=/notes')).json<{ documents: Array<{ id: string }> }>();
    const ids = new Set(all.documents.map((document) => document.id));
    expect([quiet.id, resolved.id, talked.id].every((id) => ids.has(id))).toBe(true);
  });

  it('marks an annotation orphaned once its quoted text is gone', async () => {
    const doc = await makeDocument({ path: '/notes/anchored', title: 'Anchored', body_md: 'Keep this sentence.' });
    await asStaff(`/api/docs/${doc.id}/annotations`, {
      method: 'POST',
      body: JSON.stringify({ body_md: 'Comment', anchor: { type: 'text', quote: 'Keep this sentence.' } }),
    });

    await asStaff(`/api/docs/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ body_md: 'Rewritten entirely.' }) });

    const list = await (await asStaff(`/api/docs/${doc.id}/annotations`)).json<{ annotations: Array<{ orphaned: boolean }> }>();
    expect(list.annotations[0]?.orphaned).toBe(true);
  });
});

describe('guest views and clicks reach the workspace (envisioning/starlings#1045)', () => {
  type Sent = Record<string, any>;

  /** The Worker with a MEET binding that records every documentAccessed call. */
  function withMeet(sent: Sent[], fail = false) {
    const meetEnv = {
      ...env,
      MEET: {
        check: async () => ({ ok: true }),
        documentAccessed: async (input: Sent) => {
          if (fail) throw new Error('documentAccessed is not a method');
          sent.push(input);
          return { ok: true };
        },
      },
    } as Env;
    return async (path: string, init: RequestInit = {}): Promise<Response> => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init), meetEnv, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };
  }

  async function guestToken(documentId: string, email: string): Promise<string> {
    const grant = await (
      await asStaff(`/api/docs/${documentId}/grants`, { method: 'POST', body: JSON.stringify({ role: 'viewer' }) })
    ).json<{ url: string }>();
    const claim = await (
      await call('/api/access/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: grant.url.split('/d/')[1], email }),
      })
    ).json<{ token: string }>();
    return claim.token;
  }

  async function signedPost(callWith: (path: string, init?: RequestInit) => Promise<Response>, path: string, body: unknown) {
    const payload = JSON.stringify(body);
    const timestamp = String(Date.now());
    return callWith(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': await hmacSHA256Hex(env.INTERNAL_REQUEST_SECRET, `${timestamp}.${payload}`),
      },
      body: payload,
    });
  }

  it('records a grant guest\'s view and click and tells the workspace', async () => {
    const doc = await makeDocument({ path: '/clients/acme/proposal', title: 'Acme proposal', body_md: 'See [site](https://acme.test).' });
    await asStaff(`/api/docs/${doc.id}/subjects`, {
      method: 'PUT',
      body: JSON.stringify({ subjects: [{ kind: 'organization', subject_id: 'org-acme-1045' }] }),
    });
    const sent: Sent[] = [];
    const callWith = withMeet(sent);
    const auth = { authorization: `Bearer ${await guestToken(doc.id, 'Client@Acme.test')}`, 'content-type': 'application/json' };

    expect((await callWith(`/api/docs/${doc.id}/visit`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(204);
    expect((await callWith(`/api/docs/${doc.id}/click`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ href: 'https://acme.test/' }),
    })).status).toBe(204);

    expect(sent.map((input) => input.kind)).toEqual(['view', 'click']);
    expect(sent[1]).toMatchObject({
      v: 1,
      document_id: doc.id,
      title: 'Acme proposal',
      owner: 'rosa@org.example',
      kind: 'click',
      actor: 'client@acme.test',
      via: 'grant',
      href: 'https://acme.test/',
      subjects: [{ kind: 'organization', subject_id: 'org-acme-1045' }],
    });
    expect(sent[0]!.href).toBeNull();
    expect(typeof sent[0]!.grant_id).toBe('string');

    const events = await (await asStaff(`/api/docs/${doc.id}/access-events`)).json<{ events: Array<Record<string, any>> }>();
    const click = events.events.find((event) => event.kind === 'click');
    expect(click?.id).toBe(sent[1]!.event_id);
    expect(click?.detail).toMatchObject({ href: 'https://acme.test/' });
  });

  it('refuses a click on anything but an http(s) URL', async () => {
    const doc = await makeDocument({ path: '/clients/acme/scheme', title: 'Scheme', body_md: 'x' });
    const auth = { authorization: `Bearer ${await guestToken(doc.id, 'client@acme.test')}`, 'content-type': 'application/json' };
    const response = await call(`/api/docs/${doc.id}/click`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ href: 'javascript:alert(1)' }),
    });
    expect(response.status).toBe(400);
  });

  it('never tells the workspace about staff', async () => {
    const doc = await makeDocument({ path: '/clients/acme/staff-read', title: 'Staff read', body_md: 'x' });
    const sent: Sent[] = [];
    const callWith = withMeet(sent);
    const response = await callWith(`/api/docs/${doc.id}/visit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await staffToken()}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(204);
    expect(sent).toEqual([]);
  });

  it('records a www visit and click as guest events, with the place www saw', async () => {
    const doc = await makeDocument({ path: '/notes/www-shared', title: 'Shared on www', body_md: 'x', visibility: 'link' });
    const sent: Sent[] = [];
    const callWith = withMeet(sent);

    const view = await signedPost(callWith, `/api/internal/documents/${doc.id}/access`, {
      kind: 'view', email: 'Reader@Example.test', city: 'Lisbon', country: 'PT', timezone: 'Europe/Lisbon',
    });
    expect(view.status).toBe(204);
    const click = await signedPost(callWith, `/api/internal/documents/${doc.id}/access`, {
      kind: 'click', email: 'reader@example.test', href: 'https://example.test/a',
    });
    expect(click.status).toBe(204);

    expect(sent[0]).toMatchObject({ kind: 'view', actor: 'reader@example.test', via: 'www', grant_id: null, city: 'Lisbon', country: 'PT', href: null });
    expect(sent[1]).toMatchObject({ kind: 'click', via: 'www', href: 'https://example.test/a' });

    const events = await (await asStaff(`/api/docs/${doc.id}/access-events`)).json<{ events: Array<Record<string, any>> }>();
    expect(events.events.filter((event) => event.actor_kind === 'guest').map((event) => event.kind).sort()).toEqual(['click', 'view']);
  });

  it('answers 404 for an internal document, 400 for a click without href, 401 unsigned', async () => {
    const quiet = await makeDocument({ path: '/notes/www-quiet', title: 'Quiet', body_md: 'x' });
    const shared = await makeDocument({ path: '/notes/www-open', title: 'Open', body_md: 'x', visibility: 'link' });
    const callWith = withMeet([]);
    expect((await signedPost(callWith, `/api/internal/documents/${quiet.id}/access`, { kind: 'view', email: 'a@b.test' })).status).toBe(404);
    expect((await signedPost(callWith, `/api/internal/documents/${shared.id}/access`, { kind: 'click', email: 'a@b.test' })).status).toBe(400);
    expect((await call(`/api/internal/documents/${shared.id}/access`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('keeps the request whole when the workspace Worker lacks the method', async () => {
    const doc = await makeDocument({ path: '/notes/www-old-worker', title: 'Old worker', body_md: 'x', visibility: 'link' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await signedPost(withMeet([], true), `/api/internal/documents/${doc.id}/access`, { kind: 'view', email: 'a@b.test' });
    expect(response.status).toBe(204);
    vi.restoreAllMocks();
  });
});

describe('signatures', () => {
  let logged: string[] = [];

  beforeEach(() => {
    logged = [];
    // EMAIL_MODE=log puts the verification code in the Worker log; that is how
    // the flow is exercised without a real inbox.
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
  });

  function codeFromLog(): string {
    for (const line of [...logged].reverse()) {
      const match = /Your verification code is (\d{6})/u.exec(line);
      if (match?.[1]) return match[1];
    }
    throw new Error('No verification code was logged.');
  }

  it('runs a full sign flow and seals the record', async () => {
    const doc = await makeDocument({ path: '/contracts/acme-msa', title: 'Acme MSA', body_md: 'The agreement text.' });

    const request = await (
      await asStaff(`/api/docs/${doc.id}/signature-requests`, {
        method: 'POST',
        body: JSON.stringify({
          subject: 'Please sign the Acme MSA',
          parties: [{ email: 'signer@acme.test', name: 'Ada Signer' }],
        }),
      })
    ).json<{ id: string; content_hash: string; parties: Array<{ url: string }> }>();

    expect(request.content_hash).toBe(doc.content_hash);
    const token = request.parties[0]!.url.split('/d/')[1]!;

    // A signer grant always demands the mailed code.
    const claim = await (
      await call('/api/access/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, email: 'signer@acme.test' }),
      })
    ).json<{ status: string }>();
    expect(claim.status).toBe('verify');

    const verified = await (
      await call('/api/access/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, email: 'signer@acme.test', code: codeFromLog() }),
      })
    ).json<{ token: string; session: { verified: boolean } }>();
    expect(verified.session.verified).toBe(true);

    const signed = await call(`/api/signature-requests/${request.id}/sign`, {
      method: 'POST',
      headers: { authorization: `Bearer ${verified.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        content_hash: doc.content_hash,
        method: 'typed',
        name: 'Ada Signer',
        consent: true,
      }),
    });
    expect(signed.status).toBe(200);

    const detail = await (await asStaff(`/api/signature-requests/${request.id}`)).json<{ status: string }>();
    expect(detail.status).toBe('completed');

    const certificate = await (await asStaff(`/api/signature-requests/${request.id}/certificate`)).text();
    expect(certificate).toContain('Seal verified: **yes**');
    expect(certificate).toContain(doc.content_hash);
  });

  it('refuses to sign bytes the signer was not shown', async () => {
    const doc = await makeDocument({ path: '/contracts/moving', title: 'Moving target', body_md: 'v1' });
    const request = await (
      await asStaff(`/api/docs/${doc.id}/signature-requests`, {
        method: 'POST',
        body: JSON.stringify({ parties: [{ email: 'signer2@acme.test' }] }),
      })
    ).json<{ id: string; parties: Array<{ url: string }> }>();
    const token = request.parties[0]!.url.split('/d/')[1]!;

    await call('/api/access/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, email: 'signer2@acme.test' }),
    });
    const verified = await (
      await call('/api/access/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, email: 'signer2@acme.test', code: codeFromLog() }),
      })
    ).json<{ token: string }>();

    const response = await call(`/api/signature-requests/${request.id}/sign`, {
      method: 'POST',
      headers: { authorization: `Bearer ${verified.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        content_hash: 'f'.repeat(64),
        method: 'typed',
        name: 'Someone',
        consent: true,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'hash_mismatch' });
  });

  it('will not sign from an unverified session', async () => {
    const doc = await makeDocument({ path: '/contracts/unverified', title: 'Unverified', body_md: 'text' });
    const request = await (
      await asStaff(`/api/docs/${doc.id}/signature-requests`, {
        method: 'POST',
        body: JSON.stringify({ parties: [{ email: 'signer3@acme.test' }] }),
      })
    ).json<{ id: string }>();

    // A plain viewer grant on the same document must not be able to sign.
    const grant = await (
      await asStaff(`/api/docs/${doc.id}/grants`, { method: 'POST', body: JSON.stringify({ role: 'viewer' }) })
    ).json<{ url: string }>();
    const claim = await (
      await call('/api/access/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: grant.url.split('/d/')[1], email: 'signer3@acme.test' }),
      })
    ).json<{ token: string }>();

    const response = await call(`/api/signature-requests/${request.id}/sign`, {
      method: 'POST',
      headers: { authorization: `Bearer ${claim.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content_hash: doc.content_hash, method: 'typed', name: 'X', consent: true }),
    });
    expect(response.status).toBe(403);
  });
});

describe('agent tokens', () => {
  async function issueToken(body: Record<string, unknown>): Promise<string> {
    const response = await asStaff('/api/tokens', { method: 'POST', body: JSON.stringify(body) });
    expect(response.status).toBe(201);
    const created = await response.json<{ token: string }>();
    return created.token;
  }

  it('lists a token without its secret, and revoking one stops it working', async () => {
    const token = await issueToken({ name: 'docsctl on my laptop', scopes: ['docs:read'] });
    expect(await (await call('/api/me', { headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({
      kind: 'agent',
    });

    const listed = await (await asStaff('/api/tokens')).json<{ tokens: Array<Record<string, unknown>> }>();
    const mine = listed.tokens.find((row) => row.name === 'docsctl on my laptop');
    // The page shows the prefix so a token can be recognized; the secret is
    // returned once, on create, and never again by anything.
    expect(mine).toMatchObject({ prefix: token.slice(0, mine!.prefix!.toString().length), revoked_at: null });
    expect(JSON.stringify(listed)).not.toContain(token);

    const revoked = await asStaff(`/api/tokens/${mine!.id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(204);
    expect((await call('/api/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('omits favorite targets outside an agent token path prefix', async () => {
    const allowedDocument = await makeDocument({ path: '/agents/hermes/favorite', title: 'Allowed', body_md: 'x' });
    const privateDocument = await makeDocument({ path: '/strategy/favorite', title: 'Private', body_md: 'secret' });
    const tree = await (await asStaff('/api/tree')).json<{ folders: Array<{ id: string; path: string }> }>();
    const allowedFolder = tree.folders.find((folder) => folder.path === '/agents/hermes');
    const privateFolder = tree.folders.find((folder) => folder.path === '/strategy');
    expect(allowedFolder).toBeDefined();
    expect(privateFolder).toBeDefined();

    const token = await issueToken({
      name: 'Scoped resolver',
      scopes: ['docs:read'],
      path_prefix: '/agents/hermes',
    });
    const response = await call('/api/favorites/resolve', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        documents: [allowedDocument.id, privateDocument.id],
        folders: [allowedFolder!.id, privateFolder!.id],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<{
      documents: Array<{ target_ref: string }>;
      folders: Array<{ target_ref: string; path: string }>;
    }>();
    expect(body.documents.map((document) => document.target_ref)).toEqual([allowedDocument.id]);
    expect(body.folders.map((folder) => folder.target_ref)).toEqual([allowedFolder!.id]);
    expect(JSON.stringify(body)).not.toContain(privateDocument.id);
    expect(JSON.stringify(body)).not.toContain('/strategy');
  });

  it('confines a path-scoped token to its subtree', async () => {
    const token = await issueToken({
      name: 'Research agent',
      scopes: ['docs:read', 'docs:write'],
      agent_name: 'hermes',
      path_prefix: '/agents/hermes',
    });

    const allowed = await call('/api/docs', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/agents/hermes/finding-1', title: 'Finding 1', body_md: 'Observed.' }),
    });
    expect(allowed.status).toBe(201);

    const denied = await call('/api/docs', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/strategy/secret-plan', title: 'Plan', body_md: 'nope' }),
    });
    expect(denied.status).toBe(403);
  });

  it('enforces scopes', async () => {
    const token = await issueToken({ name: 'Reader', scopes: ['docs:read'] });
    const response = await call('/api/docs', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/notes/nope', title: 'Nope', body_md: 'x' }),
    });
    expect(response.status).toBe(403);
  });

  it('lets a token with grants:write share, attributed to its owner, and refuses one without', async () => {
    const doc = await makeDocument({ path: '/work/organization/hooli/nda', title: 'Hooli NDA', body_md: 'Confidential.' });
    const sharer = await issueToken({ name: 'Meet on mini', scopes: ['docs:read', 'grants:write'], agent_name: 'meet:mini' });
    const created = await call(`/api/docs/${doc.id}/grants`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sharer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    });
    expect(created.status).toBe(201);
    const grant = await created.json<{ id: string; created_by: string; url: string }>();
    expect(grant.created_by).toBe('rosa@org.example');
    expect(grant.url).toContain('/d/');

    const reader = await issueToken({ name: 'Reader', scopes: ['docs:read'] });
    const refused = await call(`/api/docs/${doc.id}/grants`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reader}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    });
    expect(refused.status).toBe(403);

    const revoked = await call(`/api/grants/${grant.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${sharer}` } });
    expect(revoked.status).toBe(204);
  });

  it('attributes an agent write to its owner and name', async () => {
    const token = await issueToken({ name: 'Writer', scopes: ['docs:read', 'docs:write'], agent_name: 'claude' });
    const created = await (
      await call('/api/docs', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/notes/by-agent', title: 'By agent', body_md: 'Written by a machine.' }),
      })
    ).json<{ id: string; updated_by: string }>();

    expect(created.updated_by).toBe('rosa@org.example');

    const versions = await (await asStaff(`/api/docs/${created.id}/versions`)).json<{
      versions: Array<{ author_kind: string; message: string | null }>;
    }>();
    expect(versions.versions[0]?.author_kind).toBe('agent');
    expect(versions.versions[0]?.message).toBe('via claude');
  });
});

describe('subjects', () => {
  const acme = { kind: 'organization', subject_id: 'org-acme' };
  const jane = { kind: 'contact', subject_id: 'contact-jane' };

  it('creates a document about a subject and lists it by that subject', async () => {
    const doc = await makeDocument({
      path: '/work/organization/acme/proposal',
      title: 'Acme proposal',
      body_md: 'Scope and price.',
      subjects: [acme, jane],
    });
    expect(doc.subjects).toEqual([
      { system: 'core', ...jane },
      { system: 'core', ...acme },
    ]);
    // The projection rides in frontmatter so a vault mirror sees it too.
    expect(doc.frontmatter.subjects).toEqual(['core:contact:contact-jane', 'core:organization:org-acme']);

    const about = await (await asStaff('/api/docs?subject=core:organization:org-acme')).json<{
      documents: Array<{ id: string; subjects: unknown[] }>;
    }>();
    expect(about.documents.map((d) => d.id)).toEqual([doc.id]);
    expect(about.documents[0]?.subjects).toHaveLength(2);

    const nobody = await (await asStaff('/api/docs?subject=core:organization:org-other')).json<{ total: number }>();
    expect(nobody.total).toBe(0);
  });

  it('replaces subjects and survives a frontmatter overwrite', async () => {
    const doc = await makeDocument({ path: '/work/loose', title: 'Loose', body_md: 'x', subjects: [acme] });

    const replaced = await (
      await asStaff(`/api/docs/${doc.id}/subjects`, { method: 'PUT', body: JSON.stringify({ subjects: [jane] }) })
    ).json<{ subjects: Array<{ kind: string }>; frontmatter: Record<string, unknown> }>();
    expect(replaced.subjects.map((s) => s.kind)).toEqual(['contact']);
    expect(replaced.frontmatter.subjects).toEqual(['core:contact:contact-jane']);

    // A client that rewrites frontmatter wholesale is not editing subjects.
    const overwritten = await (
      await asStaff(`/api/docs/${doc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ frontmatter: { status: 'draft', subjects: ['core:organization:bogus'] } }),
      })
    ).json<{ subjects: Array<{ kind: string }>; frontmatter: Record<string, unknown> }>();
    expect(overwritten.subjects.map((s) => s.kind)).toEqual(['contact']);
    expect(overwritten.frontmatter).toEqual({ status: 'draft', subjects: ['core:contact:contact-jane'] });

    const cleared = await (
      await asStaff(`/api/docs/${doc.id}/subjects`, { method: 'PUT', body: JSON.stringify({ subjects: [] }) })
    ).json<{ subjects: unknown[]; frontmatter: Record<string, unknown> }>();
    expect(cleared.subjects).toEqual([]);
    expect(cleared.frontmatter).toEqual({ status: 'draft' });
  });

  it('rejects a subject kind the registry does not have', async () => {
    const response = await asStaff('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ path: '/work/bad', title: 'Bad', subjects: [{ kind: 'meeting', subject_id: 'm1' }] }),
    });
    expect(response.status).toBe(400);
  });
});

describe('meet token exchange', () => {
  async function exchange(body: unknown, secret = env.DOCS_INTERNAL_SECRET): Promise<Response> {
    const payload = JSON.stringify(body);
    const timestamp = String(Date.now());
    return call('/api/tokens/meet-exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': await hmacSHA256Hex(secret, `${timestamp}.${payload}`),
      },
      body: payload,
    });
  }

  it('rejects a request signed with the Core secret, not the Meet one', async () => {
    const response = await exchange({ email: 'rosa@org.example', device_name: 'mini' }, env.INTERNAL_REQUEST_SECRET);
    expect(response.status).toBe(401);
  });

  it('refuses a non-Envisioning address even when correctly signed', async () => {
    const response = await exchange({ email: 'someone@example.com', device_name: 'mini' });
    expect(response.status).toBe(403);
  });

  it('admits an @org-alt.example address, the second identity domain', async () => {
    const response = await exchange({ email: 'someone@org-alt.example', device_name: 'mini' });
    expect(response.status).toBe(201);
    const body = await response.json<{ email: string }>();
    expect(body.email).toBe('someone@org-alt.example');
  });

  it('mints a device token that writes as the owner, and re-minting revokes the old one', async () => {
    const first = await exchange({ email: 'ROSA@org.example', device_name: 'mini' });
    expect(first.status).toBe(201);
    const a = await first.json<{ token: string; scopes: string[]; expires_at: string; email: string }>();
    expect(a.email).toBe('rosa@org.example');
    expect(a.scopes).toContain('docs:write');
    expect(a.scopes).toContain('sign:manage');
    expect(a.scopes).not.toContain('sync:write');
    expect(Date.parse(a.expires_at)).toBeGreaterThan(Date.now() + 80 * 86_400_000);

    const created = await (
      await call('/api/docs', {
        method: 'POST',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/work/from-meet', title: 'From Meet', body_md: 'Typed on the Mac.' }),
      })
    ).json<{ id: string; updated_by: string }>();
    expect(created.updated_by).toBe('rosa@org.example');
    const versions = await (await asStaff(`/api/docs/${created.id}/versions`)).json<{
      versions: Array<{ message: string | null }>;
    }>();
    expect(versions.versions[0]?.message).toBe('via meet:mini');

    // A second mint moments later leaves the first token alone: Meet's Worker
    // mints from many isolates at once while a queue drains, and revoking on
    // every mint had them killing each other's in-flight writes.
    const live = async () => {
      const tokens = await (await asStaff('/api/tokens')).json<{ tokens: Array<{ agent_name: string | null; revoked_at: string | null }> }>();
      return tokens.tokens.filter((t) => t.agent_name === 'meet:mini' && !t.revoked_at);
    };
    const before = (await live()).length;

    const second = await exchange({ email: 'rosa@org.example', device_name: 'mini' });
    expect(second.status).toBe(201);
    const stillGood = await call('/api/me', { headers: { authorization: `Bearer ${a.token}` } });
    expect(stillGood.status).toBe(200);
    expect(await live()).toHaveLength(before + 1);

    // A device re-linking a day later still replaces what it held.
    await env.DB.prepare(
      `UPDATE api_tokens SET created_at = ? WHERE agent_name = 'meet:mini' AND revoked_at IS NULL`,
    ).bind(new Date(Date.now() - 2 * 86_400_000).toISOString()).run();
    const third = await exchange({ email: 'rosa@org.example', device_name: 'mini' });
    expect(third.status).toBe(201);
    const stale = await call('/api/me', { headers: { authorization: `Bearer ${a.token}` } });
    expect(stale.status).toBe(401);
    expect(await live()).toHaveLength(1);
  });
});

describe('sync', () => {
  it('pushes a batch, reports conflicts, and skips unchanged files', async () => {
    const first = await asStaff('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        documents: [
          { path: '/vault/research/one', title: 'One', body_md: 'alpha' },
          { path: '/vault/research/two', title: 'Two', body_md: 'beta' },
        ],
        message: 'initial import',
      }),
    });
    const pushed = await first.json<{ written: Array<{ path: string; content_hash: string }> }>();
    expect(pushed.written).toHaveLength(2);

    const again = await (
      await asStaff('/api/sync/push', {
        method: 'POST',
        body: JSON.stringify({ documents: [{ path: '/vault/research/one', title: 'One', body_md: 'alpha' }] }),
      })
    ).json<{ skipped: Array<{ reason: string }> }>();
    expect(again.skipped[0]?.reason).toBe('unchanged');

    const conflicted = await (
      await asStaff('/api/sync/push', {
        method: 'POST',
        body: JSON.stringify({
          documents: [
            { path: '/vault/research/one', title: 'One', body_md: 'gamma', base_hash: '0'.repeat(64) },
          ],
        }),
      })
    ).json<{ conflicts: Array<{ path: string }> }>();
    expect(conflicted.conflicts[0]?.path).toBe('/vault/research/one');
  });

  it('returns a manifest a client can diff', async () => {
    // Own prefix: storage is shared across tests in this file, so a manifest
    // scoped to /vault would also see what the push test wrote.
    await asStaff('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({ documents: [{ path: '/manifest-scope/a', title: 'A', body_md: 'x' }] }),
    });
    const manifest = await (await asStaff('/api/sync/manifest?prefix=/manifest-scope')).json<{
      entries: Array<{ path: string; content_hash: string }>;
    }>();
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.content_hash).toHaveLength(64);
  });
});

describe('a transcript stays internal', () => {
  it('refuses link or public on create and on update', async () => {
    const refused = await asStaff('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ path: '/work/meetings/shared-transcript', title: 'Shared', category: 'transcript', visibility: 'link' }),
    });
    expect(refused.status).toBe(400);

    const doc = await makeDocument({ path: '/work/meetings/kept-transcript', title: 'Kept', body_md: 'words', category: 'transcript' });
    expect(doc).toMatchObject({ transcript: true, category: null });
    // Clearing the category does not clear the marker.
    const uncategorized = await asStaff(`/api/docs/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ category: null, visibility: 'link' }) });
    expect(uncategorized.status).toBe(400);
    const flipped = await asStaff(`/api/docs/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ visibility: 'public' }) });
    expect(flipped.status).toBe(400);

    // Recategorising a shared note as a transcript is the same act.
    const note = await makeDocument({ path: '/notes/was-a-note', title: 'Note', body_md: 'x', visibility: 'link' });
    const recategorised = await asStaff(`/api/docs/${note.id}`, { method: 'PATCH', body: JSON.stringify({ category: 'transcript' }) });
    expect(recategorised.status).toBe(400);
  });

  it('refuses a grant on a transcript', async () => {
    const doc = await makeDocument({ path: '/work/meetings/granted-transcript', title: 'Granted', body_md: 'words', category: 'transcript' });
    const response = await asStaff(`/api/docs/${doc.id}/grants`, { method: 'POST', body: JSON.stringify({ role: 'viewer' }) });
    expect(response.status).toBe(400);
  });

  it('is never served by the share reader, even when an old row says link', async () => {
    const doc = await makeDocument({ path: '/work/contact/someone/old-transcript', title: 'Old', body_md: 'words', visibility: 'link' });
    await env.DB.prepare(`UPDATE documents SET category = 'transcript' WHERE id = ?`).bind(doc.id).run();
    const timestamp = String(Date.now());
    const signature = await hmacSHA256Hex(env.INTERNAL_REQUEST_SECRET, `${timestamp}.`);
    const response = await call(`/api/internal/documents/${doc.id}`, {
      headers: { 'x-internal-timestamp': timestamp, 'x-internal-signature': signature },
    });
    expect(response.status).toBe(404);
  });
});

describe('purge', () => {
  it('removes the row and every version, where delete only hides it', async () => {
    const doc = await makeDocument({ path: '/work/meetings/personal-transcript', title: 'Personal', body_md: 'first', category: 'transcript' });
    await asStaff(`/api/docs/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ body_md: 'second' }) });
    const purged = await asStaff(`/api/docs/${doc.id}?purge=1`, { method: 'DELETE' });
    expect(purged.status).toBe(204);
    const rows = await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM documents WHERE id = ?1) AS docs,
        (SELECT COUNT(*) FROM document_versions WHERE document_id = ?1) AS versions`).bind(doc.id).first<{ docs: number; versions: number }>();
    expect(rows).toEqual({ docs: 0, versions: 0 });
  });
});

describe('owner-private link saves (meet#431)', () => {
  async function asMember(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await signStaffSession({ sub: 'g-3', email: 'fabio@org.example', name: 'Fabio' }, env);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return call(path, { ...init, headers });
  }

  async function saveAsMember(url: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const response = await asMember('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ url, title: 'Dear Data', body_md: 'dataviz postcards', ...extra }),
    });
    expect(response.status).toBe(201);
    return response.json();
  }

  it('shows a loose save to its author and to nobody else', async () => {
    const save = await saveAsMember('https://dear-data.example/');
    expect(save.private).toBe(true);

    // The author reads it everywhere.
    expect((await asMember(`/api/docs/${save.id}`)).status).toBe(200);
    const own = await (await asMember('/api/docs?source=native&source_kind=link')).json<{ documents: Array<{ id: string }> }>();
    expect(own.documents.map((d) => d.id)).toContain(save.id);

    // Another member gets no row, no count, no hit, no image, no comment.
    expect((await asStaff(`/api/docs/${save.id}`)).status).toBe(404);
    expect((await asStaff(`/api/docs/${save.id}/raw`)).status).toBe(404);
    expect((await asStaff(`/api/docs/${save.id}/annotations`)).status).toBe(404);
    expect((await asStaff(`/api/docs/${save.id}/link-image`)).status).toBe(404);
    const listed = await (await asStaff('/api/docs?limit=200')).json<{ documents: Array<{ id: string }>; total: number }>();
    expect(listed.documents.map((d) => d.id)).not.toContain(save.id);
    const hits = await (await asStaff('/api/search?q=postcards')).json<{ hits: Array<{ id: string }> }>();
    expect(hits.hits.map((h) => h.id)).not.toContain(save.id);
    const mine = await (await asMember('/api/search?q=postcards')).json<{ hits: Array<{ id: string }> }>();
    expect(mine.hits.map((h) => h.id)).toContain(save.id);
    const theirs = await (await asStaff('/api/docs/summary')).json<{ links: number }>();
    const author = await (await asMember('/api/docs/summary')).json<{ links: number }>();
    expect(author.links).toBe(theirs.links + 1);
    const manifest = await (await asStaff('/api/sync/manifest')).json<{ entries: Array<{ path: string }> }>();
    expect(manifest.entries.map((e) => e.path)).not.toContain(save.path);

    // Nor can another member change it or share it.
    expect((await asStaff(`/api/docs/${save.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Mine now' }) })).status).toBe(404);
    expect((await asStaff(`/api/docs/${save.id}/grants`, { method: 'POST', body: JSON.stringify({ email: 'x@example.com' }) })).status).toBe(404);
  });

  it('files a save on a subject and makes it the workspace\'s', async () => {
    const save = await saveAsMember('https://filed.example/');
    const filed = await asMember(`/api/docs/${save.id}/subjects`, {
      method: 'PUT',
      body: JSON.stringify({ subjects: [{ kind: 'organization', subject_id: 'org-acme' }] }),
    });
    expect(filed.status).toBe(200);
    expect((await filed.json<{ private: boolean }>()).private).toBe(false);
    expect((await asStaff(`/api/docs/${save.id}`)).status).toBe(200);

    // A promotion is not undone by taking the subject away.
    await asMember(`/api/docs/${save.id}/subjects`, { method: 'PUT', body: JSON.stringify({ subjects: [] }) });
    expect((await asStaff(`/api/docs/${save.id}`)).status).toBe(200);
  });

  it('is born internal when it is saved on a subject', async () => {
    const save = await saveAsMember('https://born-filed.example/', {
      subjects: [{ kind: 'organization', subject_id: 'org-acme' }],
    });
    expect(save.private).toBe(false);
    expect((await asStaff(`/api/docs/${save.id}`)).status).toBe(200);
  });

  it('keeps every other document internal', async () => {
    const doc = await makeDocument({ path: '/work/private-rule-note', title: 'Plain note', body_md: 'x' });
    expect(doc.private).toBe(false);
    expect((await asMember(`/api/docs/${doc.id}`)).status).toBe(200);
  });
});
