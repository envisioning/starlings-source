// Fold group 4 after its move (meet#1223, meet#1204): a member's call,
// meeting or note by hand, the Granola ledger, the booking interaction and
// the meeting log's merge into it, all on D1, with nothing sent to Core.
//
// The pool's env is Envisioning, a WORK_STORE=core workspace. Every group is
// set to D1 here, as after the interactions flip. `fetch` fails the test if
// anything calls Core.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  changeBookingInteraction,
  createCrmInteraction,
  deleteCrmInteraction,
  fetchCrmContactDetail,
  fetchCrmInteractions,
  fetchGranolaLedger,
  fileBookingInteraction,
  postMeetingLog,
  updateCrmInteraction,
  type MeetingLogPayload,
} from '../src/crm';
import { ControlError } from '../src/errors';

const SECRET = 'meet-core-shared-secret-at-least-32-chars';
/** Envisioning after the interactions flip: Core for the workspace, D1 for every group. */
const onD1 = {
  ...env, INTERNAL_REQUEST_SECRET: SECRET, CRM_SYNC_MODE: 'on',
  WORK_STORE_SUBJECTS: 'd1', WORK_STORE_TASKS: 'd1', WORK_STORE_GOALS: 'd1', WORK_STORE_INTERACTIONS: 'd1',
} as Env;

const ORG = '0a000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '0a000000-0000-4000-8000-0000000000a2';
const CONTACT = '0c000000-0000-4000-8000-0000000000c1';
const LEAD = '1e000000-0000-4000-8000-0000000000e1';
const PROJECT = '9a000000-0000-4000-8000-0000000000f1';
const HOST = 'rosa@example.com';

const one = (sql: string, ...binds: unknown[]) => env.USAGE.prepare(sql).bind(...binds).first<Record<string, unknown>>();
const all = async (sql: string, ...binds: unknown[]) => (await env.USAGE.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;

async function clear(): Promise<void> {
  await env.USAGE.batch([
    'interaction_subjects', 'interaction_contacts', 'partner_agreement_signatures', 'interactions', 'contact_source_events',
    'contact_emails', 'projects', 'leads', 'contacts', 'organizations', 'work_activity', 'work_group_moves', 'bookings',
  ].map((table) => env.USAGE.prepare(`DELETE FROM ${table}`)));
}

async function seed(): Promise<void> {
  const run = (sql: string, ...binds: unknown[]) => env.USAGE.prepare(sql).bind(...binds);
  await env.USAGE.batch([
    run(`INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?1, 'Acme', 1, 1), (?2, 'Other', 1, 1)`, ORG, OTHER_ORG),
    run(`INSERT INTO contacts (id, organization_id, name, email, created_at, updated_at) VALUES (?1, ?2, 'Ana', 'ana@acme.test', 1, 1)`, CONTACT, ORG),
    run(`INSERT INTO contact_emails (email, contact_id, created_at) VALUES ('ana@acme.test', ?1, 1)`, CONTACT),
    run(`INSERT INTO leads (id, organization_id, title, status, created_at, updated_at) VALUES (?1, ?2, 'Pilot', 'Proposal', 1, 1)`, LEAD, ORG),
    run(`INSERT INTO projects (id, organization_id, title, status, created_at, updated_at) VALUES (?1, ?2, 'Radar', 'Active', 1, 1)`, PROJECT, ORG),
  ]);
}

let calls: string[] = [];
beforeEach(async () => {
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return new Response('{}', { status: 500 });
  });
  await clear();
  await seed();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clear();
});

async function rejection(call: Promise<unknown>): Promise<ControlError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ControlError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function meetingLog(overrides: Partial<MeetingLogPayload>): MeetingLogPayload {
  return {
    phase: 'ended', meeting_id: 'mtg-1', room_slug: 'rosa', host_email: HOST, source: 'meet_envisioning',
    started_at: '2026-10-20T09:00:00.000Z', ended_at: '2026-10-20T09:30:00.000Z', title: 'Kickoff', summary_markdown: '## Notes',
    transcript: [], participants: [], booking_token: null, permalink: 'https://envisioning.starlings.example/room/rosa',
    meeting_kind: 'uncategorized', lead_id: null, project_id: null, partner_organization_id: null, categorized_by: HOST,
    transcript_document_id: null, transcript_url: null, ...overrides,
  };
}

describe('an interaction by hand on D1 (meet#1223)', () => {
  it('logs a call on a project, edits it onto a lead, and deletes it', async () => {
    const call = await createCrmInteraction(onD1, HOST, {
      type: 'call', title: 'Pricing call', occurred_at: '2026-10-21T14:00:00+02:00', summary_markdown: 'They want the annual plan.',
      url: 'https://example.test/notes', project_id: PROJECT, organization_id: ORG, contact_ids: [CONTACT],
    });
    expect(call).toMatchObject({
      type: 'call', title: 'Pricing call', occurred_at: '2026-10-21T12:00:00.000Z', summary_markdown: 'They want the annual plan.',
      project_id: PROJECT, organization_id: ORG, url: 'https://example.test/notes', source: 'manual',
      contacts: [{ id: CONTACT, name: 'Ana', email: 'ana@acme.test' }],
    });
    // Core's agent route stores the summary as the description too, and files the project as a mirrored link.
    expect(await one('SELECT description, source, channel, status, external_id = id AS own_key FROM interactions WHERE id = ?1', call.id))
      .toEqual({ description: 'They want the annual plan.', source: 'manual', channel: 'manual', status: 'logged', own_key: 1 });
    expect(await all('SELECT subject_kind, subject_id, is_primary, source FROM interaction_subjects WHERE interaction_id = ?1', call.id))
      .toEqual([{ subject_kind: 'project', subject_id: PROJECT, is_primary: 1, source: 'mirror' }]);
    expect((await fetchCrmInteractions(onD1, { projectId: PROJECT })).map((row) => row.id)).toEqual([call.id]);
    expect((await fetchCrmInteractions(onD1, { organizationId: ORG })).map((row) => row.id)).toEqual([call.id]);

    const moved = await updateCrmInteraction(onD1, HOST, call.id, { project_id: null, lead_id: LEAD, type: 'meeting', contact_ids: [] });
    expect(moved).toMatchObject({ type: 'meeting', lead_id: LEAD, project_id: null, contacts: [] });
    expect(await fetchCrmInteractions(onD1, { projectId: PROJECT })).toEqual([]);
    expect((await fetchCrmInteractions(onD1, { leadId: LEAD })).map((row) => row.id)).toEqual([call.id]);
    expect(await all('SELECT action FROM work_activity WHERE row_id = ?1 ORDER BY at, action', call.id)).toEqual([{ action: 'insert' }, { action: 'update' }]);

    expect(await deleteCrmInteraction(onD1, HOST, call.id)).toEqual({ id: call.id, deleted: true });
    expect(await one('SELECT COUNT(*) AS n FROM interactions')).toEqual({ n: 0 });
    expect(await one('SELECT COUNT(*) AS n FROM interaction_subjects')).toEqual({ n: 0 });
    expect((await rejection(deleteCrmInteraction(onD1, HOST, call.id))).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('files a note on an organization alone, and refuses a lead this workspace does not hold', async () => {
    const note = await createCrmInteraction(onD1, HOST, {
      type: 'note', title: 'Met at the fair', occurred_at: '2026-10-21T10:00:00Z', organization_id: OTHER_ORG, contact_ids: [],
    });
    expect((await fetchCrmInteractions(onD1, { organizationId: OTHER_ORG })).map((row) => row.id)).toEqual([note.id]);
    expect(await fetchCrmInteractions(onD1, { organizationId: ORG })).toEqual([]);
    const refused = await rejection(createCrmInteraction(onD1, HOST, {
      type: 'note', title: 'Lost', occurred_at: '2026-10-21T10:00:00Z', lead_id: '1e000000-0000-4000-8000-0000000000ff', contact_ids: [],
    }));
    expect(refused.status).toBe(400);
  });

  it('keeps a personal row out of every list and off a contact page', async () => {
    const shown = await createCrmInteraction(onD1, HOST, {
      type: 'call', title: 'Shared', occurred_at: '2026-10-21T10:00:00Z', project_id: PROJECT, contact_ids: [CONTACT],
    });
    const hidden = await createCrmInteraction(onD1, HOST, {
      type: 'call', title: 'Mine', occurred_at: '2026-10-21T11:00:00Z', project_id: PROJECT, contact_ids: [CONTACT],
    });
    await env.USAGE.prepare("UPDATE interactions SET is_personal = 1, owner_email = ?2 WHERE id = ?1").bind(hidden.id, HOST).run();
    expect((await fetchCrmInteractions(onD1, { projectId: PROJECT })).map((row) => row.id)).toEqual([shown.id]);
    expect((await fetchCrmContactDetail(onD1, HOST, CONTACT)).interactions.map((row) => row.id)).toEqual([shown.id]);
    expect((await rejection(updateCrmInteraction(onD1, HOST, hidden.id, { title: 'x' }))).status).toBe(404);
  });

  it('answers 503 records_moving while the group is frozen', async () => {
    await env.USAGE.prepare("INSERT INTO work_group_moves (work_group, frozen, updated_at) VALUES ('interactions', 1, 1)").run();
    const refused = await rejection(createCrmInteraction(onD1, HOST, {
      type: 'note', title: 'x', occurred_at: '2026-10-21T10:00:00Z', project_id: PROJECT, contact_ids: [],
    }));
    expect(refused.code).toBe('records_moving');
  });
});

describe('the meeting log and the Granola ledger on D1 (meet#1204)', () => {
  it('lists Granola rows with their filing, files a note as personal, and links an event', async () => {
    await postMeetingLog(onD1, meetingLog({
      source: 'granola', meeting_id: 'not_1', room_slug: null, meeting_kind: 'project', project_id: PROJECT,
      participants: [{ identity: 'ana', name: 'Ana', email: 'ana@acme.test', role: 'guest', booking_token: null }],
    }));
    await postMeetingLog(onD1, meetingLog({ source: 'granola', meeting_id: 'not_2', room_slug: null, meeting_kind: 'uncategorized' }));
    const ledger = await fetchGranolaLedger(onD1);
    expect(ledger.map((row) => [row.granola_note_id, row.meeting_kind, row.subject_title]).sort()).toEqual([
      ['not_1', 'project', 'Radar'], ['not_2', 'uncategorized', null],
    ]);
    expect(await one("SELECT channel, status FROM interactions WHERE external_id = 'not_1'")).toEqual({ channel: 'granola', status: 'logged' });
    expect((await fetchGranolaLedger(onD1, 'not_1'))[0]).toMatchObject({ project_id: PROJECT, contacts: [{ id: CONTACT }] });

    // Personal: the owner's row, a title and a date, no notes, no people, no filing; only the note's own lookup sees it.
    await postMeetingLog(onD1, meetingLog({
      source: 'granola', meeting_id: 'not_1', room_slug: null, meeting_kind: 'personal', summary_markdown: null, participants: [],
    }));
    expect(await one("SELECT is_personal, owner_email, summary_markdown, organization_id FROM interactions WHERE external_id = 'not_1'"))
      .toEqual({ is_personal: 1, owner_email: HOST, summary_markdown: null, organization_id: null });
    expect(await one("SELECT COUNT(*) AS n FROM interaction_contacts")).toEqual({ n: 0 });
    expect((await fetchGranolaLedger(onD1)).map((row) => row.granola_note_id)).toEqual(['not_2']);
    expect((await fetchGranolaLedger(onD1, 'not_1')).map((row) => row.meeting_kind)).toEqual(['personal']);
    expect(await fetchCrmInteractions(onD1, { projectId: PROJECT })).toEqual([]);

    const EVENT = 'e0000000-0000-4000-8000-0000000000e9';
    await postMeetingLog(onD1, meetingLog({ source: 'granola', meeting_id: 'not_2', room_slug: null, meeting_kind: 'event', event_id: EVENT }));
    expect((await fetchGranolaLedger(onD1, 'not_2'))[0]).toMatchObject({ event_id: EVENT, meeting_kind: 'event' });
    expect(calls).toEqual([]);
  });

  it('gives an unfiled call the organization its contacts share', async () => {
    await postMeetingLog(onD1, meetingLog({
      participants: [{ identity: 'ana', name: 'Ana', email: 'ana@acme.test', role: 'guest', booking_token: null }],
    }));
    expect((await fetchCrmInteractions(onD1, { organizationId: ORG })).map((row) => row.title)).toEqual(['Kickoff']);
  });
});

describe('the booking interaction on D1 (meet#1204)', () => {
  const booking = {
    token: 'join-token-0001', booking_id: 'b-1', title: 'Bo and Rosa', start_time: '2026-10-25T09:00:00.000Z',
    end_time: '2026-10-25T09:30:00.000Z', google_event_id: 'g-1',
    guest: { name: 'Bo', email: 'bo@newco.test', title: 'CEO', organization: 'Newco', notes: null }, nda_required: true,
  };

  it('files the booking with a new contact on a new organization, moves it, merges the call into it and cancels it', async () => {
    await fileBookingInteraction(onD1, { email: HOST }, booking);
    await fileBookingInteraction(onD1, { email: HOST }, booking);
    const rows = await all("SELECT id, title, source, channel, status, external_id, occurred_at, tags FROM interactions WHERE source = 'calendar_booking'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Bo and Rosa', channel: 'calendar', status: 'scheduled', external_id: 'join-token-0001',
      occurred_at: Date.parse(booking.start_time), tags: '["calendar-booking","meeting"]',
    });
    const id = String(rows[0]!.id);
    const contact = await one("SELECT c.id, c.name, o.name AS organization FROM contacts c JOIN organizations o ON o.id = c.organization_id WHERE c.email = 'bo@newco.test'");
    expect(contact).toMatchObject({ name: 'Bo', organization: 'Newco' });
    expect(await all('SELECT contact_id FROM interaction_contacts WHERE interaction_id = ?1', id)).toEqual([{ contact_id: contact!.id }]);
    expect(await one("SELECT event_type, dedupe_key, source_record_id FROM contact_source_events WHERE contact_id = ?1 AND event_type = 'meeting_booked'", contact!.id))
      .toEqual({ event_type: 'meeting_booked', dedupe_key: 'calendar_booking:b-1', source_record_id: id });

    await changeBookingInteraction(onD1, { email: HOST }, 'join-token-0001', {
      action: 'moved', start_time: '2026-10-26T09:00:00.000Z', end_time: '2026-10-26T10:00:00.000Z', new_token: 'join-token-0002',
    });
    const moved = await one("SELECT external_id, occurred_at, json_extract(metadata, '$.cancellation_token') AS token, json_extract(metadata, '$.meeting_duration_minutes') AS minutes FROM interactions WHERE id = ?1", id);
    expect(moved).toEqual({ external_id: 'join-token-0002', occurred_at: Date.parse('2026-10-26T09:00:00.000Z'), token: 'join-token-0002', minutes: 60 });

    // The call on the booking's link writes into the booking's row, which keeps its source and its token.
    await postMeetingLog(onD1, meetingLog({
      meeting_id: 'mtg-booked', booking_token: 'join-token-0002', title: 'Bo and Rosa, intro', meeting_kind: 'uncategorized',
      participants: [{ identity: 'bo', name: 'Bo', email: 'bo@newco.test', role: 'guest', booking_token: 'join-token-0002' }],
    }));
    expect(await one("SELECT COUNT(*) AS n FROM interactions")).toEqual({ n: 1 });
    expect(await one("SELECT source, external_id, title, status, summary_markdown, json_extract(metadata, '$.meeting_id') AS meeting FROM interactions WHERE id = ?1", id))
      .toEqual({ source: 'calendar_booking', external_id: 'join-token-0002', title: 'Bo and Rosa, intro', status: 'logged', summary_markdown: '## Notes', meeting: 'mtg-booked' });
    // A redelivery finds the same row by the meeting id it left there.
    await postMeetingLog(onD1, meetingLog({ meeting_id: 'mtg-booked', title: 'Bo and Rosa, intro', meeting_kind: 'uncategorized' }));
    expect(await one("SELECT COUNT(*) AS n FROM interactions")).toEqual({ n: 1 });

    await changeBookingInteraction(onD1, { email: HOST }, 'join-token-0002', { action: 'cancelled' });
    expect(await one("SELECT status, json_extract(metadata, '$.status') AS status_in_metadata FROM interactions WHERE id = ?1", id))
      .toEqual({ status: 'cancelled', status_in_metadata: 'cancelled' });
    expect(calls).toEqual([]);
  });

  it('files the booking on the contact that holds the address already', async () => {
    await fileBookingInteraction(onD1, { email: HOST }, { ...booking, guest: { ...booking.guest, email: 'ana@acme.test' } });
    expect(await one('SELECT COUNT(*) AS n FROM contacts')).toEqual({ n: 1 });
    expect(await one("SELECT name FROM organizations WHERE name = 'Newco'")).toBeNull();
    expect(await one('SELECT contact_id FROM interaction_contacts')).toEqual({ contact_id: CONTACT });
  });
});
