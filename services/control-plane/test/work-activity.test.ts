// The activity trail of the work model on D1 (meet#1218): every write the
// Worker sends to D1 adds a row with who, what, which fields and when, and
// the admin read filters it as Core's feed does.
//
// The pool's env is Envisioning, a WORK_STORE=core workspace. `subjectsOnD1`
// is the same workspace after the `subjects` flip. Nothing leaves the test.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCrmContact, createCrmOrganization, createCrmSubject, updateCrmContact, updateCrmSubject } from '../src/crm';
import { listWorkActivity } from '../src/work-activity';

const subjectsOnD1 = { ...env, CRM_SYNC_MODE: 'on', WORK_STORE_SUBJECTS: 'd1' } as Env;
const ROSA = 'rosa@example.com';
const ADA = 'ada@example.com';

beforeEach(async () => {
  await env.USAGE.batch([
    env.USAGE.prepare('DELETE FROM work_activity'),
    env.USAGE.prepare('DELETE FROM contact_source_events'),
    env.USAGE.prepare('DELETE FROM contact_emails'),
    env.USAGE.prepare('DELETE FROM project_contacts'),
    env.USAGE.prepare('DELETE FROM projects'),
    env.USAGE.prepare('DELETE FROM leads'),
    env.USAGE.prepare('DELETE FROM contacts'),
    env.USAGE.prepare('DELETE FROM organizations'),
  ]);
});

describe('the work activity trail', () => {
  it('records each D1 write with its actor, table, row, action and fields', async () => {
    const organization = await createCrmOrganization(subjectsOnD1, ROSA, 'Acme');
    const contact = await createCrmContact(subjectsOnD1, ROSA, { name: 'Ana', emails: ['ana@example.net'], organization_id: organization.id } as never);
    await updateCrmContact(subjectsOnD1, ADA, contact.id, { phone: '+31 20 000 0000' } as never);
    const lead = await createCrmSubject(subjectsOnD1, { kind: 'lead', organization_id: organization.id }, ROSA);
    await updateCrmSubject(subjectsOnD1, 'lead', lead.id, { notes: 'Warm' }, ADA);
    await createCrmSubject(subjectsOnD1, { kind: 'project', organization_id: organization.id, lead_id: lead.id, title: 'Radar' }, ROSA);

    const all = await listWorkActivity(subjectsOnD1, {});
    expect(all.items.map((item) => [item.actor, item.table, item.action, item.changed_fields])).toEqual([
      [ROSA, 'leads', 'update', ['status']],
      [ROSA, 'projects', 'insert', ['lead_id', 'organization_id', 'title']],
      [ADA, 'leads', 'update', ['notes']],
      [ROSA, 'leads', 'insert', ['organization_id']],
      [ADA, 'contacts', 'update', ['phone']],
      [ROSA, 'contacts', 'insert', ['emails', 'name', 'organization_id']],
      [ROSA, 'organizations', 'insert', ['name']],
    ]);
    expect(all.items.find((item) => item.table === 'contacts' && item.action === 'insert')).toMatchObject({ row_id: contact.id, label: 'Ana' });
    expect(all.tables).toEqual(['contacts', 'leads', 'organizations', 'projects']);
    expect(all.actors).toEqual([ADA, ROSA]);
    expect(all.next_cursor).toBeNull();

    // Core's feed's filters: table, action, actor, text, days.
    expect((await listWorkActivity(subjectsOnD1, { table: 'contacts' })).items).toHaveLength(2);
    expect((await listWorkActivity(subjectsOnD1, { action: 'insert', actor: ROSA })).items).toHaveLength(4);
    expect((await listWorkActivity(subjectsOnD1, { q: 'phone' })).items.map((item) => item.actor)).toEqual([ADA]);
    expect((await listWorkActivity(subjectsOnD1, { q: 'Acme' })).items.map((item) => item.table)).toEqual(['leads', 'leads', 'organizations']);
    const today = new Date().toISOString().slice(0, 10);
    expect((await listWorkActivity(subjectsOnD1, { from: today, to: today })).items).toHaveLength(7);
    expect((await listWorkActivity(subjectsOnD1, { to: '2000-01-01' })).items).toEqual([]);
  });

  it('pages newest first by cursor', async () => {
    const organization = await createCrmOrganization(subjectsOnD1, ROSA, 'Acme');
    for (let index = 0; index < 55; index += 1) {
      await updateCrmSubject(subjectsOnD1, 'lead', (await createCrmSubject(subjectsOnD1, { kind: 'lead', organization_id: organization.id, title: `Lead ${index}` }, ROSA)).id, { notes: 'x' }, ROSA);
    }
    const first = await listWorkActivity(subjectsOnD1, {});
    expect(first.items).toHaveLength(50);
    expect(first.next_cursor).not.toBeNull();
    const second = await listWorkActivity(subjectsOnD1, { cursor: first.next_cursor! });
    // The organization, then a create and an update per lead: 111 rows.
    expect(second.items).toHaveLength(50);
    expect(second.items[0]!.id).toBeLessThan(first.items[49]!.id);
    const third = await listWorkActivity(subjectsOnD1, { cursor: second.next_cursor! });
    expect(third.items).toHaveLength(11);
    expect(third.next_cursor).toBeNull();
  });

  it('writes nothing while the group is on Core', async () => {
    expect((await listWorkActivity(env as Env, {})).items).toEqual([]);
  });
});
