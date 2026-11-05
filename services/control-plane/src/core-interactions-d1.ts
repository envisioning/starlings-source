// Fold group 4 in Core's names. After the
// `interactions` group moves to D1, every interaction write lands here:
//
// - a member's call, meeting or note logged by hand on a subject's History
//   (`createCrmInteraction`, crm.ts), in Core's names as Core's agent route
//   writes it;
// - Core's own interaction writers (the NDA, pricing-request, lead and Luma
//   intake rows, the offer emails, the Signals demo debrief), through
//   `/api/internal/core-writes`;
// - the booking interaction (`fileBookingInteraction`).
//
// The meeting log and the Granola bridge write through `d1WriteMeetingLog`
// (work-d1.ts), which keeps its own upsert by source and external id.
//
// D1 keeps Core's singular filing columns (`lead_id`, `project_id`,
// `event_id`) as `interaction_subjects` rows with source `mirror`, and rebuilds
// them on every write that names one, as Core's filing trigger does. A row
// goes out in Core's names: ISO times, `tags` a list, `metadata` an object.

import type {
  CoreInteractionValues,
  CoreInteractionWriteRequest,
  CorePartnerSignatureWriteRequest,
} from '@starlings/contracts/core-writes';
import type { CoreReadRequest } from '@starlings/contracts/core-reads';
import { ControlError } from './errors';
import { personIdForEmail } from './person-ids';
import { recordWorkActivity } from './work-activity';
import { contactIdForEmail, d1CreateContact, d1CreateOrganization } from './work-d1';
import { assertGroupWritable } from './work-freeze';

type Row = Record<string, string | number | null>;
type CoreRow = Record<string, unknown>;

const isoOf = (value: string | number | null | undefined): string | null =>
  typeof value === 'number' ? new Date(value).toISOString() : null;

function parsed(value: string | number | null | undefined): unknown {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

const objectOf = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** Core's text columns that D1 keeps under the same name. */
const TEXT_COLUMNS = [
  'title', 'type', 'description', 'summary_markdown', 'source', 'channel', 'status', 'url', 'external_id',
  'transcript_url', 'transcript_preview', 'organization_id', 'contact_id', 'signals_account_id',
  'signals_evaluation_id', 'gmail_email_id', 'interaction_kind', 'owner_email',
] as const satisfies readonly (keyof CoreInteractionValues)[];

/** The filing columns, in Core's trigger precedence: the narrowest subject first. */
const FILING = [['lead', 'lead_id'], ['project', 'project_id'], ['event', 'event_id']] as const;

/** One interaction in Core's names, filing and contacts included. Null when none has the id. */
export async function coreInteractionRow(env: Env, id: string): Promise<CoreRow | null> {
  const row = await env.USAGE.prepare('SELECT * FROM interactions WHERE id = ?1').bind(id).first<Row>();
  if (!row) return null;
  return (await withFilingAndContacts(env, [row]))[0]!;
}

async function withFilingAndContacts(env: Env, rows: Row[]): Promise<CoreRow[]> {
  if (rows.length === 0) return [];
  const ids = JSON.stringify(rows.map((row) => row.id));
  const [subjects, contacts] = await env.USAGE.batch<Row>([
    env.USAGE.prepare(
      `SELECT interaction_id, subject_kind, subject_id FROM interaction_subjects
        WHERE interaction_id IN (SELECT value FROM json_each(?1)) ORDER BY is_primary DESC, source = 'mirror' DESC`,
    ).bind(ids),
    env.USAGE.prepare(
      `SELECT ic.interaction_id, c.id, c.name, c.email FROM interaction_contacts ic JOIN contacts c ON c.id = ic.contact_id
        WHERE ic.interaction_id IN (SELECT value FROM json_each(?1))
       UNION
       SELECT i.id, c.id, c.name, c.email FROM interactions i JOIN contacts c ON c.id = i.contact_id
        WHERE i.id IN (SELECT value FROM json_each(?1))
       ORDER BY 3, 2`,
    ).bind(ids),
  ]);
  return rows.map((row) => {
    const filing = (kind: string) => (subjects?.results ?? []).find((link) => link.interaction_id === row.id && link.subject_kind === kind)?.subject_id ?? null;
    const people = (contacts?.results ?? []).filter((link) => link.interaction_id === row.id)
      .map((link) => ({ id: link.id, name: link.name, email: link.email }));
    const tags = parsed(row.tags);
    return {
      id: row.id,
      title: row.title,
      type: row.type,
      description: row.description,
      summary_markdown: row.summary_markdown,
      occurred_at: isoOf(row.occurred_at),
      source: row.source,
      channel: row.channel,
      status: row.status,
      url: row.url,
      // A row Core never gave an external id keeps its own id there in D1.
      external_id: row.external_id === row.id ? null : row.external_id,
      metadata: row.metadata === null ? null : parsed(row.metadata),
      tags: Array.isArray(tags) ? tags : [],
      transcript_url: row.transcript_url,
      transcript_preview: row.transcript_preview,
      lead_id: filing('lead'),
      project_id: filing('project'),
      event_id: filing('event'),
      organization_id: row.organization_id ?? filing('organization'),
      contact_id: row.contact_id,
      signals_account_id: row.signals_account_id,
      signals_evaluation_id: row.signals_evaluation_id,
      gmail_email_id: row.gmail_email_id,
      support_case_id: row.support_case_id,
      interaction_kind: row.interaction_kind,
      is_personal: row.is_personal === 1,
      owner_email: row.owner_email,
      created_by: row.host_person_id,
      created_at: isoOf(row.created_at),
      updated_at: isoOf(row.updated_at),
      contacts: people,
      contact_ids: people.map((person) => person.id),
    };
  });
}

type InteractionsRead = Extract<CoreReadRequest, { op: 'interactions' }>;

/** `interactions`: newest first, by every filter sent. A personal row is never listed. */
export async function coreInteractionRows(env: Env, read: InteractionsRead): Promise<CoreRow[]> {
  const where = ['i.is_personal = 0'];
  const binds: unknown[] = [];
  const filed = (kind: string, id: string) => {
    where.push(`EXISTS (SELECT 1 FROM interaction_subjects s WHERE s.interaction_id = i.id AND s.subject_kind = ? AND s.subject_id = ?)`);
    binds.push(kind, id);
  };
  if (read.project_id) filed('project', read.project_id);
  if (read.lead_id) filed('lead', read.lead_id);
  if (read.organization_id) { where.push('i.organization_id = ?'); binds.push(read.organization_id); }
  if (read.signals_account_ids) {
    where.push('i.signals_account_id IN (SELECT value FROM json_each(?))');
    binds.push(JSON.stringify(read.signals_account_ids));
  }
  if (read.interaction_kind) { where.push('i.interaction_kind = ?'); binds.push(read.interaction_kind); }
  if (read.type) { where.push('i.type = ?'); binds.push(read.type); }
  for (const [key, value] of Object.entries(read.metadata ?? {})) {
    // A boolean is stored as JSON true or false, which json_extract reads as 1 or 0.
    where.push(`json_extract(i.metadata, '$.${key}') = ?`);
    binds.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  const { results } = await env.USAGE.prepare(
    `SELECT i.* FROM interactions i WHERE ${where.join(' AND ')} ORDER BY i.occurred_at DESC, i.id LIMIT ?`,
  ).bind(...binds, read.limit).all<Row>();
  return withFilingAndContacts(env, results);
}

/** A row a write links to, checked before the write: D1 refuses it as a 500 otherwise. */
async function assertRow(env: Env, table: 'organizations' | 'contacts' | 'leads' | 'projects', id: string | null | undefined): Promise<void> {
  if (!id) return;
  const row = await env.USAGE.prepare(`SELECT 1 FROM ${table} WHERE id = ?1`).bind(id).first();
  if (!row) throw new ControlError(`No ${table.replace(/s$/u, '')} with id ${id} on this workspace.`, 400, 'invalid_request');
}

/** What one write changed: the row before and after, in Core's names, for the caches and the trail. */
export interface InteractionWriteResult {
  id: string;
  before: CoreRow | null;
  after: CoreRow | null;
}

/**
 * One interaction write in Core's names, into D1. `contactIds` replaces the
 * row's `interaction_contacts` when sent. Null for an update or delete that
 * matched no row. `id` presets a new row's id, for a writer that names the
 * row elsewhere in the same act (the booking's source fact).
 */
export async function writeD1Interaction(
  env: Env,
  actor: string,
  write: CoreInteractionWriteRequest,
  options: { id?: string } = {},
): Promise<InteractionWriteResult | null> {
  await assertGroupWritable(env, 'interactions');
  const now = Date.now();
  if (write.action === 'delete') {
    const before = await coreInteractionRow(env, write.id);
    if (!before) return null;
    await env.USAGE.batch([
      env.USAGE.prepare('DELETE FROM interaction_subjects WHERE interaction_id = ?1').bind(write.id),
      env.USAGE.prepare('DELETE FROM interaction_contacts WHERE interaction_id = ?1').bind(write.id),
      env.USAGE.prepare('DELETE FROM interactions WHERE id = ?1').bind(write.id),
    ]);
    await recordWorkActivity(env, { actor, table: 'interactions', id: write.id, action: 'delete', label: String(before.title ?? '') });
    return { id: write.id, before, after: null };
  }

  const values = write.values;
  await assertRow(env, 'organizations', values.organization_id);
  await assertRow(env, 'contacts', values.contact_id);
  await assertRow(env, 'leads', values.lead_id);
  await assertRow(env, 'projects', values.project_id);
  for (const contactId of write.contact_ids ?? []) await assertRow(env, 'contacts', contactId);

  const before = write.action === 'update' ? await coreInteractionRow(env, write.id) : null;
  if (write.action === 'update' && !before) return null;
  const id = write.action === 'update' ? write.id : (options.id ?? crypto.randomUUID());

  const cells: Record<string, string | number | null> = {};
  for (const column of TEXT_COLUMNS) {
    const value = values[column];
    if (value !== undefined) cells[column] = value === null ? null : String(value);
  }
  if (values.occurred_at !== undefined) cells.occurred_at = values.occurred_at === null ? now : Date.parse(values.occurred_at);
  if (values.tags !== undefined) cells.tags = values.tags.length > 0 ? JSON.stringify(values.tags) : null;
  if (values.metadata !== undefined) {
    const metadata = values.metadata ?? {};
    cells.metadata = values.metadata === null ? null : JSON.stringify(metadata);
    // The meeting log's filing kind and transcript, which Core keeps in metadata.
    cells.meeting_kind = typeof metadata.meeting_kind === 'string' ? metadata.meeting_kind : null;
    cells.transcript_document_id = typeof metadata.transcript_document_id === 'string' ? metadata.transcript_document_id : null;
  }
  if (values.is_personal !== undefined) cells.is_personal = values.is_personal ? 1 : 0;
  if (values.created_by !== undefined) cells.host_person_id = values.created_by;
  cells.updated_at = now;

  const statements: D1PreparedStatement[] = [];
  if (write.action === 'create') {
    const row: Record<string, string | number | null> = {
      source: 'manual', channel: 'manual', status: 'logged', occurred_at: now, ...cells,
      id, external_id: cells.external_id ?? id, created_at: now,
    };
    if (row.host_person_id === undefined) row.host_person_id = await personIdForEmail(env, actor);
    const columns = Object.keys(row);
    statements.push(env.USAGE.prepare(
      `INSERT INTO interactions (${columns.join(', ')}) VALUES (${columns.map((_, index) => `?${index + 1}`).join(', ')})`,
    ).bind(...columns.map((column) => row[column] ?? null)));
  } else {
    // An external id Core never set reads as null; D1 keeps the row's own id there.
    if ('external_id' in cells && cells.external_id === null) cells.external_id = id;
    const columns = Object.keys(cells);
    statements.push(env.USAGE.prepare(`UPDATE interactions SET ${columns.map((column, index) => `${column} = ?${index + 2}`).join(', ')} WHERE id = ?1`)
      .bind(id, ...columns.map((column) => cells[column] ?? null)));
  }

  // Core's filing trigger: the singular filing columns as trigger links, rebuilt on any write that names one.
  const names = (key: string) => key in values;
  if (write.action === 'create' || FILING.some(([, key]) => names(key)) || names('organization_id') || names('metadata')) {
    const filing = new Map<string, string>();
    for (const [kind, key] of FILING) {
      const value = names(key) ? values[key] : (before?.[key] as string | null | undefined);
      if (value) filing.set(kind, value);
    }
    const metadata = names('metadata') ? objectOf(values.metadata) : objectOf(before?.metadata);
    const organization = names('organization_id') ? values.organization_id : (before?.organization_id as string | null | undefined);
    if (metadata.meeting_kind === 'partner' && organization) filing.set('organization', organization);
    statements.push(env.USAGE.prepare("DELETE FROM interaction_subjects WHERE interaction_id = ?1 AND source = 'mirror'").bind(id));
    const filedPrimary = await env.USAGE.prepare("SELECT 1 FROM interaction_subjects WHERE interaction_id = ?1 AND source <> 'mirror' AND is_primary = 1")
      .bind(id).first();
    let primary = !filedPrimary;
    const createdBy = (cells.host_person_id ?? before?.created_by ?? null) as string | null;
    for (const kind of ['lead', 'project', 'event', 'organization']) {
      const subjectId = filing.get(kind);
      if (!subjectId) continue;
      // A link a person or a connector made outranks the trigger's and stays as it is.
      statements.push(env.USAGE.prepare(
        `INSERT OR IGNORE INTO interaction_subjects (interaction_id, subject_kind, subject_id, is_primary, source, created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, 'mirror', ?5, ?6)`,
      ).bind(id, kind, subjectId, primary ? 1 : 0, now, createdBy));
      primary = false;
    }
  }
  if (write.contact_ids !== undefined) {
    if (write.action === 'update') statements.push(env.USAGE.prepare('DELETE FROM interaction_contacts WHERE interaction_id = ?1').bind(id));
    for (const contactId of new Set(write.contact_ids)) {
      statements.push(env.USAGE.prepare('INSERT OR IGNORE INTO interaction_contacts (interaction_id, contact_id, created_at) VALUES (?1, ?2, ?3)')
        .bind(id, contactId, now));
    }
  }
  await env.USAGE.batch(statements);
  const after = await coreInteractionRow(env, id);
  await recordWorkActivity(env, {
    actor, table: 'interactions', id, action: write.action === 'create' ? 'insert' : 'update',
    label: String(after?.title ?? ''), fields: [...Object.keys(values), ...(write.contact_ids !== undefined ? ['contact_ids'] : [])].sort(),
  });
  return { id, before, after };
}

/** A partner agreement signature in Core's names. */
function signatureOf(row: Row): CoreRow {
  return {
    id: row.id,
    agreement_id: row.agreement_id,
    contact_id: row.contact_id,
    signer_name: row.signer_name,
    signer_email: row.signer_email,
    signing_for: row.signing_for,
    organization_name: row.organization_name,
    signed_at: isoOf(row.signed_at),
    metadata: objectOf(parsed(row.metadata)),
    created_at: isoOf(row.created_at),
    updated_at: isoOf(row.updated_at),
  };
}

export async function corePartnerSignature(env: Env, agreementId: string, contactId: string): Promise<CoreRow | null> {
  const row = await env.USAGE.prepare('SELECT * FROM partner_agreement_signatures WHERE agreement_id = ?1 AND contact_id = ?2')
    .bind(agreementId, contactId).first<Row>();
  return row ? signatureOf(row) : null;
}

/** One signature, by agreement and contact: a second signature replaces the first, as Core's upsert does. */
export async function upsertD1PartnerSignature(env: Env, write: CorePartnerSignatureWriteRequest): Promise<CoreRow> {
  await assertGroupWritable(env, 'interactions');
  const values = write.values;
  await assertRow(env, 'contacts', values.contact_id);
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO partner_agreement_signatures
       (id, agreement_id, contact_id, signer_name, signer_email, signing_for, organization_name, signed_at, metadata, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
     ON CONFLICT (agreement_id, contact_id) DO UPDATE SET
       signer_name = excluded.signer_name, signer_email = excluded.signer_email, signing_for = excluded.signing_for,
       organization_name = excluded.organization_name, signed_at = excluded.signed_at, metadata = excluded.metadata,
       updated_at = excluded.updated_at`,
  ).bind(
    crypto.randomUUID(), values.agreement_id, values.contact_id, values.signer_name, values.signer_email, values.signing_for,
    values.organization_name, Date.parse(values.signed_at), JSON.stringify(values.metadata), now,
  ).run();
  const row = await corePartnerSignature(env, values.agreement_id, values.contact_id);
  if (!row) throw new ControlError('The signature was not saved.', 500);
  return row;
}

// ── The booking interaction ────────────────────────────────────
// A booking Starlings' booking page took files its CRM interaction here once
// the `interactions` group is on D1, as Core's `saveBookingAsInteraction`
// filed it: the guest's contact found by address or made (with the
// organization they named), a `meeting_booked` source fact, and the row keyed
// by the booking's join token, so a call on that link merges into it
// (`d1WriteMeetingLog`). The token is the row's `external_id` and, as on
// Core's rows, `metadata.cancellation_token`.

export interface BookingInteraction {
  token: string;
  booking_id: string;
  title: string;
  start_time: string;
  end_time: string;
  google_event_id: string | null;
  guest: { name: string; email: string; title: string; organization: string; notes: string | null };
  nda_required: boolean;
}

export type BookingInteractionChange =
  | { action: 'moved'; start_time: string; end_time: string; new_token?: string }
  | { action: 'cancelled' };

const BOOKING_SOURCE = 'calendar_booking';
const BOOKING_CONTACT_SOURCE = 'website_meeting';

/** The booking interaction a token names, or null: by its own key, or by the token a copied Core row keeps in metadata. */
async function bookingInteractionId(env: Env, token: string): Promise<string | null> {
  const row = await env.USAGE.prepare(
    `SELECT id FROM interactions WHERE source = ?1 AND (external_id = ?2 OR json_extract(metadata, '$.cancellation_token') = ?2)
      ORDER BY occurred_at DESC LIMIT 1`,
  ).bind(BOOKING_SOURCE, token).first<{ id: string }>();
  return row?.id ?? null;
}

const minutesBetween = (start: string, end: string) => Math.round((Date.parse(end) - Date.parse(start)) / 60_000);

/** Core's description of a booking, line for line, so a booking reads the same in either store. */
function bookingDescription(booking: BookingInteraction): string {
  return [
    'Scheduled meeting via calendar booking system.',
    '',
    'Guest Details:',
    `- Name: ${booking.guest.name}`,
    `- Email: ${booking.guest.email}`,
    ...(booking.guest.title ? [`- Title: ${booking.guest.title}`] : []),
    ...(booking.guest.organization ? [`- Organization: ${booking.guest.organization}`] : []),
    ...(booking.guest.notes ? [`- Notes: ${booking.guest.notes}`] : []),
    '',
    'Meeting Details:',
    `- Title: ${booking.title}`,
    `- Booking ID: ${booking.booking_id}`,
    `- Start: ${new Date(booking.start_time).toISOString()}`,
    `- End: ${new Date(booking.end_time).toISOString()}`,
    ...(booking.google_event_id ? [`- Google Event ID: ${booking.google_event_id}`] : []),
    `- NDA: ${booking.nda_required ? 'Required' : 'Not required'}`,
    '',
    `Cancellation Token: ${booking.token}`,
  ].join('\n');
}

/** The guest's contact: the one with the address, else a new one on the organization they named. */
async function bookingContact(env: Env, host: string, booking: BookingInteraction, interactionId: string): Promise<string> {
  const known = await env.USAGE.prepare('SELECT is_active FROM contact_source_definitions WHERE key = ?1')
    .bind(BOOKING_CONTACT_SOURCE).first<{ is_active: number }>();
  const fact = {
    eventType: 'meeting_booked' as const,
    sourceKey: known?.is_active === 1 ? BOOKING_CONTACT_SOURCE : 'crm_manual',
    dedupeKey: `calendar_booking:${booking.booking_id}`,
    sourceRecordType: 'interactions',
    sourceRecordId: interactionId,
  };
  const existing = await contactIdForEmail(env, booking.guest.email);
  const organization = !existing && booking.guest.organization.trim()
    ? (await d1CreateOrganization(env, host, booking.guest.organization)).id
    : null;
  const contact = await d1CreateContact(env, {
    organization_id: organization,
    name: booking.guest.name,
    email: booking.guest.email,
    title: booking.guest.title.trim() || null,
  }, fact, host);
  return contact.id;
}

/** `fileBookingInteraction` on D1. Idempotent per token. */
export async function d1FileBookingInteraction(env: Env, host: { email: string }, booking: BookingInteraction): Promise<void> {
  if (await bookingInteractionId(env, booking.token)) return;
  const id = crypto.randomUUID();
  const contactId = await bookingContact(env, host.email, booking, id);
  await writeD1Interaction(env, host.email, {
    action: 'create',
    entity: 'interactions',
    values: {
      title: booking.title,
      type: 'meeting',
      description: bookingDescription(booking),
      occurred_at: new Date(booking.start_time).toISOString(),
      source: BOOKING_SOURCE,
      channel: 'calendar',
      status: 'scheduled',
      external_id: booking.token,
      tags: ['calendar-booking', 'meeting'],
      metadata: {
        booking_type: 'calendar_booking',
        guest_email: booking.guest.email,
        guest_name: booking.guest.name,
        guest_title: booking.guest.title || null,
        guest_organization: booking.guest.organization || null,
        guest_notes: booking.guest.notes,
        google_event_id: booking.google_event_id,
        cancellation_token: booking.token,
        meeting_duration_minutes: minutesBetween(booking.start_time, booking.end_time),
        requires_nda: booking.nda_required,
        nda_status: booking.nda_required ? 'required' : 'not_required',
        nda_accepted_at: null,
        booking_id: booking.booking_id,
      },
    },
    contact_ids: [contactId],
  }, { id });
}

/** `changeBookingInteraction` on D1: a move follows the new token, a cancel marks the row. Nothing when no row has the token. */
export async function d1ChangeBookingInteraction(env: Env, host: { email: string }, token: string, change: BookingInteractionChange): Promise<void> {
  const id = await bookingInteractionId(env, token);
  if (!id) return;
  const row = await coreInteractionRow(env, id);
  if (!row) return;
  const metadata = objectOf(row.metadata) as NonNullable<CoreInteractionValues['metadata']>;
  const description = typeof row.description === 'string' ? row.description : '';
  const now = new Date().toISOString();
  const values: CoreInteractionValues = change.action === 'moved'
    ? {
      occurred_at: new Date(change.start_time).toISOString(),
      description: `${description}\n\n[RESCHEDULED] Meeting rescheduled to ${new Date(change.start_time).toISOString()}.`,
      metadata: {
        ...metadata,
        ...(change.new_token ? { cancellation_token: change.new_token } : {}),
        rescheduled_at: now,
        meeting_duration_minutes: minutesBetween(change.start_time, change.end_time),
      },
      ...(change.new_token ? { external_id: change.new_token } : {}),
    }
    : {
      status: 'cancelled',
      description: `${description}\n\n[CANCELLED] This meeting was cancelled by the guest.`,
      metadata: { ...metadata, status: 'cancelled', cancelled_at: now },
    };
  await writeD1Interaction(env, host.email, { action: 'update', entity: 'interactions', id, values });
}
