// Core's own flows, reading fold group 1 through the Worker.
//
// Core's public flows read organizations, contacts, leads and projects from
// Postgres. After the `subjects` group moves to D1, Core's copy is
// frozen and stale, so Core reads here instead: signed with its own inbound
// key, behind the same locks as `/api/internal/core-writes`. Answers use
// Core's column names (`core-records-d1.ts`), so a caller reads one shape from
// either store.
//
// While the group is on Core, Core reads its own tables and this door refuses.
// Fold group 2 (milestones, tasks) has its own ops, which answer
// once the `tasks` group is on D1 (`core-tasks-d1.ts`), and so has fold group
// 4 (interactions and partner agreements, `core-interactions-d1.ts`)
// and fold group 5 (commercial, `core-commercial-d1.ts`) and fold
//

import {
  coreReadRequestSchema,
  type CoreMilestonesResponse,
  type CoreOfferSignersResponse,
  type CoreProjectWorkResponse,
  type CoreReadRequest,
  type CoreRowsResponse,
  type CoreProjectPage,
  type CoreProjectPageResponse,
  type CoreSubjectSearchEntity,
  type CoreSubjectSearchResponse,
} from '@starlings/contracts/core-reads';
import type { CoreCommercialRowsResponse } from '@starlings/contracts/core-commercial';
import { servedCommercialRows } from './core-commercial-d1';
import { coreInteractionRow, coreInteractionRows, corePartnerSignature } from './core-interactions-d1';
import { d1CoreRowsById, d1CoreRowsOfOrganization, fetchD1CoreRecord } from './core-records-d1';
import { coreMilestones, coreProjectWork, coreTaskById, coreTaskByTag, coreTasks } from './core-tasks-d1';
import { readCoreCall } from './core-writes';
import { ControlError } from './errors';
import { json } from './http';
import { usesCore, usesCoreFor } from './work-store';

/** The ops that read fold group 2. */
const TASK_OPS: ReadonlySet<CoreReadRequest['op']> = new Set(['task', 'task_by_tag', 'project_work', 'milestones', 'tasks']);
/** The ops that read fold group 4. */
const INTERACTION_OPS: ReadonlySet<CoreReadRequest['op']> = new Set(['interaction', 'interactions', 'partner_agreement_signature']);

/** A row in Core's column names. */
type CoreRow = Record<string, unknown>;

export async function handleInternalCoreRead(request: Request, env: Env): Promise<Response> {
  const read = coreReadRequestSchema.parse(await readCoreCall(request, env, 'core-reads'));
  if (!usesCore(env)) throw new ControlError('This workspace keeps its CRM in D1.', 404, 'not_configured');
  // Each op reads one fold group, and answers once that group is on D1.
  const group = read.op === 'commercial_rows' ? 'commercial' : TASK_OPS.has(read.op) ? 'tasks' : INTERACTION_OPS.has(read.op) ? 'interactions' : 'subjects';
  if (usesCoreFor(env, group)) {
    throw new ControlError('These records are still in Core. Read them there.', 409, 'not_configured');
  }
  switch (read.op) {
    case 'commercial_rows':
      return json({ data: await servedCommercialRows(env, read) } satisfies CoreCommercialRowsResponse);
    case 'interaction':
      return json({ data: await coreInteractionRow(env, read.id) });
    case 'interactions':
      return json({ data: await coreInteractionRows(env, read) });
    case 'partner_agreement_signature':
      return json({ data: await corePartnerSignature(env, read.agreement_id, read.contact_id) });
    case 'task':
      return json({ data: await coreTaskById(env, read.id) });
    case 'task_by_tag':
      return json({ data: await coreTaskByTag(env, read.tag) });
    case 'project_work':
      return json({ data: await coreProjectWork(env, read.id) } satisfies CoreProjectWorkResponse);
    case 'milestones':
      return json({ data: await coreMilestones(env) } satisfies CoreMilestonesResponse);
    case 'tasks':
      return json({ data: await coreTasks(env, read) } as CoreRowsResponse);
    case 'rows':
      return json({ data: await d1CoreRowsById(env, read.entity, read.ids) } as CoreRowsResponse);
    case 'organization_rows':
      return json({ data: await d1CoreRowsOfOrganization(env, read.entity, read.organization_id, read.limit) } as CoreRowsResponse);
    case 'row':
      return json({ data: await rowOrNull(env, read.entity, read.id) });
    case 'contact_by_email':
      return json({ data: await contactByEmail(env, read.email) });
    case 'organization_by_name':
      return json({ data: await oldestWhere(env, 'organizations', 'name = ?1 COLLATE NOCASE', read.name) });
    case 'organization_by_domain':
      return json({ data: await oldestWhere(env, 'organizations', 'lower(trim(domain)) = ?1', read.domain) });
    case 'lead_by_contact':
      return json({ data: await leadByContact(env, read.contact_id, read.statuses ?? null) });
    case 'project_by_lead':
      return json({ data: await oldestWhere(env, 'projects', 'lead_id = ?1', read.lead_id) });
    case 'project_page':
      return json({ data: await projectPage(env, read.id, read.email ?? null) } satisfies CoreProjectPageResponse);
    case 'offer_signers':
      return json({ data: { addresses: await offerSigners(env, read.lead_id, read.organization_id) } } satisfies CoreOfferSignersResponse);
    case 'subject_search':
      return json({ data: await subjectSearch(env, read.entity, read.query, read.ids ?? null, read.limit) } satisfies CoreSubjectSearchResponse);
  }
}

async function rowOrNull(env: Env, entity: 'organizations' | 'contacts' | 'leads' | 'projects', id: string): Promise<CoreRow | null> {
  try {
    const answer = await fetchD1CoreRecord(env, entity, id) as { data: CoreRow };
    return answer.data;
  } catch (error) {
    if (error instanceof ControlError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The contact an address belongs to: its primary email, its corporate email,
 * or another address it holds (`contact_emails`). When two contacts hold the
 * address, a person decides: the door refuses, as Core's `findContactByEmail`
 * fails closed, so Core creates nothing and links nothing.
 */
async function contactByEmail(env: Env, email: string): Promise<CoreRow | null> {
  const { results } = await env.USAGE.prepare(
    `SELECT id FROM contacts WHERE lower(trim(email)) = ?1
     UNION SELECT id FROM contacts WHERE lower(trim(corporate_email)) = ?1
     UNION SELECT c.id FROM contact_emails e JOIN contacts c ON c.id = e.contact_id WHERE e.email = ?1
     LIMIT 2`,
  ).bind(email).all<{ id: string }>();
  if (results.length > 1) {
    throw new ControlError('More than one contact holds this address. A person must decide.', 409, 'ambiguous_contact');
  }
  return results[0] ? rowOrNull(env, 'contacts', results[0].id) : null;
}

/** The newest lead of a contact, with one of `statuses` when Core sends them. */
async function leadByContact(env: Env, contactId: string, statuses: string[] | null): Promise<CoreRow | null> {
  const filter = statuses ? ` AND status IN (${statuses.map((_, index) => `?${index + 2}`).join(', ')})` : '';
  const match = await env.USAGE.prepare(
    `SELECT id FROM leads WHERE contact_id = ?1${filter} ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(contactId, ...(statuses ?? [])).first<{ id: string }>();
  return match ? rowOrNull(env, 'leads', match.id) : null;
}

/**
 * The oldest row that matches. Core's flows look up an organization by name or
 * email domain, and a project by its lead, before they create one, so a miss
 * here creates a duplicate. The oldest row wins when several match.
 */
async function oldestWhere(env: Env, entity: 'organizations' | 'projects', where: string, value: string): Promise<CoreRow | null> {
  const match = await env.USAGE.prepare(`SELECT id FROM ${entity} WHERE ${where} ORDER BY created_at, id LIMIT 1`)
    .bind(value).first<{ id: string }>();
  return match ? rowOrNull(env, entity, match.id) : null;
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * What the public project page shows from group 1. Access follows Core's
 * `public_get_project`: the lead's contact, or any contact at the project's
 * organization, by any address the contact holds.
 */
async function projectPage(env: Env, id: string, email: string | null): Promise<CoreProjectPage | null> {
  const project = await rowOrNull(env, 'projects', id);
  if (!project) return null;
  const organizationId = textOrNull(project.organization_id);
  const leadId = textOrNull(project.lead_id);
  const organization = organizationId ? await rowOrNull(env, 'organizations', organizationId) : null;
  const lead = leadId ? await rowOrNull(env, 'leads', leadId) : null;
  return {
    project: {
      id,
      title: String(project.title ?? ''),
      description: textOrNull(project.description),
      specs: textOrNull(project.specs),
      technical: textOrNull(project.technical),
      research: textOrNull(project.research),
      design: textOrNull(project.design),
      contract: textOrNull(project.contract),
      analytics: textOrNull(project.analytics),
      authentication: textOrNull(project.authentication),
      status: String(project.status ?? ''),
      start_date: textOrNull(project.start_date),
      end_date: textOrNull(project.end_date),
      url: textOrNull(project.url),
      evid: textOrNull(project.evid),
      lead_id: leadId,
      created_at: String(project.created_at ?? ''),
      updated_at: String(project.updated_at ?? ''),
    },
    organization: organization
      ? {
          id: String(organization.id),
          name: String(organization.name ?? ''),
          legal_name: textOrNull(organization.legal_name),
          country: textOrNull(organization.country),
          website: textOrNull(organization.website),
        }
      : null,
    lead: lead ? { id: String(lead.id), title: String(lead.title ?? ''), status: String(lead.status ?? '') } : null,
    email_has_access: email ? await mayBeCredited(env, email, textOrNull(lead?.contact_id), organizationId) : false,
  };
}

async function mayBeCredited(env: Env, email: string, leadContactId: string | null, organizationId: string | null): Promise<boolean> {
  if (!leadContactId && !organizationId) return false;
  const row = await env.USAGE.prepare(
    `SELECT 1 FROM contacts c
     WHERE (c.id = ?2 OR (?3 IS NOT NULL AND c.organization_id = ?3))
       AND (lower(trim(c.email)) = ?1 OR lower(trim(c.corporate_email)) = ?1
            OR EXISTS (SELECT 1 FROM contact_emails e WHERE e.contact_id = c.id AND e.email = ?1))
     LIMIT 1`,
  ).bind(email, leadContactId, organizationId).first();
  return row !== null;
}

/**
 * The group 1 part of Core's `public_offer_allowed_addresses`: the lead's
 * contact by every address it holds, and the contacts at the organization by
 * their email and corporate email. Core adds the offer's `recipient_email` and
 * applies the rule.
 */
async function offerSigners(env: Env, leadId: string | null, organizationId: string | null): Promise<string[]> {
  if (!leadId && !organizationId) return [];
  const { results } = await env.USAGE.prepare(
    `SELECT lower(trim(c.email)) AS address FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id = ?1
     UNION SELECT lower(trim(c.corporate_email)) FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id = ?1
     UNION SELECT e.email FROM leads l JOIN contact_emails e ON e.contact_id = l.contact_id WHERE l.id = ?1
     UNION SELECT lower(trim(email)) FROM contacts WHERE ?2 IS NOT NULL AND organization_id = ?2
     UNION SELECT lower(trim(corporate_email)) FROM contacts WHERE ?2 IS NOT NULL AND organization_id = ?2`,
  ).bind(leadId, organizationId).all<{ address: string | null }>();
  return results.map((row) => row.address ?? '').filter((address) => address !== '').sort();
}

/**
 * The SQL of each `subject_search` entity, in the hit shape of the contract.
 * `?1` is the LIKE pattern, or null for every row; `?2` the ids as JSON, or
 * null for every id; `?3` the limit.
 */
const SUBJECT_SEARCH_SQL: Record<CoreSubjectSearchEntity, string> = {
  leads: `SELECT l.id, coalesce(l.title, '') AS title, coalesce(l.status, '') AS status,
            l.organization_id, o.name AS organization_name, l.contact_id, c.name AS contact_name,
            c.email AS contact_email, c.corporate_email AS contact_corporate_email
          FROM leads l LEFT JOIN organizations o ON o.id = l.organization_id LEFT JOIN contacts c ON c.id = l.contact_id
          WHERE (?1 IS NULL OR l.title LIKE ?1 ESCAPE '\\' OR o.name LIKE ?1 ESCAPE '\\')
            AND (?2 IS NULL OR l.id IN (SELECT value FROM json_each(?2)))
          ORDER BY l.title COLLATE NOCASE, l.id LIMIT ?3`,
  organizations: `SELECT id, coalesce(name, '') AS name, legal_name, country FROM organizations
          WHERE (?1 IS NULL OR name LIKE ?1 ESCAPE '\\' OR legal_name LIKE ?1 ESCAPE '\\')
            AND (?2 IS NULL OR id IN (SELECT value FROM json_each(?2)))
          ORDER BY name COLLATE NOCASE, id LIMIT ?3`,
  contacts: `SELECT c.id, coalesce(c.name, '') AS name, c.email, c.corporate_email, c.organization_id FROM contacts c
          WHERE (?1 IS NULL OR c.name LIKE ?1 ESCAPE '\\' OR c.email LIKE ?1 ESCAPE '\\' OR c.corporate_email LIKE ?1 ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM contact_emails e WHERE e.contact_id = c.id AND e.email LIKE ?1 ESCAPE '\\'))
            AND (?2 IS NULL OR c.id IN (SELECT value FROM json_each(?2)))
          ORDER BY c.name COLLATE NOCASE, c.id LIMIT ?3`,
};

/**
 * Leads, organizations or contacts for the offer pages' pickers and names
 *. Core's offer pages pick and name their subjects here.
 */
async function subjectSearch(
  env: Env,
  entity: CoreSubjectSearchEntity,
  query: string,
  ids: string[] | null,
  limit: number,
): Promise<CoreSubjectSearchResponse['data']> {
  const pattern = query ? `%${query.replace(/[\\%_]/gu, (match) => `\\${match}`)}%` : null;
  const { results } = await env.USAGE.prepare(SUBJECT_SEARCH_SQL[entity])
    .bind(pattern, ids ? JSON.stringify(ids) : null, limit).all();
  return results as unknown as CoreSubjectSearchResponse['data'];
}
