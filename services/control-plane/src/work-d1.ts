/**
 * The work model in a workspace's own D1, for WORK_STORE=d1
 * (docs/WORKSPACE_STORE.md). The exported `crm.ts` functions are the
 * interface: each one sends a D1 workspace here before it builds a Core
 * request, so routes, MCP and the clients do not know which store answered.
 * Every answer is in the wire shapes of `packages/contracts/src/crm.ts`.
 *
 * Meet's Worker is the only writer (CORE_FOLD_PLAN principle 3). There is no
 * fallback to Core: a failure here is an error.
 */
import { projectLimitError } from './workspace-plan';
import { SUBJECT_STATUS_CHOICES } from '@starlings/contracts/subject-status';
import { FINISHED_TASK_STATUSES, OPEN_TASK_STATUSES, type CrmContactFilter, type CrmOrganizationFilter, type CrmOrganizationOption } from '@starlings/contracts';
import type {
  CrmDecision,
  CrmDecisionCreateInput,
  CrmGoal,
  CrmGoalCreateInput,
  CrmGoalUpdateInput,
} from '@starlings/contracts/goals-decisions';
import type { FavoriteRow, FavoriteTarget } from '@starlings/contracts/favorites';
import type {
  CrmContact,
  CrmContactDetail,
  CrmGithubRepo,
  CrmInteractionRow,
  CrmInteractionContact,
  CrmIssue,
  CrmMyTask,
  CrmContactFacets,
  CrmOrganizationFacets,
  CrmRelatedRow,
  CrmTask,
  CrmWorkItem,
  CrmSubject,
  CrmSubjectCountsResponse,
  CrmSubjectDetail,
  CrmSubjectKind,
  CrmSubjectStatusCounts,
} from '@starlings/contracts/crm';
import type { CoreCacheKey } from './core-cache';
import type { MeetingLogPayload } from './crm';
import { ControlError } from './errors';
import { usesCore } from './work-store';
import { ensurePersonId, personIdForEmail } from './person-ids';
import { loadAgents } from './agent-roster';
import type { SubjectAccessView } from './subject-access';
import { survivorOf } from './record-merges';
import { contactSourceStatement, resolveContactSource, type ContactSourceFact } from './subject-settings';
import { fieldsOf, workActivityStatement } from './work-activity';
import { ensureSignalsLeadForContact } from './signals-outreach';

/** Subjects a list returns at most; the rest is for the search box, as on Core. */
const SUBJECT_PAGE = 50;
const ORGANIZATION_PAGE = 20;

/** `open`: the statuses where a project or lead is still work (ADR 0008 decision 10). */
const OPEN_STATUSES = { project: SUBJECT_STATUS_CHOICES.project.open, lead: SUBJECT_STATUS_CHOICES.lead.open } as const;

interface OrganizationRow {
  id: string;
  name: string;
  is_partner: number;
  industry: string | null;
  url: string | null;
  logo_url: string | null;
  /** Core's curated logo (migration 0130). A reader shows it before `logo_url`. */
  profile_image_url?: string | null;
  notes?: string | null;
  updated_at: number;
}

interface LeadRow {
  id: string;
  organization_id: string | null;
  organization_name: string | null;
  contact_id: string | null;
  title: string;
  status: string;
  start_date: string | null;
  notes: string | null;
  /** The qualification checklist, JSON (migration 0115). */
  characteristics: string | null;
  responsible_email: string | null;
  responsible_set_by: string | null;
  responsible_set_at: number | null;
  updated_at: number;
}

interface ProjectRow {
  id: string;
  organization_id: string | null;
  organization_name: string | null;
  lead_id: string | null;
  title: string;
  status: string;
  description: string | null;
  url: string | null;
  start_date: string | null;
  end_date: string | null;
  internal: number;
  agent_email: string | null;
  // Core's profile columns (migration 0115).
  evid: string | null;
  license_id: string | null;
  specs: string | null;
  technical: string | null;
  research: string | null;
  design: string | null;
  contract: string | null;
  analytics: string | null;
  authentication: string | null;
  responsible_email: string | null;
  responsible_set_by: string | null;
  responsible_set_at: number | null;
  updated_at: number;
}

const iso = (millis: number | null | undefined) => (typeof millis === 'number' ? new Date(millis).toISOString() : null);
const like = (query: string) => `%${query.trim().replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;

/** Who answers for a subject, as Core projects it. */
function responsible(row: { responsible_email: string | null; responsible_set_by: string | null; responsible_set_at: number | null }) {
  return {
    responsible_email: row.responsible_email ?? null,
    responsible_set_by: row.responsible_set_by ?? null,
    responsible_set_at: iso(row.responsible_set_at),
  };
}

function notFound(kind: string): ControlError {
  return new ControlError(`No ${kind} with that id.`, 404);
}

// ---------------------------------------------------------------------------
// Rows to the wire.
// ---------------------------------------------------------------------------

function leadSubject(row: LeadRow): CrmSubject {
  return {
    id: row.id,
    kind: 'lead',
    title: row.title,
    subtitle: row.organization_name,
    organization_id: row.organization_id,
    organization_name: row.organization_name,
    status: row.status,
    ...responsible(row),
    last_activity_at: iso(row.updated_at),
  };
}

function projectSubject(row: ProjectRow): CrmSubject {
  return {
    id: row.id,
    kind: 'project',
    title: row.title,
    subtitle: row.organization_name,
    organization_id: row.organization_id,
    organization_name: row.organization_name,
    internal: row.internal === 1,
    agent_email: row.agent_email,
    status: row.status,
    ...responsible(row),
    has_repo: false,
    last_activity_at: iso(row.updated_at),
  };
}

function partnerSubject(row: OrganizationRow, related?: { projects: number; leads: number }): CrmSubject {
  return {
    id: row.id,
    kind: 'organization',
    title: row.name,
    subtitle: row.industry,
    organization_id: row.id,
    organization_name: row.name,
    organization_logo_url: row.profile_image_url ?? row.logo_url,
    ...(related ? { related_projects: related.projects, related_leads: related.leads } : {}),
    last_activity_at: iso(row.updated_at),
  };
}

const LEAD_SELECT = `SELECT l.*, o.name AS organization_name FROM leads l LEFT JOIN organizations o ON o.id = l.organization_id`;
const PROJECT_SELECT = `SELECT p.*, o.name AS organization_name FROM projects p LEFT JOIN organizations o ON o.id = p.organization_id`;

/** Open and overdue task counts per subject, so a list says where things stand. */
async function withTaskCounts(env: Env, kind: 'lead' | 'project' | 'organization', subjects: CrmSubject[]): Promise<CrmSubject[]> {
  if (subjects.length === 0) return subjects;
  const column = kind === 'lead' ? 'lead_id' : kind === 'project' ? 'project_id' : 'organization_id';
  const own = kind === 'organization' ? 'AND project_id IS NULL AND lead_id IS NULL' : '';
  // D1 binds at most 100 parameters per statement: ask in chunks.
  const ids = subjects.map((subject) => subject.id);
  const results: Array<{ id: string; open: number; overdue: number }> = [];
  for (let at = 0; at < ids.length; at += 80) {
    const chunk = ids.slice(at, at + 80);
    const page = await env.USAGE.prepare(
      `SELECT ${column} AS id, COUNT(*) AS open, SUM(CASE WHEN due_at < ? THEN 1 ELSE 0 END) AS overdue
       FROM tasks WHERE ${column} IN (${chunk.map(() => '?').join(', ')}) ${own}
         AND status IN (${OPEN_TASK_STATUSES.map(() => '?').join(', ')})
       GROUP BY ${column}`,
    ).bind(Date.now(), ...chunk, ...OPEN_TASK_STATUSES).all<{ id: string; open: number; overdue: number }>();
    results.push(...page.results);
  }
  const counts = new Map(results.map((row) => [row.id, row]));
  return subjects.map((subject) => ({
    ...subject,
    open_tasks: counts.get(subject.id)?.open ?? 0,
    overdue_tasks: counts.get(subject.id)?.overdue ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  title: string;
  starts_on: string;
  location: string | null;
  url: string | null;
  notes: string | null;
  starts_at: number | null;
  time_zone: string | null;
  updated_at: number;
}

const EVENT_SUBJECT_SELECT = 'SELECT id, title, starts_on, location, url, notes, starts_at, time_zone, updated_at FROM events';

/** A D1 event as a Work subject (docs/EVENTS.md §An event on a `d1` workspace): the date is its status. */
function eventSubject(row: EventRow): CrmSubject {
  return { id: row.id, kind: 'event', title: row.title, subtitle: row.location, event_date: row.starts_on, last_activity_at: iso(row.updated_at) };
}

/** `fetchCrmSubjects` on D1 for events: every event, soonest first, upcoming before past. */
async function d1EventSubjects(env: Env, query: string, take: number): Promise<{ subjects: CrmSubject[]; hasMore: boolean }> {
  const needle = query.trim();
  const { results } = await env.USAGE.prepare(
    `${EVENT_SUBJECT_SELECT} ${needle ? `WHERE title LIKE ?1 ESCAPE '\\'` : ''} ORDER BY starts_on DESC LIMIT ${needle ? '?2' : '?1'}`,
  ).bind(...(needle ? [like(needle)] : []), take + 1).all<EventRow>();
  return { subjects: results.slice(0, take).map(eventSubject), hasMore: results.length > take };
}

/** The columns an organization search reads: Core's list searches the same five. */
const ORGANIZATION_SEARCH_COLUMNS = ['name', 'legal_name', 'industry', 'country', 'city'] as const;

/** Every industry and country the organizations carry, for the list's filter menus. */
async function d1OrganizationFacets(env: Env): Promise<CrmOrganizationFacets> {
  const values = async (column: 'industry' | 'country') => (await env.USAGE.prepare(
    `SELECT DISTINCT TRIM(${column}) AS value FROM organizations WHERE TRIM(COALESCE(${column}, '')) <> '' ORDER BY value COLLATE NOCASE`,
  ).all<{ value: string }>()).results.map((row) => row.value);
  const [industries, countries] = await Promise.all([values('industry'), values('country')]);
  return { industries, countries };
}

/** `fetchCrmSubjects` on D1 for organizations: partners unless the filter says otherwise. */
async function d1OrganizationSubjects(
  env: Env,
  query: string,
  take: number,
  filter: CrmOrganizationFilter,
): Promise<{ subjects: CrmSubject[]; hasMore: boolean; facets: CrmOrganizationFacets }> {
  const needle = query.trim();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.partner !== false) where.push('is_partner = 1');
  if (filter.agency) where.push('is_agency = 1');
  if (filter.existing_client) where.push('is_existing_client = 1');
  if (filter.industry) { where.push('TRIM(industry) = ? COLLATE NOCASE'); binds.push(filter.industry); }
  if (filter.country) { where.push('TRIM(country) = ? COLLATE NOCASE'); binds.push(filter.country); }
  if (needle) {
    where.push(`(${ORGANIZATION_SEARCH_COLUMNS.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    binds.push(...ORGANIZATION_SEARCH_COLUMNS.map(() => like(needle)));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ results }, facets] = await Promise.all([
    env.USAGE.prepare(`SELECT * FROM organizations ${clause} ORDER BY name COLLATE NOCASE LIMIT ?`)
      .bind(...binds, take + 1).all<OrganizationRow>(),
    d1OrganizationFacets(env),
  ]);
  return {
    subjects: await withTaskCounts(env, 'organization', results.slice(0, take).map((row) => partnerSubject(row))),
    hasMore: results.length > take,
    facets,
  };
}

/** `fetchCrmSubjects` on D1. */
export async function d1Subjects(
  env: Env,
  kind: CrmSubjectKind,
  query: string,
  status?: string,
  limit = SUBJECT_PAGE,
  organizations: CrmOrganizationFilter = {},
  leadSource?: string,
): Promise<{ subjects: CrmSubject[]; hasMore: boolean; facets?: CrmOrganizationFacets }> {
  if (kind === 'event') return d1EventSubjects(env, query, Math.max(1, Math.min(limit, 200)));
  const wanted = status?.trim() || 'open';
  const needle = query.trim();
  const take = Math.max(1, Math.min(limit, 200));
  const where: string[] = [];
  const binds: unknown[] = [];

  if (kind === 'organization') return d1OrganizationSubjects(env, query, take, organizations);

  const table = kind === 'lead' ? 'l' : 'p';
  if (wanted === 'open') {
    where.push(`${table}.status IN (${OPEN_STATUSES[kind].map(() => '?').join(', ')})`);
    binds.push(...OPEN_STATUSES[kind]);
  } else if (wanted !== 'open' && wanted !== 'all') {
    where.push(`${table}.status = ?`);
    binds.push(wanted);
  }
  if (kind === 'lead' && leadSource) {
    where.push('l.source = ?');
    binds.push(leadSource);
  }
  if (needle) {
    where.push(`(${table}.title LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\')`);
    binds.push(like(needle), like(needle));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `${kind === 'lead' ? LEAD_SELECT : PROJECT_SELECT} ${clause} ORDER BY ${table}.updated_at DESC LIMIT ?`;
  if (kind === 'lead') {
    const { results } = await env.USAGE.prepare(sql).bind(...binds, take + 1).all<LeadRow>();
    return { subjects: await withTaskCounts(env, 'lead', results.slice(0, take).map(leadSubject)), hasMore: results.length > take };
  }
  const { results } = await env.USAGE.prepare(sql).bind(...binds, take + 1).all<ProjectRow>();
  return { subjects: await withTaskCounts(env, 'project', results.slice(0, take).map(projectSubject)), hasMore: results.length > take };
}

/** The merge entity of a subject kind: only organizations and leads merge. */
const MERGED_KIND: Partial<Record<CrmSubjectKind, 'organizations' | 'leads'>> = { organization: 'organizations', lead: 'leads' };

/**
 * The record a merged id became, when `id` names no row. A D1
 * merge deletes the merged row and keeps the edge in `record_merges`; the
 * `subjects` copy brings Core's merge aliases there too. Null: no such merge.
 */
async function mergedSurvivor(env: Env, entity: 'organizations' | 'leads' | 'contacts', id: string): Promise<string | null> {
  const exists = await env.USAGE.prepare(`SELECT id FROM ${entity} WHERE id = ?1`).bind(id).first();
  return exists ? null : survivorOf(env, entity, id);
}

/** `fetchCrmSubject` and `lookupCrmSubjectById` on D1: one subject by id, or null. A merged id answers its survivor. */
export async function d1Subject(env: Env, kind: CrmSubjectKind, id: string): Promise<CrmSubject | null> {
  const entity = MERGED_KIND[kind];
  const survivor = entity ? await mergedSurvivor(env, entity, id) : null;
  if (survivor) {
    const subject = await d1SubjectRow(env, kind, survivor);
    return subject ? { ...subject, merged_from: id } : null;
  }
  return d1SubjectRow(env, kind, id);
}

async function d1SubjectRow(env: Env, kind: CrmSubjectKind, id: string): Promise<CrmSubject | null> {
  if (kind === 'lead') {
    const row = await env.USAGE.prepare(`${LEAD_SELECT} WHERE l.id = ?1`).bind(id).first<LeadRow>();
    return row ? leadSubject(row) : null;
  }
  if (kind === 'project') {
    const row = await env.USAGE.prepare(`${PROJECT_SELECT} WHERE p.id = ?1`).bind(id).first<ProjectRow>();
    return row ? projectSubject(row) : null;
  }
  if (kind === 'organization') {
    // Every organization is a subject (ADR 0006); only Browse's partners list asks for `is_partner`.
    const row = await env.USAGE.prepare('SELECT * FROM organizations WHERE id = ?1').bind(id).first<OrganizationRow>();
    return row ? partnerSubject(row) : null;
  }
  if (kind === 'event') {
    const row = await env.USAGE.prepare(`${EVENT_SUBJECT_SELECT} WHERE id = ?1`).bind(id).first<EventRow>();
    return row ? eventSubject(row) : null;
  }
  return null;
}

/** `fetchCrmSubjectDetail` on D1: the editable projection, 404 when absent. A merged id answers its survivor. */
export async function d1SubjectDetail(env: Env, kind: CrmSubjectKind, id: string): Promise<CrmSubjectDetail> {
  const entity = MERGED_KIND[kind];
  const survivor = entity ? await mergedSurvivor(env, entity, id) : null;
  if (survivor) return { ...(await d1SubjectDetailRow(env, kind, survivor)), merged_from: id };
  return d1SubjectDetailRow(env, kind, id);
}

async function d1SubjectDetailRow(env: Env, kind: CrmSubjectKind, id: string): Promise<CrmSubjectDetail> {
  if (kind === 'event') {
    const row = await env.USAGE.prepare(`${EVENT_SUBJECT_SELECT} WHERE id = ?1`).bind(id).first<EventRow>();
    if (!row) throw notFound('event');
    return {
      ...eventSubject(row),
      status: 'active',
      updated_at: iso(row.updated_at),
      url: row.url,
      description: row.notes,
      location: row.location,
      start_at: iso(row.starts_at),
      timezone: row.time_zone,
    };
  }
  if (kind === 'lead') {
    const row = await env.USAGE.prepare(`${LEAD_SELECT} WHERE l.id = ?1`).bind(id).first<LeadRow>();
    if (!row) throw notFound('lead');
    // The projects this lead started, on `projects.lead_id` (ADR 0008).
    const { results: projects } = await env.USAGE.prepare('SELECT id, title, status FROM projects WHERE lead_id = ?1 ORDER BY updated_at DESC LIMIT 50')
      .bind(id).all<CrmRelatedRow>();
    return {
      ...leadSubject(row),
      status: row.status,
      updated_at: iso(row.updated_at),
      contact_id: row.contact_id,
      start_date: row.start_date,
      notes: row.notes,
      characteristics: readCharacteristics(row.characteristics),
      related: { projects, leads: [], contacts: [] },
    };
  }
  if (kind === 'project') {
    const row = await env.USAGE.prepare(`${PROJECT_SELECT} WHERE p.id = ?1`).bind(id).first<ProjectRow>();
    if (!row) throw notFound('project');
    const [{ results: contacts }, lead] = await Promise.all([
      env.USAGE.prepare('SELECT contact_id FROM project_contacts WHERE project_id = ?1').bind(id).all<{ contact_id: string }>(),
      // The lead this project came from (ADR 0008).
      row.lead_id ? env.USAGE.prepare('SELECT id, title, status FROM leads WHERE id = ?1').bind(row.lead_id).first<CrmRelatedRow>() : null,
    ]);
    return {
      ...projectSubject(row),
      status: row.status,
      updated_at: iso(row.updated_at),
      description: row.description,
      url: row.url,
      lead_id: row.lead_id,
      contact_ids: contacts.map((contact) => contact.contact_id),
      start_date: row.start_date,
      end_date: row.end_date,
      evid: row.evid,
      license_id: row.license_id,
      specs: row.specs,
      technical: row.technical,
      research: row.research,
      design: row.design,
      contract: row.contract,
      analytics: row.analytics,
      authentication: row.authentication,
      related: { projects: [], leads: lead ? [lead] : [], contacts: [] },
    };
  }
  if (kind === 'organization') {
    // Every organization is a subject (ADR 0006); only Browse's partners list asks for `is_partner`.
    const row = await env.USAGE.prepare('SELECT * FROM organizations WHERE id = ?1').bind(id).first<OrganizationRow>();
    if (!row) throw notFound('organization');
    const [projects, leads, contacts] = await Promise.all([
      env.USAGE.prepare('SELECT id, title, status FROM projects WHERE organization_id = ?1 ORDER BY updated_at DESC').bind(id).all<{ id: string; title: string; status: string }>(),
      env.USAGE.prepare('SELECT id, title, status FROM leads WHERE organization_id = ?1 ORDER BY updated_at DESC').bind(id).all<{ id: string; title: string; status: string }>(),
      env.USAGE.prepare('SELECT id, name, email, title FROM contacts WHERE organization_id = ?1 ORDER BY name COLLATE NOCASE').bind(id).all<{ id: string; name: string | null; email: string | null; title: string | null }>(),
    ]);
    return {
      ...partnerSubject(row, { projects: projects.results.length, leads: leads.results.length }),
      status: 'Active',
      updated_at: iso(row.updated_at),
      url: row.url,
      industry: row.industry,
      notes: row.notes ?? null,
      ...profileOf(ORGANIZATION_COLUMNS, row as unknown as StoredRow),
      related: { projects: projects.results, leads: leads.results, contacts: contacts.results },
    };
  }
  throw notFound(kind);
}

/** `fetchCrmSubjectCounts` on D1: one number per status, plus `all` and `open`. */
export async function d1SubjectCounts(env: Env, kind: 'lead' | 'project', query: string): Promise<CrmSubjectCountsResponse> {
  const needle = query.trim();
  const table = kind === 'lead' ? 'leads' : 'projects';
  const filter = needle
    ? `WHERE (t.title LIKE ?1 ESCAPE '\\' OR o.name LIKE ?1 ESCAPE '\\')`
    : '';
  const statement = env.USAGE.prepare(
    `SELECT t.status AS status, ${kind === 'project' ? 't.internal' : '0'} AS internal, COUNT(*) AS total
     FROM ${table} t LEFT JOIN organizations o ON o.id = t.organization_id
     ${filter}
     GROUP BY t.status, internal`,
  );
  const { results } = await (needle ? statement.bind(like(needle)) : statement).all<{ status: string; internal: number; total: number }>();
  const counts: CrmSubjectStatusCounts = {};
  const internal: CrmSubjectStatusCounts = {};
  const client: CrmSubjectStatusCounts = {};
  const add = (bucket: CrmSubjectStatusCounts, status: string, total: number) => {
    bucket[status] = (bucket[status] ?? 0) + total;
    bucket.all = (bucket.all ?? 0) + total;
    if (OPEN_STATUSES[kind].includes(status)) bucket.open = (bucket.open ?? 0) + total;
  };
  for (const row of results) {
    add(counts, row.status, row.total);
    if (kind === 'project') add(row.internal === 1 ? internal : client, row.status, row.total);
  }
  return kind === 'lead' ? { counts } : { counts, internal, client };
}

/** `searchCrmOrganizations` on D1. */
export async function d1SearchOrganizations(env: Env, query: string): Promise<CrmOrganizationOption[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT id, name FROM organizations WHERE name LIKE ?1 ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT ?2`,
  ).bind(like(query), ORGANIZATION_PAGE).all<CrmOrganizationOption>();
  return results;
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

/** `createCrmOrganization` on D1. The same name twice answers the one that exists. */
export async function d1CreateOrganization(env: Env, actorEmail: string, name: string): Promise<CrmOrganizationOption> {
  const trimmed = name.trim();
  const existing = await env.USAGE.prepare('SELECT id, name FROM organizations WHERE name = ?1 COLLATE NOCASE')
    .bind(trimmed).first<CrmOrganizationOption>();
  if (existing) return existing;
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.USAGE.batch([
    env.USAGE.prepare(
      'INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
    ).bind(id, trimmed, await personIdForEmail(env, actorEmail), now),
    workActivityStatement(env, { actor: actorEmail, table: 'organizations', id, action: 'insert', label: trimmed, fields: ['name'] }, now),
  ]);
  return { id, name: trimmed };
}

// ---------------------------------------------------------------------------
// Core's columns on organizations and contacts (migration 0130).
// The wire names each column as D1 does; a write sets only the fields present.
// ---------------------------------------------------------------------------

type StoredRow = Record<string, string | number | null>;
/** How a column is stored: trimmed text, a 0/1 flag, an integer, epoch ms, or a JSON object of flags. */
type ColumnKind = 'text' | 'flag' | 'int' | 'time' | 'flags';

/** Organization columns beyond the name, and what the detail answers for each. */
const ORGANIZATION_COLUMNS: Record<string, ColumnKind> = {
  legal_name: 'text', address: 'text', postcode: 'text', city: 'text', country: 'text', vat_id: 'text', tax_id: 'text',
  size: 'text', owner_id: 'text', founded: 'text', hq_location: 'text', company_type: 'text', linkedin_url: 'text',
  logo_url: 'text', logo_image_url: 'text', profile_image_url: 'text', entity: 'text', domain: 'text',
  is_agency: 'flag', is_existing_client: 'flag', is_partner: 'flag',
};
/** What an organization write may set: the profile, and the columns the detail already names. */
const ORGANIZATION_WRITES: Record<string, ColumnKind> = { ...ORGANIZATION_COLUMNS, url: 'text', industry: 'text', notes: 'text' };

/** Contact columns beyond the name, title, organization and addresses. */
const CONTACT_COLUMNS: Record<string, ColumnKind> = {
  notes: 'text', linkedin_url: 'text', phone: 'text', headline: 'text', location: 'text', connection_count: 'text',
  country: 'text', corporate_email: 'text', profile_image_url: 'text', characteristics: 'flags',
  preferred_language: 'text', signals_outreach_status: 'text', signals_notified_at: 'time',
  birthday_month: 'int', birthday_day: 'int', birthday_year: 'int',
  futurist: 'flag', corporate: 'flag', academic: 'flag', independent: 'flag', government: 'flag', ngo: 'flag', media: 'flag', intelligence: 'flag',
};

/** A stored row's columns as the wire reads them. */
function profileOf(columns: Record<string, ColumnKind>, row: StoredRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(columns).map(([column, kind]) => {
    const value = row[column] ?? null;
    switch (kind) {
      case 'flag': return [column, value === 1];
      case 'time': return [column, iso(typeof value === 'number' ? value : null)];
      case 'flags': return [column, readCharacteristics(typeof value === 'string' ? value : null)];
      default: return [column, value];
    }
  }));
}

/** One column's value as D1 stores it. A JSON object of flags is written with sorted keys, as the copy writes it. */
function storedValue(kind: ColumnKind, value: unknown): string | number | null {
  switch (kind) {
    case 'flag': return value === true ? 1 : 0;
    case 'int': return typeof value === 'number' && Number.isInteger(value) ? value : null;
    case 'time': return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
    case 'flags': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const entries = Object.entries(value).filter(([, flagged]) => typeof flagged === 'boolean').sort(([left], [right]) => left.localeCompare(right));
      return entries.length === 0 ? null : JSON.stringify(Object.fromEntries(entries));
    }
    default: return text(value);
  }
}

/** `SET` clauses for the columns present in the input. A present `undefined` is left alone. */
function columnSets(columns: Record<string, ColumnKind>, input: Record<string, unknown>): { sets: string[]; binds: unknown[] } {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [column, kind] of Object.entries(columns)) {
    if (!(column in input) || input[column] === undefined) continue;
    const value = storedValue(kind, input[column]);
    // `preferred_language` is NOT NULL: a cleared language goes back to Core's default.
    sets.push(`${column} = ?`);
    binds.push(column === 'preferred_language' ? value ?? 'en' : value);
  }
  return { sets, binds };
}

/**
 * An organization's fields on D1: only the fields present change.
 * A name is never blanked. Answers the organization's detail.
 */
export async function d1UpdateOrganization(env: Env, id: string, input: Record<string, unknown>): Promise<CrmSubjectDetail> {
  const exists = await env.USAGE.prepare('SELECT id FROM organizations WHERE id = ?1').bind(id).first();
  if (!exists) throw notFound('organization');
  const { sets, binds } = columnSets(ORGANIZATION_WRITES, input);
  if (text(input.name)) { sets.push('name = ?'); binds.push(text(input.name)); }
  sets.push('updated_at = ?');
  binds.push(Date.now());
  await env.USAGE.prepare(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  return d1SubjectDetail(env, 'organization', id);
}

/**
 * The rows that point at an organization, by table, as Core's guarded delete
 * counts them (`if_unreferenced`).
 */
const ORGANIZATION_REFERENCES = [
  ['contacts', 'SELECT COUNT(*) AS n FROM contacts WHERE organization_id = ?1'],
  ['leads', 'SELECT COUNT(*) AS n FROM leads WHERE organization_id = ?1'],
  ['projects', 'SELECT COUNT(*) AS n FROM projects WHERE organization_id = ?1'],
  ['tasks', 'SELECT COUNT(*) AS n FROM tasks WHERE organization_id = ?1'],
  ['interactions', `SELECT COUNT(*) AS n FROM interactions WHERE organization_id = ?1
    OR id IN (SELECT interaction_id FROM interaction_subjects WHERE subject_kind = 'organization' AND subject_id = ?1)`],
  ['decisions', "SELECT COUNT(*) AS n FROM decisions WHERE subject_kind = 'organization' AND subject_id = ?1"],
  ['peer credentials', 'SELECT COUNT(*) AS n FROM peer_credentials WHERE organization_id = ?1'],
] as const;

/**
 * Delete an organization on D1, refused while any row points at it, as
 * Core's guarded delete refuses. Nothing is repointed and
 * nothing cascades.
 */
export async function d1DeleteOrganization(env: Env, id: string): Promise<{ id: string; deleted: true }> {
  const exists = await env.USAGE.prepare('SELECT id FROM organizations WHERE id = ?1').bind(id).first();
  if (!exists) throw notFound('organization');
  const counts = await env.USAGE.batch(ORGANIZATION_REFERENCES.map(([, sql]) => env.USAGE.prepare(sql).bind(id)));
  const used = ORGANIZATION_REFERENCES
    .map(([table], index) => [table, Number((counts[index]?.results[0] as { n?: number } | undefined)?.n ?? 0)] as const)
    .filter(([, count]) => count > 0);
  if (used.length > 0) {
    throw new ControlError(
      `Organization is in use (${used.map(([table, count]) => `${table} ${count}`).join(', ')}). Move or merge those records first.`,
      409,
      'invalid_request',
    );
  }
  await env.USAGE.prepare('DELETE FROM organizations WHERE id = ?1').bind(id).run();
  return { id, deleted: true };
}

/**
 * The contact editor's choices: the characteristic names in
 * `contact_characteristics_config` and any other a contact
 * carries, and every preferred language the contacts carry.
 */
export async function d1ContactOptions(env: Env): Promise<{ characteristics: string[]; languages: string[] }> {
  const [names, languages] = await Promise.all([
    env.USAGE.prepare(
      `SELECT name AS value FROM contact_characteristics_config
       UNION SELECT j.key AS value FROM contacts c, json_each(c.characteristics) j
       WHERE json_valid(c.characteristics) AND json_type(c.characteristics) = 'object' ORDER BY value`,
    ).all<{ value: string }>(),
    env.USAGE.prepare(
      "SELECT DISTINCT LOWER(TRIM(preferred_language)) AS value FROM contacts WHERE TRIM(COALESCE(preferred_language, '')) <> '' ORDER BY value",
    ).all<{ value: string }>(),
  ]);
  return { characteristics: names.results.map((row) => row.value), languages: languages.results.map((row) => row.value) };
}

/** The rows that keep a contact from a delete: its calls, its tasks and its partner agreements. */
const CONTACT_DELETE_REFERENCES = [
  ['interactions', `SELECT COUNT(*) AS n FROM interactions WHERE contact_id = ?1
    OR id IN (SELECT interaction_id FROM interaction_contacts WHERE contact_id = ?1)`],
  ['tasks', 'SELECT COUNT(*) AS n FROM tasks WHERE contact_id = ?1'],
  ['partner agreements', 'SELECT COUNT(*) AS n FROM partner_agreement_signatures WHERE contact_id = ?1'],
] as const;

/**
 * Delete a contact on D1, refused while a call or a task references it, as
 * Core's guarded delete refuses. A lead on the contact keeps the lead and
 * loses the link; a project drops the contact; its addresses go with it.
 */
export async function d1DeleteContact(env: Env, id: string): Promise<{ id: string; deleted: true }> {
  await d1ContactRow(env, id);
  const counts = await env.USAGE.batch(CONTACT_DELETE_REFERENCES.map(([, sql]) => env.USAGE.prepare(sql).bind(id)));
  const used = CONTACT_DELETE_REFERENCES
    .map(([table], index) => [table, Number((counts[index]?.results[0] as { n?: number } | undefined)?.n ?? 0)] as const)
    .filter(([, count]) => count > 0);
  if (used.length > 0) {
    throw new ControlError(
      `Contact is in use (${used.map(([table, count]) => `${table} ${count}`).join(', ')}). Move or merge those records first.`,
      409,
      'invalid_request',
    );
  }
  await env.USAGE.batch([
    env.USAGE.prepare('UPDATE leads SET contact_id = NULL WHERE contact_id = ?1').bind(id),
    env.USAGE.prepare('DELETE FROM project_contacts WHERE contact_id = ?1').bind(id),
    env.USAGE.prepare('DELETE FROM contact_emails WHERE contact_id = ?1').bind(id),
    env.USAGE.prepare('UPDATE form_submissions SET contact_id = NULL WHERE contact_id = ?1').bind(id),
    env.USAGE.prepare('DELETE FROM contacts WHERE id = ?1').bind(id),
  ]);
  return { id, deleted: true };
}

/**
 * A contact on an organization, for a writer with no member behind it (the
 * interest form). An address that is already a contact's answers that
 * contact (one record per person outside, docs/RELATIONSHIPS.md principle 4),
 * so a second submission does not file a second person.
 */
export async function d1CreateContact(
  env: Env,
  input: { organization_id: string | null; name: string; email: string; title?: string | null },
  fact: ContactSourceFact = { eventType: 'form_submitted', sourceKey: 'website_contact' },
  actor = 'public-form',
): Promise<{ id: string }> {
  const email = input.email.trim().toLowerCase();
  const existing = await contactIdForEmail(env, email);
  const now = Date.now();
  if (existing) {
    // A second submission is a fact of its own when the writer names it; the default origin is recorded once.
    await contactSourceStatement(env, existing, fact, now).run();
    return { id: existing };
  }
  const id = crypto.randomUUID();
  await env.USAGE.batch([
    env.USAGE.prepare(
      'INSERT INTO contacts (id, organization_id, name, email, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)',
    ).bind(id, input.organization_id, text(input.name), email, text(input.title), now),
    env.USAGE.prepare('INSERT OR IGNORE INTO contact_emails (email, contact_id, created_at) VALUES (?1, ?2, ?3)').bind(email, id, now),
    contactSourceStatement(env, id, fact, now),
    workActivityStatement(env, { actor, table: 'contacts', id, action: 'insert', label: text(input.name), fields: fieldsOf(input) }, now),
  ]);
  return { id };
}

/**
 * A row a write links to, checked before the write. The schema's foreign keys
 * refuse a missing row too, but as a 500. A caller that names a row this
 * workspace does not hold gets a 400 and nothing is written.
 */
async function assertLinked(
  env: Env,
  table: 'organizations' | 'leads' | 'contacts' | 'goals',
  id: string | null | undefined,
  message: string,
): Promise<string | null> {
  if (!id) return null;
  const row = await env.USAGE.prepare(`SELECT id FROM ${table} WHERE id = ?1`).bind(id).first();
  if (!row) throw new ControlError(message, 400, 'invalid_request');
  return id;
}

const assertOrganization = (env: Env, id: string | null | undefined) =>
  assertLinked(env, 'organizations', id, 'That organization does not exist.');
const assertLead = (env: Env, id: string | null | undefined) =>
  assertLinked(env, 'leads', id, 'That lead does not exist on this workspace.');
const assertContact = (env: Env, id: string | null | undefined) =>
  assertLinked(env, 'contacts', id, 'That contact does not exist on this workspace.');
const assertGoal = (env: Env, id: string | null | undefined) =>
  assertLinked(env, 'goals', id, 'That goal does not exist on this workspace.');

async function organizationName(env: Env, id: string | null): Promise<string | null> {
  if (!id) return null;
  const row = await env.USAGE.prepare('SELECT name, legal_name FROM organizations WHERE id = ?1').bind(id).first<{ name: string | null; legal_name: string | null }>();
  return text(row?.name) ?? text(row?.legal_name);
}

/**
 * A lead's title when the writer gives none: "<Organization> <Year>", the year
 * of its start date or of today, else "Lead <Year>", as Core names a new lead
 *.
 */
export function defaultLeadTitle(organization: string | null, startDate: string | null, now = Date.now()): string {
  const parsed = startDate ? Date.parse(startDate) : Number.NaN;
  const year = new Date(Number.isFinite(parsed) ? parsed : now).getUTCFullYear();
  return organization ? `${organization} ${year}` : `Lead ${year}`;
}

async function replaceProjectContacts(env: Env, projectId: string, contactIds: readonly string[]): Promise<void> {
  await env.USAGE.batch([
    env.USAGE.prepare('DELETE FROM project_contacts WHERE project_id = ?1').bind(projectId),
    ...contactIds.map((contactId) => env.USAGE.prepare(
      'INSERT OR IGNORE INTO project_contacts (project_id, contact_id) SELECT ?1, id FROM contacts WHERE id = ?2',
    ).bind(projectId, contactId)),
  ]);
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * A project's insert. The plan's project limit is held in the insert itself:
 * the count and the insert are one statement, so two creates at once cannot
 * both pass. Every project counts, whatever its status. A batch can carry it.
 */
export function d1ProjectInsertStatement(env: Env, project: {
  id: string;
  organization_id: string | null;
  lead_id: string | null;
  title: string;
  status: string;
  description?: string | null;
  url?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  created_by: string | null;
  now: number;
}, projectLimit: number | null): D1PreparedStatement {
  return env.USAGE.prepare(
    `INSERT INTO projects (id, organization_id, lead_id, title, status, description, url, start_date, end_date, created_by, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11
     WHERE ?12 IS NULL OR (SELECT COUNT(*) FROM projects) < ?12`,
  ).bind(project.id, project.organization_id, project.lead_id, project.title, project.status, project.description ?? null, project.url ?? null,
    project.start_date ?? null, project.end_date ?? null, project.created_by, project.now, projectLimit);
}

/** A project started from a lead wins it. The lead row is otherwise left alone. */
export function d1LeadWonStatement(env: Env, leadId: string, now: number): D1PreparedStatement {
  return env.USAGE.prepare("UPDATE leads SET status = 'Closed Won', updated_at = ?2 WHERE id = ?1 AND status <> 'Closed Won'").bind(leadId, now);
}

/**
 * `createCrmSubject` on D1. The input passed `crmSubjectCreateCommandSchema`
 * in the route. A create leaves the profile fields (license, evid,
 * characteristics, the project spec fields) empty; `d1UpdateSubject` writes
 * them (migration 0115).
 */
export async function d1CreateSubject(
  env: Env,
  input: Record<string, unknown>,
  actorEmail: string,
  projectLimit: number | null = null,
): Promise<CrmSubjectDetail> {
  const kind = input.kind === 'project' ? 'project' : 'lead';
  const organizationId = await assertOrganization(env, text(input.organization_id));
  const createdBy = await personIdForEmail(env, actorEmail);
  const id = crypto.randomUUID();
  const now = Date.now();
  if (kind === 'lead') {
    await assertContact(env, text(input.contact_id));
    const title = text(input.title) ?? defaultLeadTitle(await organizationName(env, organizationId), text(input.start_date), now);
    await env.USAGE.prepare(
      `INSERT INTO leads (id, organization_id, contact_id, title, status, start_date, notes, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    ).bind(id, organizationId, text(input.contact_id), title, text(input.status) ?? 'Conversations',
      text(input.start_date), text(input.notes), createdBy, now).run();
    return d1SubjectDetail(env, 'lead', id);
  }
  await assertLead(env, text(input.lead_id));
  const inserted = await d1ProjectInsertStatement(env, {
    id, organization_id: organizationId, lead_id: text(input.lead_id), title: text(input.title) ?? 'New project', status: text(input.status) ?? 'Active',
    description: text(input.description), url: text(input.url), start_date: text(input.start_date), end_date: text(input.end_date), created_by: createdBy, now,
  }, projectLimit).run();
  if ((inserted.meta?.changes ?? 0) === 0) throw projectLimitError();
  // An offer's acceptance and Win both start one.
  const leadId = text(input.lead_id);
  if (leadId) await d1LeadWonStatement(env, leadId, now).run();
  if (Array.isArray(input.contact_ids)) await replaceProjectContacts(env, id, input.contact_ids.filter((value): value is string => typeof value === 'string'));
  return d1SubjectDetail(env, 'project', id);
}

const LEAD_FIELDS = ['organization_id', 'contact_id', 'title', 'status', 'start_date', 'notes'] as const;
const PROJECT_FIELDS = [
  'organization_id', 'lead_id', 'title', 'status', 'description', 'url', 'start_date', 'end_date',
  // Core's profile fields (migration 0115): the Fields pane writes them on both stores.
  'license_id', 'evid', 'specs', 'technical', 'research', 'design', 'contract', 'analytics', 'authentication',
] as const;

/** A stored checklist as the wire's object of booleans; anything else reads as none. */
function readCharacteristics(value: string | null): Record<string, boolean> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
  } catch {
    return null;
  }
}

/** `updateCrmSubject` on D1: only the fields present in the input change. */
export async function d1UpdateSubject(
  env: Env,
  kind: 'lead' | 'project',
  id: string,
  input: Record<string, unknown>,
  actor: string,
): Promise<CrmSubjectDetail> {
  const table = kind === 'lead' ? 'leads' : 'projects';
  const exists = await env.USAGE.prepare(`SELECT id FROM ${table} WHERE id = ?1`).bind(id).first();
  if (!exists) throw notFound(kind);
  if ('organization_id' in input) await assertOrganization(env, text(input.organization_id));
  if (kind === 'lead' && 'contact_id' in input) await assertContact(env, text(input.contact_id));
  if (kind === 'project' && 'lead_id' in input) await assertLead(env, text(input.lead_id));
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const field of kind === 'lead' ? LEAD_FIELDS : PROJECT_FIELDS) {
    if (!(field in input)) continue;
    const value = text(input[field]);
    // A title is never blanked; every other field may be cleared.
    if (field === 'title' && !value) continue;
    sets.push(`${field} = ?`);
    binds.push(value);
  }
  if (kind === 'lead' && 'characteristics' in input) {
    const checklist = input.characteristics;
    sets.push('characteristics = ?');
    binds.push(checklist && typeof checklist === 'object' ? JSON.stringify(checklist) : null);
  }
  // Core's `is_internal` is D1's `internal`; the read names it `internal`.
  if (kind === 'project' && typeof input.is_internal === 'boolean') {
    sets.push('internal = ?');
    binds.push(input.is_internal ? 1 : 0);
  }
  // Who answers for it: stamped with who chose and when, as Core does.
  if ('responsible_email' in input) {
    sets.push('responsible_email = ?', 'responsible_set_by = ?', 'responsible_set_at = ?');
    binds.push(text(input.responsible_email)?.toLowerCase() ?? null, actor.trim().toLowerCase(), Date.now());
  }
  sets.push('updated_at = ?');
  binds.push(Date.now());
  await env.USAGE.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  if (kind === 'project' && Array.isArray(input.contact_ids)) {
    await replaceProjectContacts(env, id, input.contact_ids.filter((value): value is string => typeof value === 'string'));
  }
  return d1SubjectDetail(env, kind, id);
}

// ---------------------------------------------------------------------------
// The team, tasks and milestones (slice 4).
// ---------------------------------------------------------------------------

/**
 * `fetchCrmTeam` on D1: every human who has signed in to this workspace, by
 * person id, then every enrolled agent that is not frozen. An
 * agent can hold a task as a person can.
 */
export async function d1Team(env: Env): Promise<Array<{ id: string; name: string; email: string | null; kind: 'person' | 'agent' }>> {
  const { results } = await env.USAGE.prepare(
    `SELECT sub, person_id, name, email FROM people WHERE kind = 'human' ORDER BY name COLLATE NOCASE`,
  ).all<{ sub: string; person_id: string | null; name: string | null; email: string }>();
  const members: Array<{ id: string; name: string; email: string | null; kind: 'person' | 'agent' }> = [];
  for (const row of results) {
    const id = row.person_id ?? await ensurePersonId(env, row.sub);
    if (id) members.push({ id, name: row.name?.trim() || row.email, email: row.email, kind: 'person' });
  }
  for (const agent of await assignableAgents(env)) {
    const id = agent.person_id ?? await ensurePersonId(env, agent.sub);
    if (id) members.push({ id, name: agent.name?.trim() || agent.email, email: agent.email, kind: 'agent' });
  }
  return members;
}

/**
 * The agents a task can be assigned to: on the roster, with a `people` row,
 * and not frozen. An agent removed from the roster keeps the tasks it holds
 * but takes no new one.
 */
async function assignableAgents(env: Env): Promise<Array<{ sub: string; person_id: string | null; name: string | null; email: string }>> {
  const roster = new Set((await loadAgents(env)).map((agent) => agent.sub));
  if (roster.size === 0) return [];
  const { results } = await env.USAGE.prepare(
    `SELECT p.sub, p.person_id, p.name, p.email FROM people p
      WHERE p.kind = 'agent' AND NOT EXISTS (SELECT 1 FROM agent_freezes f WHERE f.agent_sub = p.sub)
      ORDER BY p.name COLLATE NOCASE`,
  ).all<{ sub: string; person_id: string | null; name: string | null; email: string }>();
  return results.filter((row) => roster.has(row.sub));
}

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  responsible_party: string;
  priority: string | null;
  due_at: number | null;
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  project_id: string | null;
  lead_id: string | null;
  organization_id: string | null;
  meeting_id: string | null;
  event_id: string | null;
  signals_account_id: string | null;
  contact_id: string | null;
  /** A JSON array of strings, or null (migration 0127). */
  tags: string | null;
  milestone_id: string | null;
  goal_id: string | null;
  updated_at: number;
  subject_title: string | null;
  github_owner: string | null;
  github_repo: string | null;
  github_issue_number: number | null;
  assignee_people_kind: string | null;
}

const TASK_SELECT = `
  SELECT t.*, a.name AS assignee_name, a.email AS assignee_email, a.kind AS assignee_people_kind,
         COALESCE(p.title, l.title, e.title, o.name) AS subject_title
  FROM tasks t
  LEFT JOIN people a ON a.person_id = t.assignee_id
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN leads l ON l.id = t.lead_id
  LEFT JOIN events e ON e.id = t.event_id
  LEFT JOIN organizations o ON o.id = t.organization_id AND t.project_id IS NULL AND t.lead_id IS NULL`;

/**
 * A task's tags, as Core's `text[]`. Stored as a JSON array (migration 0127);
 * a row with none has no `tags` key, as Core's rows before tags had.
 */
function tagsOf(value: string | null): { tags?: string[] } {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? { tags: parsed.filter((tag): tag is string => typeof tag === 'string') } : {};
  } catch {
    return {};
  }
}

/**
 * A task on an event or a Signals account is not a partner's, even when Core
 * echoed the account's organization on it (`crmTaskSchema.organization_id`).
 */
const NO_OTHER_PLACE = 't.project_id IS NULL AND t.lead_id IS NULL AND t.event_id IS NULL AND t.signals_account_id IS NULL';

function taskOf(row: TaskRow): CrmTask {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    responsible_party: row.responsible_party,
    assignee_id: row.assignee_id,
    assignee_name: row.assignee_name,
    assignee_email: row.assignee_email,
    due_date: iso(row.due_at),
    priority: row.priority,
    project_id: row.project_id,
    lead_id: row.lead_id,
    event_id: row.event_id,
    organization_id: row.organization_id,
    meeting_id: row.meeting_id,
    signals_account_id: row.signals_account_id,
    contact_id: row.contact_id,
    ...tagsOf(row.tags),
    goal_id: row.goal_id,
    github_owner: row.github_owner,
    github_repo: row.github_repo,
    github_issue_number: row.github_issue_number,
    assignee_kind: row.assignee_id ? (row.assignee_people_kind === 'agent' ? 'agent' : 'person') : null,
    updated_at: iso(row.updated_at),
  };
}

function myTaskOf(row: TaskRow): CrmMyTask {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    responsible_party: row.responsible_party,
    due_date: iso(row.due_at),
    priority: row.priority,
    project_id: row.project_id,
    lead_id: row.lead_id,
    event_id: row.event_id,
    organization_id: row.organization_id,
    meeting_id: row.meeting_id,
    signals_account_id: row.signals_account_id,
    contact_id: row.contact_id,
    subject_title: row.subject_title,
    github_owner: row.github_owner,
    github_repo: row.github_repo,
    github_issue_number: row.github_issue_number,
    updated_at: iso(row.updated_at),
  };
}

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');

/**
 * `fetchCrmTasks` on D1: one place's tasks, open work unless `includeDone`.
 * An event's and a Signals account's tasks are here once Envisioning's
 * `tasks` group has moved.
 */
export async function d1Tasks(
  env: Env,
  subject: { projectId?: string | null; leadId?: string | null; eventId?: string | null; organizationId?: string | null; meetingId?: string | null; signalsAccountId?: string | null; includeDone?: boolean; limit?: number },
): Promise<CrmTask[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (subject.projectId) { where.push('t.project_id = ?'); binds.push(subject.projectId); }
  else if (subject.leadId) { where.push('t.lead_id = ?'); binds.push(subject.leadId); }
  else if (subject.eventId) { where.push('t.event_id = ?'); binds.push(subject.eventId); }
  else if (subject.signalsAccountId) { where.push('t.signals_account_id = ?'); binds.push(subject.signalsAccountId); }
  else if (subject.organizationId) { where.push(`t.organization_id = ? AND ${NO_OTHER_PLACE}`); binds.push(subject.organizationId); }
  else if (subject.meetingId) { where.push(`t.meeting_id = ? AND ${NO_OTHER_PLACE} AND t.organization_id IS NULL`); binds.push(subject.meetingId); }
  if (!subject.includeDone) { where.push(`t.status IN (${placeholders(OPEN_TASK_STATUSES)})`); binds.push(...OPEN_TASK_STATUSES); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(subject.limit ?? 200, 500));
  const { results } = await env.USAGE.prepare(`${TASK_SELECT} ${clause} ORDER BY t.due_at IS NULL, t.due_at, t.updated_at DESC LIMIT ?`)
    .bind(...binds, limit).all<TaskRow>();
  return results.map(taskOf);
}

/** `fetchCrmPartnerTasks` on D1: every partner's own tasks. */
export async function d1PartnerTasks(env: Env, options: { includeDone?: boolean; limit?: number } = {}): Promise<CrmTask[]> {
  const binds: unknown[] = [];
  let open = '';
  if (!options.includeDone) { open = `AND t.status IN (${placeholders(OPEN_TASK_STATUSES)})`; binds.push(...OPEN_TASK_STATUSES); }
  const { results } = await env.USAGE.prepare(
    `${TASK_SELECT} WHERE t.organization_id IS NOT NULL AND ${NO_OTHER_PLACE} ${open}
     ORDER BY t.updated_at DESC LIMIT ?`,
  ).bind(...binds, Math.max(1, Math.min(options.limit ?? 500, 500))).all<TaskRow>();
  return results.map(taskOf);
}

/** `fetchCrmTasksByStatus` on D1: every task with one status, newest change first. */
export async function d1TasksByStatus(env: Env, status: string, limit = 100, offset = 0): Promise<CrmTask[]> {
  const { results } = await env.USAGE.prepare(`${TASK_SELECT} WHERE t.status = ?1 ORDER BY t.updated_at DESC LIMIT ?2 OFFSET ?3`)
    .bind(status, Math.max(1, Math.min(limit, 500)), Math.max(0, offset)).all<TaskRow>();
  return results.map(taskOf);
}

/** `fetchCrmTask` on D1. */
export async function d1Task(env: Env, id: string): Promise<CrmTask | null> {
  const row = await env.USAGE.prepare(`${TASK_SELECT} WHERE t.id = ?1`).bind(id).first<TaskRow>();
  return row ? taskOf(row) : null;
}

/** `fetchCrmMyWork` on D1: open tasks assigned to this address. GitHub issues are not matched on a D1 workspace yet. */
export async function d1MyWork(env: Env, assigneeEmail: string): Promise<{ tasks: CrmMyTask[]; issues: CrmIssue[]; matched: boolean; github_login: string | null }> {
  const personId = await personIdForEmail(env, assigneeEmail);
  if (!personId) return { tasks: [], issues: [], matched: false, github_login: null };
  const { results } = await env.USAGE.prepare(
    `${TASK_SELECT} WHERE t.assignee_id = ? AND t.status IN (${placeholders(OPEN_TASK_STATUSES)})
     ORDER BY t.due_at IS NULL, t.due_at, t.updated_at DESC LIMIT 500`,
  ).bind(personId, ...OPEN_TASK_STATUSES).all<TaskRow>();
  return { tasks: results.map(myTaskOf), issues: [], matched: false, github_login: null };
}

/** `fetchCrmWorkItems` on D1: dated tasks and milestones between `start` and `end`, for the calendar. */
export async function d1WorkItems(env: Env, input: { start: string; end: string; includeDone?: boolean }): Promise<CrmWorkItem[]> {
  const start = Date.parse(input.start);
  const end = Date.parse(input.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new ControlError('A start and an end are required.', 400, 'invalid_request');
  const binds: unknown[] = [start, end];
  let open = '';
  if (!input.includeDone) { open = `AND t.status IN (${placeholders(OPEN_TASK_STATUSES)})`; binds.push(...OPEN_TASK_STATUSES); }
  const [tasks, milestones] = await Promise.all([
    env.USAGE.prepare(`${TASK_SELECT} WHERE t.due_at >= ? AND t.due_at < ? ${open} ORDER BY t.due_at`).bind(...binds).all<TaskRow>(),
    env.USAGE.prepare(
      `SELECT m.*, p.title AS project_title FROM milestones m JOIN projects p ON p.id = m.project_id
       WHERE m.due_at >= ?1 AND m.due_at < ?2 ${input.includeDone ? '' : "AND m.status != 'completed'"} ORDER BY m.due_at`,
    ).bind(start, end).all<{ id: string; project_id: string; project_title: string; title: string; status: string; due_at: number; updated_at: number }>(),
  ]);
  return [
    ...tasks.results.map((row): CrmWorkItem => ({
      id: row.id,
      kind: 'task',
      assignee_id: row.assignee_id,
      assignee_name: row.assignee_name,
      assignee_email: row.assignee_email,
      title: row.title,
      notes: row.notes,
      status: row.status,
      due_at: iso(row.due_at),
      priority: row.priority,
      responsible_party: row.responsible_party,
      project_id: row.project_id,
      project_title: row.project_id ? row.subject_title : null,
      lead_id: row.lead_id,
      organization_id: row.organization_id,
      organization_title: row.organization_id && !row.project_id && !row.lead_id ? row.subject_title : null,
      milestone_id: row.milestone_id,
      updated_at: iso(row.updated_at),
    })),
    ...milestones.results.map((row): CrmWorkItem => ({
      id: row.id,
      kind: 'milestone',
      assignee_id: null,
      assignee_name: null,
      assignee_email: null,
      title: row.title,
      notes: null,
      status: row.status,
      due_at: iso(row.due_at),
      priority: null,
      responsible_party: 'team',
      project_id: row.project_id,
      project_title: row.project_title,
      lead_id: null,
      milestone_id: row.id,
      updated_at: iso(row.updated_at),
    })),
  ];
}

interface TaskWrite {
  title?: string;
  notes?: string | null;
  status?: string;
  responsible_party?: string;
  assigned_to?: string | null;
  due_date?: string | null;
  project_id?: string | null;
  lead_id?: string | null;
  event_id?: string | null;
  organization_id?: string | null;
  meeting_id?: string | null;
  signals_account_id?: string | null;
  goal_id?: string | null;
  actor_email?: string | null;
}

const PLACE_KEYS = ['project_id', 'lead_id', 'event_id', 'signals_account_id', 'organization_id', 'meeting_id'] as const;

/**
 * The one place a write names, checked to exist. On a Core workspace whose
 * `tasks` group is on D1, an event and a Signals account are
 * external references: events follow WORK_STORE and Signals keeps its
 * accounts, so neither is in this D1. A D1 workspace has its own events and
 * no Signals.
 */
async function placeOf(env: Env, input: TaskWrite): Promise<Partial<Record<(typeof PLACE_KEYS)[number], string>> | null> {
  const named = PLACE_KEYS.filter((key) => typeof input[key] === 'string' && input[key]);
  if (named.length === 0) return null;
  const key = named[0]!;
  const id = input[key]!;
  if (key === 'signals_account_id' && !usesCore(env)) {
    throw new ControlError('Signals accounts are not on this workspace.', 400, 'invalid_request');
  }
  const table = key === 'project_id' ? 'projects'
    : key === 'lead_id' ? 'leads'
    : key === 'organization_id' ? 'organizations'
    : key === 'event_id' && !usesCore(env) ? 'events'
    : null;
  if (table) {
    const row = await env.USAGE.prepare(`SELECT id FROM ${table} WHERE id = ?1`).bind(id).first();
    if (!row) throw new ControlError('That subject does not exist on this workspace.', 400, 'invalid_request');
  }
  return { [key]: id };
}

async function assertAssignee(env: Env, personId: string | null | undefined): Promise<string | null> {
  if (!personId) return null;
  const row = await env.USAGE.prepare('SELECT sub, kind FROM people WHERE person_id = ?1').bind(personId).first<{ sub: string; kind: string }>();
  if (!row) throw new ControlError('That person is not on this workspace.', 400, 'invalid_request');
  // An agent holds work only while it is enrolled and not frozen.
  if (row.kind === 'agent' && !(await assignableAgents(env)).some((agent) => agent.sub === row.sub)) {
    throw new ControlError('That agent cannot take work now.', 400, 'invalid_request');
  }
  return personId;
}

function dueAt(value: string | null | undefined): number | null {
  if (!value) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new ControlError('That date is not valid.', 400, 'invalid_request');
  return millis;
}

const isFinished = (status: string) => (FINISHED_TASK_STATUSES as readonly string[]).includes(status);

/** `createCrmTask` on D1. The route already checked the input shape (crmTaskCreateSchema). */
/**
 * File on GitHub on D1: only a project's own task that is not
 * filed yet. Checked before the issue exists, so a refusal files nothing.
 */
export async function d1AssertTaskFileable(env: Env, taskId: string, projectId: string): Promise<void> {
  const row = await env.USAGE.prepare('SELECT project_id, github_issue_number FROM tasks WHERE id = ?1')
    .bind(taskId).first<{ project_id: string | null; github_issue_number: number | null }>();
  if (!row || row.project_id !== projectId || row.github_issue_number !== null) {
    throw new ControlError('This task can’t be filed on GitHub.', 409, 'invalid_request');
  }
}

/** The issue a task was filed as. Only an unlinked task takes one. */
export async function d1LinkTaskToIssue(
  env: Env,
  taskId: string,
  issue: { owner: string; repo: string; number: number },
): Promise<void> {
  await env.USAGE.prepare(
    `UPDATE tasks SET github_owner = ?2, github_repo = ?3, github_issue_number = ?4, updated_at = ?5
      WHERE id = ?1 AND github_issue_number IS NULL`,
  ).bind(taskId, issue.owner, issue.repo, issue.number, Date.now()).run();
}

export async function d1CreateTask(env: Env, input: TaskWrite & { title: string }): Promise<CrmTask> {
  const place = await placeOf(env, input);
  if (!place) throw new ControlError('A task needs a project, a lead, a partner, an event or a meeting.', 400, 'invalid_request');
  const actor = input.actor_email ? await personIdForEmail(env, input.actor_email) : null;
  const id = crypto.randomUUID();
  const now = Date.now();
  const status = input.status ?? 'pending';
  await env.USAGE.prepare(
    `INSERT INTO tasks (id, title, notes, status, responsible_party, due_at, assignee_id, project_id, lead_id,
                        organization_id, meeting_id, goal_id, created_by, updated_by, created_at, updated_at, finished_at,
                        event_id, signals_account_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14, ?14, ?15, ?16, ?17)`,
  ).bind(
    id, input.title.trim(), text(input.notes), status, input.responsible_party ?? 'team', dueAt(input.due_date),
    await assertAssignee(env, input.assigned_to), place.project_id ?? null, place.lead_id ?? null,
    place.organization_id ?? null, place.meeting_id ?? null, await assertGoal(env, input.goal_id), actor, now, isFinished(status) ? now : null,
    place.event_id ?? null, place.signals_account_id ?? null,
  ).run();
  const task = await d1Task(env, id);
  if (!task) throw new ControlError('The task was not saved.', 500);
  return task;
}

/** `updateCrmTask` on D1: only the fields present change; naming a place moves the task off every other. */
export async function d1UpdateTask(env: Env, id: string, input: TaskWrite): Promise<CrmTask> {
  const current = await env.USAGE.prepare('SELECT status FROM tasks WHERE id = ?1').bind(id).first<{ status: string }>();
  if (!current) throw new ControlError('Task not found.', 404, 'request_not_found');
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); binds.push(value); };
  if (input.title !== undefined && input.title.trim()) set('title', input.title.trim());
  if (input.notes !== undefined) set('notes', text(input.notes));
  if (input.responsible_party !== undefined) set('responsible_party', input.responsible_party);
  if (input.assigned_to !== undefined) set('assignee_id', await assertAssignee(env, input.assigned_to));
  if (input.due_date !== undefined) set('due_at', dueAt(input.due_date));
  if (input.goal_id !== undefined) set('goal_id', await assertGoal(env, input.goal_id));
  if (input.status !== undefined) {
    set('status', input.status);
    if (isFinished(input.status) && !isFinished(current.status)) set('finished_at', Date.now());
    if (!isFinished(input.status)) set('finished_at', null);
  }
  const place = await placeOf(env, input);
  if (place) for (const key of PLACE_KEYS) set(key, place[key] ?? null);
  const now = Date.now();
  set('updated_at', now);
  if (input.actor_email) set('updated_by', await personIdForEmail(env, input.actor_email));
  await env.USAGE.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  const task = await d1Task(env, id);
  if (!task) throw new ControlError('Task not found.', 404, 'request_not_found');
  return task;
}

/** Search hits from D1 past this are noise; the query narrows, not the page. */
const SEARCH_WORK_ROWS = 50;

/** A milestone as search reads it. Read only: Starlings edits no milestone. */
export interface D1MilestoneHit {
  id: string;
  title: string;
  project_id: string;
  project_title: string | null;
  due_at: number | null;
  notes: string | null;
}

/** A call as search reads it: the subject it is filed on, and the first contact. */
export interface D1CallHit {
  id: string;
  title: string;
  occurred_at: number;
  project_id: string | null;
  lead_id: string | null;
  organization_id: string | null;
  subject_title: string | null;
  contact_id: string | null;
  /** The summary, else the description: the text a hit may have matched in. */
  summary: string | null;
}

/**
 * Every task whose title or notes hold the needle, any status, any assignee
 *. Search reads it once the `tasks` group answers from D1;
 * before that, search finds the member's own tasks only.
 */
export async function d1SearchTasks(env: Env, needle: string): Promise<Array<CrmTask & { subject_title: string | null }>> {
  const { results } = await env.USAGE.prepare(
    `${TASK_SELECT} WHERE (t.title LIKE ?1 ESCAPE '\\' OR t.notes LIKE ?1 ESCAPE '\\') ORDER BY t.updated_at DESC LIMIT ?2`,
  ).bind(like(needle), SEARCH_WORK_ROWS).all<TaskRow>();
  return results.map((row) => ({ ...taskOf(row), subject_title: row.subject_title }));
}

/** Every milestone whose title or notes hold the needle, with its project's title. */
export async function d1SearchMilestones(env: Env, needle: string): Promise<D1MilestoneHit[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT m.id, m.title, m.project_id, p.title AS project_title, m.due_at, m.notes
     FROM milestones m LEFT JOIN projects p ON p.id = m.project_id
     WHERE m.title LIKE ?1 ESCAPE '\\' OR m.notes LIKE ?1 ESCAPE '\\'
     ORDER BY m.due_at IS NULL, m.due_at DESC LIMIT ?2`,
  ).bind(like(needle), SEARCH_WORK_ROWS).all<D1MilestoneHit>();
  return results;
}

/**
 * Every call whose title, summary or description holds the needle, newest
 * first, once the `interactions` group answers from D1. Its subject is the
 * project, then the lead, then the organization it is filed on.
 */
export async function d1SearchCalls(env: Env, needle: string): Promise<D1CallHit[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT i.id, i.title, i.occurred_at, sp.subject_id AS project_id, sl.subject_id AS lead_id,
            COALESCE(so.subject_id, i.organization_id) AS organization_id,
            COALESCE(p.title, l.title, o.name) AS subject_title, COALESCE(i.summary_markdown, i.description) AS summary,
            COALESCE((SELECT ic.contact_id FROM interaction_contacts ic WHERE ic.interaction_id = i.id ORDER BY ic.contact_id LIMIT 1), i.contact_id) AS contact_id
     FROM interactions i
     LEFT JOIN interaction_subjects sp ON sp.interaction_id = i.id AND sp.subject_kind = 'project'
     LEFT JOIN interaction_subjects sl ON sl.interaction_id = i.id AND sl.subject_kind = 'lead'
     LEFT JOIN interaction_subjects so ON so.interaction_id = i.id AND so.subject_kind = 'organization'
     LEFT JOIN projects p ON p.id = sp.subject_id
     LEFT JOIN leads l ON l.id = sl.subject_id
     LEFT JOIN organizations o ON o.id = COALESCE(so.subject_id, i.organization_id)
     WHERE (i.title LIKE ?1 ESCAPE '\\' OR i.summary_markdown LIKE ?1 ESCAPE '\\' OR i.description LIKE ?1 ESCAPE '\\')
       AND i.is_personal = 0
     GROUP BY i.id
     ORDER BY i.occurred_at DESC LIMIT ?2`,
  ).bind(like(needle), SEARCH_WORK_ROWS).all<D1CallHit>();
  return results;
}

/**
 * `deleteCrmTask` on D1: the row goes, and the trail records who
 * deleted it. A favorite or a support line that names the task stays: their
 * readers already skip a task that no longer answers.
 */
export async function d1DeleteTask(env: Env, id: string, actorEmail: string | null): Promise<CrmTask> {
  const task = await d1Task(env, id);
  if (!task) throw new ControlError('Task not found.', 404, 'request_not_found');
  await env.USAGE.batch([
    env.USAGE.prepare('DELETE FROM tasks WHERE id = ?1').bind(id),
    workActivityStatement(env, { actor: actorEmail, table: 'tasks', id, action: 'delete', label: task.title }),
  ]);
  return task;
}

// ---------------------------------------------------------------------------
// Goals, decisions, favorites and repository links (slice 5, migration 0075).
// ---------------------------------------------------------------------------

interface GoalRow {
  id: string;
  project_id: string;
  title: string;
  status: CrmGoal['status'];
  target_date: string | null;
  owner: string | null;
  owner_name: string | null;
  owner_email: string | null;
  created_by: string | null;
  created_by_email: string | null;
  created_at: number;
  updated_at: number;
  project_title: string | null;
}

const GOAL_SELECT = `
  SELECT g.*, o.name AS owner_name, o.email AS owner_email, c.email AS created_by_email, p.title AS project_title
  FROM goals g
  LEFT JOIN people o ON o.person_id = g.owner
  LEFT JOIN people c ON c.person_id = g.created_by
  LEFT JOIN projects p ON p.id = g.project_id`;

function goalOf(row: GoalRow, withProject = false): CrmGoal {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    status: row.status,
    target_date: row.target_date,
    owner: row.owner,
    owner_name: row.owner ? (row.owner_name?.trim() || row.owner_email) : null,
    owner_email: row.owner_email,
    created_by: row.created_by,
    created_by_email: row.created_by_email,
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at),
    ...(withProject ? { project_title: row.project_title } : {}),
  };
}

/** `fetchCrmGoals` on D1: one project's goals, open ones unless `includeClosed`. */
export async function d1Goals(env: Env, projectId: string, includeClosed: boolean): Promise<CrmGoal[]> {
  const { results } = await env.USAGE.prepare(
    `${GOAL_SELECT} WHERE g.project_id = ?1 ${includeClosed ? '' : "AND g.status = 'open'"} ORDER BY g.updated_at DESC`,
  ).bind(projectId).all<GoalRow>();
  return results.map((row) => goalOf(row));
}

/** `fetchAllCrmGoals` on D1: every open goal, newest change first, with its project's title. */
export async function d1AllGoals(env: Env, limit: number): Promise<CrmGoal[]> {
  const { results } = await env.USAGE.prepare(`${GOAL_SELECT} WHERE g.status = 'open' ORDER BY g.updated_at DESC LIMIT ?1`)
    .bind(Math.max(1, Math.min(limit, 500))).all<GoalRow>();
  return results.map((row) => goalOf(row, true));
}

async function d1Goal(env: Env, id: string): Promise<CrmGoal> {
  const row = await env.USAGE.prepare(`${GOAL_SELECT} WHERE g.id = ?1`).bind(id).first<GoalRow>();
  if (!row) throw new ControlError('Goal not found.', 404, 'request_not_found');
  return goalOf(row);
}

/** `createCrmGoal` on D1. The route already checked the input shape (crmGoalCreateSchema). */
export async function d1CreateGoal(env: Env, input: CrmGoalCreateInput & { actor_email: string }): Promise<CrmGoal> {
  const project = await env.USAGE.prepare('SELECT id FROM projects WHERE id = ?1').bind(input.project_id).first();
  if (!project) throw new ControlError('That project does not exist on this workspace.', 400, 'invalid_request');
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO goals (id, project_id, title, status, target_date, owner, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
  ).bind(
    id, input.project_id, input.title.trim(), input.status ?? 'open', input.target_date ?? null,
    await assertAssignee(env, input.owner), await personIdForEmail(env, input.actor_email), now,
  ).run();
  return d1Goal(env, id);
}

/** `updateCrmGoal` on D1: only the fields present change. */
export async function d1UpdateGoal(env: Env, id: string, input: CrmGoalUpdateInput): Promise<CrmGoal> {
  const exists = await env.USAGE.prepare('SELECT id FROM goals WHERE id = ?1').bind(id).first();
  if (!exists) throw new ControlError('Goal not found.', 404, 'request_not_found');
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); binds.push(value); };
  if (input.title !== undefined) set('title', input.title.trim());
  if (input.status !== undefined) set('status', input.status);
  if (input.target_date !== undefined) set('target_date', input.target_date);
  if (input.owner !== undefined) set('owner', await assertAssignee(env, input.owner));
  set('updated_at', Date.now());
  await env.USAGE.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  return d1Goal(env, id);
}

interface DecisionRow {
  id: string;
  subject_kind: CrmDecision['subject_kind'];
  subject_id: string;
  body: string;
  source: CrmDecision['source'];
  source_ref: string | null;
  goal_id: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_by_email: string | null;
  decided_at: number;
  subject_title: string | null;
}

const DECISION_SELECT = `
  SELECT d.*, a.name AS decided_by_name, a.email AS decided_by_email,
         CASE d.subject_kind
           WHEN 'project' THEN (SELECT title FROM projects WHERE id = d.subject_id)
           WHEN 'lead' THEN (SELECT title FROM leads WHERE id = d.subject_id)
           WHEN 'organization' THEN (SELECT name FROM organizations WHERE id = d.subject_id)
         END AS subject_title
  FROM decisions d
  LEFT JOIN people a ON a.person_id = d.decided_by`;

function decisionOf(row: DecisionRow, withSubject = false): CrmDecision {
  return {
    id: row.id,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    body: row.body,
    source: row.source,
    source_ref: row.source_ref,
    goal_id: row.goal_id,
    decided_by: row.decided_by,
    decided_by_name: row.decided_by ? (row.decided_by_name?.trim() || row.decided_by_email) : null,
    decided_by_email: row.decided_by_email,
    decided_at: iso(row.decided_at)!,
    ...(withSubject ? { subject_title: row.subject_title } : {}),
  };
}

/** `fetchCrmDecisions` on D1: one subject's decisions, newest first. */
export async function d1Decisions(env: Env, subject: { kind: CrmSubjectKind; id: string }, limit: number): Promise<CrmDecision[]> {
  const { results } = await env.USAGE.prepare(
    `${DECISION_SELECT} WHERE d.subject_kind = ?1 AND d.subject_id = ?2 ORDER BY d.decided_at DESC LIMIT ?3`,
  ).bind(subject.kind, subject.id, Math.max(1, Math.min(limit, 200))).all<DecisionRow>();
  return results.map((row) => decisionOf(row));
}

/** `fetchRecentCrmDecisions` on D1: the latest decisions on every subject, with the subject's title. */
export async function d1RecentDecisions(env: Env, limit: number): Promise<CrmDecision[]> {
  const { results } = await env.USAGE.prepare(`${DECISION_SELECT} ORDER BY d.decided_at DESC LIMIT ?1`)
    .bind(Math.max(1, Math.min(limit, 500))).all<DecisionRow>();
  return results.map((row) => decisionOf(row, true));
}

/** The table that holds a subject of this kind; events are Envisioning's CMS and have none here. */
function subjectTable(kind: CrmSubjectKind): string | null {
  return kind === 'project' ? 'projects' : kind === 'lead' ? 'leads' : kind === 'organization' ? 'organizations' : null;
}

/** `createCrmDecision` on D1. The route already checked the input shape (crmDecisionCreateSchema). */
export async function d1CreateDecision(env: Env, input: CrmDecisionCreateInput & { actor_email: string }): Promise<CrmDecision> {
  const table = subjectTable(input.subject_kind);
  const subject = table ? await env.USAGE.prepare(`SELECT id FROM ${table} WHERE id = ?1`).bind(input.subject_id).first() : null;
  if (!subject) throw new ControlError('That subject does not exist on this workspace.', 400, 'invalid_request');
  await assertGoal(env, input.goal_id);
  const id = crypto.randomUUID();
  await env.USAGE.prepare(
    `INSERT INTO decisions (id, subject_kind, subject_id, body, source, source_ref, goal_id, decided_by, decided_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    id, input.subject_kind, input.subject_id, input.body.trim(), input.source, input.source_ref ?? null,
    input.goal_id ?? null, await personIdForEmail(env, input.actor_email), Date.now(),
  ).run();
  const row = await env.USAGE.prepare(`${DECISION_SELECT} WHERE d.id = ?1`).bind(id).first<DecisionRow>();
  if (!row) throw new ControlError('The decision was not saved.', 500);
  return decisionOf(row);
}

/** The member a favorite belongs to. A signed-in member always has a person id on a D1 workspace. */
async function favoriteOwner(env: Env, actorEmail: string): Promise<string> {
  const personId = await personIdForEmail(env, actorEmail);
  if (!personId) throw new ControlError('That person is not on this workspace.', 404, 'person_not_found');
  return personId;
}

/** `listCoreFavorites` on D1: one member's favorites, newest first. */
export async function d1Favorites(env: Env, actorEmail: string): Promise<FavoriteRow[]> {
  const { results } = await env.USAGE.prepare(
    'SELECT kind, target_ref, created_at FROM favorites WHERE person_id = ?1 ORDER BY created_at DESC, kind, target_ref',
  ).bind(await favoriteOwner(env, actorEmail)).all<{ kind: string; target_ref: string; created_at: number }>();
  return results.map((row) => ({ kind: row.kind, target_ref: row.target_ref, created_at: iso(row.created_at)! }));
}

/** `addCoreFavorite` on D1. Adding one that exists answers the one that exists. */
export async function d1AddFavorite(env: Env, actorEmail: string, target: FavoriteTarget): Promise<FavoriteRow> {
  const personId = await favoriteOwner(env, actorEmail);
  await env.USAGE.prepare('INSERT OR IGNORE INTO favorites (person_id, kind, target_ref, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(personId, target.kind, target.target_ref, Date.now()).run();
  const row = await env.USAGE.prepare('SELECT created_at FROM favorites WHERE person_id = ?1 AND kind = ?2 AND target_ref = ?3')
    .bind(personId, target.kind, target.target_ref).first<{ created_at: number }>();
  return { kind: target.kind, target_ref: target.target_ref, created_at: iso(row?.created_at ?? Date.now())! };
}

/** `removeCoreFavorite` on D1. Removing one that is not there is not an error. */
export async function d1RemoveFavorite(env: Env, actorEmail: string, target: FavoriteTarget): Promise<void> {
  await env.USAGE.prepare('DELETE FROM favorites WHERE person_id = ?1 AND kind = ?2 AND target_ref = ?3')
    .bind(await favoriteOwner(env, actorEmail), target.kind, target.target_ref).run();
}

/**
 * One favorite set or cleared, as a statement, for the old subject-star
 * route (`writeSubjectState`), which writes its changes in one batch.
 */
export function d1FavoriteStatement(env: Env, personId: string, kind: string, targetRef: string, starred: boolean, at: number): D1PreparedStatement {
  return starred
    ? env.USAGE.prepare('INSERT OR IGNORE INTO favorites (person_id, kind, target_ref, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(personId, kind, targetRef, at)
    : env.USAGE.prepare('DELETE FROM favorites WHERE person_id = ?1 AND kind = ?2 AND target_ref = ?3')
      .bind(personId, kind, targetRef);
}

interface RepoRow {
  project_id: string;
  owner: string;
  repo: string;
  label: string | null;
  milestone: string | null;
  is_primary: number;
}

function repoOf(row: Omit<RepoRow, 'project_id'>): CrmGithubRepo {
  return {
    id: `${row.owner}/${row.repo}`,
    owner: row.owner,
    repo: row.repo,
    label: row.label,
    milestone: row.milestone,
    is_primary: row.is_primary === 1,
  };
}

/** `fetchCrmProjectRepos` on D1: the repositories linked to one project, the primary one first. */
export async function d1ProjectRepos(env: Env, projectId: string): Promise<CrmGithubRepo[]> {
  const { results } = await env.USAGE.prepare(
    'SELECT * FROM project_github_repos WHERE project_id = ?1 ORDER BY is_primary DESC, created_at',
  ).bind(projectId).all<RepoRow>();
  return results.map(repoOf);
}

/**
 * `fetchCrmGithubRepos` on D1. Without Meet's GitHub App there is no list of
 * every repository to search, so the picker gets the repositories already
 * linked to a project on this workspace.
 */
export async function d1GithubRepos(env: Env, query: string): Promise<CrmGithubRepo[]> {
  const needle = query.trim();
  const statement = env.USAGE.prepare(
    `SELECT owner, repo, NULL AS label, NULL AS milestone, 0 AS is_primary FROM project_github_repos
     ${needle ? `WHERE (owner || '/' || repo) LIKE ?1 ESCAPE '\\'` : ''}
     GROUP BY owner, repo ORDER BY MAX(created_at) DESC LIMIT 50`,
  );
  const { results } = await (needle ? statement.bind(like(needle)) : statement).all<Omit<RepoRow, 'project_id'>>();
  return results.map(repoOf);
}

/**
 * `createCrmProjectRepo` on D1. Linking a repository that is linked already
 * changes its label, milestone and primary flag. A project has one primary
 * repository: the first link, or the one a link names primary.
 */
export async function d1CreateProjectRepo(
  env: Env,
  input: { project_id: string; owner: string; repo: string; label?: string | null | undefined; milestone?: string | null | undefined; is_primary?: boolean | undefined },
  actor: string,
): Promise<CrmGithubRepo> {
  const project = await env.USAGE.prepare('SELECT id FROM projects WHERE id = ?1').bind(input.project_id).first();
  if (!project) throw new ControlError('That project does not exist on this workspace.', 400, 'invalid_request');
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  const primaryNow = await env.USAGE.prepare('SELECT owner, repo FROM project_github_repos WHERE project_id = ?1 AND is_primary = 1')
    .bind(input.project_id).first<{ owner: string; repo: string }>();
  const primary = input.is_primary === true || !primaryNow || (primaryNow.owner === owner && primaryNow.repo === repo);
  const statements: D1PreparedStatement[] = [];
  if (primary) {
    statements.push(env.USAGE.prepare('UPDATE project_github_repos SET is_primary = 0 WHERE project_id = ?1').bind(input.project_id));
  }
  statements.push(env.USAGE.prepare(
    `INSERT INTO project_github_repos (project_id, owner, repo, label, milestone, is_primary, linked_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (project_id, owner, repo) DO UPDATE SET
       label = excluded.label, milestone = excluded.milestone, is_primary = excluded.is_primary`,
  ).bind(input.project_id, owner, repo, text(input.label), text(input.milestone), primary ? 1 : 0,
    await personIdForEmail(env, actor), Date.now()));
  await env.USAGE.batch(statements);
  const row = await env.USAGE.prepare('SELECT * FROM project_github_repos WHERE project_id = ?1 AND owner = ?2 AND repo = ?3')
    .bind(input.project_id, owner, repo).first<RepoRow>();
  if (!row) throw new ControlError('The repository link was not saved.', 500);
  return repoOf(row);
}

// ---------------------------------------------------------------------------
// The meeting log (slice 6, migration 0076).
// ---------------------------------------------------------------------------

/** About the first lines of what was said, as Core's `transcript_preview`. */
const TRANSCRIPT_PREVIEW_CHARS = 500;
const SUMMARY_PREVIEW_CHARS = 200;

/**
 * Where a meeting is filed, as subject links; a status, internal, personal or
 * uncategorized meeting has none. An event is the CMS's, so it is linked by
 * id alone (`table` null).
 */
function meetingSubject(payload: MeetingLogPayload): { kind: 'lead' | 'project' | 'organization' | 'event'; id: string; table: string | null } | null {
  if (payload.meeting_kind === 'lead' && payload.lead_id) return { kind: 'lead', id: payload.lead_id, table: 'leads' };
  if (payload.meeting_kind === 'project' && payload.project_id) return { kind: 'project', id: payload.project_id, table: 'projects' };
  if (payload.meeting_kind === 'event' && payload.event_id) return { kind: 'event', id: payload.event_id, table: null };
  if (payload.meeting_kind === 'partner' && payload.partner_organization_id) {
    return { kind: 'organization', id: payload.partner_organization_id, table: 'organizations' };
  }
  return null;
}

function millis(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A booking's interaction (`d1FileBookingInteraction`), the row a call on its link merges into. */
export const BOOKING_INTERACTION_SOURCE = 'calendar_booking';

interface MeetingLogRow { id: string; title: string; source: string; external_id: string }

/**
 * The row this meeting writes: its own (`source`, `external_id`), or the
 * booking interaction it merged into before, or the booking interaction of
 * a booking token in the call, as Core's meeting log merges a call into its
 * booking (`meet-meeting-log.ts`). Core's copied rows keep the token and the
 * meeting id in `metadata`.
 */
async function meetingLogRow(env: Env, source: string, meetingId: string, bookingTokens: readonly string[]): Promise<MeetingLogRow | null> {
  const own = await env.USAGE.prepare(
    `SELECT id, title, source, external_id FROM interactions
      WHERE (source = ?1 AND external_id = ?2) OR (source = ?3 AND json_extract(metadata, '$.meeting_id') = ?2)
      ORDER BY source = ?1 DESC LIMIT 1`,
  ).bind(source, meetingId, BOOKING_INTERACTION_SOURCE).first<MeetingLogRow>();
  if (own || bookingTokens.length === 0 || source === 'granola') return own ?? null;
  return env.USAGE.prepare(
    `SELECT id, title, source, external_id FROM interactions
      WHERE source = ?1 AND (external_id IN (SELECT value FROM json_each(?2))
        OR json_extract(metadata, '$.cancellation_token') IN (SELECT value FROM json_each(?2)))
      ORDER BY occurred_at DESC LIMIT 1`,
  ).bind(BOOKING_INTERACTION_SOURCE, JSON.stringify([...new Set(bookingTokens)])).first<MeetingLogRow>();
}

/**
 * `postMeetingLog` on D1: one meeting's interaction, written in place.
 * The `started` phase opens the row (`in_progress`) and moves its filing;
 * the `ended` phase writes the title, the notes, the transcript's first
 * lines and its document, and sets `logged`. A redelivery updates the same
 * row (`source`, `external_id`), so the delivery ledger can retry it. A call
 * on a booking's link writes into the booking's interaction
 * (`bookingTokens`), which keeps its source and its token.
 *
 * Core's meaning holds for the Granola bridge's kinds: a
 * personal meeting is its owner's row (`is_personal`, `owner_email`) with a
 * title and a date and nothing else, and an event filing links the event.
 * An unfiled row takes the organization its contacts share, as Core infers
 * it. Answers the cache keys of the subject it is filed under.
 */
export async function d1WriteMeetingLog(
  env: Env,
  payload: MeetingLogPayload,
  bookingTokens: readonly string[] = [],
): Promise<CoreCacheKey[]> {
  const source = payload.source ?? 'meet_envisioning';
  const existing = await meetingLogRow(env, source, payload.meeting_id, bookingTokens);
  const id = existing?.id ?? crypto.randomUUID();
  const rowSource = existing?.source ?? source;
  const rowExternalId = existing?.external_id ?? payload.meeting_id;
  const now = Date.now();
  const startedAt = millis(payload.started_at) ?? now;
  const personal = payload.meeting_kind === 'personal';
  const granola = source === 'granola';
  const channel = granola ? 'granola' : 'meet';
  const statements: D1PreparedStatement[] = [];

  if (payload.phase === 'ended' || granola) {
    const transcript = personal ? '' : payload.transcript.map((segment) => segment.text.trim()).filter(Boolean).join(' ');
    statements.push(env.USAGE.prepare(
      `INSERT INTO interactions (id, type, title, status, channel, source, external_id, occurred_at, ended_at, summary_markdown,
                                 transcript_preview, transcript_url, transcript_document_id, url, meeting_kind, host_person_id,
                                 created_at, updated_at)
       VALUES (?1, 'meeting', ?2, 'logged', ?15, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
       ON CONFLICT (source, external_id) DO UPDATE SET
         title = excluded.title, status = 'logged', occurred_at = excluded.occurred_at, ended_at = excluded.ended_at,
         summary_markdown = excluded.summary_markdown, transcript_preview = excluded.transcript_preview,
         transcript_url = excluded.transcript_url, transcript_document_id = excluded.transcript_document_id,
         url = excluded.url, meeting_kind = COALESCE(excluded.meeting_kind, interactions.meeting_kind),
         updated_at = excluded.updated_at`,
    ).bind(
      id, text(payload.title) ?? existing?.title ?? 'Untitled meeting', rowSource, rowExternalId, startedAt,
      millis(payload.ended_at), personal ? null : text(payload.summary_markdown),
      transcript ? transcript.slice(0, TRANSCRIPT_PREVIEW_CHARS) : null,
      personal ? null : payload.transcript_url, personal ? null : payload.transcript_document_id, payload.permalink,
      payload.meeting_kind ?? null, await personIdForEmail(env, payload.host_email), now, channel,
    ));
  } else {
    // A started phase never overwrites what an ended one wrote: only the filing moves.
    statements.push(env.USAGE.prepare(
      `INSERT INTO interactions (id, type, title, status, channel, source, external_id, occurred_at, url, meeting_kind,
                                 host_person_id, created_at, updated_at)
       VALUES (?1, 'meeting', ?2, 'in_progress', ?10, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT (source, external_id) DO UPDATE SET
         meeting_kind = COALESCE(excluded.meeting_kind, interactions.meeting_kind), updated_at = excluded.updated_at`,
    ).bind(
      id, existing?.title ?? 'Untitled meeting', rowSource, rowExternalId, startedAt, payload.permalink,
      payload.meeting_kind ?? null, await personIdForEmail(env, payload.host_email), now, channel,
    ));
  }
  if (existing && existing.source !== source) {
    // A merged booking row says which meeting wrote into it, as Core's does.
    statements.push(env.USAGE.prepare(
      `UPDATE interactions SET metadata = json_set(COALESCE(metadata, '{}'), '$.meeting_id', ?2) WHERE id = ?1`,
    ).bind(id, payload.meeting_id));
  }
  if (payload.meeting_kind !== undefined) {
    // Personal is the owner's alone; a filing as anything else makes the row the company's again.
    statements.push(env.USAGE.prepare(
      `UPDATE interactions SET is_personal = ?2, owner_email = ?3,
         organization_id = CASE WHEN ?2 = 1 THEN NULL ELSE organization_id END,
         contact_id = CASE WHEN ?2 = 1 THEN NULL ELSE contact_id END,
         description = CASE WHEN ?2 = 1 THEN NULL ELSE description END
       WHERE id = ?1`,
    ).bind(id, personal ? 1 : 0, personal ? payload.host_email.trim().toLowerCase() : null));
  }

  // Absent `meeting_kind` means "leave the filing as it is".
  const subject = meetingSubject(payload);
  const before = existing
    ? (await env.USAGE.prepare('SELECT subject_kind, subject_id FROM interaction_subjects WHERE interaction_id = ?1')
      .bind(id).all<{ subject_kind: string; subject_id: string }>()).results
    : [];
  if (payload.meeting_kind !== undefined) {
    statements.push(env.USAGE.prepare('DELETE FROM interaction_subjects WHERE interaction_id = ?1').bind(id));
    if (subject) {
      // Only a subject that exists on this workspace is linked. The filing is
      // the row's one subject, as Core's trigger on the singular column makes it.
      statements.push(subject.table
        ? env.USAGE.prepare(
          `INSERT OR IGNORE INTO interaction_subjects (interaction_id, subject_kind, subject_id, is_primary, source, created_at)
           SELECT ?1, ?2, id, 1, 'mirror', ?4 FROM ${subject.table} WHERE id = ?3`,
        ).bind(id, subject.kind, subject.id, now)
        : env.USAGE.prepare(
          `INSERT OR IGNORE INTO interaction_subjects (interaction_id, subject_kind, subject_id, is_primary, source, created_at)
           VALUES (?1, ?2, ?3, 1, 'mirror', ?4)`,
        ).bind(id, subject.kind, subject.id, now));
      if (subject.kind === 'organization') {
        statements.push(env.USAGE.prepare('UPDATE interactions SET organization_id = ?2 WHERE id = ?1').bind(id, subject.id));
      }
    }
  }
  // The contacts who were in the call: each participant whose
  // address is a contact's. A participant with no contact is not filed here;
  // making contacts from calls is RELATIONSHIPS.md slice 4. A personal
  // meeting links nobody.
  const addresses = personal ? [] : [...new Set((payload.participants ?? [])
    .map((participant) => participant.email?.trim().toLowerCase() ?? '')
    .filter(Boolean))].slice(0, 80);
  if (addresses.length > 0) {
    const marks = addresses.map((_, index) => `?${index + 3}`).join(', ');
    statements.push(env.USAGE.prepare(
      `INSERT OR IGNORE INTO interaction_contacts (interaction_id, contact_id, created_at)
       SELECT ?1, contact_id, ?2 FROM contact_emails WHERE email IN (${marks})
       UNION SELECT ?1, id, ?2 FROM contacts WHERE lower(email) IN (${marks})`,
    ).bind(id, now, ...addresses));
    // Core's inferred edge: the organization every linked contact shares,
    // only on a row that names none. It never overrides a person's choice.
    statements.push(env.USAGE.prepare(
      `UPDATE interactions SET organization_id = (
         SELECT MIN(c.organization_id) FROM interaction_contacts ic JOIN contacts c ON c.id = ic.contact_id WHERE ic.interaction_id = ?1)
       WHERE id = ?1 AND organization_id IS NULL AND is_personal = 0
         AND NOT EXISTS (SELECT 1 FROM interaction_contacts ic JOIN contacts c ON c.id = ic.contact_id
                          WHERE ic.interaction_id = ?1 AND c.organization_id IS NULL)
         AND (SELECT COUNT(DISTINCT c.organization_id) FROM interaction_contacts ic JOIN contacts c ON c.id = ic.contact_id
               WHERE ic.interaction_id = ?1) = 1`,
    ).bind(id));
  }
  if (personal) statements.push(env.USAGE.prepare('DELETE FROM interaction_contacts WHERE interaction_id = ?1').bind(id));
  statements.push(workActivityStatement(env, {
    actor: payload.host_email, table: 'interactions', id, action: existing ? 'update' : 'insert',
    label: text(payload.title) ?? existing?.title ?? null, fields: [
      ...(payload.phase === 'ended' || granola ? ['title', 'status', 'ended_at', 'summary_markdown', 'transcript_preview'] : ['status']),
      ...(payload.meeting_kind !== undefined ? ['meeting_kind'] : []),
    ],
  }, now));
  await env.USAGE.batch(statements);

  const keys = new Set<CoreCacheKey>();
  for (const row of [...before, ...(subject ? [{ subject_kind: subject.kind, subject_id: subject.id }] : [])]) {
    if (row.subject_kind === 'project' || row.subject_kind === 'lead') keys.add(`interactions/${row.subject_kind}/${row.subject_id}`);
  }
  return [...keys];
}

interface InteractionRow {
  id: string;
  type: CrmInteractionRow['type'];
  title: string;
  status: string | null;
  channel: string | null;
  source: string;
  occurred_at: number;
  ended_at: number | null;
  summary_markdown: string | null;
  transcript_preview: string | null;
  transcript_url: string | null;
  url: string | null;
  created_at: number;
  description: string | null;
  /** A JSON array of strings, or null (migration 0128). */
  tags: string | null;
  signals_account_id: string | null;
  /** The organization the row concerns (migration 0135); `filed_organization_id` is where History shows it. */
  organization_id: string | null;
  /** The contact of a row older than `interaction_contacts` (migration 0135). */
  contact_id: string | null;
  project_id: string | null;
  lead_id: string | null;
  event_id: string | null;
  filed_organization_id: string | null;
}

/**
 * Every interaction read starts here. The filing comes from
 * `interaction_subjects`; the organization is the partner it is filed on,
 * else the organization it concerns, else its project's or lead's. A
 * personal row (`is_personal`) is its owner's: every list adds
 * `PUBLIC_INTERACTION` and never shows it.
 */
const INTERACTION_SELECT = `
  SELECT i.*, sp.subject_id AS project_id, sl.subject_id AS lead_id, se.subject_id AS event_id,
         COALESCE(so.subject_id, i.organization_id, p.organization_id, l.organization_id) AS filed_organization_id
  FROM interactions i
  LEFT JOIN interaction_subjects sp ON sp.interaction_id = i.id AND sp.subject_kind = 'project'
  LEFT JOIN interaction_subjects sl ON sl.interaction_id = i.id AND sl.subject_kind = 'lead'
  LEFT JOIN interaction_subjects se ON se.interaction_id = i.id AND se.subject_kind = 'event'
  LEFT JOIN interaction_subjects so ON so.interaction_id = i.id AND so.subject_kind = 'organization'
  LEFT JOIN projects p ON p.id = sp.subject_id
  LEFT JOIN leads l ON l.id = sl.subject_id`;
const PUBLIC_INTERACTION = 'i.is_personal = 0';
/** An organization's History: filed on it, about it, or on its projects and leads. */
const ON_ORGANIZATION = '(so.subject_id = ?1 OR i.organization_id = ?1 OR p.organization_id = ?1 OR l.organization_id = ?1)';

/** One line of the notes for a list row: the first line that says something, without its Markdown marks. */
export function summaryPreview(markdown: string | null): string | null {
  if (!markdown) return null;
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/u, '').replace(/[*_`]/gu, '').trim();
    if (line) return line.slice(0, SUMMARY_PREVIEW_CHARS);
  }
  return null;
}

function interactionOf(row: InteractionRow): CrmInteractionRow {
  // A note copied from Core has a description and no summary; Core's own
  // History reads the description as the summary (`interactionFromCore`).
  const summary = row.summary_markdown ?? row.description;
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    occurred_at: iso(row.occurred_at),
    created_at: iso(row.created_at),
    summary_preview: summaryPreview(summary),
    summary_markdown: summary,
    transcript_preview: row.transcript_preview,
    duration_minutes: row.ended_at !== null ? Math.max(0, Math.round((row.ended_at - row.occurred_at) / 60_000)) : null,
    project_id: row.project_id,
    lead_id: row.lead_id,
    organization_id: row.filed_organization_id,
    source: row.source,
    channel: row.channel,
    status: row.status,
    url: row.url,
    contacts: [],
    description: row.description,
    ...tagsOf(row.tags),
    signals_account_id: row.signals_account_id,
    event_id: row.event_id,
  };
}

/** Read every linked contact for this page in one query, including pages over D1's parameter limit. */
async function withInteractionContacts(env: Env, rows: InteractionRow[]): Promise<CrmInteractionRow[]> {
  if (rows.length === 0) return [];
  // The older single `contact_id` too, as Core's History reads both.
  const { results } = await env.USAGE.prepare(
    `SELECT ic.interaction_id, c.id, c.name, c.email
       FROM interaction_contacts ic JOIN contacts c ON c.id = ic.contact_id
      WHERE ic.interaction_id IN (SELECT value FROM json_each(?1))
     UNION
     SELECT i.id AS interaction_id, c.id, c.name, c.email
       FROM interactions i JOIN contacts c ON c.id = i.contact_id
      WHERE i.id IN (SELECT value FROM json_each(?1))
      ORDER BY 3, 2`,
  ).bind(JSON.stringify(rows.map((row) => row.id))).all<CrmInteractionContact & { interaction_id: string }>();
  const contacts = new Map<string, CrmInteractionContact[]>();
  for (const { interaction_id, ...contact } of results) {
    const linked = contacts.get(interaction_id) ?? [];
    linked.push(contact);
    contacts.set(interaction_id, linked);
  }
  return rows.map((row) => ({ ...interactionOf(row), contacts: contacts.get(row.id) ?? [] }));
}

/**
 * `fetchCrmInteractions` on D1: one subject's interactions, newest first. A
 * partner's history is everything filed under the organization: the
 * partner itself, and its projects and leads.
 */
export async function d1Interactions(
  env: Env,
  subject: { projectId?: string | null; leadId?: string | null; organizationId?: string | null },
  limit: number,
): Promise<CrmInteractionRow[]> {
  let where: string;
  let bind: string;
  if (subject.projectId) { where = 'sp.subject_id = ?1'; bind = subject.projectId; }
  else if (subject.leadId) { where = 'sl.subject_id = ?1'; bind = subject.leadId; }
  else if (subject.organizationId) {
    where = ON_ORGANIZATION;
    bind = subject.organizationId;
  } else return [];
  const { results } = await env.USAGE.prepare(`${INTERACTION_SELECT} WHERE ${where} AND ${PUBLIC_INTERACTION} ORDER BY i.occurred_at DESC LIMIT ?2`)
    .bind(bind, Math.max(1, Math.min(limit, 200))).all<InteractionRow>();
  return withInteractionContacts(env, results);
}

/** One interaction by id, in the History row shape, or null. A personal row is null, as Core answers it. */
export async function d1InteractionRecord(env: Env, id: string): Promise<CrmInteractionRow | null> {
  const row = await env.USAGE.prepare(`${INTERACTION_SELECT} WHERE i.id = ?1 AND ${PUBLIC_INTERACTION}`).bind(id).first<InteractionRow>();
  return row ? (await withInteractionContacts(env, [row]))[0]! : null;
}

/**
 * Interactions by Core's list filters, newest first: the
 * `cms` read of a D1 workspace. `q` matches the title.
 */
export async function d1InteractionRecords(
  env: Env,
  filters: Partial<Record<'q' | 'type' | 'lead_id' | 'project_id' | 'organization_id' | 'contact_id', string | undefined>>,
  limit: number,
  offset: number,
): Promise<CrmInteractionRow[]> {
  const where: string[] = [PUBLIC_INTERACTION];
  const binds: unknown[] = [];
  if (filters.type) { where.push('i.type = ?'); binds.push(filters.type); }
  if (filters.project_id) { where.push('sp.subject_id = ?'); binds.push(filters.project_id); }
  if (filters.lead_id) { where.push('sl.subject_id = ?'); binds.push(filters.lead_id); }
  if (filters.organization_id) {
    where.push('(so.subject_id = ? OR i.organization_id = ? OR p.organization_id = ? OR l.organization_id = ?)');
    binds.push(filters.organization_id, filters.organization_id, filters.organization_id, filters.organization_id);
  }
  if (filters.contact_id) {
    where.push('(i.contact_id = ? OR EXISTS (SELECT 1 FROM interaction_contacts ic WHERE ic.interaction_id = i.id AND ic.contact_id = ?))');
    binds.push(filters.contact_id, filters.contact_id);
  }
  if (filters.q?.trim()) { where.push(`i.title LIKE ? ESCAPE '\\'`); binds.push(like(filters.q)); }
  const { results } = await env.USAGE.prepare(
    `${INTERACTION_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.occurred_at DESC, i.id LIMIT ? OFFSET ?`,
  ).bind(...binds, Math.max(1, Math.min(limit, 200)), Math.max(0, offset)).all<InteractionRow>();
  return withInteractionContacts(env, results);
}

/**
 * `fetchGranolaLedger` on D1: every row the Granola bridge wrote,
 * filed or not, newest first, with where each is filed. `external_id` is the
 * note id, as the bridge writes it and as Core's copied rows carry it. A
 * personal row answers only the lookup that names its note, as on Core.
 */
export async function d1GranolaLedger(env: Env, noteId?: string): Promise<Array<CrmInteractionRow & {
  meeting_kind: string | null;
  granola_note_id: string | null;
  transcript_document_id: string | null;
  subject_title: string | null;
}>> {
  const { results } = await env.USAGE.prepare(
    `SELECT q.*, COALESCE(p.title, l.title, o.name) AS subject_title FROM (
       ${INTERACTION_SELECT}
       WHERE i.source = 'granola' AND (?1 IS NULL OR i.external_id = ?1) AND (?1 IS NOT NULL OR ${PUBLIC_INTERACTION})
     ) q
     LEFT JOIN projects p ON p.id = q.project_id
     LEFT JOIN leads l ON l.id = q.lead_id
     LEFT JOIN organizations o ON o.id = q.filed_organization_id AND q.meeting_kind = 'partner'
     ORDER BY q.occurred_at DESC LIMIT ?2`,
  ).bind(noteId ?? null, noteId ? 1 : 1000).all<InteractionRow & {
    meeting_kind: string | null; external_id: string; transcript_document_id: string | null; subject_title: string | null;
  }>();
  const rows = await withInteractionContacts(env, results);
  return rows.map((row, index) => ({
    ...row,
    meeting_kind: results[index]!.meeting_kind,
    granola_note_id: results[index]!.external_id,
    transcript_document_id: results[index]!.transcript_document_id,
    subject_title: results[index]!.subject_title,
  }));
}

/** `fetchCrmInteractionsSince` on D1: every interaction on or after `since`, newest first. */
export async function d1InteractionsSince(env: Env, since: Date, limit: number): Promise<CrmInteractionRow[]> {
  const { results } = await env.USAGE.prepare(`${INTERACTION_SELECT} WHERE i.occurred_at >= ?1 AND ${PUBLIC_INTERACTION} ORDER BY i.occurred_at DESC LIMIT ?2`)
    .bind(since.getTime(), Math.max(1, Math.min(limit, 200))).all<InteractionRow>();
  return withInteractionContacts(env, results);
}

// ---------------------------------------------------------------------------
// Contacts (docs/RELATIONSHIPS.md slice 2, migration 0121).
// ---------------------------------------------------------------------------

const CONTACT_PAGE = 50;
/** The calls a contact page lists. */
const CONTACT_CALLS = 20;

interface ContactRow {
  id: string;
  name: string | null;
  title: string | null;
  email: string | null;
  organization_id: string | null;
  organization_name: string | null;
}

const CONTACT_SELECT = `SELECT c.id, c.name, c.title, c.email, c.organization_id, o.name AS organization_name
  FROM contacts c LEFT JOIN organizations o ON o.id = c.organization_id`;

/** Calendar invitees match primary addresses and aliases in this workspace's own contacts. */
export async function d1CalendarContacts(
  env: Env,
  emails: string[],
  access: SubjectAccessView,
): Promise<Array<{ id: string; name: string | null; email: string }>> {
  if (emails.length === 0) return [];
  const { results } = await env.USAGE.prepare(
    `SELECT c.id, c.name, lower(e.email) AS email, c.organization_id
       FROM contacts c JOIN contact_emails e ON e.contact_id = c.id
      WHERE lower(e.email) IN (SELECT value FROM json_each(?1))
      UNION
     SELECT id, name, lower(email) AS email, organization_id FROM contacts
      WHERE lower(email) IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify(emails)).all<{ id: string; name: string | null; email: string; organization_id: string | null }>();
  return results
    .filter((row) => !row.organization_id || access.canSee('organization', row.organization_id))
    .map(({ organization_id: _organization, ...contact }) => contact);
}

/**
 * The contact an address belongs to. `contact_emails` is the record; a
 * contact copied in by the Core fold may have only its primary
 * `contacts.email` until it is next written, so that is read too.
 */
/** The contact that holds this address, by any of its addresses, or null. */
export async function contactIdForEmail(env: Env, email: string): Promise<string | null> {
  const address = email.trim().toLowerCase();
  if (!address) return null;
  const row = await env.USAGE.prepare(
    `SELECT contact_id AS id FROM contact_emails WHERE email = ?1
     UNION ALL SELECT id FROM contacts WHERE email = ?1 COLLATE NOCASE
     LIMIT 1`,
  ).bind(address).first<{ id: string }>();
  return row?.id ?? null;
}

/** Each contact's addresses, the primary first, by contact id. */
async function contactAddresses(env: Env, rows: readonly ContactRow[]): Promise<Map<string, string[]>> {
  const addresses = new Map<string, string[]>();
  for (const row of rows) addresses.set(row.id, row.email ? [row.email.trim().toLowerCase()] : []);
  const ids = rows.map((row) => row.id);
  for (let at = 0; at < ids.length; at += 80) {
    const chunk = ids.slice(at, at + 80);
    const { results } = await env.USAGE.prepare(
      `SELECT contact_id, email FROM contact_emails WHERE contact_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY created_at, email`,
    ).bind(...chunk).all<{ contact_id: string; email: string }>();
    for (const row of results) {
      const list = addresses.get(row.contact_id);
      if (list && !list.includes(row.email)) list.push(row.email);
    }
  }
  return addresses;
}

async function contactsOf(env: Env, rows: readonly ContactRow[]): Promise<CrmContact[]> {
  const addresses = await contactAddresses(env, rows);
  return rows.map((row) => {
    const emails = addresses.get(row.id) ?? [];
    return {
      id: row.id,
      name: row.name,
      title: row.title,
      organization_id: row.organization_id,
      organization_name: row.organization_name,
      email: emails[0] ?? null,
      emails,
    };
  });
}

/** Every country code and preferred language the contacts carry, for the Contacts group's filter menus. */
async function d1ContactFacets(env: Env): Promise<CrmContactFacets> {
  const values = async (column: 'country' | 'preferred_language', fold: string) => (await env.USAGE.prepare(
    `SELECT DISTINCT ${fold}(TRIM(${column})) AS value FROM contacts WHERE TRIM(COALESCE(${column}, '')) <> '' ORDER BY value`,
  ).all<{ value: string }>()).results.map((row) => row.value);
  const [countries, languages] = await Promise.all([values('country', 'UPPER'), values('preferred_language', 'LOWER')]);
  return { countries, languages };
}

/**
 * `fetchCrmContacts` on D1: by name, title, address or organization name, in
 * name order. `ids` names contacts by id, whatever the query. The Contacts
 * group's filters narrow it.
 */
export async function d1Contacts(
  env: Env,
  input: { q?: string; organizationId?: string | null; ids?: readonly string[]; emails?: readonly string[]; limit?: number; filter?: CrmContactFilter; facets?: boolean },
): Promise<{ contacts: CrmContact[]; hasMore: boolean; facets?: CrmContactFacets }> {
  const take = Math.max(1, Math.min(input.limit ?? CONTACT_PAGE, 200));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (input.emails) {
    const emails = input.emails.slice(0, 25);
    if (emails.length === 0) return { contacts: [], hasMore: false };
    const marks = emails.map(() => '?').join(', ');
    where.push(`(LOWER(c.email) IN (${marks}) OR EXISTS (SELECT 1 FROM contact_emails e WHERE e.contact_id = c.id AND LOWER(e.email) IN (${marks})))`);
    binds.push(...emails, ...emails);
  }
  if (input.ids) {
    const ids = input.ids.slice(0, 80);
    if (ids.length === 0) return { contacts: [], hasMore: false };
    where.push(`c.id IN (${ids.map(() => '?').join(', ')})`);
    binds.push(...ids);
  }
  if (input.organizationId) { where.push('c.organization_id = ?'); binds.push(input.organizationId); }
  const filter = input.filter ?? {};
  if (filter.country?.trim()) { where.push('UPPER(TRIM(c.country)) = ?'); binds.push(filter.country.trim().toUpperCase()); }
  if (filter.partner) where.push('o.is_partner = 1');
  if (filter.existing_client) where.push('o.is_existing_client = 1');
  if (filter.signals_outreach_status) { where.push('c.signals_outreach_status = ?'); binds.push(filter.signals_outreach_status); }
  if (filter.preferred_language?.trim()) { where.push('LOWER(TRIM(c.preferred_language)) = ?'); binds.push(filter.preferred_language.trim().toLowerCase()); }
  const needle = input.q?.trim() ?? '';
  if (needle) {
    where.push(`(c.name LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM contact_emails e WHERE e.contact_id = c.id AND e.email LIKE ? ESCAPE '\\'))`);
    binds.push(like(needle), like(needle), like(needle), like(needle), like(needle));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ results }, facets] = await Promise.all([
    env.USAGE.prepare(`${CONTACT_SELECT} ${clause} ORDER BY COALESCE(c.name, c.email) COLLATE NOCASE LIMIT ?`)
      .bind(...binds, take + 1).all<ContactRow>(),
    input.facets ? d1ContactFacets(env) : undefined,
  ]);
  return {
    contacts: await contactsOf(env, results.slice(0, take)),
    hasMore: results.length > take,
    ...(facets ? { facets } : {}),
  };
}

async function d1ContactRow(env: Env, id: string): Promise<ContactRow> {
  const row = await env.USAGE.prepare(`${CONTACT_SELECT} WHERE c.id = ?1`).bind(id).first<ContactRow>();
  if (!row) throw notFound('contact');
  return row;
}

/** The organization a contact is on, for the route's access check. 404 when there is no such contact. A merged id reads its survivor. */
export async function d1ContactOrganization(env: Env, id: string): Promise<string | null> {
  return (await d1ContactRow(env, (await mergedSurvivor(env, 'contacts', id)) ?? id)).organization_id;
}

/**
 * `fetchCrmContactDetail` on D1: the contact, the projects and leads they
 * are on, the calls they were in (`interaction_contacts`), and the members
 * who hosted those calls.
 */
export async function d1ContactDetail(env: Env, id: string): Promise<CrmContactDetail> {
  // A merged id answers its survivor, and says so.
  const survivor = await mergedSurvivor(env, 'contacts', id);
  if (survivor) return { ...(await d1ContactDetail(env, survivor)), merged_from: id };
  const row = await d1ContactRow(env, id);
  const [[contact], projects, leads, calls, members] = await Promise.all([
    contactsOf(env, [row]),
    env.USAGE.prepare(
      `SELECT p.id, p.title, p.status FROM project_contacts pc JOIN projects p ON p.id = pc.project_id
       WHERE pc.contact_id = ?1 ORDER BY p.updated_at DESC LIMIT 50`,
    ).bind(id).all<CrmRelatedRow>(),
    env.USAGE.prepare('SELECT id, title, status FROM leads WHERE contact_id = ?1 ORDER BY updated_at DESC LIMIT 50')
      .bind(id).all<CrmRelatedRow>(),
    env.USAGE.prepare(
      `${INTERACTION_SELECT}
       WHERE (i.contact_id = ?1 OR i.id IN (SELECT interaction_id FROM interaction_contacts WHERE contact_id = ?1))
         AND ${PUBLIC_INTERACTION}
       ORDER BY i.occurred_at DESC LIMIT ?2`,
    ).bind(id, CONTACT_CALLS).all<InteractionRow>(),
    env.USAGE.prepare(
      `SELECT p.email, p.name, COUNT(*) AS calls
       FROM interaction_contacts ic
       JOIN interactions i ON i.id = ic.interaction_id
       JOIN people p ON p.person_id = i.host_person_id AND p.kind = 'human'
       WHERE ic.contact_id = ?1 AND i.is_personal = 0
       GROUP BY p.email, p.name ORDER BY calls DESC, p.name COLLATE NOCASE LIMIT 20`,
    ).bind(id).all<{ email: string; name: string | null; calls: number }>(),
  ]);
  const stored = await env.USAGE.prepare('SELECT * FROM contacts WHERE id = ?1').bind(id).first<StoredRow>();
  return {
    ...contact!,
    ...(stored ? profileOf(CONTACT_COLUMNS, stored) : {}),
    projects: projects.results,
    leads: leads.results,
    interactions: await withInteractionContacts(env, calls.results),
    met_by: members.results.map((member) => ({ email: member.email, name: member.name?.trim() || null, calls: member.calls })),
  };
}

/** The addresses as a write gives them: lower case, once each, the primary first. */
function addressList(emails: readonly string[]): string[] {
  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

/** Refuses an address that belongs to another contact: one person, one record. */
async function assertAddressesFree(env: Env, emails: readonly string[], self: string | null): Promise<void> {
  for (const email of emails) {
    const owner = await contactIdForEmail(env, email);
    if (owner && owner !== self) {
      throw new ControlError(`${email} is already another contact's address.`, 409, 'contact_email_taken');
    }
  }
}

function addressStatements(env: Env, id: string, emails: readonly string[], now: number): D1PreparedStatement[] {
  return [
    env.USAGE.prepare('DELETE FROM contact_emails WHERE contact_id = ?1').bind(id),
    // `created_at` keeps the order the list gave, so the primary reads first.
    ...emails.map((email, index) => env.USAGE.prepare(
      'INSERT INTO contact_emails (email, contact_id, created_at) VALUES (?1, ?2, ?3)',
    ).bind(email, id, now + index)),
  ];
}

/**
 * The contact's primary and corporate addresses as its addresses, after the
 * write (Core's `trg_sync_contact_email_addresses`). Additive: an
 * address is never removed here. An address another contact holds stays
 * theirs. Runs last in the write's batch, so it reads the row as written.
 */
function syncAddressStatements(env: Env, id: string, now: number): D1PreparedStatement[] {
  return ['email', 'corporate_email'].map((column, index) => env.USAGE.prepare(
    `INSERT OR IGNORE INTO contact_emails (email, contact_id, created_at)
     SELECT lower(trim(${column})), id, ?2 FROM contacts WHERE id = ?1 AND ${column} IS NOT NULL AND trim(${column}) <> ''`,
  ).bind(id, now + 1000 + index));
}

/** `createCrmContact` on D1. */
export async function d1CreateContactRecord(
  env: Env,
  input: { name: string; title?: string | null | undefined; organization_id?: string | null | undefined; emails: readonly string[]; source_key?: string | undefined } & Record<string, unknown>,
  options: { anySource?: boolean | undefined } = {},
): Promise<CrmContactDetail> {
  const organizationId = await assertOrganization(env, text(input.organization_id));
  const emails = addressList(input.emails);
  await assertAddressesFree(env, emails, null);
  // Where the contact came from, as Core's contact create records it.
  const sourceKey = await resolveContactSource(env, input.source_key, options.anySource);
  const id = crypto.randomUUID();
  const now = Date.now();
  const profile = columnSets(CONTACT_COLUMNS, input);
  await env.USAGE.batch([
    env.USAGE.prepare(
      'INSERT INTO contacts (id, organization_id, name, email, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)',
    ).bind(id, organizationId, text(input.name), emails[0] ?? null, text(input.title), now),
    ...(profile.sets.length > 0 ? [env.USAGE.prepare(`UPDATE contacts SET ${profile.sets.join(', ')} WHERE id = ?`).bind(...profile.binds, id)] : []),
    ...addressStatements(env, id, emails, now),
    ...syncAddressStatements(env, id, now),
    contactSourceStatement(env, id, { eventType: 'created', sourceKey }, now),
  ]);
  const contact = await d1ContactDetail(env, id);
  await ensureSignalsLeadForContact(env, contact);
  return contact;
}

/** `updateCrmContact` on D1: only the fields present change; `emails` replaces the list. */
export async function d1UpdateContact(
  env: Env,
  id: string,
  input: { name?: string | undefined; title?: string | null | undefined; organization_id?: string | null | undefined; emails?: readonly string[] | undefined } & Record<string, unknown>,
): Promise<CrmContactDetail> {
  await d1ContactRow(env, id);
  if ('organization_id' in input) await assertOrganization(env, text(input.organization_id));
  const emails = input.emails ? addressList(input.emails) : null;
  if (emails) await assertAddressesFree(env, emails, id);
  const now = Date.now();
  const { sets, binds } = columnSets(CONTACT_COLUMNS, input);
  // A name is never blanked; the title and the organization may be cleared.
  if (text(input.name)) { sets.push('name = ?'); binds.push(text(input.name)); }
  if ('title' in input) { sets.push('title = ?'); binds.push(text(input.title)); }
  if ('organization_id' in input) { sets.push('organization_id = ?'); binds.push(text(input.organization_id)); }
  if (emails) { sets.push('email = ?'); binds.push(emails[0] ?? null); }
  sets.push('updated_at = ?');
  binds.push(now);
  await env.USAGE.batch([
    env.USAGE.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id),
    ...(emails ? addressStatements(env, id, emails, now) : []),
    ...syncAddressStatements(env, id, now),
  ]);
  const contact = await d1ContactDetail(env, id);
  // Core's trigger fires on these two columns only.
  if ('signals_outreach_status' in input || 'organization_id' in input) await ensureSignalsLeadForContact(env, contact);
  return contact;
}
