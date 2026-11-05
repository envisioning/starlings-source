// The settings tables of the subjects group on D1 (migration 0132):
// the characteristics vocabulary and contact sources. Currencies and rates
// stay in Core until the commercial group moves.
//
// Admin › Records reads and edits them (`/api/admin/records`). They live in
// D1 once the subjects group answers from D1; until then Core holds them, so
// the read answers `editable: false` and every write is refused. A write
// checks the group's freeze first, as every subjects write does.
//
// The contact write path records where a contact came from here
// (`contactSourceStatement`), as Core's `recordContactSourceEvent` does.

import type {
  CharacteristicKind,
  ContactSourceDefinition,
  SubjectSettingsResponse,
  SubjectSettingsWrite,
} from '@starlings/contracts/subject-settings';
import { ControlError } from './errors';
import { assertGroupWritable } from './work-freeze';
import { usesCoreFor } from './work-store';

/** Who a contact came from when the writer names no source. */
export const DEFAULT_CONTACT_SOURCE = 'crm_manual';

const CHARACTERISTIC_TABLE: Record<CharacteristicKind, { config: string; records: string }> = {
  lead: { config: 'lead_characteristics_config', records: 'leads' },
  contact: { config: 'contact_characteristics_config', records: 'contacts' },
};

const iso = (millis: number | null | undefined) => (typeof millis === 'number' && millis > 0 ? new Date(millis).toISOString() : null);

interface SourceRow {
  key: string;
  label: string;
  category: ContactSourceDefinition['category'];
  description: string | null;
  is_active: number;
  manual_selectable: number;
  import_selectable: number;
  is_system: number;
  sort_order: number;
}

const EMPTY: Omit<SubjectSettingsResponse, 'editable'> = {
  lead_characteristics: [],
  contact_characteristics: [],
  contact_sources: [],
};

/** `GET /api/admin/records`. */
export async function readSubjectSettings(env: Env): Promise<SubjectSettingsResponse> {
  if (usesCoreFor(env, 'subjects')) return { editable: false, ...EMPTY };
  const [lead, contact, sources] = await env.USAGE.batch([
    env.USAGE.prepare('SELECT id, name, created_at FROM lead_characteristics_config ORDER BY name'),
    env.USAGE.prepare('SELECT id, name, created_at FROM contact_characteristics_config ORDER BY name'),
    env.USAGE.prepare(`SELECT key, label, category, description, is_active, manual_selectable, import_selectable, is_system, sort_order
                         FROM contact_source_definitions ORDER BY sort_order, label COLLATE NOCASE`),
  ]);
  const characteristic = (row: { id: string; name: string; created_at: number }) => ({ id: row.id, name: row.name, created_at: iso(row.created_at) });
  return {
    editable: true,
    lead_characteristics: (lead!.results as Array<{ id: string; name: string; created_at: number }>).map(characteristic),
    contact_characteristics: (contact!.results as Array<{ id: string; name: string; created_at: number }>).map(characteristic),
    contact_sources: (sources!.results as unknown as SourceRow[]).map((row) => ({
      key: row.key,
      label: row.label,
      category: row.category,
      description: row.description,
      is_active: row.is_active === 1,
      manual_selectable: row.manual_selectable === 1,
      import_selectable: row.import_selectable === 1,
      is_system: row.is_system === 1,
      sort_order: row.sort_order,
    })),
  };
}

async function assertEditable(env: Env): Promise<void> {
  if (usesCoreFor(env, 'subjects')) {
    throw new ControlError('Core holds these settings until the subjects group moves to Starlings.', 409, 'invalid_request');
  }
  await assertGroupWritable(env, 'subjects');
}

/** A JSON path to one key of a `characteristics` object. The name schema allows only [a-z0-9_]. */
const flagPath = (name: string) => `$."${name}"`;

/** `POST /api/admin/records`: one change, then the whole page again. */
export async function writeSubjectSettings(env: Env, write: SubjectSettingsWrite, now = Date.now()): Promise<SubjectSettingsResponse> {
  await assertEditable(env);
  try {
    switch (write.op) {
      case 'characteristic.save': await saveCharacteristic(env, write.kind, write.id, write.name, now); break;
      case 'characteristic.delete': {
        // A record keeps its flag; only the vocabulary loses the name, as in Core.
        await env.USAGE.prepare(`DELETE FROM ${CHARACTERISTIC_TABLE[write.kind].config} WHERE id = ?1`).bind(write.id).run();
        break;
      }
      case 'source.save': await saveSource(env, write, now); break;
    }
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) {
      throw new ControlError('That name is in the list already.', 409, 'invalid_request');
    }
    throw error;
  }
  return readSubjectSettings(env);
}

/**
 * Add a characteristic, or rename one. A rename moves the flag on every lead
 * or contact that has it, in the same batch, so no record loses its value.
 */
async function saveCharacteristic(env: Env, kind: CharacteristicKind, id: string | undefined, name: string, now: number): Promise<void> {
  const { config, records } = CHARACTERISTIC_TABLE[kind];
  if (!id) {
    await env.USAGE.prepare(`INSERT INTO ${config} (id, name, created_at) VALUES (?1, ?2, ?3)`).bind(crypto.randomUUID(), name, now).run();
    return;
  }
  const before = await env.USAGE.prepare(`SELECT name FROM ${config} WHERE id = ?1`).bind(id).first<{ name: string }>();
  if (!before) throw new ControlError('No characteristic with that id.', 404);
  if (before.name === name) return;
  const statements = [env.USAGE.prepare(`UPDATE ${config} SET name = ?1 WHERE id = ?2`).bind(name, id)];
  // `json(… -> …)` keeps the flag a JSON boolean; json_extract would make it 1.
  // An old name outside the name rule cannot go in a JSON path safely; the vocabulary changes, the records keep it.
  if (/^[a-z0-9_]+$/u.test(before.name)) {
    statements.push(env.USAGE.prepare(
      `UPDATE ${records}
          SET characteristics = json_set(json_remove(characteristics, ?1), ?2, json(characteristics -> ?1))
        WHERE characteristics IS NOT NULL AND json_valid(characteristics) AND json_type(characteristics, ?1) IS NOT NULL`,
    ).bind(flagPath(before.name), flagPath(name)));
  }
  await env.USAGE.batch(statements);
}

async function saveSource(env: Env, write: Extract<SubjectSettingsWrite, { op: 'source.save' }>, now: number): Promise<void> {
  const existing = await env.USAGE.prepare('SELECT is_system, category FROM contact_source_definitions WHERE key = ?1')
    .bind(write.key).first<{ is_system: number; category: string }>();
  // A system source keeps its category: the Worker and Core's flows write it by key.
  const category = existing?.is_system === 1 ? existing.category : write.category;
  await env.USAGE.prepare(
    `INSERT INTO contact_source_definitions
       (key, label, category, description, is_active, manual_selectable, import_selectable, is_system, sort_order, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?9)
     ON CONFLICT (key) DO UPDATE SET label = excluded.label, category = excluded.category, description = excluded.description,
       is_active = excluded.is_active, manual_selectable = excluded.manual_selectable,
       import_selectable = excluded.import_selectable, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
  ).bind(write.key, write.label, category, write.description?.trim() || null, write.is_active ? 1 : 0,
    write.manual_selectable ? 1 : 0, write.import_selectable ? 1 : 0, write.sort_order, now).run();
}

// ── Where a contact came from ───────────────────────────────────────────────

export type ContactSourceEventType = 'created' | 'imported' | 'subscribed' | 'meeting_booked' | 'form_submitted' | 'event_registered' | 'inbound_contact' | 'document_viewed';

export interface ContactSourceFact {
  eventType: ContactSourceEventType;
  sourceKey: string;
  /** The fact's identity on the contact. Default: `origin:<source>` for a create, as Core writes it. */
  dedupeKey?: string;
  sourceRecordType?: string | null;
  sourceRecordId?: string | null;
  createdBy?: string | null;
  /** What the fact's reader shows. Stored with sorted keys; none is null. */
  metadata?: Record<string, unknown>;
}

/**
 * The source a contact write may name. A member names an active source an
 * admin marked selectable, or none (`crm_manual`). Core's own flows
 * (`anySource`) may name any active source: their sources are not offered to
 * a member.
 */
export async function resolveContactSource(env: Env, key: string | undefined, anySource = false): Promise<string> {
  if (!key || key === DEFAULT_CONTACT_SOURCE) return DEFAULT_CONTACT_SOURCE;
  const row = await env.USAGE.prepare('SELECT is_active, manual_selectable FROM contact_source_definitions WHERE key = ?1')
    .bind(key).first<{ is_active: number; manual_selectable: number }>();
  if (!row || row.is_active !== 1 || (!anySource && row.manual_selectable !== 1)) {
    throw new ControlError(`${key} is not a contact source you can choose.`, 400, 'invalid_request');
  }
  return key;
}

function metadataCell(metadata: Record<string, unknown> | undefined): string | null {
  const keys = Object.keys(metadata ?? {}).sort();
  return keys.length > 0 ? JSON.stringify(Object.fromEntries(keys.map((key) => [key, metadata![key]]))) : null;
}

/** One provenance fact, idempotent on (contact, dedupe key). Goes in the batch that writes the contact. */
export function contactSourceStatement(env: Env, contactId: string, fact: ContactSourceFact, now: number): D1PreparedStatement {
  const dedupe = (fact.dedupeKey ?? `origin:${fact.sourceKey}`).slice(0, 300);
  return env.USAGE.prepare(
    `INSERT OR IGNORE INTO contact_source_events
       (id, contact_id, event_type, source_key, occurred_at, source_record_type, source_record_id, created_by, dedupe_key, metadata, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?5)`,
  ).bind(crypto.randomUUID(), contactId, fact.eventType, fact.sourceKey, now, fact.sourceRecordType ?? null,
    fact.sourceRecordId ?? null, fact.createdBy ?? null, dedupe, metadataCell(fact.metadata));
}
