// Moving one table group from Core to D1 (docs/CORE_FOLD_PLAN.md
// §The group move): freeze, copy, verify, then a deploy flips the group's
// WORK_STORE_<GROUP> var. Nothing here flips a store.
//
// - `freeze` makes every write to the group answer 503 `records_moving`
//   (work-freeze.ts). Reads still answer from Core.
// - `copy` reads each table of the group from Core's read-only export route,
//   maps Core's columns to D1's, and upserts the rows by key into D1, parents
//   before children (the D1 foreign keys refuse any other order). It is
//   idempotent: a second run writes the same rows again. It stops at a page
//   budget and returns where to resume.
// - `verify` reads every row again from both stores and compares, per
//   table, the row count and a SHA-256 of the rows on the copied columns
//   (the approach of `compareSnapshots`, object-snapshot.ts). Any difference
//   is `ok: false`: unfreeze, and nothing has changed.
// - `diff`, for a rollback after the flip: the rows D1 has that Core does
//   not (new or changed since the copy), and the keys Core has that D1 lost.
//
// Only an admin runs these (POST /api/admin/work-groups); the route writes
// each act to `admin_audit`.

import { coreFoldExportPageSchema, type WorkGroupDiff, type WorkGroupMoveResponse, type WorkGroupStatus, type WorkGroupTableReport } from './contracts';
import { COMMERCIAL_COLUMNS, COMMERCIAL_TABLES, type CommercialColumnKind, type CommercialTable } from '@starlings/contracts/core-commercial';
import { WORK_GROUPS, WORK_GROUP_TABLES, type WorkGroup } from '@starlings/contracts/work-groups';
import { commercialCell } from './core-commercial-d1';
import { coreFailure, readCoreJson, signedCoreFetch } from './crm';
import { replayCoreMergeRepoints } from './core-merge-repoint';
import { ControlError } from './errors';
import { tableDigest } from './object-snapshot';
import { mergedInto } from './record-merges';
import { groupStore, usesCore } from './work-store';

/** A D1 cell. */
export type Cell = string | number | null;
export type D1Row = Record<string, Cell>;

/** One D1 table of a group: where Core keeps it, its key, and how a Core row becomes a D1 row. */
export interface TableSpec {
  /** Core's table, as the export route names it. */
  core: string;
  /** D1's primary key columns. */
  key: readonly string[];
  /** Every D1 column the copy writes and the verify compares. */
  columns: readonly string[];
  fromCore(row: Record<string, unknown>): D1Row;
}

/** Rows per Core page and per D1 batch. */
const PAGE_ROWS = 500;
const BATCH_ROWS = 100;
/** Core pages one `copy` reads before it stops and returns `next`. */
const COPY_PAGE_BUDGET = 40;
/** Core pages one `verify` or `diff` reads per table before it refuses. */
const READ_PAGE_BUDGET = 400;
const EXPORT_PATH = '/api/public/meet-fold-export';

// ── Core columns to D1 columns ─────────────────────────────────────────────
// D1 stores times as epoch milliseconds and booleans as 0/1; Core sends ISO
// strings and booleans (docs/CORE_FOLD_PLAN.md §Postgres to D1). Each map is
// pure, so the copy and the verify produce the same row from the same input.

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const flag = (value: unknown): number => (value === true || value === 1 || value === 'true' ? 1 : 0);
const integer = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
};
/** An ISO time as epoch ms. A value that does not parse stops the move: it is not a time we can copy. */
export function millis(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new ControlError(`Core sent a time that does not parse: ${String(value).slice(0, 40)}.`, 502, 'upstream_shape');
  return parsed;
}
/** A NOT NULL time column. 0 when Core has none, so the copy and the verify agree. */
const requiredMillis = (...values: unknown[]): number => {
  for (const value of values) {
    const parsed = millis(value);
    if (parsed !== null) return parsed;
  }
  return 0;
};
/**
 * Core's `text[]` as D1's JSON text (§Postgres to D1). An empty or absent list
 * is null, so a task without tags reads the same before and after the copy.
 */
const jsonList = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item) => item !== null && item !== undefined).map(String);
  return items.length === 0 ? null : JSON.stringify(items);
};
/**
 * Core's `jsonb` object as D1's JSON text, keys sorted at every level, so the
 * copy and the verify write the same text for the same object whatever order
 * Core sends. An empty or absent object is null.
 */
const jsonObject = (value: unknown): string | null => {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) return null;
  return JSON.stringify(sorted(value));
};
/** A flag Core leaves nullable with a default of true. */
const flagOn = (value: unknown): number => (value === null || value === undefined ? 1 : flag(value));
/** Core still names the organization subject `partner` (ADR 0006). */
const subjectKind = (value: unknown): string | null => (value === 'partner' ? 'organization' : text(value));
const responsibleOf = (row: Record<string, unknown>) => ({
  responsible_email: text(row.responsible_email),
  responsible_set_by: text(row.responsible_set_by),
  responsible_set_at: millis(row.responsible_set_at),
});
const metadataOf = (row: Record<string, unknown>): Record<string, unknown> =>
  (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {});

/** Core's organization text columns that D1 keeps under the same name (migration 0130). */
const ORGANIZATION_TEXT = [
  'legal_name', 'address', 'postcode', 'city', 'country', 'vat_id', 'tax_id', 'size', 'notes', 'owner_id', 'founded',
  'hq_location', 'company_type', 'linkedin_url', 'logo_image_url', 'profile_image_url', 'entity', 'domain',
] as const;
/** Core's contact text columns that D1 keeps under the same name (migration 0130). */
const CONTACT_TEXT = [
  'notes', 'linkedin_url', 'phone', 'headline', 'location', 'connection_count', 'country', 'corporate_email',
  'profile_image_url', 'signals_outreach_status',
] as const;
/** Core's contact profile kinds, one boolean each. */
const CONTACT_FLAGS = ['futurist', 'corporate', 'academic', 'independent', 'government', 'ngo', 'media', 'intelligence'] as const;
/** Core's lead qualification checklist, one boolean each (migration 0131). */
const LEAD_FLAGS = ['event_timeline', 'budget_availability', 'stakeholder_buy_in', 'previous_engagement', 'project_fit'] as const;
/** Core's project text columns that D1 keeps under the same name (migration 0115, the Fields pane). */
const PROJECT_TEXT = [
  'evid', 'license_id', 'specs', 'technical', 'research', 'design', 'contract', 'analytics', 'authentication',
] as const;
/** Core's milestone text columns (migration 0134). `start_time` is Core's `time`, as text. */
const MILESTONE_TEXT = ['notes', 'place', 'location', 'start_time', 'timezone'] as const;

/** Core's `numeric` as D1's REAL. PostgREST may send it as a string. */
const real = (value: unknown, fallback: number): number => {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

/**
 * The commercial group's copy. Each table keeps Core's name and
 * columns, so one list maps the row (`COMMERCIAL_COLUMNS`, the same map a write
 * from Core uses). A null stays null. A table's key is `id`, but for the
 * junction `license_offers`, which is the pair.
 */
function coreNamedSpec(table: string, kinds: Readonly<Record<string, CommercialColumnKind>>, key: readonly string[]): TableSpec {
  return {
    core: table,
    key: [...key],
    columns: Object.keys(kinds),
    fromCore: (row) => Object.fromEntries(Object.entries(kinds).map(([column, kind]) => [column, commercialCell(kind, row[column])])),
  };
}

function commercialSpec(table: CommercialTable): TableSpec {
  return coreNamedSpec(table, COMMERCIAL_COLUMNS[table], table === 'license_offers' ? ['license_id', 'offer_id'] : ['id']);
}

/**
 * Every D1 table a group copies, keyed by its D1 name. Columns Core has and
 * D1 does not (a subject's tags, a generated `search_vector`) are not copied;
 * they stay in Core's archive (CORE_FOLD_PLAN principle 7, Phase 6). People
 * are copied as Core's uuids, which makes Meet's person ids.
 */
export const TABLE_SPECS: Record<string, TableSpec> = {
  // The settings tables (migration 0132): same names as Core.
  lead_characteristics_config: {
    core: 'lead_characteristics_config',
    key: ['id'],
    columns: ['id', 'name', 'created_at'],
    fromCore: (row) => ({ id: text(row.id), name: text(row.name) ?? '', created_at: requiredMillis(row.created_at) }),
  },
  contact_characteristics_config: {
    core: 'contact_characteristics_config',
    key: ['id'],
    columns: ['id', 'name', 'created_at'],
    fromCore: (row) => ({ id: text(row.id), name: text(row.name) ?? '', created_at: requiredMillis(row.created_at) }),
  },
  contact_source_definitions: {
    core: 'contact_source_definitions',
    key: ['key'],
    columns: [
      'key', 'label', 'category', 'description', 'is_active', 'manual_selectable', 'import_selectable', 'is_system',
      'sort_order', 'created_at', 'updated_at',
    ],
    fromCore: (row) => ({
      key: text(row.key),
      label: text(row.label) ?? '',
      category: text(row.category) ?? 'legacy',
      description: text(row.description),
      is_active: flagOn(row.is_active),
      manual_selectable: flag(row.manual_selectable),
      import_selectable: flag(row.import_selectable),
      is_system: flag(row.is_system),
      sort_order: integer(row.sort_order) ?? 100,
      created_at: requiredMillis(row.created_at),
      updated_at: requiredMillis(row.updated_at, row.created_at),
    }),
  },
  contact_source_events: {
    core: 'contact_source_events',
    key: ['id'],
    columns: [
      'id', 'contact_id', 'event_type', 'source_key', 'occurred_at', 'external_id', 'import_batch_id', 'source_record_type',
      'source_record_id', 'metadata', 'created_by', 'dedupe_key', 'created_at',
    ],
    fromCore: (row) => ({
      id: text(row.id),
      contact_id: text(row.contact_id),
      event_type: text(row.event_type) ?? 'created',
      source_key: text(row.source_key),
      occurred_at: requiredMillis(row.occurred_at, row.created_at),
      external_id: text(row.external_id),
      import_batch_id: text(row.import_batch_id),
      source_record_type: text(row.source_record_type),
      source_record_id: text(row.source_record_id),
      metadata: jsonObject(row.metadata),
      created_by: text(row.created_by),
      dedupe_key: text(row.dedupe_key) ?? '',
      created_at: requiredMillis(row.created_at),
    }),
  },
  organizations: {
    core: 'organizations',
    key: ['id'],
    columns: [
      'id', 'name', 'is_partner', 'industry', 'url', 'logo_url', 'created_by', 'created_at', 'updated_at',
      // Migration 0130: every other column Core keeps.
      ...ORGANIZATION_TEXT, 'is_agency', 'is_existing_client',
    ],
    fromCore: (row) => ({
      id: text(row.id),
      name: text(row.name) ?? '',
      is_partner: flag(row.is_partner),
      industry: text(row.industry),
      url: text(row.website),
      logo_url: text(row.logo_url),
      created_by: null,
      created_at: requiredMillis(row.created_at),
      updated_at: requiredMillis(row.updated_at, row.created_at),
      ...Object.fromEntries(ORGANIZATION_TEXT.map((column) => [column, text(row[column])])),
      is_agency: flag(row.is_agency),
      is_existing_client: flag(row.is_existing_client),
    }),
  },
  contacts: {
    core: 'contacts',
    key: ['id'],
    columns: [
      'id', 'organization_id', 'name', 'email', 'title', 'created_at', 'updated_at',
      // Migration 0130: every other column Core keeps.
      ...CONTACT_TEXT, 'characteristics', 'preferred_language', 'signals_notified_at',
      'birthday_month', 'birthday_day', 'birthday_year', ...CONTACT_FLAGS,
    ],
    fromCore: (row) => ({
      id: text(row.id),
      organization_id: text(row.organization_id),
      name: text(row.name),
      email: text(row.email),
      title: text(row.company_role),
      created_at: requiredMillis(row.created_at),
      updated_at: requiredMillis(row.updated_at, row.created_at),
      ...Object.fromEntries(CONTACT_TEXT.map((column) => [column, text(row[column])])),
      characteristics: jsonObject(row.characteristics),
      preferred_language: text(row.preferred_language) ?? 'en',
      signals_notified_at: millis(row.signals_notified_at),
      birthday_month: integer(row.birthday_month),
      birthday_day: integer(row.birthday_day),
      birthday_year: integer(row.birthday_year),
      ...Object.fromEntries(CONTACT_FLAGS.map((column) => [column, flag(row[column])])),
    }),
  },
  leads: {
    core: 'leads',
    key: ['id'],
    columns: [
      'id', 'organization_id', 'contact_id', 'title', 'status', 'start_date', 'notes', 'created_by', 'created_at', 'updated_at',
      'responsible_email', 'responsible_set_by', 'responsible_set_at',
      // Migration 0115 (the Fields pane) and 0131 (the contact form, the checklist).
      'characteristics', 'source', ...LEAD_FLAGS,
    ],
    fromCore: (row) => ({
      id: text(row.id),
      organization_id: text(row.organization_id),
      contact_id: text(row.contact_id),
      title: text(row.title) ?? '',
      status: text(row.status) ?? 'Conversations',
      start_date: text(row.start_date),
      notes: text(row.notes),
      created_by: null,
      created_at: requiredMillis(row.created_at),
      updated_at: requiredMillis(row.updated_at, row.created_at),
      ...responsibleOf(row),
      characteristics: jsonObject(row.characteristics),
      source: text(row.source),
      ...Object.fromEntries(LEAD_FLAGS.map((column) => [column, flag(row[column])])),
    }),
  },
  projects: {
    core: 'projects',
    key: ['id'],
    columns: [
      'id', 'organization_id', 'lead_id', 'title', 'status', 'description', 'url', 'start_date', 'end_date', 'internal', 'agent_email',
      'created_by', 'created_at', 'updated_at', 'responsible_email', 'responsible_set_by', 'responsible_set_at',
      // Migration 0115 (the Fields pane) and 0131 (the public page, revenue, the event).
      ...PROJECT_TEXT, 'last_viewed_at', 'mrr', 'event_id',
    ],
    fromCore: (row) => ({
      id: text(row.id),
      organization_id: text(row.organization_id),
      lead_id: text(row.lead_id),
      title: text(row.title) ?? '',
      status: text(row.status) ?? 'Planning',
      description: text(row.description),
      url: text(row.url),
      start_date: text(row.start_date),
      end_date: text(row.end_date),
      internal: flag(row.is_internal),
      agent_email: text(row.agent_email),
      created_by: null,
      created_at: requiredMillis(row.created_at),
      updated_at: requiredMillis(row.updated_at, row.created_at),
      ...responsibleOf(row),
      ...Object.fromEntries(PROJECT_TEXT.map((column) => [column, text(row[column])])),
      last_viewed_at: millis(row.last_viewed_at),
      mrr: integer(row.mrr) ?? 0,
      event_id: text(row.event_id),
    }),
  },
  project_contacts: {
    core: 'project_contacts',
    key: ['project_id', 'contact_id'],
    columns: ['project_id', 'contact_id'],
    fromCore: (row) => ({ project_id: text(row.project_id), contact_id: text(row.contact_id) }),
  },
  milestones: {
    core: 'milestones',
    key: ['id'],
    columns: [
      'id', 'project_id', 'title', 'status', 'due_at', 'created_at', 'updated_at',
      // Migration 0134: what the public project page and milestones.ics show.
      ...MILESTONE_TEXT, 'start_at',
    ],
    fromCore: (row) => ({
      id: text(row.id),
      project_id: text(row.project_id),
      title: text(row.title) ?? '',
      status: text(row.status) ?? 'planned',
      due_at: millis(row.due_date),
      created_at: requiredMillis(row.created_at),
      updated_at: requiredMillis(row.updated_at, row.created_at),
      ...Object.fromEntries(MILESTONE_TEXT.map((column) => [column, text(row[column])])),
      start_at: millis(row.start_at),
    }),
  },
  tasks: {
    core: 'tasks',
    key: ['id'],
    columns: [
      'id', 'title', 'notes', 'status', 'responsible_party', 'priority', 'due_at', 'assignee_id', 'project_id', 'lead_id',
      'organization_id', 'meeting_id', 'milestone_id', 'goal_id', 'created_by', 'updated_by', 'created_at', 'updated_at',
      'finished_at', 'github_owner', 'github_repo', 'github_issue_number',
      // Migration 0127: a task's subject on an event, a Signals account or a contact.
      'event_id', 'signals_account_id', 'contact_id', 'tags',
    ],
    fromCore: (row) => ({
      id: text(row.id),
      title: text(row.title) ?? '',
      notes: text(row.notes),
      status: text(row.status) ?? 'pending',
      responsible_party: text(row.responsible_party) ?? 'unassigned',
      priority: text(row.priority),
      due_at: millis(row.due_date),
      assignee_id: text(row.assigned_to),
      project_id: text(row.project_id),
      lead_id: text(row.lead_id),
      organization_id: text(row.organization_id),
      meeting_id: text(row.meeting_id),
      milestone_id: text(row.milestone_id),
      goal_id: text(row.goal_id),
      created_by: null,
      updated_by: text(row.updated_by),
      created_at: requiredMillis(row.created_at),
      updated_at: requiredMillis(row.updated_at, row.created_at),
      finished_at: millis(row.completed_at),
      github_owner: text(row.github_owner),
      github_repo: text(row.github_repo),
      github_issue_number: integer(row.github_issue_number),
      event_id: text(row.event_id),
      signals_account_id: text(row.signals_account_id),
      contact_id: text(row.contact_id),
      tags: jsonList(row.tags),
    }),
  },
  goals: {
    core: 'goals',
    key: ['id'],
    columns: ['id', 'project_id', 'title', 'status', 'target_date', 'owner', 'created_by', 'created_at', 'updated_at'],
    fromCore: (row) => ({
      id: text(row.id),
      project_id: text(row.project_id),
      title: text(row.title) ?? '',
      status: text(row.status) ?? 'open',
      target_date: text(row.target_date),
      owner: text(row.owner),
      created_by: text(row.created_by),
      created_at: requiredMillis(row.created_at),
      updated_at: requiredMillis(row.updated_at, row.created_at),
    }),
  },
  decisions: {
    core: 'decisions',
    key: ['id'],
    columns: ['id', 'subject_kind', 'subject_id', 'body', 'source', 'source_ref', 'goal_id', 'decided_by', 'decided_at'],
    fromCore: (row) => ({
      id: text(row.id),
      subject_kind: subjectKind(row.subject_kind),
      subject_id: text(row.subject_id),
      body: text(row.body) ?? '',
      source: text(row.source) ?? 'manual',
      source_ref: text(row.source_ref),
      goal_id: text(row.goal_id),
      decided_by: text(row.decided_by),
      decided_at: requiredMillis(row.decided_at),
    }),
  },
  favorites: {
    core: 'member_favorites',
    key: ['person_id', 'kind', 'target_ref'],
    columns: ['person_id', 'kind', 'target_ref', 'created_at'],
    fromCore: (row) => ({
      person_id: text(row.member_id),
      kind: text(row.kind),
      target_ref: text(row.target_ref),
      created_at: requiredMillis(row.created_at),
    }),
  },
  project_github_repos: {
    core: 'project_github_repos',
    key: ['project_id', 'owner', 'repo'],
    columns: ['project_id', 'owner', 'repo', 'label', 'milestone', 'is_primary', 'linked_by', 'created_at'],
    fromCore: (row) => ({
      project_id: text(row.project_id),
      owner: text(row.owner),
      repo: text(row.repo),
      label: text(row.label),
      milestone: text(row.milestone),
      is_primary: flag(row.is_primary),
      linked_by: text(row.linked_by),
      created_at: requiredMillis(row.linked_at, row.created_at),
    }),
  },
  interactions: {
    core: 'interactions',
    key: ['id'],
    columns: [
      'id', 'type', 'title', 'status', 'channel', 'source', 'external_id', 'occurred_at', 'ended_at', 'summary_markdown',
      'transcript_preview', 'transcript_url', 'transcript_document_id', 'url', 'meeting_kind', 'host_person_id', 'created_at', 'updated_at',
      // Migration 0128: what Core keeps beyond the meeting log.
      'description', 'tags', 'metadata', 'signals_account_id',
      // Migration 0135: every other Core column. `lead_id`,
      // `project_id` and `event_id` are Core's mirrored `interaction_subjects` rows.
      'organization_id', 'contact_id', 'is_personal', 'owner_email', 'interaction_kind', 'gmail_email_id',
      'support_case_id', 'signals_evaluation_id',
    ],
    fromCore: (row) => {
      const metadata = metadataOf(row);
      return {
        id: text(row.id),
        type: text(row.type) ?? 'note',
        title: text(row.title) ?? '',
        status: text(row.status),
        channel: text(row.channel),
        source: text(row.source) ?? 'manual',
        // D1 keys a redelivery on (source, external_id); a manual Core row has no external id.
        external_id: text(row.external_id) ?? text(row.id),
        occurred_at: requiredMillis(row.occurred_at, row.created_at),
        ended_at: millis(metadata.ended_at),
        summary_markdown: text(row.summary_markdown),
        transcript_preview: text(row.transcript_preview),
        transcript_url: text(row.transcript_url),
        transcript_document_id: text(metadata.transcript_document_id),
        url: text(row.url),
        // The meeting log's filing kind; Core keeps it in metadata. Core's own kind is `interaction_kind`.
        meeting_kind: text(metadata.meeting_kind),
        host_person_id: text(row.created_by),
        created_at: requiredMillis(row.created_at),
        updated_at: requiredMillis(row.updated_at, row.created_at),
        description: text(row.description),
        tags: jsonList(row.tags),
        metadata: jsonObject(row.metadata),
        signals_account_id: text(row.signals_account_id),
        organization_id: text(row.organization_id),
        contact_id: text(row.contact_id),
        is_personal: flag(row.is_personal),
        owner_email: text(row.owner_email),
        interaction_kind: text(row.interaction_kind),
        gmail_email_id: text(row.gmail_email_id),
        support_case_id: text(row.support_case_id),
        signals_evaluation_id: text(row.signals_evaluation_id),
      };
    },
  },
  interaction_subjects: {
    core: 'interaction_subjects',
    key: ['interaction_id', 'subject_kind', 'subject_id'],
    columns: ['interaction_id', 'subject_kind', 'subject_id', 'is_primary', 'source', 'created_at', 'created_by', 'via_contact_id'],
    fromCore: (row) => ({
      interaction_id: text(row.interaction_id),
      subject_kind: subjectKind(row.subject_kind),
      subject_id: text(row.subject_id),
      is_primary: flag(row.is_primary),
      source: text(row.source) ?? 'filed',
      created_at: millis(row.created_at),
      created_by: text(row.created_by),
      via_contact_id: text(row.via_contact_id),
    }),
  },
  interaction_contacts: {
    core: 'interaction_contacts',
    key: ['interaction_id', 'contact_id'],
    columns: ['interaction_id', 'contact_id', 'created_at'],
    fromCore: (row) => ({ interaction_id: text(row.interaction_id), contact_id: text(row.contact_id), created_at: millis(row.created_at) }),
  },
  // Partner agreements move with this group (MZ, 2026-10-10).
  partner_agreement_signatures: {
    core: 'partner_agreement_signatures',
    key: ['id'],
    columns: [
      'id', 'agreement_id', 'contact_id', 'signer_name', 'signer_email', 'signing_for', 'organization_name', 'signed_at',
      'metadata', 'created_at', 'updated_at',
    ],
    fromCore: (row) => ({
      id: text(row.id),
      agreement_id: text(row.agreement_id),
      contact_id: text(row.contact_id),
      signer_name: text(row.signer_name) ?? '',
      signer_email: text(row.signer_email) ?? '',
      signing_for: text(row.signing_for) ?? '',
      organization_name: text(row.organization_name),
      signed_at: requiredMillis(row.signed_at, row.created_at),
      // NOT NULL in both stores; an empty object is `{}`, not null.
      metadata: jsonObject(row.metadata) ?? '{}',
      created_at: requiredMillis(row.created_at),
      updated_at: requiredMillis(row.updated_at, row.created_at),
    }),
  },
  // The commercial group (migration 0137).
  ...Object.fromEntries(COMMERCIAL_TABLES.map((table) => [table, commercialSpec(table)])),
  // Migration 0132 made these two NOT NULL where Core's columns are nullable.
  currency_settings: {
    core: 'currency_settings',
    key: ['id'],
    columns: ['id', 'currency_code', 'symbol', 'is_enabled', 'surcharge_percentage', 'created_at'],
    fromCore: (row) => ({
      id: text(row.id),
      currency_code: text(row.currency_code) ?? '',
      symbol: text(row.symbol) ?? '',
      is_enabled: flagOn(row.is_enabled),
      surcharge_percentage: real(row.surcharge_percentage, 5),
      created_at: requiredMillis(row.created_at),
    }),
  },
  exchange_rates_cache: {
    core: 'exchange_rates_cache',
    key: ['id'],
    columns: ['id', 'base_currency', 'target_currency', 'rate', 'last_updated', 'created_at'],
    fromCore: (row) => ({
      id: text(row.id),
      base_currency: text(row.base_currency) ?? 'EUR',
      target_currency: text(row.target_currency) ?? '',
      rate: real(row.rate, 0),
      last_updated: requiredMillis(row.last_updated, row.created_at),
      created_at: requiredMillis(row.created_at),
    }),
  },
};

function specFor(table: string): TableSpec {
  const spec = TABLE_SPECS[table];
  if (!spec) throw new ControlError(`No table ${table} in any group.`, 400, 'invalid_request');
  return spec;
}

function tablesOf(group: WorkGroup, table?: string): readonly string[] {
  const tables = WORK_GROUP_TABLES[group];
  if (table === undefined) return tables;
  if (!tables.includes(table)) throw new ControlError(`The ${group} group has no table ${table}.`, 400, 'invalid_request');
  return [table];
}

export function rowKey(spec: TableSpec, row: D1Row): string {
  return spec.key.map((column) => String(row[column] ?? '')).join('|');
}

// ── Merges made on D1 ──────────────────────────────────────────────────────
// After the `subjects` flip a merge deletes the merged record in D1 only
// (record-merges.ts). Core rows of a group that has not moved still name it.
// The copy, the verify and the diff all map those references to the survivor,
// so D1's foreign keys accept the row and the two digests agree.

/** `<D1 table>` → column → the merged entity its value names. */
const MERGED_COLUMNS: Record<string, Record<string, string>> = {
  contacts: { organization_id: 'organizations' },
  contact_source_events: { contact_id: 'contacts' },
  leads: { organization_id: 'organizations', contact_id: 'contacts' },
  projects: { organization_id: 'organizations', lead_id: 'leads' },
  project_contacts: { contact_id: 'contacts' },
  tasks: { organization_id: 'organizations', lead_id: 'leads', contact_id: 'contacts' },
  interaction_subjects: { via_contact_id: 'contacts' },
  interaction_contacts: { contact_id: 'contacts' },
  interactions: { organization_id: 'organizations', contact_id: 'contacts' },
  partner_agreement_signatures: { contact_id: 'contacts' },
  offers: { organization_id: 'organizations', lead_id: 'leads' },
  licenses: { organization_id: 'organizations', lead_id: 'leads' },
  policies: { organization_id: 'organizations' },
};
/** Subject kinds as D1 stores them, to the merged entity. */
const MERGED_KINDS: Record<string, string> = { organization: 'organizations', lead: 'leads' };
/** Favorite kinds that pin a merged entity by its bare id. */
const MERGED_FAVORITES: Record<string, string> = { 'crm.partner': 'organizations', 'crm.lead': 'leads' };

export type Merges = ReadonlyMap<string, string>;

/** The row with every reference to a merged record pointing at its survivor. Pure. */
export function remapMerged(table: string, row: D1Row, merges: Merges): D1Row {
  if (merges.size === 0) return row;
  const into = (entity: string | undefined, id: Cell) => (entity && typeof id === 'string' ? merges.get(`${entity}:${id}`) : undefined);
  const out = { ...row };
  for (const [column, entity] of Object.entries(MERGED_COLUMNS[table] ?? {})) {
    out[column] = into(entity, out[column] ?? null) ?? out[column] ?? null;
  }
  if (table === 'decisions' || table === 'interaction_subjects') {
    out.subject_id = into(MERGED_KINDS[String(out.subject_kind)], out.subject_id ?? null) ?? out.subject_id ?? null;
  }
  if (table === 'favorites' && typeof out.target_ref === 'string') {
    const kind = String(out.kind);
    const pinned = into(MERGED_FAVORITES[kind], out.target_ref);
    if (pinned) out.target_ref = pinned;
    if (kind === 'core.record') {
      const separator = out.target_ref.indexOf(':');
      const record = into(out.target_ref.slice(0, separator), out.target_ref.slice(separator + 1));
      if (separator > 0 && record) out.target_ref = `${out.target_ref.slice(0, separator)}:${record}`;
    }
  }
  return out;
}

// ── Empty sessions ───────────────────────────────────
// Core holds thousands of `meet_envisioning` interactions for hosted sessions
// where nothing happened: a few minutes, no transcript, no organization, and
// no subject or guest (MZ, 2026-11-04). They do not move. Core's
// archive keeps them. The copy, the verify and the diff all leave them and
// their junction rows out, so the two digests agree.

/** Sessions of this length or longer stay, with or without a transcript. */
const EMPTY_SESSION_MINUTES = 5;

/** A Core `interactions` row for a hosted session with nothing in it. Pure. */
export function isEmptySession(row: Record<string, unknown>): boolean {
  if (row.source !== 'meet_envisioning' || row.organization_id) return false;
  if (typeof row.description !== 'string' || !row.description.includes('No finalized transcript segments')) return false;
  const metadata = metadataOf(row);
  if (metadata.transcript_document_id || Number(metadata.transcript_segment_count ?? 0) > 0) return false;
  return Number(metadata.duration_minutes ?? 0) < EMPTY_SESSION_MINUTES;
}

const EMPTY_SESSION_JUNCTIONS: ReadonlySet<string> = new Set(['interaction_subjects', 'interaction_contacts']);

/** The ids of Core's empty sessions. Only the `interactions` group needs them. */
async function emptySessionIds(env: Env, group: WorkGroup): Promise<ReadonlySet<string>> {
  if (group !== 'interactions') return new Set();
  const rows = await readCoreTable(env, specFor('interactions'));
  return new Set(rows.filter(isEmptySession).map((row) => String(row.id)));
}

/** Core rows mapped to D1 rows, one per key; a later row wins, as the upsert does. */
function mapRows(
  table: string,
  spec: TableSpec,
  rows: ReadonlyArray<Record<string, unknown>>,
  merges: Merges,
  empty: ReadonlySet<string> = new Set(),
): { rows: Map<string, D1Row>; collapsed: number } {
  const mapped = new Map<string, D1Row>();
  const kept = rows.filter((row) => !(
    (table === 'interactions' && empty.has(String(row.id)))
    || (EMPTY_SESSION_JUNCTIONS.has(table) && empty.has(String(row.interaction_id)))
  ));
  for (const row of kept) {
    const d1 = remapMerged(table, spec.fromCore(row), merges);
    mapped.set(rowKey(spec, d1), d1);
  }
  return { rows: mapped, collapsed: kept.length - mapped.size };
}

// ── The two stores ─────────────────────────────────────────────────────────

async function readCorePage(env: Env, spec: TableSpec, offset: number): Promise<{ rows: Array<Record<string, unknown>>; hasMore: boolean }> {
  const response = await signedCoreFetch(env, EXPORT_PATH, {
    method: 'GET',
    searchParams: { table: spec.core, offset: String(offset), limit: String(PAGE_ROWS) },
  });
  if (!response.ok) throw coreFailure('table export', response);
  const page = await readCoreJson(response, coreFoldExportPageSchema, `GET ${EXPORT_PATH}`);
  return { rows: page.rows, hasMore: page.has_more };
}

async function readCoreTable(env: Env, spec: TableSpec): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let pages = 0; pages < READ_PAGE_BUDGET; pages += 1) {
    const page = await readCorePage(env, spec, rows.length);
    rows.push(...page.rows);
    if (!page.hasMore || page.rows.length === 0) return rows;
  }
  throw new ControlError(`Core's ${spec.core} has more than ${READ_PAGE_BUDGET * PAGE_ROWS} rows; verify it one table at a time.`, 409, 'invalid_request');
}

async function readD1Table(env: Env, table: string, spec: TableSpec): Promise<D1Row[]> {
  const columns = spec.columns.map((column) => `"${column}"`).join(', ');
  const { results } = await env.USAGE.prepare(`SELECT ${columns} FROM "${table}"`).all<D1Row>();
  return results;
}

function upsertSql(table: string, spec: TableSpec): string {
  const columns = spec.columns.map((column) => `"${column}"`).join(', ');
  const values = spec.columns.map(() => '?').join(', ');
  const rest = spec.columns.filter((column) => !spec.key.includes(column));
  const conflict = rest.length === 0
    ? 'DO NOTHING'
    : `DO UPDATE SET ${rest.map((column) => `"${column}" = excluded."${column}"`).join(', ')}`;
  return `INSERT INTO "${table}" (${columns}) VALUES (${values}) ON CONFLICT (${spec.key.map((column) => `"${column}"`).join(', ')}) ${conflict}`;
}

async function writeD1Rows(env: Env, table: string, spec: TableSpec, rows: Iterable<D1Row>): Promise<number> {
  const sql = upsertSql(table, spec);
  const all = [...rows];
  for (let start = 0; start < all.length; start += BATCH_ROWS) {
    // One batch is one transaction: a page lands whole or not at all.
    await env.USAGE.batch(all.slice(start, start + BATCH_ROWS).map((row) => env.USAGE.prepare(sql).bind(...spec.columns.map((column) => row[column] ?? null))));
  }
  return all.length;
}

// ── The move's record ──────────────────────────────────────────────────────

interface MoveRow {
  work_group: WorkGroup;
  frozen: number;
  frozen_at: number | null;
  copied_at: number | null;
  verified_at: number | null;
  verified_ok: number | null;
}

async function readMove(env: Env, group: WorkGroup): Promise<MoveRow | null> {
  return env.USAGE.prepare(
    'SELECT work_group, frozen, frozen_at, copied_at, verified_at, verified_ok FROM work_group_moves WHERE work_group = ?1',
  ).bind(group).first<MoveRow>();
}

async function writeMove(env: Env, group: WorkGroup, set: Partial<Omit<MoveRow, 'work_group'>> & { report?: string }, now: number): Promise<void> {
  const columns = Object.keys(set) as Array<keyof typeof set>;
  const assignments = columns.map((column) => `${column} = excluded.${column}`);
  await env.USAGE.prepare(
    `INSERT INTO work_group_moves (work_group, updated_at${columns.map((column) => `, ${column}`).join('')})
     VALUES (?1, ?2${columns.map((_, index) => `, ?${index + 3}`).join('')})
     ON CONFLICT (work_group) DO UPDATE SET updated_at = excluded.updated_at${assignments.map((line) => `, ${line}`).join('')}`,
  ).bind(group, now, ...columns.map((column) => set[column] ?? null)).run();
}

function assertCoreWorkspace(env: Env): void {
  if (!usesCore(env)) throw new ControlError('This workspace keeps its records in D1. Nothing moves.', 409, 'invalid_request');
}

const iso = (value: number | null | undefined) => (typeof value === 'number' ? new Date(value).toISOString() : null);

export async function workGroupStatus(env: Env): Promise<WorkGroupStatus> {
  const groups = await Promise.all(WORK_GROUPS.map(async (group) => {
    const row = usesCore(env) ? await readMove(env, group) : null;
    return {
      group,
      store: groupStore(env, group),
      frozen: row?.frozen === 1,
      frozen_at: iso(row?.frozen_at),
      copied_at: iso(row?.copied_at),
      verified_at: iso(row?.verified_at),
      verified_ok: row?.verified_ok === null || row?.verified_ok === undefined ? null : row.verified_ok === 1,
    };
  }));
  return { groups };
}

// ── The steps ──────────────────────────────────────────────────────────────

export async function freezeGroup(env: Env, group: WorkGroup, now = Date.now()): Promise<void> {
  assertCoreWorkspace(env);
  await writeMove(env, group, { frozen: 1, frozen_at: now }, now);
}

export async function unfreezeGroup(env: Env, group: WorkGroup, now = Date.now()): Promise<void> {
  assertCoreWorkspace(env);
  await writeMove(env, group, { frozen: 0 }, now);
}

/**
 * Copy the group's Core rows into D1, table by table in foreign-key order.
 * Refused unless the group is frozen and still answers from Core: a copy after
 * the flip would write Core's old rows over D1's new ones.
 */
export async function copyGroup(
  env: Env,
  group: WorkGroup,
  resume?: { table: string; offset: number },
  now = Date.now(),
): Promise<{ copied: Record<string, number>; next: { table: string; offset: number } | null }> {
  assertCoreWorkspace(env);
  if (groupStore(env, group) !== 'core') {
    throw new ControlError(`The ${group} group answers from D1 already. A copy would overwrite its new rows.`, 409, 'invalid_request');
  }
  if ((await readMove(env, group))?.frozen !== 1) {
    throw new ControlError(`Freeze the ${group} group before the copy, so no write lands in Core during it.`, 409, 'invalid_request');
  }
  const tables = WORK_GROUP_TABLES[group];
  let index = 0;
  if (resume) {
    index = tables.indexOf(resume.table);
    if (index < 0) throw new ControlError(`The ${group} group has no table ${resume.table}.`, 400, 'invalid_request');
  }
  const copied: Record<string, number> = {};
  const merges = await mergedInto(env);
  const empty = await emptySessionIds(env, group);
  let pages = 0;
  for (; index < tables.length; index += 1) {
    const table = tables[index]!;
    const spec = specFor(table);
    let offset = resume && resume.table === table ? resume.offset : 0;
    copied[table] = 0;
    for (;;) {
      if (pages >= COPY_PAGE_BUDGET) return { copied, next: { table, offset } };
      const page = await readCorePage(env, spec, offset);
      pages += 1;
      copied[table] += await writeD1Rows(env, table, spec, mapRows(table, spec, page.rows, merges, empty).rows.values());
      offset += page.rows.length;
      if (!page.hasMore || page.rows.length === 0) break;
    }
  }
  if (group === 'subjects') copied.record_merges = await copyCoreMergeAliases(env);
  await writeMove(env, group, { copied_at: now }, now);
  return { copied, next: null };
}

/**
 * Core's merge aliases: each id Core redirects to the record it
 * was merged into (`resolve_contact_id`, `resolve_organization_id`). The
 * `subjects` copy writes them into `record_merges`, so a merged id from
 * before the flip opens its survivor on D1, as a D1 merge does after it.
 */
export const CORE_MERGE_ALIASES = [
  { entity: 'organizations', core: 'organization_merge_aliases', from: 'old_organization_id' },
  { entity: 'contacts', core: 'contact_merge_aliases', from: 'old_contact_id' },
] as const;

async function copyCoreMergeAliases(env: Env): Promise<number> {
  let written = 0;
  for (const alias of CORE_MERGE_ALIASES) {
    const spec: TableSpec = { core: alias.core, key: [alias.from], columns: [], fromCore: () => ({}) };
    const rows = (await readCoreTable(env, spec)).flatMap((row) => {
      const from = text(row[alias.from]);
      const into = text(row.survivor_id);
      return from && into && from !== into ? [{ from, into, at: requiredMillis(row.created_at) }] : [];
    });
    const sql = `INSERT INTO record_merges (entity, from_id, into_id, merged_by, merged_at) VALUES (?1, ?2, ?3, NULL, ?4)
      ON CONFLICT (entity, from_id) DO UPDATE SET into_id = excluded.into_id, merged_at = excluded.merged_at`;
    for (let start = 0; start < rows.length; start += BATCH_ROWS) {
      await env.USAGE.batch(rows.slice(start, start + BATCH_ROWS).map((row) => env.USAGE.prepare(sql).bind(alias.entity, row.from, row.into, row.at)));
    }
    written += rows.length;
  }
  return written;
}

/** Row counts and a SHA-256 per table, Core against D1. Read-only on both stores, except the move's own record. */
export async function verifyGroup(env: Env, group: WorkGroup, table?: string, now = Date.now()): Promise<{ tables: WorkGroupTableReport[]; ok: boolean }> {
  assertCoreWorkspace(env);
  const reports: WorkGroupTableReport[] = [];
  const merges = await mergedInto(env);
  const empty = await emptySessionIds(env, group);
  for (const name of tablesOf(group, table)) {
    const spec = specFor(name);
    const raw = await readCoreTable(env, spec);
    const core = mapRows(name, spec, raw, merges, empty);
    const d1 = await readD1Table(env, name, spec);
    const columns = new Set(spec.columns);
    const coreSha = await tableDigest([...core.rows.values()], columns);
    const d1Sha = await tableDigest(d1, columns);
    reports.push({
      table: name,
      core_rows: core.rows.size,
      d1_rows: d1.length,
      core_sha256: coreSha,
      d1_sha256: d1Sha,
      match: core.rows.size === d1.length && coreSha === d1Sha,
      collapsed: core.collapsed,
      ...(name === 'tasks' ? { unknown_assignees: await unknownAssignees(env) } : {}),
    });
  }
  const ok = reports.every((report) => report.match);
  // A one-table check is a step, not the verdict on the group.
  if (table === undefined) await writeMove(env, group, { verified_at: now, verified_ok: ok ? 1 : 0, report: JSON.stringify(reports) }, now);
  return { tables: reports, ok };
}

/** D1 tasks held by a person id no `people` row has ( did not seed them). */
async function unknownAssignees(env: Env): Promise<number> {
  const row = await env.USAGE.prepare(
    'SELECT COUNT(*) AS n FROM tasks t WHERE t.assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM people p WHERE p.person_id = t.assignee_id)',
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * What a rollback would lose: per table, the D1 rows Core does not have or has
 * with other values, and the keys Core has that D1 does not. Run it frozen,
 * after the flip, before the store goes back to Core.
 */
export async function diffGroup(env: Env, group: WorkGroup, table?: string): Promise<WorkGroupDiff[]> {
  assertCoreWorkspace(env);
  const diffs: WorkGroupDiff[] = [];
  const merges = await mergedInto(env);
  const empty = await emptySessionIds(env, group);
  for (const name of tablesOf(group, table)) {
    const spec = specFor(name);
    const core = mapRows(name, spec, await readCoreTable(env, spec), merges, empty).rows;
    const d1 = await readD1Table(env, name, spec);
    const seen = new Set<string>();
    const sameRow = (left: D1Row, right: D1Row) => spec.columns.every((column) => (left[column] ?? null) === (right[column] ?? null));
    const changed: D1Row[] = [];
    for (const row of d1) {
      const key = rowKey(spec, row);
      seen.add(key);
      const before = core.get(key);
      if (!before || !sameRow(before, row)) changed.push(row);
    }
    diffs.push({ table: name, added_or_changed: changed, removed: [...core.keys()].filter((key) => !seen.has(key)) });
  }
  return diffs;
}

/** One admin step, in the response the route sends. */
export async function runWorkGroupMove(
  env: Env,
  input: { action: WorkGroupMoveResponse['action']; group: WorkGroup; table?: string | undefined; resume?: { table: string; offset: number } | undefined },
): Promise<WorkGroupMoveResponse> {
  const result: Partial<WorkGroupMoveResponse> = {};
  switch (input.action) {
    case 'freeze': await freezeGroup(env, input.group); break;
    case 'unfreeze': await unfreezeGroup(env, input.group); break;
    case 'copy': Object.assign(result, await copyGroup(env, input.group, input.resume)); break;
    case 'verify': Object.assign(result, await verifyGroup(env, input.group, input.table)); break;
    case 'diff': result.diff = await diffGroup(env, input.group, input.table); break;
    case 'repoint_merges':
      if (input.group !== 'subjects') throw new ControlError('Merges repoint under the subjects group.', 400, 'invalid_request');
      result.repoint = await replayCoreMergeRepoints(env);
      result.ok = result.repoint.failed.length === 0;
      break;
  }
  const move = await readMove(env, input.group);
  return {
    ...result,
    group: input.group,
    action: input.action,
    frozen: move?.frozen === 1,
    store: groupStore(env, input.group),
  };
}
