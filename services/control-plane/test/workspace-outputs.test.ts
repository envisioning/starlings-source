import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { THREAD_EVENT_SENDER } from '@starlings/contracts';
import { statusPage } from '../src/public-pages';
import { threadEventSender } from '../src/threads';
import { serveStatic } from '../src/static-pages';
import { workspaceServices } from '../src/workspace-descriptor';

// meet#863: what a workspace hands out names that workspace, and Envisioning's
// outputs stay as they were.
describe('a second workspace\'s outputs', () => {
  it.each([
    ['core', 'https://records.example.test'],
    ['d1', 'off'],
  ])('projects the descriptor’s Core service into the %s workspace page', async (store, expected) => {
    const workspace = {
      ...env, WORK_STORE: store, INTERNAL_REQUEST_SECRET: 'test-core-secret', CORE_API_ORIGIN: 'https://records.example.test',
      ASSETS: { fetch: async () => new Response('<html><head></head><body>Work</body></html>', { headers: { 'content-type': 'text/html' } }) },
    } as unknown as Env;
    const page = await serveStatic(new Request('http://local/work'), workspace, '/work');
    expect(await page.text()).toContain(`<meta name="workspace-core" content="${expected}">`);
  });

  it.each([
    [{}, 'subjects,tasks,goals,interactions,commercial'],
    [{ WORK_STORE_SUBJECTS: 'd1' }, 'tasks,goals,interactions,commercial'],
    [{ WORK_STORE: 'd1' }, ''],
  ])('names the groups Core still holds, so a moved record has no Core link (meet#1219): %o', async (vars, expected) => {
    const workspace = {
      ...env, WORK_STORE: 'core', INTERNAL_REQUEST_SECRET: 'test-core-secret', CORE_API_ORIGIN: 'https://records.example.test', ...vars,
      ASSETS: { fetch: async () => new Response('<html><head></head><body>Work</body></html>', { headers: { 'content-type': 'text/html' } }) },
    } as unknown as Env;
    const page = await serveStatic(new Request('http://local/work'), workspace, '/work');
    expect(await page.text()).toContain(`<meta name="workspace-core-groups" content="${expected}">`);
    expect(workspaceServices(workspace).core_groups).toEqual(expected ? expected.split(',') : []);
  });

  it('keeps Envisioning\'s event sender on the Core workspace', () => {
    expect(threadEventSender(env)).toEqual(THREAD_EVENT_SENDER);
  });

  it('sends a D1 workspace\'s event lines from its own MAIL_FROM address', () => {
    const hq = { ...env, WORK_STORE: 'd1', MAIL_FROM: 'Starlings <Hello@HQ.example>' } as unknown as Env;
    expect(threadEventSender(hq)).toEqual({ sub: THREAD_EVENT_SENDER.sub, email: 'hello@hq.example', name: THREAD_EVENT_SENDER.name });
  });

  it('names the workspace\'s public host when it has no MAIL_FROM', () => {
    const hq = { ...env, WORK_STORE: 'd1', MAIL_FROM: '', PUBLIC_WEB_ORIGIN: 'https://hq.starlings.example' } as unknown as Env;
    expect(threadEventSender(hq).email).toBe('starlings@hq.starlings.example');
  });

  it('draws the status page link in the workspace\'s accent, else the default lime', async () => {
    expect(await statusPage('Done', 'All set.', 200, '#2563EB').text()).toContain('color: #2563eb;');
    expect(await statusPage('Done', 'All set.').text()).toContain('color: #d6f249;');
    // An accent that cannot carry text is refused, as everywhere else.
    expect(await statusPage('Done', 'All set.', 200, '#808080').text()).toContain('color: #d6f249;');
  });
});
