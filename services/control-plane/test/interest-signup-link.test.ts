// Answering an interest request with a signup link (meet#1177): hq lists the
// requests, the ops console sends a link from one with its answers, and the
// link opens /start filled in.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signupPrefillOf, type SignupInterest } from '@starlings/contracts/signup';
import { listSignups, mintSignupLink, viewSignupLink, type SignupEnv } from '../src/auth-worker/signup';
import { interestByID, listInterests } from '../src/interest';
import { handleRequestsPost, renderRequestsPage, type InterestSourceStub, type SignupAdminStub } from '../src/ops-worker/requests';

const authDB = (env as unknown as { AUTH_DB: D1Database }).AUTH_DB;
const signupEnv: SignupEnv = {
  AUTH_DB: authDB,
  POSTMARK_API_KEY: 'test-postmark-key',
  MAIL_FROM: 'Starlings <hello@starlings.example>',
  OPS_ALERT_EMAIL: 'ops@example.net',
  SIGNUP_ORIGIN: 'https://site.example',
  OPS_ORIGIN: 'https://ops.starlings.example',
};

const answers = {
  name: 'Ana Lima', email: 'ana@acme.com', company: 'Acme Studio', role: 'founder', team_size: '2-10', agents: 'none',
};

describe('the prefill an interest request gives a link', () => {
  it('takes name, role, company as workspace name, team size and agents', () => {
    expect(signupPrefillOf(answers)).toEqual({ name: 'Ana Lima', role: 'founder', workspace_name: 'Acme Studio', team_size: '2-10', agents: 'none' });
  });
  it('drops a field that is not one of today\'s options, and keeps the rest', () => {
    expect(signupPrefillOf({ ...answers, role: 'astronaut', agents: undefined })).toEqual({ name: 'Ana Lima', workspace_name: 'Acme Studio', team_size: '2-10' });
  });
});

describe('hq lists its interest requests for the console', () => {
  beforeEach(async () => {
    await env.USAGE.prepare("DELETE FROM interest_submissions WHERE id LIKE 'int_test%'").run();
    await env.USAGE.batch([
      env.USAGE.prepare('INSERT INTO interest_submissions (id, created_at, email, company, body) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind('int_testolder1', 1_000, 'old@acme.com', 'Old Co', '{not json'),
      env.USAGE.prepare('INSERT INTO interest_submissions (id, created_at, email, company, body) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind('int_testnewer1', 9_999_999_999_000, 'ana@acme.com', 'Acme Studio', JSON.stringify(answers)),
    ]);
  });

  it('newest first, with the prefill; a body that does not parse still lists', async () => {
    const rows = (await listInterests(env)).filter((row) => row.id.startsWith('int_test'));
    expect(rows.map((row) => row.id)).toEqual(['int_testnewer1', 'int_testolder1']);
    expect(rows[0]?.prefill.workspace_name).toBe('Acme Studio');
    expect(rows[1]).toMatchObject({ name: '', company: 'Old Co', prefill: {} });
    expect((await interestByID(env, 'int_testnewer1'))?.email).toBe('ana@acme.com');
  });
});

describe('a link sent from an interest request', () => {
  let mailed: string[] = [];
  beforeEach(async () => {
    mailed = [];
    await authDB.prepare("DELETE FROM signup_links WHERE email = 'ana@acme.com'").run();
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      mailed.push(String(init?.body ?? ''));
      return Response.json({ MessageID: 'm' });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const tokenFromMail = () => /#t=([A-Za-z0-9_-]+)/u.exec(mailed.join(''))?.[1] ?? '';

  it('carries the prefill to /start and is listed against its request', async () => {
    await mintSignupLink(signupEnv, { email: 'ana@acme.com', interest_id: 'int_testnewer1', prefill: signupPrefillOf(answers), operator: 'rosa@example.com' });
    const view = await viewSignupLink(signupEnv, tokenFromMail());
    expect(view).toMatchObject({ state: 'open', email: 'ana@acme.com', prefill: { name: 'Ana Lima', workspace_name: 'Acme Studio' } });
    const { interest_links } = await listSignups(signupEnv);
    expect(interest_links.find((link) => link.interest_id === 'int_testnewer1')?.email).toBe('ana@acme.com');
  });

  it('a link minted by address alone opens an empty form', async () => {
    await mintSignupLink(signupEnv, { email: 'ana@acme.com', interest_id: null, operator: 'rosa@example.com' });
    expect(await viewSignupLink(signupEnv, tokenFromMail())).toMatchObject({ state: 'open', prefill: {} });
  });
});

describe('the console answers an interest request', () => {
  const interest: SignupInterest = {
    id: 'int_testnewer1', created_at: 1_000, email: 'ana@acme.com', name: 'Ana Lima', company: 'Acme Studio', team_size: '2-10',
    prefill: signupPrefillOf(answers),
  };
  const hq: InterestSourceStub = { interests: async () => [interest], interest: async (id) => (id === interest.id ? interest : null) };

  function post(body: string): Request {
    return new Request('https://ops.starlings.example/requests/mint', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://ops.starlings.example' },
      body,
    });
  }

  it('mints for hq\'s address and prefill, whatever the form says', async () => {
    const mint = vi.fn(async (input: Parameters<SignupAdminStub['mint']>[0]) => ({ email: input.email, expires_at: 2_000 }));
    const signup = { mint, list: vi.fn(), decide: vi.fn() } as unknown as SignupAdminStub;
    const notice = await handleRequestsPost(post('interest_id=int_testnewer1&email=evil%40example.com'), signup, 'rosa@example.com', '/requests/mint', hq);
    expect(notice.kind).toBe('ok');
    expect(mint).toHaveBeenCalledWith({ email: 'ana@acme.com', interest_id: 'int_testnewer1', prefill: interest.prefill, operator: 'rosa@example.com' });
  });

  it('refuses an interest id hq does not have', async () => {
    const signup = { mint: vi.fn(), list: vi.fn(), decide: vi.fn() } as unknown as SignupAdminStub;
    const notice = await handleRequestsPost(post('interest_id=int_missing123'), signup, 'rosa@example.com', '/requests/mint', hq);
    expect(notice).toMatchObject({ kind: 'error', text: 'That interest request is not in hq.' });
    expect(signup.mint).not.toHaveBeenCalled();
  });

  it('the page offers Send signup link, says when one was sent, and gives a personal address no button', () => {
    const personal = { ...interest, id: 'int_testgmail1', email: 'bo@gmail.com' };
    const sent = { ...interest, id: 'int_testsent01' };
    const html = renderRequestsPage(
      { requests: [], links: [], interest_links: [{ email: 'ana@acme.com', created_at: 1_500, expires_at: 9_000, used_at: null, revoked_at: null, created_by: 'rosa@example.com', interest_id: 'int_testsent01' }] },
      null,
      5_000,
      [interest, personal, sent],
    );
    expect(html).toContain('<h2>Interest</h2>');
    expect(html).toContain('name="interest_id" value="int_testnewer1"><button class="secondary">Send signup link</button>');
    expect(html).toContain('Personal address: ask for a work address');
    expect(html).not.toContain('value="int_testgmail1"');
    expect(html).toContain('Link sent');
    expect(html).toContain('value="int_testsent01"><button class="secondary">Send again</button>');
  });

  it('says so when hq does not answer', () => {
    expect(renderRequestsPage({ requests: [], links: [] }, null, 5_000, { error: 'No answer from hq: down' })).toContain('No answer from hq: down');
  });
});
