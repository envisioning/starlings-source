import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETUP_STEPS, setupStepsFor, type SetupResponse } from '@starlings/contracts/setup';
import { SAMPLE_PROJECT, SAMPLE_PROJECT_ID, WORKSPACE_ORGANIZATION_ID, sampleProjectSQL, workspaceOrganizationSQL } from '../src/starter-content';
import { CAPABILITIES, resetRoleCache } from '../src/capabilities';
import { resetPeerRosterCache } from '../src/peers';
import { readSetup, sendSetupReminder } from '../src/setup';
import fixture from '../../../fixtures/setup-steps.json';

/**
 * The setup checklist (docs/ONBOARDING.md §The setup checklist). The table is
 * pinned to fixtures/setup-steps.json, which Tests/SetupStepsFixtureTests.swift
 * reads too; the done tests are run here against the data each step creates.
 */

const DAY = 86_400_000;

async function session(email: string, role: 'admin' | 'member' = 'member') {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Setup' }),
  }));
  const body = await response.json<{ access_token: string }>();
  const headers = { authorization: `Bearer ${body.access_token}` };
  await exports.default.fetch(new Request('http://local/api/peers', { headers }));
  await env.USAGE.prepare('UPDATE people SET role = ?2 WHERE email = ?1').bind(email, role).run();
  resetRoleCache();
  return headers;
}

async function hit(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return exports.default.fetch(new Request(`http://local${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  }));
}

async function setup(headers: Record<string, string>): Promise<SetupResponse> {
  const response = await hit('GET', '/api/setup', headers);
  expect(response.status).toBe(200);
  return response.json<SetupResponse>();
}

const doneOf = (body: SetupResponse) => Object.fromEntries(body.steps.map((step) => [step.id, step.done]));

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.USAGE.batch([
    env.USAGE.prepare("DELETE FROM workspace_settings WHERE key IN ('brand', 'membership', 'setup_checklist', 'setup_mail_e5')"),
    env.USAGE.prepare('DELETE FROM projects'),
    env.USAGE.prepare('DELETE FROM organizations WHERE id = ?1').bind(WORKSPACE_ORGANIZATION_ID),
    env.USAGE.prepare("DELETE FROM record_merges WHERE entity = 'organizations'"),
    env.USAGE.prepare("DELETE FROM built_in_agent_installations WHERE id = 'setup-steward'"),
    env.USAGE.prepare("DELETE FROM agents WHERE email LIKE 'setup-%'"),
    env.USAGE.prepare("DELETE FROM owner_devices WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'setup-%')"),
    env.USAGE.prepare("DELETE FROM setup_skips WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'setup-%')"),
    env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'setup-%'"),
  ]);
  resetRoleCache();
  resetPeerRosterCache();
});

describe('the setup registry', () => {
  it('equals fixtures/setup-steps.json, the table the Swift registry is pinned to', () => {
    expect(fixture.version).toBe(1);
    expect(fixture.steps).toEqual(SETUP_STEPS);
  });

  it('names each step once, with a capability the Worker knows', () => {
    const ids = SETUP_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of SETUP_STEPS) expect(Object.keys(CAPABILITIES)).toContain(step.capability);
  });

  it('gives an admin eight steps and a member four, optional ones last', () => {
    expect(setupStepsFor('admin').map((step) => step.id)).toEqual(['look', 'membership', 'invite', 'project', 'calendar', 'assistant', 'agent', 'call', 'apps']);
    expect(setupStepsFor('member').map((step) => step.id)).toEqual(['profile', 'calendar', 'assistant', 'apps']);
    expect(setupStepsFor('admin').filter((step) => !step.required).map((step) => step.id)).toEqual(['call', 'apps']);
  });
});

describe('/api/setup', () => {
  it('needs a session', async () => {
    expect((await hit('GET', '/api/setup', {})).status).toBe(401);
  });

  it('gives a new member their four steps, none done, the photo first', async () => {
    const body = await setup(await session('setup-member@example.com'));
    expect(body.steps.map((step) => step.id)).toEqual(['profile', 'calendar', 'assistant', 'apps']);
    expect(body.steps.every((step) => !step.done)).toBe(true);
    expect(body.next).toBe('profile');
    expect(body.complete).toBe(false);
    expect(body.on).toBe(true);
    expect(body.can_turn_off).toBe(false);
  });

  it('gives a new admin eight steps, each done when the thing exists', async () => {
    const headers = await session('setup-admin@example.com', 'admin');
    const fresh = await setup(headers);
    expect(fresh.steps.map((step) => step.id)).toEqual(['look', 'membership', 'invite', 'project', 'calendar', 'assistant', 'agent', 'call', 'apps']);
    // The suite's IDENTITY_DOMAINS already decides who can join.
    expect(fresh.steps.find((step) => step.id === 'membership')).toMatchObject({ done: true, blocked: null });
    expect(fresh.next).toBe('look');
    expect(fresh.can_turn_off).toBe(true);

    const sub = (await env.USAGE.prepare("SELECT sub FROM people WHERE email = 'setup-admin@example.com'").first<{ sub: string }>())!.sub;
    const now = Date.now();
    await env.USAGE.batch([
      env.USAGE.prepare("INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES ('brand', '{\"name\":\"Acme\",\"accent\":null}', ?1, ?2)").bind(sub, now),
      env.USAGE.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('setup-p1', 'First', ?1, ?1)").bind(now),
      env.USAGE.prepare("INSERT INTO owner_devices (device_id, sub, client, refresh_jti, issued_at, renewed_at) VALUES ('setup-d1', ?1, 'mac', 'j', ?2, ?2)").bind(sub, now),
    ]);
    await session('setup-colleague@example.com');
    const later = doneOf(await setup(headers));
    expect(later).toMatchObject({ look: true, membership: true, invite: true, project: true, apps: true, call: false });
  });

  it('does not count the sample project provisioning seeds, which reruns never duplicate or overwrite', async () => {
    await session('setup-admin@example.com', 'admin');
    const sub = (await env.USAGE.prepare("SELECT sub FROM people WHERE email = 'setup-admin@example.com'").first<{ sub: string }>())!.sub;
    // A provisioned workspace keeps its subjects in D1; the suite's default reads them from Core.
    const projectDone = async () => (await readSetup({ ...env, WORK_STORE: 'd1' } as Env, { sub, email: 'setup-admin@example.com', role: 'admin' }))
      .steps.find((step) => step.id === 'project')!.done;
    const seed = () => env.USAGE.batch([env.USAGE.prepare(workspaceOrganizationSQL("Acme's Studio", Date.now())), env.USAGE.prepare(sampleProjectSQL(Date.now()))]);
    await seed();
    await env.USAGE.prepare("UPDATE organizations SET name = 'Renamed' WHERE id = ?1").bind(WORKSPACE_ORGANIZATION_ID).run();
    await env.USAGE.prepare("UPDATE projects SET status = 'Archived' WHERE id = ?1").bind(SAMPLE_PROJECT_ID).run();
    await seed();
    const project = await env.USAGE.prepare('SELECT p.title, p.status, p.description, o.name FROM projects p JOIN organizations o ON o.id = p.organization_id')
      .all<{ title: string; status: string; description: string; name: string }>();
    expect(project.results).toEqual([{ title: SAMPLE_PROJECT.title, status: 'Archived', description: SAMPLE_PROJECT.description, name: 'Renamed' }]);
    expect(await projectDone()).toBe(false);

    await env.USAGE.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('setup-p1', 'First', ?1, ?1)").bind(Date.now()).run();
    expect(await projectDone()).toBe(true);
  });

  it('does not bring the workspace organisation back after a merge folded it away', async () => {
    await env.USAGE.prepare("INSERT INTO record_merges (entity, from_id, into_id, merged_at) VALUES ('organizations', ?1, 'other', ?2)")
      .bind(WORKSPACE_ORGANIZATION_ID, Date.now()).run();
    await env.USAGE.batch([env.USAGE.prepare(workspaceOrganizationSQL('Acme', Date.now())), env.USAGE.prepare(sampleProjectSQL(Date.now()))]);
    expect(await env.USAGE.prepare('SELECT COUNT(*) AS n FROM organizations WHERE id = ?1').bind(WORKSPACE_ORGANIZATION_ID).first('n')).toBe(0);
    expect(await env.USAGE.prepare('SELECT COUNT(*) AS n FROM projects WHERE id = ?1').bind(SAMPLE_PROJECT_ID).first('n')).toBe(0);
  });

  it('counts who can join as chosen by signup, else by a sign-in domain rule', async () => {
    await session('setup-admin@example.com', 'admin');
    const sub = (await env.USAGE.prepare("SELECT sub FROM people WHERE email = 'setup-admin@example.com'").first<{ sub: string }>())!.sub;
    const viewer = { sub, email: 'setup-admin@example.com', role: 'admin' as const };
    const membership = async (overrides: Record<string, string | undefined>) =>
      (await readSetup({ ...env, ...overrides } as Env, viewer)).steps.find((step) => step.id === 'membership')!;
    expect(await membership({ IDENTITY_DOMAINS: '', WORKSPACE_MEMBERSHIP: 'invite' })).toMatchObject({ done: true, blocked: null });
    expect(await membership({ IDENTITY_DOMAINS: '', WORKSPACE_MEMBERSHIP: 'domains' })).toMatchObject({ done: true });
    expect(await membership({ IDENTITY_DOMAINS: 'acme.com' })).toMatchObject({ done: true });
    const unset = await membership({ IDENTITY_DOMAINS: '', WORKSPACE_MEMBERSHIP: undefined });
    expect(unset.done).toBe(false);
    expect(unset.blocked?.by).toBe('starlings');
  });

  it('does not count the Starlings-managed Steward as an agent somebody added', async () => {
    const headers = await session('setup-admin@example.com', 'admin');
    const now = Date.now();
    // The suite's config imports Envisioning's roster; retire it for this test.
    await env.USAGE.prepare("UPDATE agents SET removed_at = ?1 WHERE email NOT LIKE 'setup-%' AND removed_at IS NULL").bind(now).run();
    await env.USAGE.batch([
      env.USAGE.prepare("INSERT INTO agents (email, sub, name, created_at) VALUES ('setup-steward@example.com', 'setup-steward-sub', 'Steward', ?1)").bind(now),
      env.USAGE.prepare(`INSERT INTO built_in_agent_installations (id, workspace_id, agent_sub, role, state, created_at)
        VALUES ('setup-steward', 'ws', 'setup-steward-sub', 'meeting_follow_through', 'ready', ?1)`).bind(now),
    ]);
    expect(doneOf(await setup(headers)).agent).toBe(false);
    await env.USAGE.prepare("INSERT INTO agents (email, sub, name, created_at) VALUES ('setup-bot@example.com', 'setup-bot-sub', 'Bot', ?1)").bind(now).run();
    expect(doneOf(await setup(headers)).agent).toBe(true);
  });

  it('lets a person skip a step from their own card, and bring it back', async () => {
    const member = await session('setup-member@example.com');
    const other = await session('setup-colleague@example.com');
    const skipped = await hit('PUT', '/api/setup/skip', member, { step: 'calendar', skipped: true });
    expect(skipped.status).toBe(200);
    expect((await skipped.json<SetupResponse>()).steps.map((step) => step.id)).toEqual(['profile', 'assistant', 'apps']);
    expect((await setup(member)).steps.map((step) => step.id)).not.toContain('calendar');
    expect((await setup(other)).steps.map((step) => step.id)).toContain('calendar');
    for (const step of ['profile', 'assistant']) await hit('PUT', '/api/setup/skip', member, { step, skipped: true });
    // Every required step is skipped: nothing holds the card open.
    expect((await setup(member)).complete).toBe(true);
    const back = await hit('PUT', '/api/setup/skip', member, { step: 'calendar', skipped: false });
    expect((await back.json<SetupResponse>()).steps.map((step) => step.id)).toEqual(['calendar', 'apps']);
    // A step the viewer does not have, or one the registry does not know.
    expect((await hit('PUT', '/api/setup/skip', member, { step: 'look', skipped: true })).status).toBe(404);
    expect((await hit('PUT', '/api/setup/skip', member, { step: 'nope', skipped: true })).status).toBe(404);
    expect((await hit('PUT', '/api/setup/skip', member, { step: 'calendar' })).status).toBe(400);
  });

  it('lets an admin turn the checklist off for everyone, and nobody else', async () => {
    const member = await session('setup-member@example.com');
    expect((await hit('PUT', '/api/admin/setup', member, { on: false })).status).toBe(403);
    const admin = await session('setup-admin@example.com', 'admin');
    const off = await hit('PUT', '/api/admin/setup', admin, { on: false });
    expect(off.status).toBe(200);
    expect((await off.json<SetupResponse>()).on).toBe(false);
    expect((await setup(member)).on).toBe(false);
    expect((await hit('PUT', '/api/admin/setup', admin, { on: 'no' })).status).toBe(400);
  });
});

describe('mail E5', () => {
  const mailEnv = { ...env, POSTMARK_API_KEY: 'test-postmark-key', MAIL_FROM: 'Starlings <contact@org.example>' } as Env;

  async function newWorkspace(ageDays: number) {
    await session('setup-admin@example.com', 'admin');
    // Every human row is this test's; the workspace is as old as its first sign-in.
    await env.USAGE.prepare("UPDATE people SET first_seen_at = ?1 WHERE kind = 'human'").bind(Date.now() - ageDays * DAY).run();
  }

  function stubPostmark() {
    const sent: Array<{ To: string; Subject: string; TextBody: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith('https://api.postmarkapp.com/')) throw new Error(`unexpected outbound request: ${url}`);
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ MessageID: 'm' });
    });
    return sent;
  }

  it('goes to the admin on day 3 with the next step, once', async () => {
    await newWorkspace(3.5);
    const sent = stubPostmark();
    await sendSetupReminder(mailEnv, Date.now());
    await sendSetupReminder(mailEnv, Date.now());
    const mine = sent.filter((mail) => mail.To === 'setup-admin@example.com');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.TextBody).toContain('Check your workspace’s look');
  });

  it('is not sent before day 3, after day 7, or when the checklist is off', async () => {
    const sent = stubPostmark();
    await newWorkspace(1);
    await sendSetupReminder(mailEnv, Date.now());
    await newWorkspace(30);
    await sendSetupReminder(mailEnv, Date.now());
    await newWorkspace(4);
    await env.USAGE.prepare("INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES ('setup_checklist', '{\"on\":false}', 'x', 1)").run();
    await sendSetupReminder(mailEnv, Date.now());
    expect(sent).toHaveLength(0);
  });
});
