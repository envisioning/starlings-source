import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { ControlErrorBody } from '@starlings/contracts';
import { ROUTES } from '../src/routes';

const WEB_ORIGIN = 'http://127.0.0.1:5173';

function eventRequest(body: unknown, origin = WEB_ORIGIN): Request {
  return new Request('https://envisioning.starlings.example/api/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'user-agent': 'Test Browser', 'cf-connecting-ip': '192.0.2.7' },
    body: JSON.stringify(body),
  });
}

/** The `/api/event` row, called past its gate with a workspace that names a Plausible site. */
async function forward(body: unknown): Promise<{ response: Response; sent: Promise<unknown>[] }> {
  const row = ROUTES.find((route) => route.path === '/api/event')!;
  const sent: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { sent.push(promise); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const request = eventRequest(body);
  const response = await (row.handler as (context: unknown) => Promise<Response>)({
    request, env: { ...(env as Env), PLAUSIBLE_DOMAIN: 'starlings.example' }, ctx, url: new URL(request.url), params: {}, dispatch: () => { throw new Error('unused'); },
  });
  return { response, sent };
}

describe('Usage counts (docs/ANALYTICS.md)', () => {
  it('is not there on a workspace that names no Plausible site', async () => {
    const response = await exports.default.fetch(eventRequest({ name: 'pageview', path: '/work' }));
    expect(response.status).toBe(404);
    expect((await response.json<ControlErrorBody>()).code).toBe('not_configured');
  });

  it('refuses another origin before anything else', async () => {
    const response = await exports.default.fetch(eventRequest({ name: 'pageview', path: '/work' }, 'https://evil.example'));
    expect(response.status).toBe(403);
  });

  it('forwards a page name with the browser\'s address and agent, and the domain from config', async () => {
    let upstream: Request | undefined;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: Request) => { upstream = input; return new Response(null, { status: 202 }); }) as typeof fetch;
    try {
      const { response, sent } = await forward({ name: 'pageview', path: '/work', referrer: 'https://news.example/item?id=9', campaign: 'utm_source=x&token=secret' });
      expect(response.status).toBe(202);
      await Promise.all(sent);
    } finally {
      globalThis.fetch = real;
    }
    expect(upstream?.url).toBe('https://plausible.io/api/event');
    expect(upstream?.headers.get('x-forwarded-for')).toBe('192.0.2.7');
    expect(upstream?.headers.get('user-agent')).toBe('Test Browser');
    expect(await upstream?.json()).toEqual({
      domain: 'starlings.example',
      name: 'pageview',
      url: 'https://envisioning.starlings.example/work?utm_source=x',
      referrer: 'https://news.example/item',
    });
  });

  it('refuses a name off the list, an address in place of a page name, and a free-text property', async () => {
    for (const body of [
      { name: 'Anything', path: '/work' },
      { name: 'pageview', path: '/work/0f6e7c1a-1111-4222-8333-444455556666?x=1' },
      { name: 'pageview', path: 'https://evil.example/' },
      { name: 'Task created', path: '/work', props: { title: 'x'.repeat(61) } },
    ]) {
      await expect(forward(body)).rejects.toMatchObject({ status: 400 });
    }
  });
});
