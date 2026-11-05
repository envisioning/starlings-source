import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { ControlErrorBody } from '@starlings/contracts';
import { issueBody, issueTitle } from '../src/feedback';
import { assertHuman, assertHumanJsonBody, isBrowserFetch } from '../src/turnstile';

const WEB_ORIGIN = 'http://127.0.0.1:5173';

function feedbackRequest(body: unknown, origin = WEB_ORIGIN): Request {
  return new Request('http://local/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
}

describe('Bug reports', () => {
  it('refuses a report that did not come from the web origin', async () => {
    const response = await exports.default.fetch(feedbackRequest(
      { message: 'Camera froze.' },
      'https://evil.example',
    ));
    expect(response.status).toBe(403);
    expect((await response.json<ControlErrorBody>()).code).toBe('untrusted_origin');
  });

  it('refuses a report with nothing written in it', async () => {
    const response = await exports.default.fetch(feedbackRequest({ message: '   ' }));
    expect(response.status).toBe(400);
  });

  it('reports itself as unconfigured rather than dropping the report silently', async () => {
    // No GITHUB_ISSUES_TOKEN or repo in the test Worker, so the browser is told
    // to fall back to copy instead of believing the report was filed.
    const response = await exports.default.fetch(feedbackRequest({ message: 'Camera froze.' }));
    expect(response.status).toBe(503);
    expect((await response.json<ControlErrorBody>()).code).toBe('not_configured');
  });

  it('keeps a debug report from breaking out of its code fence', () => {
    // A report containing its own triple-backtick run would otherwise end the
    // block early and render the remainder as markdown.
    const body = issueBody({ message: 'Broke.', report: 'before\n```\nafter' });
    expect(body).toContain('````text\nbefore\n```\nafter\n````');
  });

  it('titles the issue from the first line and keeps it short', () => {
    expect(issueTitle('Camera froze\nthen the tab crashed')).toBe('Camera froze');
    expect(issueTitle('x'.repeat(200))).toHaveLength(72);
    expect(issueTitle('   ')).toBe('Bug report from Starlings');
  });
});

describe('Turnstile', () => {
  const request = new Request('http://local/api/feedback', { method: 'POST' });
  const configured = { ...env, TURNSTILE_SECRET_KEY: 'test-turnstile-secret' };

  it('does nothing at all while no secret is configured', async () => {
    // The state of every deploy until the widget exists: the route stays
    // open, protected by rate limiting alone.
    await expect(assertHuman(request, env, undefined)).resolves.toBeUndefined();
  });

  it('keeps the challenge origin out of the CSP while no secret is set', async () => {
    // The widget and the enforcement are one switch. Until it is thrown, the
    // policy must not name a third-party script origin it has no use for.
    const response = await exports.default.fetch(new Request('http://local/api/health'));
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('challenges.cloudflare.com');
    expect(csp).toContain("frame-src 'self';");
  });

  it('rejects a missing token once a secret exists', async () => {
    await expect(assertHuman(request, configured, undefined)).rejects.toMatchObject({
      status: 403,
      code: 'turnstile_failed',
    });
  });

  it('treats URLSession-shaped requests as native and skips the widget', async () => {
    // Mac and iOS set Origin but never Sec-Fetch-Site. Flipping the secret
    // must not 403 those shipped builds.
    const native = new Request('http://local/api/rooms/rosa/join-requests', {
      method: 'POST',
      headers: { origin: WEB_ORIGIN, 'content-type': 'application/json' },
    });
    expect(isBrowserFetch(native)).toBe(false);
    await expect(assertHuman(native, configured, undefined, 'browser')).resolves.toBeUndefined();
  });

  it('still requires a token from a browser fetch once a secret exists', async () => {
    const browser = new Request('http://local/api/rooms/rosa/join-requests', {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
      },
    });
    expect(isBrowserFetch(browser)).toBe(true);
    await expect(assertHuman(browser, configured, undefined, 'browser')).rejects.toMatchObject({
      status: 403,
      code: 'turnstile_failed',
    });
  });

  it('strips turnstile_token from a JSON body before an upstream sees it', async () => {
    const raw = JSON.stringify({
      guest_name: 'Ana',
      guest_email: 'ana@acme.com',
      turnstile_token: 'ignored-while-unset',
    });
    const forwarded = await assertHumanJsonBody(request, env, raw);
    expect(JSON.parse(forwarded)).toEqual({ guest_name: 'Ana', guest_email: 'ana@acme.com' });
  });

  it('rejects a book body with no token once a secret exists', async () => {
    await expect(assertHumanJsonBody(request, configured, '{"guest_name":"Ana"}')).rejects.toMatchObject({
      status: 403,
      code: 'turnstile_failed',
    });
  });
});
