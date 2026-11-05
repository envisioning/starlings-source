import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCrmIssues, fetchGithubAvatar } from '../src/crm';

const secretEnv = {
  ...env,
  INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars',
  CORE_API_BASE_URL: 'https://core.test',
} as Env;

afterEach(() => vi.restoreAllMocks());

/**
 * Answers every Core call with one issue and remembers what was asked, so a
 * test can assert on the question rather than on the answer.
 */
function coreReturns(body: unknown = { issues: [], linked: true }) {
  const asked: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    asked.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  return {
    /** The one call that was made. Named so a failure says which, not `undefined`. */
    url() {
      expect(asked, 'Core should have been asked exactly once').toHaveLength(1);
      return new URL(asked[0] ?? '');
    },
  };
}

describe('the issue list the Worker asks Core for', () => {
  it('forwards GitHub’s own filter and order vocabulary untranslated', async () => {
    const asked = coreReturns();
    await fetchCrmIssues(secretEnv, {
      project_id: '0f1a5a2c-1111-4c8f-9a13-8a9d0e2f0001',
      state: 'all',
      labels: 'bug,ready-for-agent',
      assignee: 'rosa',
      milestone: '4',
      sort: 'comments',
      direction: 'asc',
      limit: 50,
      page: 2,
    });
    const url = asked.url();
    expect(url.searchParams.get('state')).toBe('all');
    expect(url.searchParams.get('labels')).toBe('bug,ready-for-agent');
    expect(url.searchParams.get('assignee')).toBe('rosa');
    expect(url.searchParams.get('milestone')).toBe('4');
    expect(url.searchParams.get('sort')).toBe('comments');
    expect(url.searchParams.get('direction')).toBe('asc');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('page')).toBe('2');
  });

  it('sends nothing for a filter nobody set', async () => {
    // An empty parameter is not the same as an absent one: Core would read
    // `assignee=` as "issues assigned to somebody called nothing".
    const asked = coreReturns();
    await fetchCrmIssues(secretEnv, { project_id: '0f1a5a2c-1111-4c8f-9a13-8a9d0e2f0001' });
    const url = asked.url();
    expect(url.searchParams.get('project_id')).toBe('0f1a5a2c-1111-4c8f-9a13-8a9d0e2f0001');
    expect(url.searchParams.has('labels')).toBe(false);
    expect(url.searchParams.has('assignee')).toBe(false);
    expect(url.searchParams.has('milestone')).toBe(false);
    expect(url.searchParams.has('page')).toBe(false);
  });

  it('carries has_more so a list can say it is a prefix of the truth', async () => {
    coreReturns({ issues: [], linked: true, has_more: true });
    const answer = await fetchCrmIssues(secretEnv, { project_id: '0f1a5a2c-1111-4c8f-9a13-8a9d0e2f0001' });
    expect(answer.has_more).toBe(true);
  });

  it('keeps unlinked apart from empty, and never invents either', async () => {
    coreReturns({ linked: false });
    const answer = await fetchCrmIssues(secretEnv, { project_id: '0f1a5a2c-1111-4c8f-9a13-8a9d0e2f0001' });
    expect(answer).toEqual({ issues: [], linked: false, has_more: false });
  });

  it('passes a Core refusal through with its status', async () => {
    // 503 is Core saying nobody has told it how to reach GitHub. That is not
    // a project with no issues, and the two must not read alike.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
    await expect(
      fetchCrmIssues(secretEnv, { project_id: '0f1a5a2c-1111-4c8f-9a13-8a9d0e2f0001' }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('the avatar proxy', () => {
  function githubReturns(status: number, type = 'image/png') {
    const asked: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      asked.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response(status < 400 ? 'PNG' : 'nope', {
        status,
        headers: { 'content-type': type },
      });
    });
    return asked;
  }

  it('asks GitHub for the size that will actually be drawn', async () => {
    const asked = githubReturns(200);
    const image = await fetchGithubAvatar('https://avatars.githubusercontent.com/u/42?v=4', 36);
    const url = new URL(asked[0] ?? '');
    expect(url.hostname).toBe('avatars.githubusercontent.com');
    expect(url.pathname).toBe('/u/42');
    expect(url.searchParams.get('s'), 'a 400px face in an 18pt circle is bytes nobody sees').toBe('36');
    expect(url.searchParams.has('v'), 'the query is rebuilt, not forwarded').toBe(false);
    expect(image.headers.get('cache-control')).toContain('immutable');
  });

  it('refuses any host but GitHub’s avatar CDN', async () => {
    // The point of this route is that exactly one thing can be drawn through
    // it. An open image proxy is worth keeping on a short leash.
    githubReturns(200);
    for (const bad of [
      'https://example.com/pic.png',
      'http://avatars.githubusercontent.com/u/42',
      'https://evil.avatars.githubusercontent.com.example.com/u/42',
      'not a url',
    ]) {
      await expect(fetchGithubAvatar(bad, 36), bad).rejects.toMatchObject({ status: 400 });
    }
  });

  it('refuses something that is not an image', async () => {
    // A CDN answering HTML is a redirect somewhere, and this route exists so
    // that nothing else is drawn.
    githubReturns(200, 'text/html');
    await expect(
      fetchGithubAvatar('https://avatars.githubusercontent.com/u/42', 36),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('passes a refusal through with its status', async () => {
    githubReturns(404);
    await expect(
      fetchGithubAvatar('https://avatars.githubusercontent.com/u/42', 36),
    ).rejects.toMatchObject({ status: 404 });
  });
});
