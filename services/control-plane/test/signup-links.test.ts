// Signup links can be resent and revoked, and a request keeps the mails that
// did not go out (meet#1157).
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignupRequest } from '@starlings/contracts/signup';
import { listSignups, mintSignupLink, revokeSignupLinks, submitSignup, viewSignupLink, type SignupEnv } from '../src/auth-worker/signup';
import { handleRequestsPost, renderRequestsPage, type SignupAdminStub } from '../src/ops-worker/requests';

const authDB = (env as unknown as { AUTH_DB: D1Database }).AUTH_DB;
const signupEnv: SignupEnv = {
  AUTH_DB: authDB,
  POSTMARK_API_KEY: 'test-postmark-key',
  MAIL_FROM: 'Starlings <hello@starlings.example>',
  OPS_ALERT_EMAIL: 'ops@example.net',
  SIGNUP_ORIGIN: 'https://site.example',
  OPS_ORIGIN: 'https://ops.starlings.example',
};
const operator = 'rosa@example.com';
const email = 'lia@friendco.com';

let mailed: string[] = [];
let mailWorks = true;
beforeEach(async () => {
  mailed = [];
  mailWorks = true;
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!mailWorks) return new Response('down', { status: 500 });
    mailed.push(String(init?.body ?? ''));
    return Response.json({ MessageID: 'm' });
  }));
  await authDB.batch([
    authDB.prepare("DELETE FROM workspace_requests WHERE slug = 'friendco'"),
    authDB.prepare("DELETE FROM workspace_slugs WHERE slug = 'friendco'"),
    authDB.prepare('DELETE FROM signup_links WHERE email = ?1').bind(email),
  ]);
});
afterEach(() => vi.unstubAllGlobals());

const tokens = () => [...mailed.join('').matchAll(/#t=([A-Za-z0-9_-]+)/gu)].map((match) => match[1]!);

describe('resend and revoke', () => {
  it('a second link to the same address closes the first', async () => {
    await mintSignupLink(signupEnv, { email, interest_id: null, operator });
    await mintSignupLink(signupEnv, { email, interest_id: null, operator });
    const [first, second] = tokens();
    expect(await viewSignupLink(signupEnv, first)).toEqual({ state: 'closed' });
    expect(await viewSignupLink(signupEnv, second)).toMatchObject({ state: 'open', email });
    const { links } = await listSignups(signupEnv);
    const mine = links.filter((link) => link.email === email);
    expect(mine.map((link) => link.revoked_at === null)).toEqual([true, false]);
  });

  it('revoke closes the open link and says so on the row', async () => {
    await mintSignupLink(signupEnv, { email, interest_id: null, operator });
    expect(await revokeSignupLinks(signupEnv, { email, operator })).toEqual({ email, revoked: 1 });
    expect(await viewSignupLink(signupEnv, tokens()[0])).toEqual({ state: 'closed' });
    const page = renderRequestsPage({ requests: [], links: (await listSignups(signupEnv)).links }, null);
    expect(page).toMatch(/Revoked /u);
    expect(await revokeSignupLinks(signupEnv, { email, operator })).toEqual({ email, revoked: 0 });
  });

  it('the console offers Resend on every unused link and Revoke on an open one', () => {
    const now = Date.now();
    const page = renderRequestsPage({ requests: [], links: [
      { email, created_at: now - 1, expires_at: now + 100_000, used_at: null, revoked_at: null, created_by: operator, interest_id: null },
    ] }, null);
    expect(page).toContain('action="/requests/mint"');
    expect(page).toContain('action="/requests/revoke"');
    expect(page).toContain('>Resend</button>');
    expect(page).toContain('>Revoke</button>');
  });

  it('the console posts a revoke to starlings-auth', async () => {
    const calls: unknown[] = [];
    const stub = { revoke: async (input: unknown) => { calls.push(input); return { email, revoked: 1 }; } } as unknown as SignupAdminStub;
    const request = new Request('https://ops.starlings.example/requests/revoke', {
      method: 'POST',
      headers: { origin: 'https://ops.starlings.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email }),
    });
    expect(await handleRequestsPost(request, stub, operator, '/requests/revoke')).toEqual({ kind: 'ok', text: `The open link for ${email} no longer works.` });
    expect(calls).toEqual([{ email, operator }]);
  });
});

describe('a mail about a request that did not go out', () => {
  it('is written on the request and shown on its card', async () => {
    await mintSignupLink(signupEnv, { email, interest_id: null, operator });
    const token = tokens()[0]!;
    mailWorks = false;
    const answer = await submitSignup(signupEnv, {
      token, name: 'Lia', role: 'founder', workspace_name: 'FriendCo', slug: 'friendco', accent: '',
      membership: { mode: 'invite' }, team_size: '2-10', agents: 'none', region: 'eu', terms: true,
    });
    expect(answer.ok).toBe(true);
    const request = (await listSignups(signupEnv)).requests.find((row) => row.slug === 'friendco') as SignupRequest;
    expect(request.mail_failed).toEqual(['operator', 'receipt']);
    const page = renderRequestsPage({ requests: [request], links: [] }, null);
    expect(page).toContain(`The receipt to ${email} did not go out.`);
    expect(page).toContain('The mail to operators about this request did not go out.');
  });
});
