// The operator's side of a workspace request after Accept (docs/ONBOARDING.md):
// the Requests card says what to do next in each state (meet#1153), and Send
// ready mail checks every host of the workspace before it marks the request
// ready (meet#1154).
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signupAddressProblem, signupFormSchema, signupRequestSchema, type SignupRequest } from '@starlings/contracts/signup';
import { decideSignup, submitSignup, type SignupEnv } from '../src/auth-worker/signup';
import { sha256 } from '../src/crypto';
import { renderRequestsPage } from '../src/ops-worker/requests';

const authDB = (env as unknown as { AUTH_DB: D1Database }).AUTH_DB;
const signupEnv: SignupEnv = {
  AUTH_DB: authDB,
  MAIL_FROM: 'Starlings <hello@starlings.example>',
  OPS_ALERT_EMAIL: 'ops@example.net',
  SIGNUP_ORIGIN: 'https://site.example',
  OPS_ORIGIN: 'https://ops.starlings.example',
};

const base: SignupRequest = {
  id: 'req_fixture01', email: 'owner@acme.com', name: 'Owner', role: 'Founder', workspace_name: 'Acme', slug: 'acme', accent: '',
  membership: { mode: 'domains', domains: ['acme.com'] }, suite: 'google', region: 'eu',
  answers: { team_size: '2-10', agents: 'some', first_parts: [] }, interest_id: null,
  state: 'submitted', payment: 'waived', created_at: 1_790_000_000_000, decided_by: null, decided_at: null,
  host: null, failure: null, provisioned_at: null, service_hosts: [], agent_state: null, mail_failed: [],
};
const card = (overrides: Partial<SignupRequest>) => renderRequestsPage({ requests: [{ ...base, ...overrides }], links: [] }, null);
const command = 'node scripts/provision-workspace.mjs --from-request req_fixture01 --apply';

describe('the Requests page: cards for what waits, rows for the rest', () => {
  it('a ready request is a row under Workspaces made, with its link, and no card', () => {
    const html = card({ state: 'ready', host: 'https://acme.starlings.example' });
    expect(html).toContain('<h2>Workspaces made</h2>');
    expect(html).toContain('<a href="https://acme.starlings.example/">Acme</a>');
    expect(html).not.toContain('class="card" id="req_fixture01"');
    expect(html).toContain('Nothing waits for you.');
  });
  it('a submitted request is a card under Waiting for you', () => {
    const html = card({});
    expect(html).toContain('<h2>Waiting for you</h2>');
    expect(html).toContain('class="card" id="req_fixture01"');
    expect(html).not.toContain('<h2>Workspaces made</h2>');
  });
});

describe('the Requests card says the next step in each state (meet#1153)', () => {
  it('submitted: Accept, Ask with its question, and Decline', () => {
    const html = card({});
    expect(html).toContain('value="accept"');
    expect(html).toContain('value="ask"');
    expect(html).toContain('<textarea');
    expect(html).toContain('value="decline"');
  });
  it('approved: the command, then Send ready mail; Decline, and no Ask', () => {
    const html = card({ state: 'approved' });
    expect(html).toContain(command);
    expect(html).toContain('come back here and press Send ready mail');
    expect(html).toContain('value="decline"');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('value="ask"');
  });
  it('provisioning: a running run and a finished one read differently', () => {
    const running = card({ state: 'provisioning', host: 'https://acme.starlings.example' });
    expect(running).toContain('the run has not finished');
    const done = card({ state: 'provisioning', host: 'https://acme.starlings.example', provisioned_at: 1_790_000_100_000, agent_state: 'failed at runtime_deploy' });
    expect(done).toContain('Provisioned at https://acme.starlings.example');
    expect(done).toContain('Send the ready mail.');
    expect(done).toContain('Meeting agent: failed at runtime_deploy');
    for (const html of [running, done]) {
      expect(html).toContain('value="ready"');
      expect(html).not.toContain('<textarea');
    }
  });
  it('failed: the step, the command to run again, and Decline', () => {
    const html = card({ state: 'failed', host: 'https://acme.starlings.example', failure: 'deploy' });
    expect(html).toContain('Failed at deploy');
    expect(html).toContain(command);
    expect(html).toContain('it continues where it stopped');
    expect(html).toContain('value="decline"');
    expect(html).not.toContain('<textarea');
  });
});

describe('Send ready mail checks every host of the workspace (meet#1154)', () => {
  const seen: string[] = [];
  let down = new Set<string>();
  beforeEach(async () => {
    seen.length = 0;
    down = new Set();
    await authDB.batch([
      authDB.prepare("DELETE FROM workspace_requests WHERE id = 'req_fixture01'"),
      authDB.prepare("DELETE FROM signup_links WHERE token_hash = 'hash_fixture01'"),
      authDB.prepare("DELETE FROM workspace_slugs WHERE slug = 'acme'"),
    ]);
    await authDB.batch([
      authDB.prepare(`INSERT INTO signup_links (token_hash, email, interest_id, created_by, created_at, expires_at, used_at)
        VALUES ('hash_fixture01', 'owner@acme.com', NULL, 'rosa@example.com', 1, 9999999999999, 2)`),
      authDB.prepare(`INSERT INTO workspace_requests (id, token_hash, email, name, role, workspace_name, slug, accent, membership, answers,
        interest_id, state, payment, created_at, updated_at, decided_by, decided_at, host, failure, provisioned_at, service_hosts, agent_state)
        VALUES ('req_fixture01', 'hash_fixture01', 'owner@acme.com', 'Owner', 'Founder', 'Acme', 'acme', '', ?1, ?2, NULL, 'provisioning', 'waived',
        1, 1, 'rosa@example.com', 1, 'https://acme.starlings.example', NULL, 3, ?3, 'awaiting_admin')`)
        .bind(JSON.stringify(base.membership), JSON.stringify(base.answers), JSON.stringify(['https://docs-acme.starlings.example', 'https://keep-acme.starlings.example'])),
      authDB.prepare("INSERT INTO workspace_slugs (slug, state, request_id, updated_at) VALUES ('acme', 'held', 'req_fixture01', 1)"),
    ]);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      seen.push(url.origin);
      return new Response('{}', { status: down.has(url.origin) ? 503 : 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  const ready = () => decideSignup(signupEnv, { id: 'req_fixture01', action: 'ready', message: '', operator: 'rosa@example.com' });
  const state = async () => (await authDB.prepare("SELECT state FROM workspace_requests WHERE id = 'req_fixture01'").first<{ state: string }>())?.state;

  it.each(['https://docs-acme.starlings.example', 'https://keep-acme.starlings.example'])('refuses while %s does not answer, and names it', async (host) => {
    down.add(host);
    const answer = await ready();
    expect(answer).toEqual({ ok: false, message: `${host}/api/health does not answer yet (503).` });
    expect(await state()).toBe('provisioning');
  });
  it('marks the request ready when the workspace, Docs and Keep answer', async () => {
    const answer = await ready();
    expect(answer.ok).toBe(true);
    expect(seen.slice(0, 3)).toEqual(['https://acme.starlings.example', 'https://docs-acme.starlings.example', 'https://keep-acme.starlings.example']);
    expect(await state()).toBe('ready');
  });
});

describe('the data region is chosen at signup and final (meet#1166)', () => {
  const form = {
    token: 'a'.repeat(32), name: 'Owner', role: 'founder', workspace_name: 'Acme', slug: 'acme', accent: '',
    membership: { mode: 'invite' }, team_size: '2-10', agents: 'some', terms: true,
  };
  it('a new request must name the region', () => {
    const missing = signupFormSchema.safeParse(form);
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.some((issue) => issue.path[0] === 'region')).toBe(true);
    expect(signupFormSchema.safeParse({ ...form, region: 'mars' }).success).toBe(false);
  });
  it('a request from before the field reads as eu', () => {
    const { region: _, ...old } = base;
    expect(signupRequestSchema.parse(old).region).toBe('eu');
  });
  it('the card shows the region', () => {
    expect(card({ region: 'us' })).toContain('<dt>Data</dt><dd>In the United States</dd>');
    expect(card({})).toContain('<dt>Data</dt><dd>In the European Union</dd>');
  });
  it('Accept keeps the region', async () => {
    await authDB.batch([
      authDB.prepare("DELETE FROM workspace_requests WHERE id = 'req_fixture01'"),
      authDB.prepare("DELETE FROM workspace_slugs WHERE slug = 'acme'"),
      authDB.prepare(`INSERT OR IGNORE INTO signup_links (token_hash, email, interest_id, created_by, created_at, expires_at, used_at)
        VALUES ('hash_fixture01', 'owner@acme.com', NULL, 'rosa@example.com', 1, 9999999999999, 2)`),
    ]);
    await authDB.prepare(`INSERT INTO workspace_requests (id, token_hash, email, name, role, workspace_name, slug, accent, membership, region, answers,
      interest_id, state, payment, created_at, updated_at)
      VALUES ('req_fixture01', 'hash_fixture01', 'owner@acme.com', 'Owner', 'Founder', 'Acme', 'acme', '', ?1, 'us', ?2, NULL, 'submitted', 'waived', 1, 1)`)
      .bind(JSON.stringify(base.membership), JSON.stringify(base.answers)).run();
    const answer = await decideSignup(signupEnv, { id: 'req_fixture01', action: 'accept', message: '', operator: 'rosa@example.com' });
    expect(answer.ok && answer.request.region).toBe('us');
    const row = await authDB.prepare("SELECT region FROM workspace_requests WHERE id = 'req_fixture01'").first<{ region: string }>();
    expect(row?.region).toBe('us');
  });
});

describe('a personal address cannot start a workspace yet (meet#1156)', () => {
  const token = 'p'.repeat(32);
  const form = {
    token, name: 'Ana', role: 'founder', workspace_name: 'Ana', slug: 'ana-studio', accent: '',
    membership: { mode: 'invite' }, team_size: '2-10', agents: 'none', region: 'eu', terms: true,
  };
  beforeEach(async () => {
    await authDB.batch([
      authDB.prepare("DELETE FROM workspace_requests WHERE id = 'req_personal1' OR slug = 'ana-studio'"),
      authDB.prepare("DELETE FROM workspace_slugs WHERE slug = 'ana-studio'"),
      authDB.prepare("DELETE FROM signup_links WHERE email = 'ana@gmail.com'"),
    ]);
    await authDB.prepare(`INSERT INTO signup_links (token_hash, email, interest_id, created_by, created_at, expires_at)
      VALUES (?1, 'ana@gmail.com', NULL, 'rosa@example.com', 1, 9999999999999)`).bind(await sha256(token)).run();
  });

  it('the contract names personal mail and nothing else', () => {
    expect(signupAddressProblem('ana@gmail.com')).toMatch(/personal address/u);
    expect(signupAddressProblem('Ana@Proton.me')).toMatch(/personal address/u);
    expect(signupAddressProblem('ana@acme.com')).toBeNull();
  });

  it('the submit refuses it and holds nothing', async () => {
    const answer = await submitSignup(signupEnv, form);
    expect(answer).toEqual({ ok: false, field: null, message: signupAddressProblem('ana@gmail.com') });
    expect(await authDB.prepare("SELECT 1 FROM workspace_slugs WHERE slug = 'ana-studio'").first()).toBeNull();
  });

  it('Accept refuses a request from before the rule', async () => {
    await authDB.prepare(`INSERT INTO workspace_requests (id, token_hash, email, name, role, workspace_name, slug, accent, membership, region, answers,
      interest_id, state, payment, created_at, updated_at)
      VALUES ('req_personal1', ?1, 'ana@gmail.com', 'Ana', 'Founder', 'Ana', 'ana-studio', '', '{"mode":"invite"}', 'eu', '{}', NULL, 'submitted', 'waived', 1, 1)`).bind(await sha256(token)).run();
    const answer = await decideSignup(signupEnv, { id: 'req_personal1', action: 'accept', message: '', operator: 'rosa@example.com' });
    expect(answer.ok).toBe(false);
    const row = await authDB.prepare("SELECT state FROM workspace_requests WHERE id = 'req_personal1'").first<{ state: string }>();
    expect(row?.state).toBe('submitted');
  });
});
