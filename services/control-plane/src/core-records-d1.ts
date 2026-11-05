// Core's record shape over D1. `/api/core/records/:entity` and
// `/api/core/fields/:entity/:id` answer a group that has moved to D1 from D1,
// in the shape Core's `/api/agent/*` answers: `{ data }`, Core's column
// names, ISO times and booleans. MCP `cms` and the web Fields pane then read
// one shape whichever store holds the record.
//
// Reads map a D1 row to Core's names. Writes go through the CRM helpers the
// Work routes use (`createCrmOrganization`, `createCrmContact`,
// `updateCrmSubject`, …), so there is one D1 write path per record. Every
// write checks the group's freeze first. A field D1 does not keep is refused,
// never dropped.
import { z } from 'zod';
import {
  crmContactCreateSchema,
  crmContactUpdateSchema,
  crmLeadUpdateSchema,
  crmOrganizationUpdateSchema,
  crmProjectUpdateSchema,
  crmSubjectCreateCommandSchema,
} from '@starlings/contracts';
import {
  CORE_RECORD_LIST_FILTERS,
  type CoreFieldsWriteBody,
  type CoreRecordEntity,
} from '@starlings/contracts/core-fields';
import {
  coreRecordGroup,
  createCrmContact,
  createCrmOrganization,
  createCrmSubject,
  deleteCrmOrganization,
  purgeRecordCaches,
  updateCrmContact,
  updateCrmOrganization,
  updateCrmSubject,
} from './crm';
import { jsonValueSchema, type JsonValue } from './contracts';
import { ControlError } from './errors';
import { coreInteractionValuesSchema } from '@starlings/contracts/core-writes';
import { writeD1Interaction } from './core-interactions-d1';
import { d1InteractionRecord, d1InteractionRecords } from './work-d1';
import { assertGroupWritable } from './work-freeze';

type Row = Record<string, string | number | null>;
type SubjectEntity = Exclude<CoreRecordEntity, 'interactions'>;

/** How one D1 table reads in Core's names: renamed columns, 0/1 flags, epoch-ms times, JSON text. */
interface RecordView {
  table: string;
  rename: Record<string, string>;
  flags: readonly string[];
  times: readonly string[];
  json: readonly string[];
  /** Searched by `q`. */
  label: string;
}

const VIEWS: Record<SubjectEntity, RecordView> = {
  organizations: {
    table: 'organizations',
    rename: { url: 'website' },
    flags: ['is_partner', 'is_agency', 'is_existing_client'],
    times: ['created_at', 'updated_at'],
    json: [],
    label: 'name',
  },
  contacts: {
    table: 'contacts',
    rename: { title: 'company_role' },
    flags: ['futurist', 'corporate', 'academic', 'independent', 'government', 'ngo', 'media', 'intelligence'],
    times: ['created_at', 'updated_at', 'signals_notified_at'],
    json: ['characteristics'],
    label: 'name',
  },
  leads: {
    table: 'leads',
    rename: {},
    flags: ['event_timeline', 'budget_availability', 'stakeholder_buy_in', 'previous_engagement', 'project_fit'],
    times: ['created_at', 'updated_at', 'responsible_set_at'],
    json: ['characteristics'],
    label: 'title',
  },
  projects: {
    table: 'projects',
    rename: { internal: 'is_internal' },
    flags: ['internal'],
    times: ['created_at', 'updated_at', 'responsible_set_at', 'last_viewed_at'],
    json: [],
    label: 'title',
  },
};

const parseJson = (value: string | number | null): unknown => {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

/** A D1 row in Core's column names and types. */
function recordOf(view: RecordView, row: Row): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    const name = view.rename[column] ?? column;
    if (view.flags.includes(column)) record[name] = value === 1;
    else if (view.times.includes(column)) record[name] = typeof value === 'number' ? new Date(value).toISOString() : null;
    else if (view.json.includes(column)) record[name] = parseJson(value);
    else record[name] = value;
  }
  return record;
}

const answer = (data: unknown): JsonValue => jsonValueSchema.parse({ data });

async function readRow(env: Env, entity: SubjectEntity, id: string): Promise<Record<string, unknown>> {
  const view = VIEWS[entity];
  const row = await env.USAGE.prepare(`SELECT * FROM ${view.table} WHERE id = ?1`).bind(id).first<Row>();
  if (!row) throw new ControlError(`No ${entity.replace(/s$/u, '')} with that id.`, 404);
  return recordOf(view, row);
}

const pageOf = (params: Record<string, string>) => ({
  limit: Math.max(1, Math.min(Number.parseInt(params.limit ?? '50', 10) || 50, 200)),
  offset: Math.max(0, Number.parseInt(params.offset ?? '0', 10) || 0),
});

/** `GET /api/core/records/:entity` on D1: Core's filters, `q` on the name or title, `limit` and `offset`. */
export async function listD1CoreRecords(env: Env, entity: CoreRecordEntity, params: Record<string, string>): Promise<JsonValue> {
  const { limit, offset } = pageOf(params);
  const q = params.q?.trim() ?? '';
  if (entity === 'interactions') {
    return answer(await d1InteractionRecords(env, {
      q, type: params.type, lead_id: params.lead_id, project_id: params.project_id,
      organization_id: params.organization_id, contact_id: params.contact_id,
    }, limit, offset));
  }
  const view = VIEWS[entity];
  const where: string[] = [];
  const binds: unknown[] = [];
  for (const filter of CORE_RECORD_LIST_FILTERS[entity] as readonly string[]) {
    const value = params[filter];
    if (value === undefined || filter === 'source_key') continue;
    where.push(`"${filter}" = ?`);
    binds.push(view.flags.includes(filter) ? (value === 'true' ? 1 : 0) : value);
  }
  // A contact's sources are facts in `contact_source_events`, as Core filters them.
  if (params.source_key !== undefined) {
    where.push('id IN (SELECT contact_id FROM contact_source_events WHERE source_key = ?)');
    binds.push(params.source_key);
  }
  if (q) {
    where.push(`${view.label} LIKE ? ESCAPE '\\'`);
    binds.push(`%${q.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`);
  }
  const { results } = await env.USAGE.prepare(
    `SELECT * FROM ${view.table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${view.label} COLLATE NOCASE, id LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all<Row>();
  return answer(results.map((row) => recordOf(view, row)));
}

/** Rows by id in Core's names, for Core's lists (`rows` in core-reads). A missing id is not in the answer. */
export async function d1CoreRowsById(env: Env, entity: SubjectEntity, ids: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const view = VIEWS[entity];
  const { results } = await env.USAGE.prepare(`SELECT * FROM ${view.table} WHERE id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(ids)).all<Row>();
  return results.map((row) => recordOf(view, row));
}

/** An organization's contacts, leads or projects in Core's names, sorted by name or title. */
export async function d1CoreRowsOfOrganization(
  env: Env,
  entity: 'contacts' | 'leads' | 'projects',
  organizationId: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const view = VIEWS[entity];
  const { results } = await env.USAGE.prepare(
    `SELECT * FROM ${view.table} WHERE organization_id = ?1 ORDER BY ${view.label} COLLATE NOCASE, id LIMIT ?2`,
  ).bind(organizationId, limit).all<Row>();
  return results.map((row) => recordOf(view, row));
}

/** `GET /api/core/fields/:entity/:id` on D1. */
export async function fetchD1CoreRecord(env: Env, entity: CoreRecordEntity, id: string): Promise<JsonValue> {
  if (entity === 'interactions') {
    const record = await d1InteractionRecord(env, id);
    if (!record) throw new ControlError('No interaction with that id.', 404);
    return answer(record);
  }
  return answer(await readRow(env, entity, id));
}

/** The keys of `body` that `schema` does not name: D1 has no column for them. */
function refuseUnknown(entity: CoreRecordEntity, body: Record<string, unknown>, known: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new ControlError(`This workspace's ${entity} keep no ${unknown.join(', ')}.`, 400, 'invalid_request');
  }
}

/** Core's names for a contact as the Work contact write names them. */
function contactInput(body: CoreFieldsWriteBody): Record<string, unknown> {
  const { company_role, email, first_name, last_name, ...rest } = body;
  const input: Record<string, unknown> = { ...rest };
  if (company_role !== undefined) input.title = company_role;
  if (email !== undefined) input.emails = typeof email === 'string' && email.trim() ? [email] : [];
  const parts = [first_name, last_name].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  if (input.name === undefined && parts.length > 0) input.name = parts.join(' ');
  return input;
}

const organizationInput = (body: CoreFieldsWriteBody): Record<string, unknown> => {
  const { website, ...rest } = body;
  return website === undefined ? rest : { ...rest, url: website };
};

const shapeKeys = (schema: z.ZodObject) => Object.keys(schema.shape);

/**
 * Core's agent names for an interaction: `interactionDate` is
 * `occurred_at`, `contact_ids` the contacts, and a `description` alone is
 * the summary too, as Core's agent route stores it.
 */
function interactionInput(body: CoreFieldsWriteBody): { values: z.infer<typeof coreInteractionValuesSchema>; contactIds?: string[] } {
  const { contact_ids: contactIds, interactionDate, interaction_date: interactionDateSnake, ...rest } = body;
  const fields: Record<string, unknown> = { ...rest };
  const date = rest.occurred_at ?? interactionDate ?? interactionDateSnake;
  if (date !== undefined) fields.occurred_at = date;
  if (fields.description !== undefined && fields.summary_markdown === undefined) fields.summary_markdown = fields.description;
  refuseUnknown('interactions', fields, shapeKeys(coreInteractionValuesSchema));
  const ids = z.array(z.uuid()).max(100).optional().parse(contactIds);
  return { values: coreInteractionValuesSchema.parse(fields), ...(ids ? { contactIds: ids } : {}) };
}

/** The written interaction as History reads it. */
async function interactionAnswer(env: Env, id: string): Promise<JsonValue> {
  const record = await d1InteractionRecord(env, id);
  if (!record) throw new ControlError('No interaction with that id.', 404);
  return answer(record);
}

/** `POST /api/core/records/:entity` on D1, through the Work write helpers. */
export async function createD1CoreRecord(
  env: Env,
  actorEmail: string,
  entity: CoreRecordEntity,
  body: CoreFieldsWriteBody,
  options: { anySource?: boolean } = {},
): Promise<JsonValue> {
  await assertGroupWritable(env, coreRecordGroup(entity));
  switch (entity) {
    case 'organizations': {
      const { name, ...fields } = organizationInput(body);
      refuseUnknown(entity, fields, shapeKeys(crmOrganizationUpdateSchema));
      const parsed = crmOrganizationUpdateSchema.parse(fields);
      const created = await createCrmOrganization(env, actorEmail, z.string().trim().min(1).max(200).parse(name));
      if (Object.keys(parsed).length > 0) await updateCrmOrganization(env, actorEmail, created.id, parsed);
      await purgeRecordCaches('organizations', null);
      return answer(await readRow(env, entity, created.id));
    }
    case 'contacts': {
      const input = contactInput(body);
      refuseUnknown(entity, input, shapeKeys(crmContactCreateSchema));
      const created = await createCrmContact(env, actorEmail, crmContactCreateSchema.parse(input), options);
      return answer(await readRow(env, entity, created.id));
    }
    case 'leads':
    case 'projects': {
      const kind = entity === 'leads' ? 'lead' : 'project';
      const { is_internal: internal, ...fields } = body;
      const create = kind === 'lead' ? crmLeadUpdateSchema : crmProjectUpdateSchema;
      refuseUnknown(entity, kind === 'project' ? fields : body, shapeKeys(create));
      const created = await createCrmSubject(env, crmSubjectCreateCommandSchema.parse({ ...fields, kind }), actorEmail);
      if (kind === 'project' && internal !== undefined) {
        await updateCrmSubject(env, 'project', created.id, crmProjectUpdateSchema.parse({ is_internal: internal }), actorEmail);
      }
      return answer(await readRow(env, entity, created.id));
    }
    case 'interactions': {
      const { values, contactIds } = interactionInput(body);
      const title = z.string().trim().min(1).max(500).parse(values.title);
      const written = await writeD1Interaction(env, actorEmail, {
        action: 'create', entity: 'interactions', values: { ...values, title, type: values.type ?? 'note' },
        ...(contactIds ? { contact_ids: contactIds } : {}),
      });
      await purgeRecordCaches('interactions', null, written?.after ?? undefined);
      return interactionAnswer(env, written!.id);
    }
  }
}

/** `PATCH /api/core/fields/:entity/:id` on D1, through the Work write helpers. */
export async function updateD1CoreRecord(
  env: Env,
  actorEmail: string,
  entity: CoreRecordEntity,
  id: string,
  body: CoreFieldsWriteBody,
): Promise<JsonValue> {
  await assertGroupWritable(env, coreRecordGroup(entity));
  switch (entity) {
    case 'organizations': {
      const input = organizationInput(body);
      refuseUnknown(entity, input, shapeKeys(crmOrganizationUpdateSchema));
      await updateCrmOrganization(env, actorEmail, id, crmOrganizationUpdateSchema.parse(input));
      return answer(await readRow(env, entity, id));
    }
    case 'contacts': {
      const input = contactInput(body);
      refuseUnknown(entity, input, shapeKeys(crmContactUpdateSchema));
      await updateCrmContact(env, actorEmail, id, crmContactUpdateSchema.parse(input));
      return answer(await readRow(env, entity, id));
    }
    case 'leads':
    case 'projects': {
      const kind = entity === 'leads' ? 'lead' : 'project';
      const schema = kind === 'lead' ? crmLeadUpdateSchema : crmProjectUpdateSchema;
      refuseUnknown(entity, body, shapeKeys(schema));
      await updateCrmSubject(env, kind, id, schema.parse(body), actorEmail);
      return answer(await readRow(env, entity, id));
    }
    case 'interactions': {
      const { values, contactIds } = interactionInput(body);
      const written = await writeD1Interaction(env, actorEmail, {
        action: 'update', entity: 'interactions', id, values, ...(contactIds ? { contact_ids: contactIds } : {}),
      });
      if (!written) throw new ControlError('No interaction with that id.', 404);
      for (const row of [written.before, written.after]) if (row) await purgeRecordCaches('interactions', null, row);
      return interactionAnswer(env, id);
    }
  }
}

/** `DELETE /api/core/fields/organizations/:id` on D1: refused while any row points at it. */
export async function deleteD1CoreOrganization(env: Env, actorEmail: string, id: string): Promise<JsonValue> {
  return answer(await deleteCrmOrganization(env, actorEmail, id));
}
