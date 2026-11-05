// Core's write side effects on contacts and leads, kept on D1 (meet#1217):
// the "<Organization> <Year>" lead title, Closed Won when a project starts
// from a lead, and a contact's primary and corporate addresses as its
// addresses. The Signals account trigger stays in Core.
//
// The pool's env is Envisioning, a WORK_STORE=core workspace. `subjectsOnD1`
// is the same workspace after the `subjects` flip. Nothing leaves the test.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCrmContact, createCrmSubject, updateCrmContact } from '../src/crm';
import { defaultLeadTitle } from '../src/work-d1';

const subjectsOnD1 = { ...env, CRM_SYNC_MODE: 'on', WORK_STORE_SUBJECTS: 'd1' } as Env;
const ACTOR = 'rosa@example.com';
const ORG = '0a000000-0000-4000-8000-000000000001';

beforeEach(async () => {
  await env.USAGE.batch([
    env.USAGE.prepare('DELETE FROM contact_source_events'),
    env.USAGE.prepare('DELETE FROM contact_emails'),
    env.USAGE.prepare('DELETE FROM project_contacts'),
    env.USAGE.prepare('DELETE FROM projects'),
    env.USAGE.prepare('DELETE FROM leads'),
    env.USAGE.prepare('DELETE FROM contacts'),
    env.USAGE.prepare('DELETE FROM organizations'),
    env.USAGE.prepare("INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?1, 'Acme', 1, 1)").bind(ORG),
  ]);
});

describe('the default lead title', () => {
  it('is the organization and the year of the start date, as Core names it', async () => {
    const lead = await createCrmSubject(subjectsOnD1, { kind: 'lead', organization_id: ORG, start_date: '2027-02-01' }, ACTOR);
    expect(lead.title).toBe('Acme 2027');
    const named = await createCrmSubject(subjectsOnD1, { kind: 'lead', organization_id: ORG, title: 'Pilot' }, ACTOR);
    expect(named.title).toBe('Pilot');
    expect(defaultLeadTitle(null, null, Date.parse('2026-10-21T00:00:00Z'))).toBe('Lead 2026');
    expect(defaultLeadTitle('Acme', 'not a date', Date.parse('2026-10-21T00:00:00Z'))).toBe('Acme 2026');
  });
});

describe('a project started from a lead', () => {
  it('sets the lead to Closed Won', async () => {
    const lead = await createCrmSubject(subjectsOnD1, { kind: 'lead', organization_id: ORG, status: 'Proposal Out' }, ACTOR);
    await createCrmSubject(subjectsOnD1, { kind: 'project', organization_id: ORG, lead_id: lead.id, title: 'Acme radar' }, ACTOR);
    expect(await env.USAGE.prepare('SELECT status FROM leads WHERE id = ?1').bind(lead.id).first('status')).toBe('Closed Won');
  });
});

describe("a contact's addresses", () => {
  it('keeps the primary and the corporate address as addresses of the contact, after any write', async () => {
    const contact = await createCrmContact(subjectsOnD1, ACTOR, { name: 'Ana', emails: ['ana@example.net'], corporate_email: 'Ana@Corp.example.net' } as never);
    const addresses = async () => (await env.USAGE.prepare('SELECT email FROM contact_emails WHERE contact_id = ?1 ORDER BY email').bind(contact.id).all<{ email: string }>())
      .results.map((row) => row.email);
    expect(await addresses()).toEqual(['ana@corp.example.net', 'ana@example.net']);

    // A contact copied from Core has only its primary column until it is next written.
    await env.USAGE.prepare('DELETE FROM contact_emails WHERE contact_id = ?1').bind(contact.id).run();
    await updateCrmContact(subjectsOnD1, ACTOR, contact.id, { phone: '+31 20 000 0000' } as never);
    expect(await addresses()).toEqual(['ana@corp.example.net', 'ana@example.net']);

    // Replacing the list keeps the corporate address.
    await updateCrmContact(subjectsOnD1, ACTOR, contact.id, { emails: ['ana.new@example.net'] } as never);
    expect(await addresses()).toEqual(['ana.new@example.net', 'ana@corp.example.net']);
  });
});
