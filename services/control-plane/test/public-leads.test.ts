import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { hmacSHA256Hex } from '../src/crypto';
import { publicLeadResponseSchema } from '@starlings/contracts/public-leads';

/**
 * The public lead form (MZ, 2026-11-05): what Core's `/api/public/leads` does,
 * on D1. Shut until the workspace sets its key.
 */

const secret = 'public-lead-key-for-the-tests-0123456789';
const open = { ...env, WORK_STORE: 'd1', PUBLIC_LEAD_SECRET: secret, AGENT_LIMIT: undefined, FEEDBACK_LIMIT: undefined } as unknown as Env;

const form = {
  name: 'Ana Souza',
  email: 'Ana@Example.org',
  title: 'Director',
  organization: 'Boa Vista Labs',
  country: 'br',
  message: 'We would like to talk about a research session.',
  partner: 'Acme',
  requestOffer: true,
  createLead: true,
  budgetRange: '10k-25k',
  fundsAllocated: 'yes',
  sourcePage: '/contact',
  // A form field that means nothing to the record; ignored, as Core ignores it.
  scheduleMeeting: true,
};

async function post(body: unknown, init: { workspace?: Env; key?: string | null; at?: number; headers?: Record<string, string> } = {}): Promise<Response> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const key = init.key === undefined ? secret : init.key;
  const timestamp = String(init.at ?? Date.now());
  const signed = key === null ? {} : {
    'x-internal-timestamp': timestamp,
    'x-internal-signature': await hmacSHA256Hex(key, `${timestamp}.${raw}`),
  };
  const context = createExecutionContext();
  const response = await worker.fetch(new Request('https://workspace.example/api/public/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed, ...init.headers },
    body: raw,
  }), init.workspace ?? open, context);
  await waitOnExecutionContext(context);
  return response;
}

const count = async (table: string): Promise<number> =>
  (await env.USAGE.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

async function counts() {
  return {
    organizations: await count('organizations'),
    contacts: await count('contacts'),
    leads: await count('leads'),
    interactions: await count('interactions'),
    facts: await count("contact_source_events WHERE event_type = 'form_submitted'"),
  };
}

const NOTHING = { organizations: 0, contacts: 0, leads: 0, interactions: 0, facts: 0 };

beforeEach(async () => {
  for (const table of [
    'interaction_subjects', 'interaction_contacts', 'interactions', 'contact_source_events',
    'contact_emails', 'leads', 'contacts', 'organizations', 'ops_inbound',
  ]) {
    await env.USAGE.prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('The public lead route is shut until a workspace enables it', () => {
  it('answers 404 on a D1 workspace with no key, as a path with no route', async () => {
    const response = await post(form, { workspace: { ...open, PUBLIC_LEAD_SECRET: '' } as Env });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found.' });
    expect(await counts()).toEqual(NOTHING);
  });

  it('answers 404 on a key too short to count', async () => {
    expect((await post(form, { workspace: { ...open, PUBLIC_LEAD_SECRET: 'short' } as Env, key: 'short' })).status).toBe(404);
  });

  it('answers 404 on Envisioning with no key', async () => {
    const workspace = { ...open, WORK_STORE: 'core', WORK_STORE_SUBJECTS: 'd1', WORK_STORE_INTERACTIONS: 'd1', PUBLIC_LEAD_SECRET: '' } as Env;
    expect((await post(form, { workspace })).status).toBe(404);
  });

  it('answers 404 while these records are still on Core, even with a key', async () => {
    const workspace = { ...open, WORK_STORE: 'core', WORK_STORE_SUBJECTS: 'd1', WORK_STORE_INTERACTIONS: 'core' } as Env;
    expect((await post(form, { workspace })).status).toBe(404);
    expect(await counts()).toEqual(NOTHING);
  });

  it('answers on Envisioning with its key once the groups moved', async () => {
    const workspace = { ...open, WORK_STORE: 'core', WORK_STORE_SUBJECTS: 'd1', WORK_STORE_INTERACTIONS: 'd1', CRM_SYNC_MODE: 'off' } as Env;
    expect((await post(form, { workspace })).status).toBe(200);
  });
});

describe('Who may post', () => {
  it('refuses a signature made with another key, and writes nothing', async () => {
    const response = await post(form, { key: 'another-key-of-the-same-length-0123456789' });
    expect(response.status).toBe(403);
    expect(await counts()).toEqual(NOTHING);
    const refused = await env.USAGE.prepare("SELECT last_refused_at FROM ops_inbound WHERE caller = 'public-leads'").first<{ last_refused_at: number }>();
    expect(refused?.last_refused_at).toBeGreaterThan(0);
  });

  it('refuses a signature for another body', async () => {
    const raw = JSON.stringify(form);
    const timestamp = String(Date.now());
    const response = await post({ ...form, email: 'other@example.org' }, {
      key: null,
      headers: { 'x-internal-timestamp': timestamp, 'x-internal-signature': await hmacSHA256Hex(secret, `${timestamp}.${raw}`) },
    });
    expect(response.status).toBe(403);
    expect(await counts()).toEqual(NOTHING);
  });

  it('refuses an old signature', async () => {
    expect((await post(form, { at: Date.now() - 10 * 60_000 })).status).toBe(403);
    expect(await counts()).toEqual(NOTHING);
  });

  it('does not let a good token rescue a wrong signature', async () => {
    const fetchStub = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal('fetch', fetchStub);
    const response = await post({ ...form, turnstileToken: 'good' }, { key: 'another-key-of-the-same-length-0123456789', workspace: { ...open, TURNSTILE_SECRET_KEY: 'turnstile' } as Env });
    expect(response.status).toBe(403);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('refuses a call with no signature and no token, and writes nothing', async () => {
    expect((await post(form, { key: null, workspace: { ...open, TURNSTILE_SECRET_KEY: 'turnstile' } as Env })).status).toBe(403);
    expect(await counts()).toEqual(NOTHING);
  });

  it('fails closed with no Turnstile secret', async () => {
    expect((await post({ ...form, turnstileToken: 'any' }, { key: null, workspace: { ...open, TURNSTILE_SECRET_KEY: '' } as Env })).status).toBe(503);
    expect(await counts()).toEqual(NOTHING);
  });

  it('fails closed when siteverify does not answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect((await post({ ...form, turnstileToken: 'any' }, { key: null, workspace: { ...open, TURNSTILE_SECRET_KEY: 'turnstile' } as Env })).status).toBe(503);
    expect(await counts()).toEqual(NOTHING);
  });

  it('refuses a token siteverify refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: false })));
    expect((await post({ ...form, turnstileToken: 'bad' }, { key: null, workspace: { ...open, TURNSTILE_SECRET_KEY: 'turnstile' } as Env })).status).toBe(403);
    expect(await counts()).toEqual(NOTHING);
  });

  it('takes an unsigned call with a token siteverify accepts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true })));
    expect((await post({ ...form, turnstileToken: 'good' }, { key: null, workspace: { ...open, TURNSTILE_SECRET_KEY: 'turnstile' } as Env })).status).toBe(200);
    expect(await counts()).toMatchObject({ leads: 1 });
  });

  it('answers 429 when the address limit refuses', async () => {
    const workspace = { ...open, AGENT_LIMIT: { limit: async () => ({ success: false }) } } as unknown as Env;
    expect((await post(form, { workspace })).status).toBe(429);
    expect(await counts()).toEqual(NOTHING);
  });

  it('answers 429 past the hourly total', async () => {
    const contact = await post({ ...form, createLead: false });
    const { contact_id: contactId } = publicLeadResponseSchema.parse(await contact.json());
    const now = Date.now();
    await env.USAGE.batch(Array.from({ length: 60 }, (_, index) => env.USAGE.prepare(
      `INSERT INTO contact_source_events (id, contact_id, event_type, source_key, occurred_at, dedupe_key, created_at)
       VALUES (?1, ?2, 'form_submitted', 'website_contact', ?3, ?4, ?3)`,
    ).bind(`fill-${index}`, contactId, now, `fill:${index}`)));
    expect((await post({ ...form, email: 'someone@example.org' })).status).toBe(429);
  });
});

describe('The body', () => {
  it('refuses invalid JSON and a body the contract refuses', async () => {
    expect((await post('{nope')).status).toBe(400);
    expect((await post({ ...form, email: 'not-an-address' })).status).toBe(400);
    expect((await post({ ...form, organization: '' })).status).toBe(400);
    expect((await post({ ...form, message: undefined })).status).toBe(400);
    expect(await counts()).toEqual(NOTHING);
  });
});

describe('A submission', () => {
  it('makes the organization, the contact, the lead, the interaction, the fact and the channel line', async () => {
    const response = await post(form);
    expect(response.status).toBe(200);
    const answer = publicLeadResponseSchema.parse(await response.json());
    expect(answer).toMatchObject({ duplicate: false, requestOffer: true, message: 'Contact and lead created successfully' });

    const organization = await env.USAGE.prepare('SELECT name, legal_name, country FROM organizations WHERE id = ?1').bind(answer.organization_id).first();
    expect(organization).toEqual({ name: 'Boa Vista Labs', legal_name: 'Boa Vista Labs', country: 'BR' });

    const contact = await env.USAGE.prepare('SELECT name, email, title, country, organization_id, notes FROM contacts WHERE id = ?1').bind(answer.contact_id).first();
    expect(contact).toEqual({
      name: 'Ana Souza', email: 'ana@example.org', title: 'Director', country: 'BR', organization_id: answer.organization_id,
      notes: 'Created from public form submission. Organization: Boa Vista Labs',
    });

    const lead = await env.USAGE.prepare('SELECT title, status, source, notes, contact_id, organization_id FROM leads WHERE id = ?1').bind(answer.lead_id).first<Record<string, string>>();
    expect(lead).toMatchObject({ title: 'Lead for Boa Vista Labs', status: 'Conversations', source: '/contact', contact_id: answer.contact_id, organization_id: answer.organization_id });
    expect(lead!.notes).toContain('Contact Reason:\nWe would like to talk about a research session.');
    expect(lead!.notes).toContain('Country: Brazil');
    expect(lead!.notes).toContain('Referred by partner: Acme');
    expect(lead!.notes).toContain('Budget Range: 10k-25k');

    const interaction = await env.USAGE.prepare(
      `SELECT i.title, i.type, i.tags, c.contact_id, s.subject_kind, s.subject_id FROM interactions i
       JOIN interaction_contacts c ON c.interaction_id = i.id
       JOIN interaction_subjects s ON s.interaction_id = i.id AND s.is_primary = 1`,
    ).first();
    expect(interaction).toEqual({
      title: 'Site - Offer requested', type: 'web', tags: JSON.stringify(['public-form', 'initial-contact']),
      contact_id: answer.contact_id, subject_kind: 'lead', subject_id: answer.lead_id,
    });

    const fact = await env.USAGE.prepare(
      "SELECT source_key, source_record_type, source_record_id, metadata FROM contact_source_events WHERE event_type = 'form_submitted'",
    ).first<{ metadata: string } & Record<string, string>>();
    expect(fact).toMatchObject({ source_key: 'website_contact', source_record_type: 'leads', source_record_id: answer.lead_id });
    expect(JSON.parse(fact!.metadata)).toMatchObject({ createLead: true, sourcePage: '/contact', requestOffer: true, organization_id: answer.organization_id });

    const line = await env.USAGE.prepare(
      "SELECT last_message_preview AS text FROM threads WHERE kind = 'lead' AND parent_id = ?1",
    ).bind(answer.lead_id).first<{ text: string }>();
    expect(line?.text).toBe('New Lead: Boa Vista Labs - Ana Souza');
  });

  it('files a repeat submit once, and answers with what the first made', async () => {
    const first = publicLeadResponseSchema.parse(await (await post(form)).json());
    const before = await counts();
    expect(before).toEqual({ organizations: 1, contacts: 1, leads: 1, interactions: 1, facts: 1 });

    const again = await post({ ...form, email: 'ANA@example.org', organization: 'boa vista labs' });
    expect(again.status).toBe(200);
    expect(publicLeadResponseSchema.parse(await again.json())).toEqual({ ...first, duplicate: true });
    expect(await counts()).toEqual(before);
  });

  it('files a new message from the same person as a new lead on the same records', async () => {
    const first = publicLeadResponseSchema.parse(await (await post(form)).json());
    const second = publicLeadResponseSchema.parse(await (await post({ ...form, message: 'A second question, about a workspace.' })).json());
    expect(second).toMatchObject({ duplicate: false, contact_id: first.contact_id, organization_id: first.organization_id });
    expect(second.lead_id).not.toBe(first.lead_id);
    expect(await counts()).toEqual({ organizations: 1, contacts: 1, leads: 2, interactions: 2, facts: 2 });
  });

  it('finds a contact by a secondary address, and changes neither the contact nor the organization', async () => {
    const now = Date.now();
    await env.USAGE.batch([
      env.USAGE.prepare("INSERT INTO organizations (id, name, country, created_at, updated_at) VALUES ('org-1', 'Boa Vista Labs', 'PT', ?1, ?1)").bind(now),
      env.USAGE.prepare("INSERT INTO contacts (id, organization_id, name, email, title, created_at, updated_at) VALUES ('contact-1', 'org-1', 'Ana S.', 'primary@example.org', 'CEO', ?1, ?1)").bind(now),
      env.USAGE.prepare("INSERT INTO contact_emails (email, contact_id, created_at) VALUES ('ana@example.org', 'contact-1', ?1)").bind(now),
    ]);
    const answer = publicLeadResponseSchema.parse(await (await post(form)).json());
    expect(answer).toMatchObject({ contact_id: 'contact-1', organization_id: 'org-1' });
    expect(await env.USAGE.prepare("SELECT name, title FROM contacts WHERE id = 'contact-1'").first()).toEqual({ name: 'Ana S.', title: 'CEO' });
    expect(await env.USAGE.prepare("SELECT country FROM organizations WHERE id = 'org-1'").first()).toEqual({ country: 'PT' });
    expect(await counts()).toMatchObject({ organizations: 1, contacts: 1, leads: 1 });
  });

  it('makes no lead and no channel line unless it asks for a lead', async () => {
    const answer = publicLeadResponseSchema.parse(await (await post({ ...form, createLead: false, message: undefined, requestOffer: false })).json());
    expect(answer).toMatchObject({ lead_id: null, message: 'Contact created successfully' });
    expect(await counts()).toEqual({ organizations: 1, contacts: 1, leads: 0, interactions: 1, facts: 1 });
    expect(await env.USAGE.prepare("SELECT source_record_type, source_record_id FROM contact_source_events WHERE event_type = 'form_submitted'").first())
      .toEqual({ source_record_type: 'contacts', source_record_id: answer.contact_id });
  });

  it('keeps "Not provided" out of the contact title', async () => {
    const answer = publicLeadResponseSchema.parse(await (await post({ ...form, title: 'Not provided' })).json());
    expect(await env.USAGE.prepare('SELECT title FROM contacts WHERE id = ?1').bind(answer.contact_id).first()).toEqual({ title: null });
  });
});
