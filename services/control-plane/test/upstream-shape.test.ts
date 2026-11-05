import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crmSubjectSchema } from '@starlings/contracts/crm';
import { crmLedgerRowSchema } from '../src/crm';
import { DocsError, getDocsDocument, resetDocsTokenCache } from '../src/docs';
import { GithubError } from '../src/github-app';
import { connectedGithub } from './github-broker-fake';
import { readIssue } from '../src/github-issues';
import { lenient, parseUpstream } from '../src/upstream';
import { coreInteraction, docsDocumentDetail } from './core-rows';

// meet#335 for GitHub and Docs, and the lenient read every upstream shares:
// a schema is checked as the clients decode it, never stricter.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function loggedShape(spy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
}

describe('lenient', () => {
  const subject = { id: 's-1', kind: 'project', title: 'Acme', subtitle: null };

  it('reads a value set as open, like the Swift decoder', () => {
    expect(crmSubjectSchema.safeParse({ ...subject, kind: 'venue' }).success).toBe(false);
    expect(lenient(crmSubjectSchema).safeParse({ ...subject, kind: 'venue' }).success).toBe(true);
  });

  it('keeps fields it does not know, at every depth', () => {
    const parsed = parseUpstream(crmLedgerRowSchema, coreInteraction({ added: 1, contacts: [{ id: 'c', name: null, email: null, added: 2 }] }), {
      source: 'core', route: 'GET /test', error: GithubError,
    });
    expect(parsed).toMatchObject({ added: 1, contacts: [{ added: 2 }] });
  });

  it('keeps a default and every required field', () => {
    expect(lenient(crmLedgerRowSchema).parse(coreInteraction())).toMatchObject({ meeting_kind: null, granola_note_id: null });
    expect(lenient(crmSubjectSchema).safeParse({ ...subject, title: undefined }).success).toBe(false);
  });
});

describe('Docs reads', () => {
  const docsEnv = { ...env, DOCS_INTERNAL_SECRET: 'meet-docs-shared-secret-at-least-32-chars' } as Env;
  const issued = { token: 'evd_test', scopes: ['docs:read'], expires_at: '2027-01-01T00:00:00.000Z', email: 'rosa@example.com' };

  beforeEach(() => resetDocsTokenCache());

  function docsAnswers(document: unknown): void {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === '/api/tokens/meet-exchange') return Response.json(issued, { status: 201 });
      return Response.json(document);
    });
  }

  it('passes a whole document, with a field Docs added and a category this build never saw', async () => {
    docsAnswers(docsDocumentDetail({ category: 'poem', added_by_docs: true }));
    const document = await getDocsDocument(docsEnv, 'rosa@example.com', 'doc-1');
    expect(document).toMatchObject({ id: 'doc-1', category: 'poem', added_by_docs: true });
  });

  it('refuses a document without a required field, as a logged 502 upstream_shape', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { content_hash: _hash, ...hashless } = docsDocumentDetail({ title: 'ana@acme.com' });
    docsAnswers(hashless);
    const failure = await getDocsDocument(docsEnv, 'rosa@example.com', 'doc-1').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DocsError);
    expect(failure).toMatchObject({ status: 502, code: 'upstream_shape', message: 'Docs answered an unexpected shape at content_hash.' });
    expect(loggedShape(logged)).toMatchObject({
      message: 'upstream.shape', source: 'docs', route: 'GET /api/docs/:id', issues: [{ path: 'content_hash' }],
    });
    expect(String(logged.mock.calls[0]?.[0])).not.toContain('ana@acme.com');
  });
});

describe('GitHub reads', () => {
  let githubEnv: Env;

  beforeEach(() => {
    githubEnv = connectedGithub(env);
  });

  const issue = {
    number: 7, title: 'Fix the rail', state: 'open', html_url: 'https://github.com/envisioning/starlings-source/issues/7',
    body: 'Body', labels: ['bug', { name: 'agent:building', color: 'ededed', description: null }],
    user: { login: 'rosa', avatar_url: null }, comments: 0, node_id: 'I_added',
  };

  function githubAnswers(answers: { issue?: unknown; timeline?: unknown }): void {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith('/timeline')) return Response.json(answers.timeline ?? []);
      if (url.pathname.endsWith('/comments') || url.pathname.endsWith('/sub_issues')) return Response.json([]);
      return Response.json(answers.issue ?? issue);
    });
  }

  it('reads an issue with fields GitHub added', async () => {
    githubAnswers({ timeline: [{ id: 1, event: 'labeled', actor: { login: 'rosa' }, label: { name: 'bug', color: 'd73a4a' }, created_at: '2026-09-22T09:00:00Z' }] });
    const detail = await readIssue(githubEnv, 'envisioning', 'starlings', 7);
    expect(detail).toMatchObject({ id: 'envisioning/starlings#7', labels: ['bug', 'agent:building'], body: 'Body', author: { login: 'rosa' } });
    expect(detail.timeline).toHaveLength(1);
  });

  it('refuses an issue without a title, as a logged 502 upstream_shape', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { title: _title, ...untitled } = issue;
    githubAnswers({ issue: untitled });
    await expect(readIssue(githubEnv, 'envisioning', 'starlings', 7))
      .rejects.toMatchObject({ status: 502, code: 'upstream_shape', message: 'GitHub answered an unexpected shape at title.' });
    expect(loggedShape(logged)).toMatchObject({ source: 'github', route: 'GET /repos/:owner/:repo/issues/:number' });
  });

  it('still opens the issue when only the timeline has a shape it cannot read', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    githubAnswers({ timeline: { not: 'a list' } });
    const detail = await readIssue(githubEnv, 'envisioning', 'starlings', 7);
    expect(detail.title).toBe('Fix the rail');
    expect(detail.timeline).toEqual([]);
    expect(loggedShape(logged)).toMatchObject({ source: 'github', route: 'GET /repos/:owner/:repo/issues/:number/timeline' });
  });
});
