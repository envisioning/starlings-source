import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  personIdSeedPlanSchema,
  personIdSeedResponseSchema,
  type PersonIdSeedPlan,
} from '@starlings/contracts/person-ids';
import worker from '../src/index';

/*
 * Core fold phase 1 (meet#720): every person on a Core workspace takes the id
 * of the Core user with the same address. The dry run writes nothing; the real
 * run takes back the dry run's fingerprint and a settlement for every
 * mismatch, and never changes an id that is set.
 */

const SECRET = 'meet-core-shared-secret-at-least-32-chars';
const coreEnv = { ...env, INTERNAL_REQUEST_SECRET: SECRET } as Env;

const ROSA = '11111111-1111-4111-8111-111111111111';
const ADA = '22222222-2222-4222-8222-222222222222';
const BEN_ONE = '33333333-3333-4333-8333-333333333333';
const BEN_TWO = '44444444-4444-4444-8444-444444444444';
const CY = '55555555-5555-4555-8555-555555555555';
const SPARE = '66666666-6666-4666-8666-666666666666';
const HELD = '77777777-7777-4777-8777-777777777777';

/** Core's `meet-team` roster: `auth.users`, as `fetchCrmTeam` reads it. */
const ROSTER = [
  { id: ROSA, name: 'Rosa', email: 'rosa@example.com', github_login: null },
  // Core holds the address in another case: it still matches.
  { id: ADA, name: 'Ada', email: 'Ada@example.com', github_login: null },
  { id: BEN_ONE, name: 'Ben', email: 'ben@example.com', github_login: null },
  { id: BEN_TWO, name: 'Ben again', email: 'ben@example.com', github_login: null },
  { id: CY, name: 'Cy', email: 'cy@example.com', github_login: null },
  { id: SPARE, name: 'Spare', email: 'spare@example.com', github_login: null },
  { id: 'not-a-uuid', name: 'Dee', email: 'dee@example.com', github_login: null },
];

let coreCalls = 0;

function coreAnswers(roster: unknown[] | null, status = 200): void {
  coreCalls = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/api/public/meet-team')) throw new Error(`unexpected outbound request: ${url}`);
    coreCalls += 1;
    return Response.json(roster === null ? { ok: false, error: 'down' } : { ok: true, members: roster }, { status });
  });
}

async function dispatch(request: Request, workerEnv: Env = coreEnv): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, workerEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function session(email: string): Promise<Record<string, string>> {
  const response = await dispatch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: email.split('@')[0], email }),
  }), env);
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}` };
}

async function addPerson(email: string, kind = 'human', personId: string | null = null): Promise<void> {
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, kind, person_id)
     VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)`,
  ).bind(`sub-${email}`, email, email.split('@')[0], now, kind, personId).run();
}

async function personIds(): Promise<Record<string, string | null>> {
  const { results } = await env.USAGE.prepare('SELECT email, person_id FROM people ORDER BY email')
    .all<{ email: string; person_id: string | null }>();
  return Object.fromEntries(results.map((row) => [row.email, row.person_id]));
}

async function dryRun(headers: Record<string, string>, workerEnv: Env = coreEnv): Promise<Response> {
  return dispatch(new Request('http://local/api/admin/person-ids/seed', { headers }), workerEnv);
}

async function realRun(headers: Record<string, string>, body: unknown, workerEnv: Env = coreEnv): Promise<Response> {
  return dispatch(new Request('http://local/api/admin/person-ids/seed', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), workerEnv);
}

let admin: Record<string, string>;

beforeEach(async () => {
  await env.USAGE.prepare('DELETE FROM people').run();
  // The session writes rosa's own row; it is one of the people to seed.
  admin = await session('rosa@example.com');
  await addPerson('ada@example.com');
  await addPerson('ben@example.com');
  await addPerson('dee@example.com');
  await addPerson('eve@example.com');
  await addPerson('vocab@agents.org.example', 'agent');
  // Already holds an id: the seed keeps it, even though Core knows Cy by another.
  await addPerson('cy@example.com', 'human', HELD);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('person id seed: the dry run', () => {
  it('maps each person to the Core user of their address and writes nothing', async () => {
    coreAnswers(ROSTER);
    const before = await personIds();
    const response = await dryRun(admin);
    expect(response.status).toBe(200);
    const plan = personIdSeedPlanSchema.parse(await response.json());

    expect(plan.people).toBe(7);
    expect(plan.core_users).toBe(ROSTER.length);
    expect(plan.set.map((row) => [row.email, row.person_id])).toEqual([
      ['ada@example.com', ADA],
      ['rosa@example.com', ROSA],
    ]);
    expect(plan.kept).toEqual([
      { email: 'cy@example.com', name: 'cy', kind: 'human', person_id: HELD, core_user_id: CY },
    ]);
    expect(plan.mismatches.map((row) => [row.email, row.reason, row.core_user_ids])).toEqual([
      ['ben@example.com', 'several_core_users', [BEN_ONE, BEN_TWO]],
      ['dee@example.com', 'invalid_core_id', ['not-a-uuid']],
      ['eve@example.com', 'no_core_user', []],
      ['vocab@agents.org.example', 'no_core_user', []],
    ]);
    expect(plan.mismatches.find((row) => row.kind === 'agent')?.email).toBe('vocab@agents.org.example');
    expect(plan.plan).toMatch(/^[0-9a-f]{64}$/u);

    expect(await personIds()).toEqual(before);
  });

  it('reports a Core id another person already holds', async () => {
    await env.USAGE.prepare('UPDATE people SET person_id = ?1 WHERE email = ?2').bind(ADA, 'cy@example.com').run();
    coreAnswers(ROSTER);
    const plan = personIdSeedPlanSchema.parse(await (await dryRun(admin)).json());
    expect(plan.mismatches.find((row) => row.email === 'ada@example.com')).toMatchObject({ reason: 'core_id_taken', core_user_ids: [ADA] });
    expect(plan.set.map((row) => row.email)).toEqual(['rosa@example.com']);
  });

  it('gives the same fingerprint for the same state and another one after a change', async () => {
    coreAnswers(ROSTER);
    const first = personIdSeedPlanSchema.parse(await (await dryRun(admin)).json());
    const again = personIdSeedPlanSchema.parse(await (await dryRun(admin)).json());
    expect(again.plan).toBe(first.plan);
    await addPerson('new@example.com');
    const changed = personIdSeedPlanSchema.parse(await (await dryRun(admin)).json());
    expect(changed.plan).not.toBe(first.plan);
  });
});

describe('person id seed: the real run', () => {
  const settle = {
    'ben@example.com': { core_user_id: BEN_TWO },
    'dee@example.com': { mint: true },
    'eve@example.com': { core_user_id: SPARE },
    // Any case reaches the person when only one has the address.
    'VOCAB@agents.org.example': { mint: true },
  };

  async function currentPlan(): Promise<PersonIdSeedPlan> {
    return personIdSeedPlanSchema.parse(await (await dryRun(admin)).json());
  }

  it('writes the matched, settled and minted ids, and runs again without a change', async () => {
    coreAnswers(ROSTER);
    const { plan } = await currentPlan();
    const response = await realRun(admin, { plan, settle });
    expect(response.status).toBe(200);
    const result = personIdSeedResponseSchema.parse(await response.json());
    expect(result.written.map((row) => [row.email, row.source])).toEqual([
      ['ada@example.com', 'core'],
      ['rosa@example.com', 'core'],
      ['ben@example.com', 'settled'],
      ['dee@example.com', 'minted'],
      ['eve@example.com', 'settled'],
      ['vocab@agents.org.example', 'minted'],
    ]);

    const ids = await personIds();
    expect(ids).toMatchObject({
      'ada@example.com': ADA,
      'rosa@example.com': ROSA,
      'ben@example.com': BEN_TWO,
      'eve@example.com': SPARE,
      // Never changed.
      'cy@example.com': HELD,
    });
    expect(ids['dee@example.com']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(ids['vocab@agents.org.example']).toMatch(/^[0-9a-f-]{36}$/u);

    const audit = await env.USAGE.prepare("SELECT actor_email, detail FROM admin_audit WHERE action = 'person_ids.seed' ORDER BY id DESC LIMIT 1")
      .first<{ actor_email: string; detail: string }>();
    expect(audit).toEqual({ actor_email: 'rosa@example.com', detail: 'core 2, settled 2, minted 2' });

    // Idempotent: everyone is kept now, nothing is planned, and a second run writes nothing.
    const after = await currentPlan();
    expect(after.set).toEqual([]);
    expect(after.mismatches).toEqual([]);
    expect(after.kept).toHaveLength(7);
    const second = personIdSeedResponseSchema.parse(await (await realRun(admin, { plan: after.plan })).json());
    expect(second.written).toEqual([]);
    expect(await personIds()).toEqual(ids);
  });

  it('refuses a plan that is not the current dry run', async () => {
    coreAnswers(ROSTER);
    const { plan } = await currentPlan();
    await addPerson('late@example.com');
    const before = await personIds();
    const response = await realRun(admin, { plan, settle });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(await personIds()).toEqual(before);
  });

  it.each([
    ['an unsettled mismatch', (s: Record<string, unknown>) => {
      const { ['eve@example.com']: _, ...rest } = s;
      return rest;
    }, 409, /Unsettled: eve@example.com/u],
    ['a settlement for a person who is no mismatch', (s: Record<string, unknown>) => ({ ...s, 'ada@example.com': { mint: true } }), 400, /Not a mismatch/u],
    ['a Core user id Core does not have', (s: Record<string, unknown>) => ({ ...s, 'eve@example.com': { core_user_id: '88888888-8888-4888-8888-888888888888' } }), 409, /is not a Core user/u],
    ['a Core user id another person holds', (s: Record<string, unknown>) => ({ ...s, 'eve@example.com': { core_user_id: ROSA } }), 409, /held by another person/u],
    ['the same Core user id twice', (s: Record<string, unknown>) => ({ ...s, 'eve@example.com': { core_user_id: BEN_TWO } }), 409, /held by another person/u],
    ['a settlement that is neither shape', (s: Record<string, unknown>) => ({ ...s, 'eve@example.com': { mint: false } }), 400, /./u],
  ])('refuses %s and writes nothing', async (_name, edit, status, message) => {
    coreAnswers(ROSTER);
    const { plan } = await currentPlan();
    const before = await personIds();
    const response = await realRun(admin, { plan, settle: edit(settle) });
    expect(response.status).toBe(status);
    const body = await response.json<{ code: string; error: string }>();
    expect(body.code).toBe('invalid_request');
    expect(body.error).toMatch(message);
    expect(await personIds()).toEqual(before);
  });

  it('refuses a body with no plan', async () => {
    coreAnswers(ROSTER);
    const response = await realRun(admin, { settle });
    expect(response.status).toBe(400);
    expect(coreCalls).toBe(0);
  });
});

describe('person id seed: fails closed', () => {
  it('refuses a member who is not an admin', async () => {
    const member = await session('member@example.com');
    coreAnswers(ROSTER);
    expect((await dryRun(member)).status).toBe(403);
    expect((await realRun(member, { plan: 'x' })).status).toBe(403);
    expect(coreCalls).toBe(0);
  });

  it('refuses a call with no session', async () => {
    coreAnswers(ROSTER);
    expect((await dryRun({})).status).toBe(401);
  });

  it('refuses a workspace that keeps its records in D1', async () => {
    coreAnswers(ROSTER);
    const d1Env = { ...coreEnv, WORK_STORE: 'd1' } as Env;
    const before = await personIds();
    const dry = await dryRun(admin, d1Env);
    expect(dry.status).toBe(409);
    expect(await dry.json()).toMatchObject({ code: 'not_configured' });
    expect((await realRun(admin, { plan: 'x' }, d1Env)).status).toBe(409);
    expect(coreCalls).toBe(0);
    expect(await personIds()).toEqual(before);
  });

  it('refuses when the Worker holds no Core secret', async () => {
    coreAnswers(ROSTER);
    const response = await dryRun(admin, { ...coreEnv, INTERNAL_REQUEST_SECRET: '' } as Env);
    expect(response.status).toBe(503);
    expect(coreCalls).toBe(0);
  });

  it('refuses when Core does not answer', async () => {
    coreAnswers(null, 500);
    const before = await personIds();
    expect((await dryRun(admin)).status).toBe(500);
    expect((await realRun(admin, { plan: 'x' })).status).toBe(500);
    expect(await personIds()).toEqual(before);
  });

  it('refuses an empty roster', async () => {
    coreAnswers([]);
    const response = await dryRun(admin);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'upstream_shape' });
  });
});
