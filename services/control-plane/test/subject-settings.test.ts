// The settings tables of the subjects group on D1 (meet#1228): Admin ›
// Records reads and edits them once the group answers from D1, a rename of a
// characteristic moves the flag on every record, and a contact write records
// where the contact came from, through a merge too.
//
// The pool's env is Envisioning, a WORK_STORE=core workspace. `subjectsOnD1`
// is the same workspace after the `subjects` flip. Nothing leaves the test.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCrmContact, mergeCoreRecords } from '../src/crm';
import { ControlError } from '../src/errors';
import { readSubjectSettings, writeSubjectSettings } from '../src/subject-settings';
import { d1CreateContact } from '../src/work-d1';
import { freezeGroup, unfreezeGroup } from '../src/work-group-moves';

const coreEnv = { ...env, CRM_SYNC_MODE: 'on' } as Env;
const subjectsOnD1 = { ...coreEnv, WORK_STORE_SUBJECTS: 'd1' } as Env;
const ACTOR = 'rosa@example.com';

async function rejection(call: Promise<unknown>): Promise<ControlError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ControlError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(async () => {
  await env.USAGE.batch([
    env.USAGE.prepare('DELETE FROM contact_source_events'),
    env.USAGE.prepare('DELETE FROM contact_emails'),
    env.USAGE.prepare('DELETE FROM record_merges'),
    env.USAGE.prepare('DELETE FROM contacts'),
    env.USAGE.prepare('DELETE FROM lead_characteristics_config'),
    env.USAGE.prepare('DELETE FROM contact_characteristics_config'),
    env.USAGE.prepare(`DELETE FROM contact_source_definitions WHERE key NOT IN ('crm_manual', 'agent_api', 'website_contact')`),
    env.USAGE.prepare('DELETE FROM work_group_moves'),
  ]);
});

describe('Admin › Records', () => {
  it('says Core holds the settings while the subjects group is on Core, and refuses a write', async () => {
    expect(await readSubjectSettings(coreEnv)).toMatchObject({ editable: false, contact_sources: [] });
    const refused = await rejection(writeSubjectSettings(coreEnv, { op: 'characteristic.save', kind: 'lead', name: 'project_fit' }));
    expect(refused.status).toBe(409);
  });

  it('edits each table once the group answers from D1, and the freeze holds', async () => {
    let page = await writeSubjectSettings(subjectsOnD1, { op: 'characteristic.save', kind: 'contact', name: 'speaker' });
    expect(page.contact_characteristics.map((row) => row.name)).toEqual(['speaker']);

    // A system source keeps its category; its label changes.
    page = await writeSubjectSettings(subjectsOnD1, {
      op: 'source.save', key: 'crm_manual', label: 'By hand', category: 'legacy', is_active: true,
      manual_selectable: true, import_selectable: false, sort_order: 10,
    });
    expect(page.contact_sources.find((row) => row.key === 'crm_manual')).toMatchObject({ label: 'By hand', category: 'manual', is_system: true });

    // The same name twice is refused.
    expect((await rejection(writeSubjectSettings(subjectsOnD1, { op: 'characteristic.save', kind: 'contact', name: 'speaker' }))).status).toBe(409);

    await freezeGroup(coreEnv, 'subjects');
    expect((await rejection(writeSubjectSettings(subjectsOnD1, { op: 'characteristic.save', kind: 'lead', name: 'budget' }))).code).toBe('records_moving');
    await unfreezeGroup(coreEnv, 'subjects');
  });

  it('renames a characteristic on every contact that has the flag', async () => {
    const page = await writeSubjectSettings(subjectsOnD1, { op: 'characteristic.save', kind: 'contact', name: 'speaker' });
    const contact = await createCrmContact(subjectsOnD1, ACTOR, { name: 'Ana', emails: [], characteristics: { speaker: true, media: false } } as never);
    await writeSubjectSettings(subjectsOnD1, { op: 'characteristic.save', kind: 'contact', id: page.contact_characteristics[0]!.id, name: 'keynote' });
    const stored = await env.USAGE.prepare('SELECT characteristics FROM contacts WHERE id = ?1').bind(contact.id).first<{ characteristics: string }>();
    expect(JSON.parse(stored!.characteristics)).toEqual({ keynote: true, media: false });
  });
});

describe('where a contact came from', () => {
  it('records the origin of a contact a member adds, and refuses a source not offered to a member', async () => {
    const contact = await createCrmContact(subjectsOnD1, ACTOR, { name: 'Ana', emails: ['ana@example.net'] } as never);
    const { results } = await env.USAGE.prepare('SELECT event_type, source_key, dedupe_key FROM contact_source_events WHERE contact_id = ?1').bind(contact.id).all();
    expect(results).toEqual([{ event_type: 'created', source_key: 'crm_manual', dedupe_key: 'origin:crm_manual' }]);

    const refused = await rejection(createCrmContact(subjectsOnD1, ACTOR, { name: 'Bo', emails: [], source_key: 'website_contact' } as never));
    expect(refused.status).toBe(400);
    // Core's own flows may name it.
    const fromCore = await createCrmContact(subjectsOnD1, ACTOR, { name: 'Bo', emails: [], source_key: 'website_contact' } as never, { anySource: true });
    expect(await env.USAGE.prepare('SELECT source_key FROM contact_source_events WHERE contact_id = ?1').bind(fromCore.id).first('source_key')).toBe('website_contact');
  });

  it('records each form submission once, on the contact the address already has', async () => {
    await env.USAGE.prepare("INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('0a000000-0000-4000-8000-000000000001', 'Acme', 1, 1)").run();
    const input = { organization_id: '0a000000-0000-4000-8000-000000000001', name: 'Ana', email: 'ana@example.net' };
    const fact = (id: string) => ({ eventType: 'form_submitted' as const, sourceKey: 'website_contact', sourceRecordType: 'form_submissions', sourceRecordId: id, dedupeKey: `form_submission:${id}` });
    const first = await d1CreateContact(subjectsOnD1, input, fact('f1'));
    expect((await d1CreateContact(subjectsOnD1, input, fact('f2'))).id).toBe(first.id);
    await d1CreateContact(subjectsOnD1, input, fact('f2'));
    const { results } = await env.USAGE.prepare('SELECT source_record_id FROM contact_source_events WHERE contact_id = ?1 ORDER BY source_record_id').bind(first.id).all();
    expect(results).toEqual([{ source_record_id: 'f1' }, { source_record_id: 'f2' }]);
  });

  it('keeps every fact of a merged contact on the survivor', async () => {
    const older = await createCrmContact(subjectsOnD1, ACTOR, { name: 'Ana', emails: ['ana@example.net'] } as never);
    const newer = await createCrmContact(subjectsOnD1, ACTOR, { name: 'Ana S', emails: ['ana.s@example.net'] } as never);
    await env.USAGE.prepare('UPDATE contacts SET created_at = 1 WHERE id = ?1').bind(older.id).run();
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'contacts', [older.id, newer.id]);
    const { results } = await env.USAGE.prepare('SELECT contact_id, dedupe_key FROM contact_source_events ORDER BY dedupe_key').all<{ contact_id: string; dedupe_key: string }>();
    expect(results.map((row) => row.contact_id)).toEqual([older.id, older.id]);
    expect(results[0]!.dedupe_key).toBe('origin:crm_manual');
    expect(results[1]!.dedupe_key).toMatch(/^origin:crm_manual:merged:/u);
  });
});
