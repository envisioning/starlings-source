import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { HELP_PAGES, helpPath } from '@starlings/contracts/help';
import { isAllowedPublicDocument } from '../src/index';

// llms.txt links every help page; each of those addresses has to be a page,
// not the Worker's 404, or an agent following the index finds nothing.
describe('public documents', () => {
  it('serves the help index, the glossary, and every help page', async () => {
    expect(HELP_PAGES.length).toBeGreaterThan(0);
    expect(await isAllowedPublicDocument('/help', env)).toBe(true);
    expect(await isAllowedPublicDocument('/help/', env)).toBe(true);
    expect(await isAllowedPublicDocument('/help/glossary', env)).toBe(true);
    for (const page of HELP_PAGES) expect(await isAllowedPublicDocument(helpPath(page.slug), env), page.slug).toBe(true);
  });

  it('does not serve a help slug the index does not have', async () => {
    expect(await isAllowedPublicDocument('/help/surfaces/nope', env)).toBe(false);
  });

  it('serves the changelog', async () => {
    expect(await isAllowedPublicDocument('/changelog', env)).toBe(true);
  });

  it('serves the shell for a record permalink, and nothing past its grammar (meet#581)', async () => {
    for (const path of [
      '/team/agent/agent%3Aclaude',
      '/team/person/1234567890',
      '/team/thread/t1',
      '/work/task/rec123',
      '/work/project/p1',
      '/work/partner/o1/',
      '/work/issue/envisioning/starlings/581',
      '/docs/document/d1',
      '/calendar/event/primary%3Aabc',
    ]) expect(await isAllowedPublicDocument(path, env), path).toBe(true);
    for (const path of [
      '/team/nobody/x',
      '/work/issue/envisioning%2Fmeet%23581',
      '/docs/document/',
      '/docs/document/a/b',
      '/calendar/event/%E0%A4%A',
    ]) expect(await isAllowedPublicDocument(path, env), path).toBe(false);
  });
});
