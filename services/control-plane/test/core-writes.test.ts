import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { hmacSHA256Hex } from '../src/crypto';
import { inboundKeyEnvName } from '../src/inbound-keys';
import { coreRowsResponseSchema } from '@starlings/contracts/core-reads';
import { createCrmContact, updateCrmContact } from '../src/crm';

/**
 * Core's own writers through the one write path (meet#275). Core signs each
 * CRM write with its own inbound key; the Worker forwards it to Core's
 * `meet-crm-writes` while fold group 1 lives in Core, and answers with Core's
 * row or Core's refusal.
 */

const agentEmail = 'agent-vocab@example.com';
const coreKey = 'core-key-for-the-core-writes-tests-0123456789';
const agentKey = 'agent-key-for-the-core-writes-tests-0123456789';
const requestSecret = 'meet-core-shared-secret-at-least-32-chars';
const ORGANIZATION = 'aaaaaaaa-0000-4000-8000-000000000003';
const LEAD = 'aaaaaaaa-0000-4000-8000-000000000002';

function configured(overrides: Record<string, string> = {}): Env {
  return {
    ...env,
    INTERNAL_REQUEST_SECRET: requestSecret,
    [inboundKeyEnvName('core')]: coreKey,
    [inboundKeyEnvName(agentEmail)]: agentKey,
    AGENT_ROSTER: JSON.stringify({ [agentEmail]: 'Vocab' }),
    ...overrides,
  } as Env;
}

async function send(body: unknown, init: { secret?: string; keyId?: string | null; headers?: Record<string, string>; env?: Env; path?: string } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = await hmacSHA256Hex(init.secret ?? coreKey, `${timestamp}.${raw}`);
  const keyId = init.keyId === undefined ? 'core' : init.keyId;
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`http://local${init.path ?? '/api/internal/core-writes'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature,
      ...(keyId ? { 'x-internal-key-id': keyId } : {}),
      ...init.headers,
    },
    body: raw,
  }), init.env ?? configured(), context);
  await waitOnExecutionContext(context);
  return response;
}

interface CoreCall { url: string; method: string; headers: Headers; body: string }

/** Core answers `meet-crm-writes` with `answer`; every call is kept. */
function coreAnswers(answer: unknown, status = 200): CoreCall[] {
  const calls: CoreCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, method: request.method, headers: request.headers, body: await request.text() });
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const createOrganization = {
  action: 'create',
  entity: 'organizations',
  values: { name: 'Example Ltd', legal_name: 'Example Ltd', country: 'NL' },
  select: 'id',
};

describe('POST /api/internal/core-writes', () => {
  it('forwards a create to Core, signed as Meet, and answers with the row', async () => {
    const calls = coreAnswers({ data: { id: ORGANIZATION } }, 201);
    const response = await send(createOrganization);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: ORGANIZATION } });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe('https://core.invalid/api/public/meet-crm-writes');
    expect(call!.method).toBe('POST');
    expect(JSON.parse(call!.body)).toEqual(createOrganization);
    // Meet -> Core is the INTERNAL_REQUEST_SECRET pair, not Core's inbound key.
    const timestamp = call!.headers.get('x-internal-timestamp')!;
    expect(call!.headers.get('x-internal-signature')).toBe(await hmacSHA256Hex(requestSecret, `${timestamp}.${call!.body}`));
  });

  it('forwards an update by id', async () => {
    const calls = coreAnswers({ data: { id: LEAD, status: 'Closed Won' } });
    const update = { action: 'update', entity: 'leads', id: LEAD, values: { status: 'Closed Won' }, select: 'id, status' };
    const response = await send(update);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: LEAD, status: 'Closed Won' } });
    expect(JSON.parse(calls[0]!.body)).toEqual(update);
  });

  it('answers null for an update that matched no row', async () => {
    coreAnswers({ data: null });
    const response = await send({ action: 'update', entity: 'projects', id: LEAD, values: { last_viewed_at: '2026-10-10T10:00:00.000Z' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: null });
  });

  it('passes Core\'s refusal through with its Postgres code', async () => {
    coreAnswers({ error: 'duplicate key value violates unique constraint', code: '23505' }, 409);
    const response = await send({ action: 'create', entity: 'contacts', values: { name: 'Ada', email: 'ada@example.test' } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'duplicate key value violates unique constraint', code: '23505' });
  });

  it('answers 502 when Core fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    coreAnswers({ error: 'boom' }, 500);
    const response = await send(createOrganization);
    expect(response.status).toBe(502);
  });

  it('refuses a table outside fold group 1, and an unknown key', async () => {
    const calls = coreAnswers({ data: { id: ORGANIZATION } });
    expect((await send({ action: 'create', entity: 'goals', values: { title: 'x' } })).status).toBe(400);
    // A task write waits for the tasks group to move (meet#1222).
    expect((await send({ action: 'create', entity: 'tasks', values: { title: 'x', project_id: ORGANIZATION } })).status).toBe(409);
    expect((await send({ ...createOrganization, extra: true })).status).toBe(400);
    expect((await send({ action: 'create', entity: 'organizations', values: {} })).status).toBe(400);
    expect((await send({ action: 'create', entity: 'organizations', values: { 'name; drop': 'x' } })).status).toBe(400);
    expect((await send({ ...createOrganization, select: 'id,*' })).status).toBe(400);
    expect((await send({ action: 'update', entity: 'leads', id: 'not-a-uuid', values: { status: 'x' } })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses an agent key, a wrong signature, a session and a request with no key id', async () => {
    const calls = coreAnswers({ data: { id: ORGANIZATION } });
    expect((await send(createOrganization, { secret: agentKey, keyId: agentEmail })).status).toBe(403);
    expect((await send(createOrganization, { secret: agentKey })).status).toBe(403);
    expect((await send(createOrganization, { headers: { authorization: 'Bearer anything' } })).status).toBe(403);
    expect((await send(createOrganization, { keyId: null })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('writes nothing on a workspace whose CRM is in D1', async () => {
    const calls = coreAnswers({ data: { id: ORGANIZATION } });
    const response = await send(createOrganization, { env: configured({ WORK_STORE: 'd1' }) });
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

/** Envisioning after the subjects flip: Core for the workspace, D1 for group 1. */
const subjectsOnD1 = () => configured({ WORK_STORE_SUBJECTS: 'd1' });

/** Rows a test wrote to D1, children first, so the next test starts clean. */
async function clearSubjects(): Promise<void> {
  for (const table of ['work_activity', 'tasks', 'milestones', 'contact_emails', 'projects', 'leads', 'contacts', 'organizations', 'work_group_moves']) {
    await env.USAGE.prepare(`DELETE FROM ${table}`).run();
  }
}

describe('POST /api/internal/core-writes after the subjects flip (meet#1220)', () => {
  afterEach(clearSubjects);

  it('writes each group 1 row in D1, Core\'s writer columns included, and sends nothing to Core', async () => {
    const calls = coreAnswers({ data: null });
    const organization = await send({ ...createOrganization, values: { ...createOrganization.values, website: 'https://example.test' }, select: 'id, name, website' }, { env: subjectsOnD1() });
    expect(organization.status).toBe(200);
    const org = (await organization.json() as { data: { id: string; name: string; website: string } }).data;
    expect(org).toMatchObject({ name: 'Example Ltd', website: 'https://example.test' });

    const contact = await send({
      action: 'create',
      entity: 'contacts',
      values: { name: 'Ada', email: 'ada@example.test', organization_id: org.id, company_role: 'CTO', notes: 'x'.repeat(4000) },
      select: 'id, company_role',
    }, { env: subjectsOnD1() });
    expect(contact.status).toBe(200);
    const person = (await contact.json() as { data: { id: string; company_role: string } }).data;
    expect(person).toMatchObject({ company_role: 'CTO' });

    const lead = await send({
      action: 'create',
      entity: 'leads',
      values: { title: 'Lead for Example', organization_id: org.id, contact_id: person.id, start_date: '2026-10-21T10:00:00.000Z', status: 'Conversations', notes: 'y'.repeat(3000), source: 'website' },
      select: 'id, source, status',
    }, { env: subjectsOnD1() });
    expect(lead.status).toBe(200);
    const leadRow = (await lead.json() as { data: { id: string; source: string } }).data;
    expect(leadRow).toMatchObject({ source: 'website', status: 'Conversations' });

    const project = await send({ action: 'create', entity: 'projects', values: { title: 'Example', organization_id: org.id, lead_id: leadRow.id, status: 'Active' }, select: 'id, title' }, { env: subjectsOnD1() });
    const projectId = (await project.json() as { data: { id: string } }).data.id;
    const viewed = await send({ action: 'update', entity: 'projects', id: projectId, values: { last_viewed_at: '2026-10-21T12:00:00.000Z' }, select: 'id, last_viewed_at' }, { env: subjectsOnD1() });
    expect(await viewed.json()).toEqual({ data: { id: projectId, last_viewed_at: '2026-10-21T12:00:00.000Z' } });
    const won = await send({ action: 'update', entity: 'leads', id: leadRow.id, values: { status: 'Closed Won' }, select: 'status' }, { env: subjectsOnD1() });
    expect(await won.json()).toEqual({ data: { status: 'Closed Won' } });

    expect(calls).toHaveLength(0);
  });

  it('answers null for an update that matched no row', async () => {
    coreAnswers({ data: null });
    const missing = 'aaaaaaaa-0000-4000-8000-0000000000ff';
    expect(await (await send({ action: 'update', entity: 'projects', id: missing, values: { last_viewed_at: '2026-10-21T12:00:00.000Z' } }, { env: subjectsOnD1() })).json()).toEqual({ data: null });
    expect(await (await send({ action: 'update', entity: 'leads', id: missing, values: { status: 'Closed Won' } }, { env: subjectsOnD1() })).json()).toEqual({ data: null });
  });

  it('refuses a column D1 does not keep, and every write while the group is frozen', async () => {
    const calls = coreAnswers({ data: null });
    const unknown = await send({ action: 'create', entity: 'organizations', values: { name: 'X', not_a_column: 'y' } }, { env: subjectsOnD1() });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: 'invalid_request' });

    await env.USAGE.prepare("INSERT INTO work_group_moves (work_group, frozen, frozen_at, updated_at) VALUES ('subjects', 1, 1, 1)").run();
    const frozen = await send(createOrganization, { env: subjectsOnD1() });
    expect(frozen.status).toBe(503);
    expect(await frozen.json()).toMatchObject({ code: 'records_moving' });
    expect(calls).toHaveLength(0);
  });
});

describe('the Signals lead after a D1 contact write (decided by MZ, 2026-11-05)', () => {
  afterEach(async () => {
    await env.USAGE.prepare('DELETE FROM work_activity').run();
    await env.USAGE.prepare("DELETE FROM ops_failures WHERE kind = 'signals_lead_ensure'").run();
    await clearSubjects();
  });

  async function seedOrganization(): Promise<void> {
    await env.USAGE.prepare("INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?1, 'Example', 1, 1)").bind(ORGANIZATION).run();
  }

  async function createContact(values: Record<string, unknown>, onEnv: Env = subjectsOnD1()): Promise<string> {
    const created = await send({ action: 'create', entity: 'contacts', values: { name: 'Ada', ...values }, select: 'id' }, { env: onEnv });
    expect(created.status).toBe(200);
    return (await created.json() as { data: { id: string } }).data.id;
  }

  const signalsLeads = async () => (await env.USAGE.prepare("SELECT organization_id, contact_id, title, status, source FROM leads WHERE source = 'signals'").all()).results;

  it('makes a lead when a new contact is in outreach, once per organization, with no call to Core', async () => {
    await seedOrganization();
    const calls = coreAnswers({ ok: true });
    const id = await createContact({ organization_id: ORGANIZATION, signals_outreach_status: 'to_notify' });
    await createContact({ organization_id: ORGANIZATION, signals_outreach_status: 'notified', email: 'bo@example.test' });
    expect(calls).toHaveLength(0);
    expect(await signalsLeads()).toEqual([{ organization_id: ORGANIZATION, contact_id: id, title: 'Example · Signals', status: 'Conversations', source: 'signals' }]);
  });

  it('applies the condition of Core\'s trigger', async () => {
    await seedOrganization();
    await createContact({ organization_id: ORGANIZATION, email: 'none@example.test' });
    await createContact({ signals_outreach_status: 'to_notify', email: 'noorg@example.test' });
    await createContact({ organization_id: ORGANIZATION, signals_outreach_status: 'not_interested', email: 'no@example.test' });
    await createContact({ organization_id: ORGANIZATION, signals_outreach_status: '', email: 'blank@example.test' });
    expect(await signalsLeads()).toEqual([]);
  });

  it('fires for the outreach status and the organization, and keeps the outreach state on the contact', async () => {
    await seedOrganization();
    const id = await createContact({ email: 'ada@example.test' });
    const update = (values: Record<string, unknown>) => send({ action: 'update', entity: 'contacts', id, values }, { env: subjectsOnD1() });
    expect((await update({ signals_outreach_status: 'notified', signals_notified_at: '2026-11-04T10:00:00.000Z' })).status).toBe(200);
    expect(await signalsLeads()).toHaveLength(0);
    expect((await update({ organization_id: ORGANIZATION })).status).toBe(200);
    expect(await signalsLeads()).toHaveLength(1);
    expect((await update({ signals_outreach_status: null })).status).toBe(200);
    const row = await env.USAGE.prepare('SELECT signals_outreach_status, signals_notified_at FROM contacts WHERE id = ?1').bind(id).first();
    expect(row).toEqual({ signals_outreach_status: null, signals_notified_at: Date.parse('2026-11-04T10:00:00.000Z') });
  });

  it('makes nothing on a WORK_STORE=d1 workspace', async () => {
    await seedOrganization();
    const d1Workspace = configured({ WORK_STORE: 'd1', CORE_API_ORIGIN: 'https://core.example.test' });
    await createCrmContact(d1Workspace, 'ada@example.test', { name: 'Ada', emails: [], organization_id: ORGANIZATION, signals_outreach_status: 'to_notify' });
    expect(await signalsLeads()).toEqual([]);
  });

  it('sends nothing while the group is on Core: Core\'s trigger does it', async () => {
    const calls = coreAnswers({ data: { id: LEAD } });
    await send({ action: 'update', entity: 'contacts', id: LEAD, values: { signals_outreach_status: 'notified' }, select: 'id' });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe('/api/public/meet-crm-writes');
  });
});

describe('POST /api/internal/core-reads (meet#1220)', () => {
  const read = (body: unknown, init: Parameters<typeof send>[1] = {}) => send(body, { env: subjectsOnD1(), ...init, path: '/api/internal/core-reads' });
  afterEach(clearSubjects);

  async function seed() {
    const now = Date.now();
    const statements = [
      env.USAGE.prepare("INSERT INTO organizations (id, name, legal_name, country, url, created_at, updated_at) VALUES (?1, 'Example', 'Example Ltd', 'NL', 'https://example.test', ?2, ?2)").bind(ORGANIZATION, now),
      env.USAGE.prepare("INSERT INTO contacts (id, organization_id, name, email, corporate_email, created_at, updated_at) VALUES ('cccccccc-0000-4000-8000-000000000001', ?1, 'Ada', 'ada@example.test', 'ada@corp.example', ?2, ?2)").bind(ORGANIZATION, now),
      env.USAGE.prepare("INSERT INTO contacts (id, organization_id, name, email, created_at, updated_at) VALUES ('cccccccc-0000-4000-8000-000000000002', NULL, 'Bo', 'bo@example.test', ?1, ?1)").bind(now),
      env.USAGE.prepare("INSERT INTO contact_emails (email, contact_id, created_at) VALUES ('bo@other.example', 'cccccccc-0000-4000-8000-000000000002', ?1)").bind(now),
      env.USAGE.prepare("INSERT INTO leads (id, organization_id, contact_id, title, status, start_date, created_at, updated_at) VALUES (?1, ?2, 'cccccccc-0000-4000-8000-000000000002', 'Lead', 'Closed Won', '2026-10-01', ?3, ?3)").bind(LEAD, ORGANIZATION, now),
      env.USAGE.prepare("INSERT INTO projects (id, organization_id, lead_id, title, status, specs, evid, created_at, updated_at) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', ?1, ?2, 'Project', 'Active', 'Specs', 'EV-1', ?3, ?3)").bind(ORGANIZATION, LEAD, now),
    ];
    await env.USAGE.batch(statements);
  }

  it('refuses while the subjects group is still on Core, and on a D1 workspace', async () => {
    const onCore = await read({ op: 'row', entity: 'organizations', id: ORGANIZATION }, { env: configured() });
    expect(onCore.status).toBe(409);
    expect((await read({ op: 'row', entity: 'organizations', id: ORGANIZATION }, { env: configured({ WORK_STORE: 'd1' }) })).status).toBe(404);
  });

  it('answers rows by id, without one read per row, and leaves a missing id out', async () => {
    await seed();
    const answer = coreRowsResponseSchema.parse(await (await read({ op: 'rows', entity: 'organizations', ids: [ORGANIZATION, 'aaaaaaaa-0000-4000-8000-0000000000ff'] })).json());
    expect(answer.data).toHaveLength(1);
    expect(answer.data[0]).toMatchObject({ id: ORGANIZATION, name: 'Example', website: 'https://example.test' });
    expect((await read({ op: 'rows', entity: 'contacts', ids: [] })).status).toBe(400);
    expect((await read({ op: 'rows', entity: 'organizations', ids: [ORGANIZATION] }, { env: configured() })).status).toBe(409);
  });

  it('answers an organization\'s contacts, leads and projects, sorted', async () => {
    await seed();
    await env.USAGE.prepare("INSERT INTO contacts (id, organization_id, name, created_at, updated_at) VALUES ('cccccccc-0000-4000-8000-000000000009', ?1, 'aaron', 1, 1)").bind(ORGANIZATION).run();
    const rows = async (entity: string) => coreRowsResponseSchema.parse(await (await read({ op: 'organization_rows', entity, organization_id: ORGANIZATION })).json()).data;
    expect((await rows('contacts')).map((row) => row.name)).toEqual(['aaron', 'Ada']);
    expect((await rows('contacts'))[1]).toMatchObject({ company_role: null, corporate_email: 'ada@corp.example' });
    expect((await rows('leads')).map((row) => row.title)).toEqual(['Lead']);
    expect((await rows('projects')).map((row) => row.title)).toEqual(['Project']);
    expect((await read({ op: 'organization_rows', entity: 'organizations', organization_id: ORGANIZATION })).status).toBe(400);
  });

  it('answers a row in Core\'s names, and null for an unknown id', async () => {
    await seed();
    const row = await read({ op: 'row', entity: 'organizations', id: ORGANIZATION });
    expect(await row.json()).toMatchObject({ data: { id: ORGANIZATION, name: 'Example', website: 'https://example.test' } });
    expect(await (await read({ op: 'row', entity: 'leads', id: 'aaaaaaaa-0000-4000-8000-0000000000ff' })).json()).toEqual({ data: null });
  });

  it('finds a contact by its primary, corporate or other address', async () => {
    await seed();
    for (const [email, id] of [
      ['ADA@example.test', 'cccccccc-0000-4000-8000-000000000001'],
      ['ada@corp.example', 'cccccccc-0000-4000-8000-000000000001'],
      ['bo@other.example', 'cccccccc-0000-4000-8000-000000000002'],
    ] as const) {
      expect(await (await read({ op: 'contact_by_email', email })).json(), email).toMatchObject({ data: { id } });
    }
    expect(await (await read({ op: 'contact_by_email', email: 'nobody@example.test' })).json()).toEqual({ data: null });
  });

  it('refuses an address two contacts hold, as Core fails closed', async () => {
    await seed();
    await env.USAGE.prepare("UPDATE contacts SET corporate_email = 'ada@example.test' WHERE id = 'cccccccc-0000-4000-8000-000000000002'").run();
    const refused = await read({ op: 'contact_by_email', email: 'ada@example.test' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'ambiguous_contact' });
    expect(await (await read({ op: 'contact_by_email', email: 'bo@other.example' })).json()).toMatchObject({ data: { id: 'cccccccc-0000-4000-8000-000000000002' } });
  });

  it('finds the newest lead of a contact, with one of the statuses when sent', async () => {
    await seed();
    const bo = 'cccccccc-0000-4000-8000-000000000002';
    const newer = 'aaaaaaaa-0000-4000-8000-000000000005';
    await env.USAGE.prepare("INSERT INTO leads (id, contact_id, title, status, created_at, updated_at) VALUES (?1, ?2, 'Newer', 'Rapport', ?3, ?3)").bind(newer, bo, Date.now() + 1000).run();
    expect(await (await read({ op: 'lead_by_contact', contact_id: bo })).json()).toMatchObject({ data: { id: newer } });
    expect(await (await read({ op: 'lead_by_contact', contact_id: bo, statuses: ['Closed Won'] })).json()).toMatchObject({ data: { id: LEAD } });
    expect(await (await read({ op: 'lead_by_contact', contact_id: bo, statuses: ['Pain'] })).json()).toEqual({ data: null });
  });

  it('finds the oldest organization by name without case, and by domain', async () => {
    await seed();
    const later = 'aaaaaaaa-0000-4000-8000-000000000004';
    const now = Date.now();
    await env.USAGE.batch([
      env.USAGE.prepare("UPDATE organizations SET domain = 'example.test' WHERE id = ?1").bind(ORGANIZATION),
      env.USAGE.prepare("INSERT INTO organizations (id, name, domain, created_at, updated_at) VALUES (?1, 'EXAMPLE', 'Example.test', ?2, ?2)").bind(later, now + 1000),
    ]);
    expect(await (await read({ op: 'organization_by_name', name: ' example ' })).json()).toMatchObject({ data: { id: ORGANIZATION, name: 'Example', website: 'https://example.test' } });
    expect(await (await read({ op: 'organization_by_domain', domain: 'EXAMPLE.test' })).json()).toMatchObject({ data: { id: ORGANIZATION, domain: 'example.test' } });
    expect(await (await read({ op: 'organization_by_name', name: 'Exampl' })).json()).toEqual({ data: null });
    expect(await (await read({ op: 'organization_by_domain', domain: 'other.example' })).json()).toEqual({ data: null });
    expect((await read({ op: 'organization_by_name', name: '  ' })).status).toBe(400);
  });

  it('finds the project made from a lead', async () => {
    await seed();
    expect(await (await read({ op: 'project_by_lead', lead_id: LEAD })).json()).toMatchObject({ data: { id: 'bbbbbbbb-0000-4000-8000-000000000001', lead_id: LEAD } });
    expect(await (await read({ op: 'project_by_lead', lead_id: 'aaaaaaaa-0000-4000-8000-0000000000ff' })).json()).toEqual({ data: null });
  });

  it('answers the project page and credits only the lead contact or a contact at the organization', async () => {
    await seed();
    const project = 'bbbbbbbb-0000-4000-8000-000000000001';
    const page = await (await read({ op: 'project_page', id: project, email: 'bo@other.example' })).json() as { data: Record<string, unknown> };
    expect(page.data).toMatchObject({
      project: { id: project, title: 'Project', status: 'Active', specs: 'Specs', evid: 'EV-1', lead_id: LEAD },
      organization: { id: ORGANIZATION, name: 'Example', legal_name: 'Example Ltd', country: 'NL', website: 'https://example.test' },
      lead: { id: LEAD, title: 'Lead', status: 'Closed Won' },
      email_has_access: true,
    });
    const colleague = await (await read({ op: 'project_page', id: project, email: 'ada@corp.example' })).json() as { data: { email_has_access: boolean } };
    expect(colleague.data.email_has_access).toBe(true);
    const stranger = await (await read({ op: 'project_page', id: project, email: 'eve@example.test' })).json() as { data: { email_has_access: boolean } };
    expect(stranger.data.email_has_access).toBe(false);
    expect(await (await read({ op: 'project_page', id: 'bbbbbbbb-0000-4000-8000-0000000000ff' })).json()).toEqual({ data: null });
  });

  it('answers the addresses that may sign an offer: the lead contact by every address, and the organization by email', async () => {
    await seed();
    const signers = async (body: Record<string, unknown>) =>
      ((await (await read({ op: 'offer_signers', ...body })).json()) as { data: { addresses: string[] } }).data.addresses;
    expect(await signers({ lead_id: LEAD, organization_id: ORGANIZATION })).toEqual([
      'ada@corp.example',
      'ada@example.test',
      'bo@example.test',
      'bo@other.example',
    ]);
    expect(await signers({ lead_id: LEAD, organization_id: null })).toEqual(['bo@example.test', 'bo@other.example']);
    expect(await signers({ lead_id: null, organization_id: ORGANIZATION })).toEqual(['ada@corp.example', 'ada@example.test']);
    expect(await signers({ lead_id: null, organization_id: null })).toEqual([]);
    expect(await signers({ lead_id: 'aaaaaaaa-0000-4000-8000-0000000000ff', organization_id: null })).toEqual([]);
    expect((await read({ op: 'offer_signers', lead_id: LEAD })).status).toBe(400);
  });

  it('searches leads, organizations and contacts for the offer pages (meet#1230)', async () => {
    await seed();
    const search = async (body: Record<string, unknown>) =>
      ((await (await read({ op: 'subject_search', ...body })).json()) as { data: Array<Record<string, unknown>> }).data;
    expect(await search({ entity: 'leads' })).toEqual([{
      id: LEAD,
      title: 'Lead',
      status: 'Closed Won',
      organization_id: ORGANIZATION,
      organization_name: 'Example',
      contact_id: 'cccccccc-0000-4000-8000-000000000002',
      contact_name: 'Bo',
      contact_email: 'bo@example.test',
      contact_corporate_email: null,
    }]);
    // A lead matches on its organization's name too, without case.
    expect((await search({ entity: 'leads', query: 'EXAMP' })).map((hit) => hit.id)).toEqual([LEAD]);
    expect(await search({ entity: 'leads', query: 'nothing' })).toEqual([]);
    expect(await search({ entity: 'organizations', query: 'ltd' })).toEqual([
      { id: ORGANIZATION, name: 'Example', legal_name: 'Example Ltd', country: 'NL' },
    ]);
    // A contact matches on its name, its email, its corporate email or another address it holds.
    for (const [query, name] of [['ad', 'Ada'], ['corp.example', 'Ada'], ['other.example', 'Bo']] as const) {
      expect((await search({ entity: 'contacts', query })).map((hit) => hit.name), query).toEqual([name]);
    }
    expect((await search({ entity: 'contacts' })).map((hit) => hit.name)).toEqual(['Ada', 'Bo']);
    expect((await search({ entity: 'contacts', limit: 1 })).map((hit) => hit.name)).toEqual(['Ada']);
    expect((await search({ entity: 'contacts', ids: ['cccccccc-0000-4000-8000-000000000002'] })).map((hit) => hit.name)).toEqual(['Bo']);
    // `%` and `_` match themselves, not every row.
    expect(await search({ entity: 'organizations', query: '%' })).toEqual([]);
    expect((await read({ op: 'subject_search', entity: 'projects' })).status).toBe(400);
    expect((await read({ op: 'subject_search', entity: 'leads', limit: 5000 })).status).toBe(400);
  });

  it('refuses an agent key and an unknown op', async () => {
    expect((await read({ op: 'row', entity: 'organizations', id: ORGANIZATION }, { secret: agentKey, keyId: agentEmail })).status).toBe(403);
    expect((await read({ op: 'everything' })).status).toBe(400);
  });
});

/** Envisioning after the tasks flip: Core for the workspace, D1 for groups 1 and 2. */
const tasksOnD1 = () => configured({ WORK_STORE_SUBJECTS: 'd1', WORK_STORE_TASKS: 'd1' });

describe('Core\'s task writes and reads after the tasks flip (meet#1222)', () => {
  const PROJECT = 'bbbbbbbb-0000-4000-8000-000000000001';
  const TAG = 'crm-event:offer:aaaaaaaa-0000-4000-8000-000000000009:offer.accepted';
  afterEach(clearSubjects);

  async function seed() {
    const now = Date.now();
    await env.USAGE.batch([
      env.USAGE.prepare("INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?1, 'Example', ?2, ?2)").bind(ORGANIZATION, now),
      env.USAGE.prepare("INSERT INTO projects (id, organization_id, title, status, created_at, updated_at) VALUES (?1, ?2, 'Project', 'Active', ?3, ?3)").bind(PROJECT, ORGANIZATION, now),
      env.USAGE.prepare(`INSERT INTO milestones (id, project_id, title, status, due_at, notes, place, location, start_at, created_at, updated_at)
        VALUES ('ab000000-0000-4000-8000-000000000001', ?1, 'Kickoff', 'planned', ?2, 'Bring the deck.', 'Studio', 'Amsterdam', ?3, ?4, ?4)`)
        .bind(PROJECT, Date.parse('2026-11-02'), Date.parse('2026-11-02T08:00:00Z'), now),
    ]);
  }

  it('files a proposed task in D1, finds it by tag, updates it and deletes it, and sends nothing to Core', async () => {
    const calls = coreAnswers({ data: null });
    await seed();
    const created = await send({
      action: 'create', entity: 'tasks', select: 'id, status, tags, due_date',
      values: { title: 'Kick off the project', status: 'proposed', responsible_party: 'team', priority: 'high', project_id: PROJECT, tags: ['proposed', TAG], due_date: '2026-11-01T00:00:00.000Z' },
    }, { env: tasksOnD1() });
    expect(created.status).toBe(200);
    const task = (await created.json() as { data: { id: string } }).data;
    expect(task).toMatchObject({ status: 'proposed', tags: ['proposed', TAG], due_date: '2026-11-01T00:00:00.000Z' });

    const read = (body: unknown) => send(body, { env: tasksOnD1(), path: '/api/internal/core-reads' });
    expect(await (await read({ op: 'task_by_tag', tag: TAG })).json()).toMatchObject({ data: { id: task.id, project_id: PROJECT, priority: 'high' } });
    expect(await (await read({ op: 'task_by_tag', tag: 'nothing' })).json()).toEqual({ data: null });

    const done = await send({ action: 'update', entity: 'tasks', id: task.id, values: { status: 'completed' }, select: 'status, completed_at' }, { env: tasksOnD1() });
    expect((await done.json() as { data: { completed_at: string | null } }).data.completed_at).not.toBeNull();
    expect(await (await read({ op: 'task', id: task.id })).json()).toMatchObject({ data: { status: 'completed' } });

    expect(await (await send({ action: 'delete', entity: 'tasks', id: task.id }, { env: tasksOnD1() })).json()).toEqual({ data: { id: task.id } });
    expect(await (await read({ op: 'task', id: task.id })).json()).toEqual({ data: null });
    expect(await (await send({ action: 'delete', entity: 'tasks', id: task.id }, { env: tasksOnD1() })).json()).toEqual({ data: null });
    expect(calls).toHaveLength(0);
  });

  it('refuses a task with no place, an unknown person, and a project D1 does not hold', async () => {
    coreAnswers({ data: null });
    await seed();
    expect((await send({ action: 'create', entity: 'tasks', values: { title: 'Nowhere' } }, { env: tasksOnD1() })).status).toBe(400);
    expect((await send({ action: 'create', entity: 'tasks', values: { title: 'x', project_id: PROJECT, assigned_to: 'aaaaaaaa-0000-4000-8000-0000000000ee' } }, { env: tasksOnD1() })).status).toBe(400);
    const orphan = await send({ action: 'create', entity: 'tasks', values: { title: 'x', project_id: 'bbbbbbbb-0000-4000-8000-0000000000ff' } }, { env: tasksOnD1() });
    expect(orphan.status).toBe(409);
    expect(await orphan.json()).toMatchObject({ code: '23503' });
    expect((await send({ action: 'create', entity: 'tasks', values: { title: 'x', project_id: PROJECT, unknown: 1 } }, { env: tasksOnD1() })).status).toBe(400);
  });

  it('answers tasks by filter, by due date with no due date last', async () => {
    coreAnswers({ data: null });
    await seed();
    const ACCOUNT = 'cd000000-0000-4000-8000-000000000001';
    const OTHER = 'cd000000-0000-4000-8000-000000000002';
    const file = async (title: string, values: Record<string, unknown>) => {
      const created = await send({ action: 'create', entity: 'tasks', values: { title, project_id: PROJECT, organization_id: ORGANIZATION, ...values }, select: 'id' }, { env: tasksOnD1() });
      expect(created.status).toBe(200);
    };
    await file('No date', { signals_account_id: ACCOUNT });
    await file('Late', { signals_account_id: ACCOUNT, due_date: '2026-12-01T00:00:00.000Z' });
    await file('Soon', { due_date: '2026-11-10T00:00:00.000Z' });
    await file('Other account', { signals_account_id: OTHER, due_date: '2026-11-11T00:00:00.000Z' });
    await file('Done', { signals_account_id: ACCOUNT, status: 'completed' });
    const titles = async (filter: Record<string, unknown>) => {
      const response = await send({ op: 'tasks', ...filter }, { env: tasksOnD1(), path: '/api/internal/core-reads' });
      expect(response.status).toBe(200);
      return coreRowsResponseSchema.parse(await response.json()).data.map((row) => row.title);
    };
    const open = ['pending', 'in_progress', 'review', 'blocked'];
    expect(await titles({ signals_account_ids: [ACCOUNT], statuses: open })).toEqual(['Late', 'No date']);
    expect(await titles({ organization_id: ORGANIZATION, signals_account_or_none: ACCOUNT, statuses: open })).toEqual(['Soon', 'Late', 'No date']);
    expect(await titles({ organization_id: ORGANIZATION, limit: 2 })).toEqual(['Soon', 'Other account']);
    expect((await send({ op: 'tasks', statuses: open }, { env: tasksOnD1(), path: '/api/internal/core-reads' })).status).toBe(400);
    expect((await send({ op: 'tasks', organization_id: ORGANIZATION }, { env: subjectsOnD1(), path: '/api/internal/core-reads' })).status).toBe(409);
  });

  it('answers the public project page\'s milestones and tasks, and every milestone for the feed', async () => {
    coreAnswers({ data: null });
    await seed();
    await send({ action: 'create', entity: 'tasks', values: { title: 'Send the brief', project_id: PROJECT, responsible_party: 'client', milestone_id: 'ab000000-0000-4000-8000-000000000001' } }, { env: tasksOnD1() });
    const read = (body: unknown, init: Parameters<typeof send>[1] = {}) => send(body, { env: tasksOnD1(), path: '/api/internal/core-reads', ...init });
    const work = await (await read({ op: 'project_work', id: PROJECT })).json() as { data: { milestones: unknown[]; tasks: unknown[] } };
    expect(work.data.milestones).toEqual([expect.objectContaining({
      title: 'Kickoff', due_date: '2026-11-02', notes: 'Bring the deck.', place: 'Studio', location: 'Amsterdam', start_at: '2026-11-02T08:00:00.000Z',
    })]);
    expect(work.data.tasks).toEqual([expect.objectContaining({ title: 'Send the brief', responsible_party: 'client', milestone_id: 'ab000000-0000-4000-8000-000000000001', status: 'pending' })]);
    const feed = await (await read({ op: 'milestones' })).json() as { data: Array<{ project_title: string | null }> };
    expect(feed.data).toEqual([expect.objectContaining({ title: 'Kickoff', project_title: 'Project' })]);
    // While the tasks group is on Core, Core reads its own tables.
    expect((await read({ op: 'milestones' }, { env: subjectsOnD1() })).status).toBe(409);
  });
});

/** Envisioning after the interactions flip: D1 for every group. */
const interactionsOnD1 = () => configured({ WORK_STORE_SUBJECTS: 'd1', WORK_STORE_TASKS: 'd1', WORK_STORE_GOALS: 'd1', WORK_STORE_INTERACTIONS: 'd1' });

describe('Core\'s interaction writes and reads after the interactions flip (meet#1223)', () => {
  const PROJECT = 'bbbbbbbb-0000-4000-8000-000000000011';
  const CONTACT = 'cccccccc-0000-4000-8000-000000000011';
  const ACCOUNT = 'dddddddd-0000-4000-8000-000000000011';
  afterEach(async () => {
    for (const table of ['interaction_subjects', 'interaction_contacts', 'partner_agreement_signatures', 'interactions']) {
      await env.USAGE.prepare(`DELETE FROM ${table}`).run();
    }
    await clearSubjects();
  });

  async function seed() {
    const now = Date.now();
    await env.USAGE.batch([
      env.USAGE.prepare("INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?1, 'Example', ?2, ?2)").bind(ORGANIZATION, now),
      env.USAGE.prepare("INSERT INTO contacts (id, organization_id, name, email, created_at, updated_at) VALUES (?1, ?2, 'Ada', 'ada@example.net', ?3, ?3)").bind(CONTACT, ORGANIZATION, now),
      env.USAGE.prepare("INSERT INTO leads (id, organization_id, title, status, created_at, updated_at) VALUES (?1, ?2, 'Lead', 'New', ?3, ?3)").bind(LEAD, ORGANIZATION, now),
      env.USAGE.prepare("INSERT INTO projects (id, organization_id, title, status, created_at, updated_at) VALUES (?1, ?2, 'Project', 'Active', ?3, ?3)").bind(PROJECT, ORGANIZATION, now),
    ]);
  }
  const read = (body: unknown) => send(body, { env: interactionsOnD1(), path: '/api/internal/core-reads' });

  it('refuses an interaction write and read while the group is on Core', async () => {
    coreAnswers({ data: null });
    expect((await send({ action: 'create', entity: 'interactions', values: { title: 'x', type: 'note' } }, { env: tasksOnD1() })).status).toBe(409);
    expect((await send({ op: 'interaction', id: PROJECT }, { env: tasksOnD1(), path: '/api/internal/core-reads' })).status).toBe(409);
  });

  it('files Core\'s demo debrief in D1, finds it as Core\'s flows read it, and undoes it, with nothing sent to Core', async () => {
    const calls = coreAnswers({ data: null });
    await seed();
    const created = await send({
      action: 'create', entity: 'interactions', select: 'id, title, lead_id, tags, metadata',
      values: {
        title: 'Signals demo', type: 'meeting', description: 'Demo notes.', occurred_at: '2026-10-20T10:00:00.000Z', source: 'signals',
        channel: 'meet', lead_id: LEAD, organization_id: ORGANIZATION, signals_account_id: ACCOUNT, interaction_kind: 'signals_demo',
        tags: ['signals'], metadata: { offer_id: 'o-1', reminder: 'expiry', meeting_kind: 'lead' },
      },
      contact_ids: [CONTACT],
    }, { env: interactionsOnD1() });
    expect(created.status).toBe(200);
    const row = (await created.json() as { data: { id: string } }).data;
    expect(row).toMatchObject({ title: 'Signals demo', lead_id: LEAD, tags: ['signals'], metadata: { offer_id: 'o-1', reminder: 'expiry', meeting_kind: 'lead' } });

    expect(await (await read({ op: 'interactions', organization_id: ORGANIZATION, signals_account_ids: [ACCOUNT], interaction_kind: 'signals_demo' })).json())
      .toMatchObject({ data: [{ id: row.id, signals_account_id: ACCOUNT, contacts: [{ id: CONTACT, name: 'Ada' }], contact_ids: [CONTACT] }] });
    expect(await (await read({ op: 'interactions', type: 'meeting', metadata: { offer_id: 'o-1', reminder: 'expiry' } })).json()).toMatchObject({ data: [{ id: row.id }] });
    expect(await (await read({ op: 'interactions', type: 'meeting', metadata: { offer_id: 'o-2' } })).json()).toEqual({ data: [] });
    expect((await read({ op: 'interactions', limit: 5 })).status).toBe(400);

    const moved = await send({ action: 'update', entity: 'interactions', id: row.id, values: { lead_id: null, project_id: PROJECT }, contact_ids: [], select: 'project_id, lead_id, contact_ids' }, { env: interactionsOnD1() });
    expect(await moved.json()).toEqual({ data: { project_id: PROJECT, lead_id: null, contact_ids: [] } });
    expect(await (await read({ op: 'interactions', project_id: PROJECT })).json()).toMatchObject({ data: [{ id: row.id }] });

    expect(await (await send({ action: 'delete', entity: 'interactions', id: row.id }, { env: interactionsOnD1() })).json()).toEqual({ data: { id: row.id } });
    expect(await (await read({ op: 'interaction', id: row.id })).json()).toEqual({ data: null });
    expect(await (await send({ action: 'update', entity: 'interactions', id: row.id, values: { title: 'gone' } }, { env: interactionsOnD1() })).json()).toEqual({ data: null });
    expect((await send({ action: 'create', entity: 'interactions', values: { title: 'x', type: 'note', colour: 'red' } }, { env: interactionsOnD1() })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('keeps one partner agreement signature per contact and agreement', async () => {
    coreAnswers({ data: null });
    await seed();
    const sign = (name: string) => send({
      action: 'upsert', entity: 'partner_agreement_signatures', select: 'agreement_id, signer_name, signed_at',
      values: {
        agreement_id: 'partners-2026', contact_id: CONTACT, signer_name: name, signer_email: 'ada@example.net', signing_for: 'individual',
        organization_name: null, signed_at: '2026-10-20T10:00:00.000Z', metadata: { source: 'public-partner-agreement' },
      },
    }, { env: interactionsOnD1() });
    expect(await (await sign('Ada')).json()).toEqual({ data: { agreement_id: 'partners-2026', signer_name: 'Ada', signed_at: '2026-10-20T10:00:00.000Z' } });
    await sign('Ada Lovelace');
    expect(await (await read({ op: 'partner_agreement_signature', agreement_id: 'partners-2026', contact_id: CONTACT })).json())
      .toMatchObject({ data: { signer_name: 'Ada Lovelace', metadata: { source: 'public-partner-agreement' } } });
    expect(await (await read({ op: 'partner_agreement_signature', agreement_id: 'other', contact_id: CONTACT })).json()).toEqual({ data: null });
  });
});
