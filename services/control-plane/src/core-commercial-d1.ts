// Fold group 5 in Core's names (decided by MZ, 2026-11-04). After
// the `commercial` group moves to D1, Core's own flows (the public offer page,
// its accept, extend, billing and service inputs, the pricing request, the
// expiry reminders, the rate refresh, the public catalog and currency reads)
// come here through `/api/internal/core-writes` and `/api/internal/core-reads`.
// Starlings' own lists on a subject and in INBOX read here too.
//
// Every table keeps Core's name and columns, so one column list
// (`COMMERCIAL_COLUMNS`) maps a row both ways: ISO times to epoch ms, booleans
// to 0 and 1, `jsonb` to JSON text with sorted keys.

import {
  COMMERCIAL_COLUMNS,
  COMMERCIAL_D1_COLUMNS,
  type CommercialColumnKind,
  type CommercialTable,
  type CoreCommercialRowsRequest,
  type CoreCommercialWriteRequest,
} from '@starlings/contracts/core-commercial';
import type { CommercialSummary } from '@starlings/contracts';
import { computeOfferTotals } from '@starlings/contracts/offer-values';
import { purgeCoreCache } from './core-cache';
import { purgeRecordCaches, taskCacheKeys } from './crm';
import { ControlError } from './errors';
import { personIdForEmail } from './person-ids';
import { postSubjectEvent } from './threads';
import { recordWorkActivity, workActivityStatement } from './work-activity';
import { d1LeadWonStatement, d1ProjectInsertStatement } from './work-d1';
import { assertGroupWritable } from './work-freeze';
import { projectLimitError, projectLimitForCreate } from './workspace-plan';

type Cell = string | number | null;
export type CommercialRawRow = Record<string, Cell>;
type Row = CommercialRawRow;
export type CoreCommercialRow = Record<string, unknown>;

/** JSON text with sorted keys at every level, so one value has one text. */
export function commercialJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return JSON.stringify(sorted(value));
}

/** One value as D1 stores it. Pure, so the copy, the verify, a write and a filter agree. */
export function commercialCell(kind: CommercialColumnKind, value: unknown): Cell {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'uuid':
    case 'text':
      return String(value);
    case 'time': {
      const parsed = Date.parse(String(value));
      if (!Number.isFinite(parsed)) throw new ControlError(`Not a time: ${String(value).slice(0, 40)}.`, 400, 'invalid_request');
      return parsed;
    }
    // Postgres sends a `date` as YYYY-MM-DD. A time in this column keeps its day.
    case 'date':
      return String(value).slice(0, 10);
    case 'flag':
      return value === true || value === 1 || value === 'true' ? 1 : 0;
    // PostgREST may send a `numeric` as a string.
    case 'real':
    case 'integer': {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new ControlError(`Not a number: ${String(value).slice(0, 40)}.`, 400, 'invalid_request');
      return number;
    }
    case 'json':
      return commercialJson(value);
  }
}

function jsonOf(value: Cell): unknown {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** A D1 row in Core's names, by a column list of any group. */
export function coreRowFromD1(kinds: Readonly<Record<string, CommercialColumnKind>>, row: Row): CoreCommercialRow {
  const out: CoreCommercialRow = {};
  for (const [column, kind] of Object.entries(kinds)) {
    const value = row[column] ?? null;
    if (value === null) out[column] = null;
    else if (kind === 'time') out[column] = new Date(Number(value)).toISOString();
    else if (kind === 'flag') out[column] = value === 1;
    else if (kind === 'json') out[column] = jsonOf(value);
    else out[column] = value;
  }
  return out;
}

/** A D1 row in Core's names. */
export function coreCommercialRow(table: CommercialTable, row: Row): CoreCommercialRow {
  return coreRowFromD1(COMMERCIAL_COLUMNS[table], row);
}

/** The columns a member route reads and writes: Core's, and the ones only D1 has. */
const allColumns = (table: CommercialTable): Readonly<Record<string, CommercialColumnKind>> => ({ ...COMMERCIAL_COLUMNS[table], ...COMMERCIAL_D1_COLUMNS[table] });

/** A D1 row in Core's names with D1's own columns too: what a member route reads. */
export function memberCommercialRow(table: CommercialTable, row: Row): CoreCommercialRow {
  return coreRowFromD1(allColumns(table), row);
}

/** One column's kind, refused when the group's list does not name it. */
export function columnKind(table: string, kinds: Readonly<Record<string, CommercialColumnKind>>, column: string): CommercialColumnKind {
  const kind = kinds[column];
  if (!kind) throw new ControlError(`${table} has no column ${column}.`, 400, 'invalid_request');
  return kind;
}

const kindOf = (table: CommercialTable, column: string): CommercialColumnKind => columnKind(table, allColumns(table), column);
const quoted = (column: string) => `"${column}"`;

/** The filters of a `commercial_rows` or `signals_rows` read. */
interface GroupRowsRead {
  table: string;
  eq?: Record<string, unknown> | undefined;
  not?: Record<string, unknown> | undefined;
  in?: Record<string, readonly unknown[]> | undefined;
  gte?: Record<string, unknown> | undefined;
  lte?: Record<string, unknown> | undefined;
  order?: ReadonlyArray<{ column: string; descending: boolean }> | undefined;
  limit: number;
  offset: number;
}

/** The raw rows a group's read names. Each column is checked against the list. `also` is a fixed clause of this file's own. */
async function selectGroupRows(
  env: Env,
  kinds: Readonly<Record<string, CommercialColumnKind>>,
  read: GroupRowsRead,
  also?: string,
): Promise<Row[]> {
  const where: string[] = also ? [also] : [];
  const binds: Cell[] = [];
  const bind = (column: string, value: unknown) => {
    binds.push(commercialCell(columnKind(read.table, kinds, column), value));
    return `?${binds.length}`;
  };
  for (const [column, value] of Object.entries(read.eq ?? {})) {
    where.push(value === null ? `${quoted(column)} IS NULL` : `${quoted(column)} = ${bind(column, value)}`);
  }
  for (const [column, value] of Object.entries(read.not ?? {})) where.push(`${quoted(column)} IS NOT ${bind(column, value)}`);
  for (const [column, values] of Object.entries(read.in ?? {})) {
    where.push(`${quoted(column)} IN (${values.map((value) => bind(column, value)).join(', ')})`);
  }
  for (const [column, value] of Object.entries(read.gte ?? {})) where.push(`${quoted(column)} >= ${bind(column, value)}`);
  for (const [column, value] of Object.entries(read.lte ?? {})) where.push(`${quoted(column)} <= ${bind(column, value)}`);
  const order = (read.order ?? []).map((entry) => `${quoted((columnKind(read.table, kinds, entry.column), entry.column))} ${entry.descending ? 'DESC' : 'ASC'}`);
  const sql = `SELECT * FROM ${quoted(read.table)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${order.length ? ` ORDER BY ${order.join(', ')}` : ''} LIMIT ${read.limit} OFFSET ${read.offset}`;
  const { results } = await env.USAGE.prepare(sql).bind(...binds).all<Row>();
  return results;
}

/** The rows a group's read names, in Core's names. */
export async function coreGroupRows(
  env: Env,
  kinds: Readonly<Record<string, CommercialColumnKind>>,
  read: GroupRowsRead,
): Promise<CoreCommercialRow[]> {
  return (await selectGroupRows(env, kinds, read)).map((row) => coreRowFromD1(kinds, row));
}

/** The rows a `commercial_rows` read names, in Core's names. */
export async function coreCommercialRows(env: Env, read: CoreCommercialRowsRequest): Promise<CoreCommercialRow[]> {
  return coreGroupRows(env, COMMERCIAL_COLUMNS[read.table], read);
}

// ── What a buyer reads ───────────────────────────────
// An offer's frozen part lives in `offer_versions`. While an offer has no
// unsent changes its rows equal its latest version, so only a row with unsent
// changes, or a read of an earlier version, opens a snapshot.

/** The columns Send freezes. The rest (status, acceptance, billing, service inputs) the buyer's own flows write. */
export const FROZEN_OFFER_COLUMNS = [
  'title', 'currency', 'exchange_rate', 'total_amount', 'valid_until', 'global_discount_percentage', 'discount_reason', 'tax_percentage', 'tax_reason',
  'payment_term_id', 'delivery_condition_id', 'payment_terms_text', 'delivery_conditions_text', 'corporate_entity_id', 'recipient_email',
  'agreement_date', 'agreement_start_date', 'agreement_end_date', 'agreement_terms_override', 'agreement_notice_email', 'agreement_include_annex',
] as const;

/** One version's `snapshot`: the header, lines and links as the buyer saw them, in Core's names. */
export interface OfferSnapshot {
  offer: CoreCommercialRow;
  notes: string | null;
  lines: CoreCommercialRow[];
  links: CoreCommercialRow[];
}

function parseSnapshot(raw: unknown): OfferSnapshot {
  return JSON.parse(String(raw)) as OfferSnapshot;
}

/**
 * The offer as it stands, ready to freeze. A line with no snapshot columns,
 * from before Core wrote them, takes its service's words now, so a later catalog
 * edit cannot reach a version.
 */
export async function liveOfferSnapshot(env: Env, offerId: string): Promise<OfferSnapshot | null> {
  const [offerResult, lineResult, linkResult] = await env.USAGE.batch([
    env.USAGE.prepare('SELECT * FROM offers WHERE id = ?1').bind(offerId),
    env.USAGE.prepare(
      `SELECT l.*, s.name AS live_name, s.description AS live_description, s.group_type AS live_group, s.is_recurring AS live_recurring
         FROM offer_services l LEFT JOIN services s ON s.id = l.service_id WHERE l.offer_id = ?1 ORDER BY l.id`,
    ).bind(offerId),
    env.USAGE.prepare('SELECT * FROM offer_selected_links WHERE offer_id = ?1 ORDER BY id').bind(offerId),
  ]);
  const offer = offerResult!.results[0] as Row | undefined;
  if (!offer) return null;
  const wire = coreCommercialRow('offers', offer);
  return {
    offer: Object.fromEntries(FROZEN_OFFER_COLUMNS.map((column) => [column, wire[column] ?? null])),
    notes: (offer.notes as string | null) ?? null,
    lines: (lineResult!.results as Row[]).map((line) => coreCommercialRow('offer_services', {
      ...line,
      snapshot_name: line.snapshot_name ?? (line.is_custom === 1 ? line.custom_title ?? null : line.live_name ?? null),
      snapshot_description: line.snapshot_name != null ? line.snapshot_description ?? null : line.is_custom === 1 ? line.custom_description ?? null : line.live_description ?? null,
      snapshot_group_type: line.snapshot_group_type ?? (line.is_custom === 1 ? 'Custom' : line.live_group ?? null),
      snapshot_is_recurring: line.snapshot_is_recurring ?? (line.is_custom === 1 ? 0 : line.live_recurring ?? 0),
    })),
    links: (linkResult!.results as Row[]).map((link) => coreCommercialRow('offer_selected_links', link)),
  };
}

interface VersionMeta { offer_id: string; version: number; sent_at: number }

const ID_CHUNK = 90;

async function latestVersions(env: Env, offerIds: readonly string[]): Promise<Map<string, VersionMeta>> {
  const latest = new Map<string, VersionMeta>();
  for (let start = 0; start < offerIds.length; start += ID_CHUNK) {
    const chunk = offerIds.slice(start, start + ID_CHUNK);
    // SQLite answers the other columns from the row holding the MAX.
    const { results } = await env.USAGE.prepare(
      `SELECT offer_id, MAX(version) AS version, sent_at FROM offer_versions WHERE offer_id IN (${chunk.map((_, index) => `?${index + 1}`).join(', ')}) GROUP BY offer_id`,
    ).bind(...chunk).all<VersionMeta>();
    for (const row of results) latest.set(row.offer_id, row);
  }
  return latest;
}

async function snapshotOf(env: Env, offerId: string, version: number | undefined): Promise<(VersionMeta & { snapshot: OfferSnapshot }) | null> {
  const row = await env.USAGE.prepare(
    `SELECT offer_id, version, sent_at, snapshot FROM offer_versions WHERE offer_id = ?1 AND version = ${version === undefined ? '(SELECT MAX(version) FROM offer_versions WHERE offer_id = ?1)' : '?2'}`,
  ).bind(...(version === undefined ? [offerId] : [offerId, version])).first<VersionMeta & { snapshot: string }>();
  return row ? { ...row, snapshot: parseSnapshot(row.snapshot) } : null;
}

const iso = (millis: number) => new Date(millis).toISOString();

/** The offers a read names, as the buyer sees them. A draft a member has not sent answers no row. */
async function servedOffers(env: Env, read: CoreCommercialRowsRequest): Promise<CoreCommercialRow[]> {
  const rows = await selectGroupRows(env, COMMERCIAL_COLUMNS[read.table], read, 'unsent_draft IS NOT 1');
  const latest = await latestVersions(env, rows.map((row) => String(row.id)));
  const out: CoreCommercialRow[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const open = read.version !== undefined || row.has_unsent_changes === 1 ? await snapshotOf(env, id, read.version) : null;
    if (read.version !== undefined && !open) continue;
    const version = open ?? latest.get(id) ?? null;
    out.push({
      ...coreCommercialRow('offers', row),
      ...open?.snapshot.offer,
      notes: open ? open.snapshot.notes : (row.notes as string | null) ?? null,
      served_version: version?.version ?? null,
      served_sent_at: version ? iso(version.sent_at) : null,
    });
  }
  return out;
}

/** The lines or links of a read, as the buyer sees them. */
async function servedChildren(env: Env, read: CoreCommercialRowsRequest): Promise<CoreCommercialRow[]> {
  const offerId = read.eq?.offer_id;
  if (typeof offerId !== 'string') {
    // No Core flow reads these across offers. An offer with unsent edits or no buyer yet answers no line here, so nothing unsent leaks.
    return (await selectGroupRows(env, COMMERCIAL_COLUMNS[read.table], read, 'offer_id NOT IN (SELECT id FROM offers WHERE has_unsent_changes = 1 OR unsent_draft = 1)')).map((row) => coreCommercialRow(read.table, row));
  }
  const offer = await env.USAGE.prepare('SELECT unsent_draft, has_unsent_changes FROM offers WHERE id = ?1').bind(offerId).first<{ unsent_draft: number; has_unsent_changes: number }>();
  if (!offer || offer.unsent_draft === 1) return [];
  if (read.version === undefined && offer.has_unsent_changes !== 1) return coreCommercialRows(env, read);
  const frozen = await snapshotOf(env, offerId, read.version);
  if (!frozen) return [];
  const rows = read.table === 'offer_services' ? frozen.snapshot.lines : frozen.snapshot.links;
  const matches = (row: CoreCommercialRow) => Object.entries(read.eq ?? {}).every(([column, value]) => (row[column] ?? null) === value);
  return rows.filter(matches).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(read.offset, read.offset + read.limit);
}

/**
 * The door Core's flows read through once the group moved. An edit never
 * changes what a buyer sees: `offers`, `offer_services` and
 * `offer_selected_links` answer the latest sent version, or the one `version`
 * names, and every other table its live rows.
 */
export function servedCommercialRows(env: Env, read: CoreCommercialRowsRequest): Promise<CoreCommercialRow[]> {
  if (read.table === 'offers') return servedOffers(env, read);
  if (read.table === 'offer_services' || read.table === 'offer_selected_links') return servedChildren(env, read);
  return coreCommercialRows(env, read);
}

/**
 * One insert in Core's names, for a caller that lands several rows in one batch
 * (a duplicate, a restore). The values are mapped as a door's write is mapped.
 */
export function commercialInsertStatement(env: Env, table: CommercialTable, values: Readonly<Record<string, unknown>>): D1PreparedStatement {
  const names = Object.keys(values);
  return env.USAGE.prepare(
    `INSERT INTO ${quoted(table)} (${names.map(quoted).join(', ')}) VALUES (${names.map((_, index) => `?${index + 1}`).join(', ')})`,
  ).bind(...names.map((name) => commercialCell(kindOf(table, name), values[name])));
}

/** One calendar year on, with no time zone: 29 February lands on the 28th. */
function addOneYearToDay(day: string): string {
  const year = Number(day.slice(0, 4)) + 1;
  const month = Number(day.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${day.slice(5, 7)}-${String(Math.min(Number(day.slice(8, 10)), last)).padStart(2, '0')}`;
}

/** What an accept made or found. A created row is new; otherwise the id is the one that already stood. */
export interface OfferAcceptance {
  row: CoreCommercialRow;
  license_id: string | null;
  license_created: boolean;
  project_id: string | null;
  project_created: boolean;
}

const ACCEPT_GUARD_FAILED = /NOT NULL constraint failed: offer_versions\.offer_id/u;

/**
 * The one acceptance (#223; decided by MZ, 2026-11-05).
 * A member's recorded accept and Core's public accept both land here: Core's
 * accept reaches this through the write door, so its own license and project
 * steps then find the rows and stop. `values` are the offer's own columns, and
 * `accepted_metadata.selected_optional_ids` names the optional lines taken.
 *
 * One batch, so an offer is never locked without what its accept makes:
 *
 * - The offer locks on the version the buyer read. Unsent edits go back to it.
 * - The optional lines the buyer took become regular lines.
 * - A license, unless one stands for this offer: the recurring total after the
 *   discount, from the agreement's start or the offer's creation, for a year.
 *   No recurring amount, no license.
 * - A project from the offer's lead, unless the lead has one: the lead's title
 *   and organization, status Active. Only a new project closes the lead as won.
 * - A proposed kick-off task on the new project, else the lead, once per offer.
 *
 * The answer is null when a guard does not hold: already accepted, or no row.
 */
export async function acceptOfferRecord(
  env: Env,
  actor: string,
  id: string,
  values: Readonly<Record<string, unknown>>,
  guards: { only_if?: Readonly<Record<string, unknown>> | undefined; unless?: Readonly<Record<string, unknown>> | undefined } = {},
): Promise<OfferAcceptance | null> {
  await Promise.all([assertGroupWritable(env, 'commercial'), assertGroupWritable(env, 'subjects'), assertGroupWritable(env, 'tasks')]);
  const current = await env.USAGE.prepare('SELECT * FROM offers WHERE id = ?1').bind(id).first<Row>();
  if (!current) return null;
  if (current.unsent_draft === 1) throw new ControlError('This offer has not been sent.', 409, 'invalid_request');

  const unsent = current.has_unsent_changes === 1;
  const latest = await snapshotOf(env, id, undefined);
  const live = (await liveOfferSnapshot(env, id))!;
  const served = unsent && latest ? latest.snapshot : live;

  const now = Date.now();
  const cells: Row = Object.fromEntries(Object.entries(values).map(([column, value]) => [column, commercialCell(kindOf('offers', column), value)]));
  cells.updated_at ??= now;
  cells.accepted_version = latest?.version ?? null;
  cells.has_unsent_changes = 0;
  const columns = Object.keys(cells);

  // The batch's first statement fails it when a guard does not hold: a row with no `offer_id`. A batch is one transaction, so nothing after it lands.
  const guardBinds: Cell[] = [id];
  const guardClauses: string[] = ['"is_accepted" IS NOT 1'];
  for (const [column, value] of Object.entries(guards.only_if ?? {})) {
    guardBinds.push(commercialCell(kindOf('offers', column), value));
    guardClauses.push(`${quoted(column)} IS ?${guardBinds.length}`);
  }
  for (const [column, value] of Object.entries(guards.unless ?? {})) {
    guardBinds.push(commercialCell(kindOf('offers', column), value));
    guardClauses.push(`${quoted(column)} IS NOT ?${guardBinds.length}`);
  }
  const statements: D1PreparedStatement[] = [
    env.USAGE.prepare(
      `INSERT INTO offer_versions (id, offer_id, version, sent_at, snapshot, totals)
       SELECT 'accept-guard', NULL, 0, 0, '', '' WHERE NOT EXISTS (SELECT 1 FROM offers WHERE id = ?1 AND ${guardClauses.join(' AND ')})`,
    ).bind(...guardBinds),
    env.USAGE.prepare(`UPDATE offers SET ${columns.map((column, index) => `${quoted(column)} = ?${index + 2}`).join(', ')} WHERE id = ?1`)
      .bind(id, ...columns.map((column) => cells[column] ?? null)),
  ];
  const trail: Parameters<typeof workActivityStatement>[1][] = [
    { actor, table: 'offers', id, action: 'update', label: (served.offer.title as string | null) ?? null, fields: [...Object.keys(values), 'accepted_version', 'has_unsent_changes'] },
  ];

  if (unsent && latest) {
    const restored = FROZEN_OFFER_COLUMNS.filter((column) => !(column in values));
    statements.push(
      env.USAGE.prepare(`UPDATE offers SET ${restored.map((column, index) => `${quoted(column)} = ?${index + 2}`).join(', ')}, notes = ?${restored.length + 2} WHERE id = ?1`)
        .bind(id, ...restored.map((column) => commercialCell(kindOf('offers', column), latest.snapshot.offer[column])), latest.snapshot.notes),
      env.USAGE.prepare('DELETE FROM offer_services WHERE offer_id = ?1').bind(id),
      ...latest.snapshot.lines.map((line) => commercialInsertStatement(env, 'offer_services', line)),
      env.USAGE.prepare('DELETE FROM offer_selected_links WHERE offer_id = ?1').bind(id),
      ...latest.snapshot.links.map((link) => commercialInsertStatement(env, 'offer_selected_links', link)),
    );
    trail.push({ actor, table: 'offer_services', id, action: 'update', fields: ['restored'] });
  }

  // Only ids of optional lines on this offer count.
  const metadata = values.accepted_metadata as { selected_optional_ids?: unknown } | null | undefined;
  const asked = Array.isArray(metadata?.selected_optional_ids) ? metadata.selected_optional_ids : [];
  const chosen = new Set(served.lines.filter((line) => line.is_optional === true && asked.includes(line.id)).map((line) => String(line.id)));
  for (const lineId of chosen) {
    statements.push(env.USAGE.prepare('UPDATE offer_services SET is_optional = 0 WHERE id = ?1 AND offer_id = ?2').bind(lineId, id));
    trail.push({ actor, table: 'offer_services', id: lineId, action: 'update', fields: ['is_optional'] });
  }

  // The license. A link in `license_offers` counts too: that table allows one license per offer.
  const standing = await env.USAGE.prepare(
    'SELECT id FROM licenses WHERE offer_id = ?1 UNION ALL SELECT license_id AS id FROM license_offers WHERE offer_id = ?1 LIMIT 1',
  ).bind(id).first<string>('id');
  let licenseId = standing ?? null;
  let licenseCreated = false;
  if (!standing) {
    const amount = computeOfferTotals(served.lines.map((line) => ({
      price: line.price as number,
      quantity: line.quantity as number,
      is_optional: line.is_optional === true && !chosen.has(String(line.id)),
      is_recurring: line.snapshot_is_recurring === true,
    })), { globalDiscountPct: (served.offer.global_discount_percentage as number | null) ?? null }).recurring_total_eur;
    if (amount > 0) {
      const created = coreCommercialRow('offers', current).created_at as string | null;
      const start = String(served.offer.agreement_start_date ?? created ?? new Date(now).toISOString()).slice(0, 10);
      const stamp = new Date(now).toISOString();
      licenseId = crypto.randomUUID();
      licenseCreated = true;
      statements.push(
        commercialInsertStatement(env, 'licenses', {
          id: licenseId, created_at: stamp, updated_at: stamp, organization_id: current.organization_id ?? null, lead_id: current.lead_id ?? null, offer_id: id,
          start_date: start, renewal_date: addOneYearToDay(start), amount_eur: amount, is_active: true,
        }),
        commercialInsertStatement(env, 'license_offers', { license_id: licenseId, offer_id: id, created_at: stamp }),
      );
      trail.push(
        { actor, table: 'licenses', id: licenseId, action: 'insert', fields: ['offer_id', 'amount_eur'] },
        { actor, table: 'license_offers', id: `${licenseId}:${id}`, action: 'insert' },
      );
    }
  }

  // The project, from the lead, and only from a lead.
  const leadId = typeof current.lead_id === 'string' ? current.lead_id : null;
  const lead = leadId
    ? await env.USAGE.prepare('SELECT title, organization_id FROM leads WHERE id = ?1').bind(leadId).first<{ title: string | null; organization_id: string | null }>()
    : null;
  let projectId: string | null = null;
  let projectCreated = false;
  let projectTitle = '';
  if (leadId && lead) {
    projectId = await env.USAGE.prepare('SELECT id FROM projects WHERE lead_id = ?1 ORDER BY created_at LIMIT 1').bind(leadId).first<string>('id');
    if (!projectId) {
      const limit = await projectLimitForCreate(env);
      if (limit !== null && (await env.USAGE.prepare('SELECT COUNT(*) AS n FROM projects').first<number>('n'))! >= limit) throw projectLimitError();
      projectId = crypto.randomUUID();
      projectCreated = true;
      projectTitle = lead.title || 'Untitled Project';
      statements.push(
        d1ProjectInsertStatement(env, {
          id: projectId, organization_id: lead.organization_id, lead_id: leadId, title: projectTitle, status: 'Active',
          created_by: await personIdForEmail(env, actor), now,
        }, null),
        d1LeadWonStatement(env, leadId, now),
      );
      trail.push(
        { actor, table: 'projects', id: projectId, action: 'insert', label: projectTitle, fields: ['lead_id', 'organization_id', 'status', 'title'] },
        { actor, table: 'leads', id: leadId, action: 'update', fields: ['status'] },
      );
    }
  }

  // The kick-off, so somebody owns it. The tag makes it once per offer: Core's own proposal finds this row and stops.
  const tag = `crm-event:offer:${id}:offer.accepted`;
  const taskSubject = projectCreated ? { project_id: projectId } : leadId ? { lead_id: leadId } : null;
  if (taskSubject) {
    const proposed = await env.USAGE.prepare(`SELECT 1 AS one FROM tasks t WHERE EXISTS (SELECT 1 FROM json_each(t.tags) WHERE json_each.value = ?1) LIMIT 1`).bind(tag).first<number>('one');
    if (!proposed) {
      const label = (served.offer.title as string | null) || 'Untitled Offer';
      const organization = typeof current.organization_id === 'string'
        ? await env.USAGE.prepare('SELECT name FROM organizations WHERE id = ?1').bind(current.organization_id).first<string>('name')
        : null;
      const acceptedBy = typeof values.accepted_by_name === 'string' && values.accepted_by_name ? values.accepted_by_name : 'A team member';
      const taskId = crypto.randomUUID();
      statements.push(env.USAGE.prepare(
        `INSERT INTO tasks (id, title, notes, status, responsible_party, priority, project_id, lead_id, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'proposed', 'team', 'high', ?4, ?5, ?6, ?7, ?7)`,
      ).bind(
        taskId, `Kick off delivery: ${label}`,
        `${acceptedBy} accepted “${label}”${organization ? ` for ${organization}` : ''} on ${new Date(now).toISOString().slice(0, 10)}.\nAccept to put it on the plate, decline if delivery is already under way.`,
        taskSubject.project_id ?? null, taskSubject.lead_id ?? null, JSON.stringify(['proposed', tag]), now,
      ));
      trail.push({ actor, table: 'tasks', id: taskId, action: 'insert', label: `Kick off delivery: ${label}`, fields: ['status', 'tags'] });
    }
  }

  statements.push(...trail.map((entry) => workActivityStatement(env, entry, now)));
  try {
    await env.USAGE.batch(statements);
  } catch (error) {
    if (error instanceof Error && ACCEPT_GUARD_FAILED.test(error.message)) return null;
    throw error;
  }

  // After the commit: a lost cache purge or channel line is logged, never a failed accept.
  try {
    if (projectCreated) await purgeRecordCaches('projects', null);
    if (taskSubject) await purgeCoreCache(taskCacheKeys(taskSubject));
    if (projectCreated) await postSubjectEvent(env, { kind: 'project', id: projectId! }, `New Project: ${projectTitle}`, [], { dedupeKey: `crm:project:${projectId}:created` });
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', message: 'offer.accept.after.failed', error: error instanceof Error ? error.message : 'Unknown error' }));
  }
  const row = await env.USAGE.prepare('SELECT * FROM offers WHERE id = ?1').bind(id).first<Row>();
  return { row: coreCommercialRow('offers', row!), license_id: licenseId, license_created: licenseCreated, project_id: projectId, project_created: projectCreated };
}

const MONTH_LABEL = new Intl.DateTimeFormat('en', { month: 'short', year: '2-digit', timeZone: 'UTC' });

/**
 * Home's commercial card, from D1. Core's dashboard series, in the
 * one shape: each month's offers by `created_at`, and new licences by
 * `start_date`. Accepted is sales, past `valid_until` is lost, the rest is
 * pipeline. `total_amount` is EUR on every offer, so the figures are EUR. A draft
 * a member has not sent is not yet an offer.
 */
export async function d1CommercialSummary(env: Env, months: number, now = new Date()): Promise<CommercialSummary> {
  const keys = Array.from({ length: months }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1 - index), 1));
    return { key: date.toISOString().slice(0, 7), label: MONTH_LABEL.format(date), start: date.getTime() };
  });
  const [offers, licenses] = await env.USAGE.batch([
    env.USAGE.prepare('SELECT total_amount, is_accepted, valid_until, created_at FROM offers WHERE created_at >= ?1 AND unsent_draft IS NOT 1').bind(keys[0]!.start),
    env.USAGE.prepare('SELECT start_date FROM licenses WHERE start_date >= ?1').bind(keys[0]!.key),
  ]);
  const sales = new Map(keys.map(({ key }) => [key, { total: 0, positive: 0, negative: 0 }]));
  let offerCount = 0;
  for (const offer of offers!.results as Array<{ total_amount: number | null; is_accepted: number | null; valid_until: number | null; created_at: number }>) {
    const bucket = sales.get(new Date(offer.created_at).toISOString().slice(0, 7));
    if (!bucket) continue;
    offerCount += 1;
    const amount = Number(offer.total_amount) || 0;
    if (amount <= 0) continue;
    bucket.total += amount;
    if (offer.is_accepted === 1) bucket.positive += amount;
    else if (offer.valid_until !== null && offer.valid_until < now.getTime()) bucket.negative += amount;
  }
  const newLicenses = (licenses!.results as Array<{ start_date: string }>).filter((license) => sales.has(license.start_date.slice(0, 7))).length;
  const points = keys.map(({ key, label }) => ({ key, label, ...sales.get(key)! }));
  return {
    lookback_months: months,
    offers: offerCount,
    sales_amount: points.reduce((sum, point) => sum + point.positive, 0),
    pipeline_amount: points.reduce((sum, point) => sum + Math.max(point.total - point.positive - point.negative, 0), 0),
    new_licenses: newLicenses,
    currency_code: 'EUR',
    points,
  };
}

/** The newest offers or licences on a subject, for Starlings' own lists. Core's agent lists answer in the same names. */
export async function d1CommercialList(
  env: Env,
  table: 'offers' | 'licenses',
  filter: Readonly<Record<string, string>>,
): Promise<CoreCommercialRow[]> {
  const eq = Object.fromEntries(['lead_id', 'organization_id'].flatMap((column) => (filter[column] ? [[column, filter[column]!]] : [])));
  // A member's list, not a buyer's read: it names D1's columns, such as `has_unsent_changes`.
  const rows = await selectGroupRows(env, allColumns(table), {
    table,
    eq,
    order: [{ column: table === 'offers' ? 'created_at' : 'start_date', descending: true }],
    limit: Math.min(Math.max(Number(filter.limit) || 100, 1), 1000),
    offset: 0,
  });
  return rows.map((row) => memberCommercialRow(table, row));
}

/** Core's offer insert trigger: a term, its text and a corporate entity when the write names none. */
async function withOfferDefaults(env: Env, cells: Row): Promise<Row> {
  const out = { ...cells };
  if (!out.payment_term_id) {
    const term = await env.USAGE.prepare(
      'SELECT id, description FROM settings_payment_terms WHERE is_active = 1 ORDER BY is_default DESC, title ASC LIMIT 1',
    ).first<{ id: string; description: string }>();
    if (term) {
      out.payment_term_id = term.id;
      out.payment_terms_text ??= term.description;
    }
  } else if (out.payment_terms_text === undefined || out.payment_terms_text === null) {
    const term = await env.USAGE.prepare('SELECT description FROM settings_payment_terms WHERE id = ?1')
      .bind(out.payment_term_id).first<{ description: string }>();
    out.payment_terms_text = term?.description ?? null;
  }
  if (!out.corporate_entity_id) {
    const entity = await env.USAGE.prepare('SELECT id FROM corporate_entities ORDER BY is_default = 1 DESC, name ASC LIMIT 1').first<{ id: string }>();
    if (entity) out.corporate_entity_id = entity.id;
  }
  return out;
}

const labelOf = (row: Row): string | null =>
  (['title', 'name', 'currency_code', 'target_currency'].map((column) => row[column]).find((value) => typeof value === 'string') as string | undefined) ?? null;

/**
 * One write from Core, into D1. The answer is the whole row in Core's names,
 * or null for an update or delete that matched no row, an `only_if` or `unless`
 * that did not hold included. A view log is no change to the work model, so it
 * writes no activity row.
 */
export async function writeCoreCommercial(env: Env, actor: string, write: CoreCommercialWriteRequest, source: 'core' | 'member' = 'core'): Promise<CoreCommercialRow | null> {
  await assertGroupWritable(env, 'commercial');
  const { table } = write;
  const columns = COMMERCIAL_COLUMNS[table];
  const hasId = 'id' in columns;
  const trail = table !== 'offer_access_logs';
  const selectById = (id: string) => env.USAGE.prepare(`SELECT * FROM ${quoted(table)} WHERE id = ?1`).bind(id).first<Row>();

  if (write.action === 'delete') {
    if (!hasId) throw new ControlError(`${table} has no id.`, 400, 'invalid_request');
    const row = await selectById(write.id);
    if (!row) return null;
    await env.USAGE.prepare(`DELETE FROM ${quoted(table)} WHERE id = ?1`).bind(write.id).run();
    if (trail) await recordWorkActivity(env, { actor, table, id: write.id, action: 'delete', label: labelOf(row) });
    return coreCommercialRow(table, row);
  }

  const now = Date.now();
  let cells: Row = Object.fromEntries(Object.entries(write.values).map(([column, value]) => [column, commercialCell(kindOf(table, column), value)]));
  const fields = Object.keys(write.values).sort();

  if (write.action === 'create') {
    const id = crypto.randomUUID();
    if (hasId) cells.id = id;
    for (const stamp of ['created_at', 'updated_at', 'accessed_at', 'last_updated']) {
      if (stamp in columns) cells[stamp] ??= now;
    }
    if (table === 'offers') cells = await withOfferDefaults(env, cells);
    const names = Object.keys(cells);
    await env.USAGE.prepare(
      `INSERT INTO ${quoted(table)} (${names.map(quoted).join(', ')}) VALUES (${names.map((_, index) => `?${index + 1}`).join(', ')})`,
    ).bind(...names.map((name) => cells[name] ?? null)).run();
    const row = hasId
      ? await selectById(id)
      : await env.USAGE.prepare('SELECT * FROM license_offers WHERE license_id = ?1 AND offer_id = ?2').bind(cells.license_id ?? null, cells.offer_id ?? null).first<Row>();
    if (!row) throw new ControlError('The record was not saved.', 500);
    if (trail) await recordWorkActivity(env, { actor, table, id: hasId ? id : `${cells.license_id}:${cells.offer_id}`, action: 'insert', label: labelOf(row), fields });
    return coreCommercialRow(table, row);
  }

  if (!hasId) throw new ControlError(`${table} has no id.`, 400, 'invalid_request');
  if (table === 'offers' && write.values.is_accepted === true) {
    return (await acceptOfferRecord(env, actor, write.id, write.values, { only_if: write.only_if, unless: write.unless }))?.row ?? null;
  }
  // Core's `update_*_updated_at` triggers.
  if ('updated_at' in columns) cells.updated_at ??= now;
  const names = Object.keys(cells);
  const binds: Cell[] = [write.id, ...names.map((name) => cells[name] ?? null)];
  const guard: string[] = [];
  for (const [column, value] of Object.entries(write.only_if ?? {})) {
    binds.push(commercialCell(kindOf(table, column), value));
    guard.push(`${quoted(column)} IS ?${binds.length}`);
  }
  for (const [column, value] of Object.entries(write.unless ?? {})) {
    binds.push(commercialCell(kindOf(table, column), value));
    guard.push(`${quoted(column)} IS NOT ?${binds.length}`);
  }
  const result = await env.USAGE.prepare(
    `UPDATE ${quoted(table)} SET ${names.map((name, index) => `${quoted(name)} = ?${index + 2}`).join(', ')} WHERE id = ?1${guard.map((clause) => ` AND ${clause}`).join('')}`,
  ).bind(...binds).run();
  if (!result.meta.changes) return null;
  // The buyer's own extension reaches the version they read. A member's new date waits for Send update.
  if (source === 'core' && table === 'offers' && 'valid_until' in write.values) {
    await env.USAGE.prepare(
      `UPDATE offer_versions SET snapshot = json_set(snapshot, '$.offer.valid_until', ?2)
        WHERE offer_id = ?1 AND version = (SELECT MAX(version) FROM offer_versions WHERE offer_id = ?1)`,
    ).bind(write.id, write.values.valid_until as string | null).run();
  }
  const row = await selectById(write.id);
  if (!row) return null;
  if (trail) await recordWorkActivity(env, { actor, table, id: write.id, action: 'update', label: labelOf(row), fields });
  return coreCommercialRow(table, row);
}
