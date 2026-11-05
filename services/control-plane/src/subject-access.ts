// Who reaches which subject (docs/ACCESS.md, slice 1).
//
// A subject is `workspace` unless `subject_visibility` says `restricted`.
// The rule is `subjectAccessLevel` in the contracts; this module reads the
// two tables it needs and hands every route one answer per request.
//
// Every path that returns subject data, or writes onto a subject, asks the
// view from `subjectAccessFor`. A hidden subject answers 404
// `subject_not_found`, never 403, so a restricted subject's existence does
// not leak. Core is read with a service key, not as the member, so this
// filter is the only one that applies to Core rows.
//
// Fail closed: an unreadable store is a 503, never "everything is
// workspace".

import {
  GRANT_ROLES,
  accessMin,
  agentAccessLevel,
  WRITABLE_GRANT_PRINCIPAL_KINDS,
  accessAtLeast,
  subjectAccessLevel,
  type GrantRole,
  type SubjectAccessLevel,
  type SubjectAccessResponse,
  type SubjectGrant,
  type SubjectGrantUpdate,
  type SubjectVisibility,
} from '@starlings/contracts/subject-access';
import { parseSearchDoor } from '@starlings/contracts/search-values';
import { taskSubject } from '@starlings/contracts/standard-records';
import { isSubjectKind, type SubjectKind } from '@starlings/contracts/subject-kinds';
import { agentByEmail } from './agents';
import { fetchCrmSubject, workModelEnabled } from './crm';
import { ensureGuestThread, guestLinkURL, guestThreadId, mintGuestLink } from './guests';
import { isMemberEmail } from './workspace-identity';
import { writePeerGrant } from './peer-workspaces';
import { recordAdminAction } from './admin-audit';
import { roleOf, type RoleSession } from './capabilities';
import type { OwnerSession } from './contracts';
import { ControlError } from './errors';
import { isProjectFrozen, workspacePlanSpec, type WorkspacePlanFacts } from '@starlings/contracts/workspace-plans';
import { PLAN_SETTING_KEY, PLAN_SETTING_SQL, parsePlanRow, projectFrozenError } from './workspace-plan';

export interface SubjectKey {
  kind: SubjectKind;
  id: string;
}

export interface SubjectAccessView {
  /** True when this workspace has at least one restricted subject. False means every check passes for a member. */
  readonly anyRestricted: boolean;
  /** The restricted subjects this caller cannot see. Empty for an admin, and when nothing is restricted. */
  readonly hidden: readonly SubjectKey[];
  /** The restricted subjects this caller cannot write: the hidden ones and those granted `read`. */
  readonly readOnly: readonly SubjectKey[];
  levelOf(kind: string, id: string): SubjectAccessLevel;
  canSee(kind: string, id: string): boolean;
  canWrite(kind: string, id: string): boolean;
  /** Rows whose subject this caller cannot see are dropped. A row with no subject (`null`) stays. */
  filter<T>(rows: readonly T[], keyOf: (row: T) => SubjectKey | null | undefined): T[];
  /** Throws `subject_not_found` (404) unless the caller sees the subject. */
  requireSee(kind: string, id: string): void;
  /** Throws `subject_not_found` when hidden, `subject_access_denied` (403) when seen but not writable. */
  requireWrite(kind: string, id: string): void;
}

const keyString = (kind: string, id: string): string => `${kind}:${id}`;

function isGrantRole(value: string): value is GrantRole {
  return (GRANT_ROLES as readonly string[]).includes(value);
}

function storeFailure(message: string, error: unknown): ControlError {
  console.warn(JSON.stringify({
    level: 'warn',
    message,
    error: error instanceof Error ? error.message : 'Unknown error',
  }));
  return new ControlError('The access store could not be read.', 503);
}

/**
 * `agentGrants` is set when an agent acts as this person: the level is the
 * lower of the person's and the agent's own (docs/ACCESS.md slice 2).
 * `plan` makes a project read-only on Free; it only ever lowers a
 * level, never raises one.
 */
function buildView(
  role: RoleSession['role'],
  restricted: Set<string>,
  grants: Map<string, GrantRole>,
  agentGrants: Map<string, GrantRole> | null,
  plan: WorkspacePlanFacts,
  frozenProjects: readonly string[],
): SubjectAccessView {
  const frozen = (kind: string, id: string) => kind === 'project' && isProjectFrozen(plan, id);
  const levelOf = (kind: string, id: string): SubjectAccessLevel => {
    const key = keyString(kind, id);
    const visibility = restricted.has(key) ? 'restricted' : 'workspace';
    const person = subjectAccessLevel({ role, visibility, grant: grants.get(key) ?? null });
    const level = agentGrants ? accessMin(person, agentAccessLevel({ visibility, grant: agentGrants.get(key) ?? null })) : person;
    return frozen(kind, id) ? accessMin(level, 'read') : level;
  };
  const canSee = (kind: string, id: string) => accessAtLeast(levelOf(kind, id), 'read');
  const canWrite = (kind: string, id: string) => accessAtLeast(levelOf(kind, id), 'write');
  const restrictedKeys = [...restricted].flatMap((key): SubjectKey[] => {
    const at = key.indexOf(':');
    const kind = key.slice(0, at);
    return isSubjectKind(kind) ? [{ kind, id: key.slice(at + 1) }] : [];
  });
  return {
    anyRestricted: restricted.size > 0,
    hidden: restrictedKeys.filter((key) => !canSee(key.kind, key.id)),
    // Frozen projects are read-only too, so a route that skips its checks
    // when this list is empty still sees them.
    readOnly: [
      ...restrictedKeys.filter((key) => !canWrite(key.kind, key.id) && !frozen(key.kind, key.id)),
      ...frozenProjects.map((id): SubjectKey => ({ kind: 'project', id })),
    ],
    levelOf,
    canSee,
    canWrite,
    filter(rows, keyOf) {
      if (restricted.size === 0 && role !== 'community') return [...rows];
      return rows.filter((row) => {
        const key = keyOf(row);
        return !key || canSee(key.kind, key.id);
      });
    },
    requireSee(kind, id) {
      if (!canSee(kind, id)) throw new ControlError('No such subject.', 404, 'subject_not_found');
    },
    requireWrite(kind, id) {
      if (!canSee(kind, id)) throw new ControlError('No such subject.', 404, 'subject_not_found');
      if (frozen(kind, id)) throw projectFrozenError();
      if (!canWrite(kind, id)) throw new ControlError('Your access to this subject is read-only.', 403, 'subject_access_denied');
    },
  };
}

// One view per session object. A route handler holds one session for the
// whole request, so this is a per-request memo; nothing outlives it.
const views = new WeakMap<RoleSession | OwnerSession, Promise<SubjectAccessView>>();

/**
 * The access view for one signed-in caller, read once per request. A session
 * from an owner or admin gate carries no role; D1's is read, as
 * `requireCapability` would have.
 */
export function subjectAccessFor(env: Env, session: RoleSession | OwnerSession): Promise<SubjectAccessView> {
  const existing = views.get(session);
  if (existing) return existing;
  const view = loadView(env, session);
  views.set(session, view);
  view.catch(() => views.delete(session));
  return view;
}

async function loadView(env: Env, session: RoleSession | OwnerSession): Promise<SubjectAccessView> {
  const role = 'role' in session ? session.role : await roleOf(env, session.sub);
  const agentSub = (session as { agentSub?: string }).agentSub ?? null;
  type GrantRead = { kind: string; subject_id: string; role: string };
  let restrictedRows: Array<{ kind: string; subject_id: string }>;
  let grantRows: GrantRead[];
  let agentRows: GrantRead[] = [];
  let planRow: { value: string } | null = null;
  const grantsOf = (kind: 'member' | 'agent', id: string) => env.USAGE.prepare(
    `SELECT kind, subject_id, role FROM subject_grants
     WHERE principal_kind = ?1 AND principal_id = ?2 AND revoked_at IS NULL`,
  ).bind(kind, id);
  try {
    const [planResult, restrictedResult, grantResult, agentResult] = await env.USAGE.batch([
      env.USAGE.prepare(PLAN_SETTING_SQL).bind(PLAN_SETTING_KEY),
      env.USAGE.prepare('SELECT kind, subject_id FROM subject_visibility'),
      grantsOf('member', session.sub),
      ...(agentSub ? [grantsOf('agent', agentSub)] : []),
    ]);
    planRow = ((planResult?.results ?? [])[0] as { value: string } | undefined) ?? null;
    restrictedRows = (restrictedResult?.results ?? []) as typeof restrictedRows;
    grantRows = (grantResult?.results ?? []) as GrantRead[];
    agentRows = (agentResult?.results ?? []) as GrantRead[];
  } catch (error) {
    throw storeFailure('subject_access.read.failed', error);
  }
  const restricted = new Set(restrictedRows.map((row) => keyString(row.kind, row.subject_id)));
  const toMap = (rows: GrantRead[]) => {
    const map = new Map<string, GrantRole>();
    for (const row of rows) if (isGrantRole(row.role)) map.set(keyString(row.kind, row.subject_id), row.role);
    return map;
  };
  const plan = parsePlanRow(planRow);
  // Only a Free workspace after a downgrade freezes anything; every other
  // workspace skips this read.
  let frozenProjects: string[] = [];
  if (plan.kept_project_id !== null && workspacePlanSpec(plan.plan).projectLimit !== null) {
    try {
      const rows = await env.USAGE.prepare('SELECT id FROM projects WHERE id != ?1').bind(plan.kept_project_id).all<{ id: string }>();
      frozenProjects = (rows.results ?? []).map((row) => row.id);
    } catch (error) {
      throw storeFailure('subject_access.plan.read.failed', error);
    }
  }
  return buildView(role, restricted, toMap(grantRows), agentSub ? toMap(agentRows) : null, plan, frozenProjects);
}

/** Drop a cached view after a write, so the same request reads its own change. */
function forget(session: RoleSession | OwnerSession): void {
  views.delete(session);
}

function requireSubjectKey(kind: string, id: string): SubjectKey {
  if (!isSubjectKind(kind) || !id || id.length > 200) {
    throw new ControlError('No such subject.', 404, 'subject_not_found');
  }
  return { kind, id };
}

async function requireManage(env: Env, session: RoleSession, key: SubjectKey): Promise<void> {
  const view = await subjectAccessFor(env, session);
  view.requireSee(key.kind, key.id);
  if (!accessAtLeast(view.levelOf(key.kind, key.id), 'manage')) {
    throw new ControlError('Only an admin or a manager of this subject changes who reaches it.', 403, 'subject_access_denied');
  }
}

async function visibilityOf(env: Env, key: SubjectKey): Promise<SubjectVisibility> {
  const row = await env.USAGE.prepare('SELECT visibility FROM subject_visibility WHERE kind = ?1 AND subject_id = ?2')
    .bind(key.kind, key.id)
    .first<{ visibility: string }>();
  return row?.visibility === 'restricted' ? 'restricted' : 'workspace';
}

interface GrantRow {
  id: string;
  principal_kind: SubjectGrant['principal_kind'];
  principal_id: string;
  role: string;
  granted_by: string;
  granted_at: number;
  email: string | null;
  name: string | null;
}

async function liveGrants(env: Env, key: SubjectKey): Promise<SubjectGrant[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT g.id, g.principal_kind, g.principal_id, g.role, g.granted_by, g.granted_at,
            p.email, COALESCE(p.name, o.name) AS name
     FROM subject_grants g
     LEFT JOIN people p ON g.principal_kind IN ('member', 'agent') AND p.sub = g.principal_id
     LEFT JOIN organizations o ON g.principal_kind = 'peer_workspace' AND o.id = g.principal_id
     WHERE g.kind = ?1 AND g.subject_id = ?2 AND g.revoked_at IS NULL
     ORDER BY g.granted_at`,
  ).bind(key.kind, key.id).all<GrantRow>();
  return (results ?? []).flatMap((row) => isGrantRole(row.role)
    ? [{
        id: row.id,
        principal_kind: row.principal_kind,
        principal_id: row.principal_id,
        email: row.principal_kind === 'guest' ? row.principal_id : row.email,
        name: row.name,
        role: row.role,
        granted_by: row.granted_by,
        granted_at: row.granted_at,
      }]
    : []);
}

/** `GET /api/crm/subjects/:kind/:id/access`: who reaches this subject. Anyone who sees it may read the list. */
export async function readSubjectAccess(env: Env, session: RoleSession, kind: string, id: string): Promise<SubjectAccessResponse> {
  const key = requireSubjectKey(kind, id);
  const view = await subjectAccessFor(env, session);
  view.requireSee(key.kind, key.id);
  const threadId = await guestThreadId(key.kind, key.id);
  const [visibility, grants, thread] = await Promise.all([
    visibilityOf(env, key),
    liveGrants(env, key),
    env.USAGE.prepare(`SELECT id FROM threads WHERE id = ?1 AND kind = 'guest' AND removed_at IS NULL`).bind(threadId).first<{ id: string }>(),
  ]);
  return { kind: key.kind, id: key.id, visibility, level: view.levelOf(key.kind, key.id), grants, guest_thread_id: thread?.id ?? null };
}

/**
 * Set a subject's visibility. Only a `manage` holder or an admin may, so the
 * member who restricts a subject already holds the grant that keeps them in.
 */
export async function writeSubjectVisibility(
  env: Env,
  session: RoleSession,
  kind: string,
  id: string,
  visibility: SubjectVisibility,
): Promise<SubjectAccessResponse> {
  const key = requireSubjectKey(kind, id);
  await requireManage(env, session, key);
  const now = Date.now();
  if (visibility === 'restricted') {
    await env.USAGE.prepare(
      `INSERT INTO subject_visibility (kind, subject_id, visibility, updated_by, updated_at)
       VALUES (?1, ?2, 'restricted', ?3, ?4)
       ON CONFLICT (kind, subject_id) DO UPDATE SET updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(key.kind, key.id, session.sub, now).run();
  } else {
    await env.USAGE.prepare('DELETE FROM subject_visibility WHERE kind = ?1 AND subject_id = ?2')
      .bind(key.kind, key.id)
      .run();
  }
  forget(session);
  await recordAdminAction(env, session, 'subject.visibility', keyString(key.kind, key.id), visibility);
  return readSubjectAccess(env, session, key.kind, key.id);
}

/**
 * Create or change one grant: to a member (slice 1) or an agent on the roster
 * (slice 2). A guest or peer workspace grant is refused until its slice
 * ships (docs/ACCESS.md §Build order). A member grantee must be a current
 * human member; a revoked or community account gets no grant. An agent never
 * holds `manage`.
 */
export async function writeSubjectGrant(
  env: Env,
  session: RoleSession,
  kind: string,
  id: string,
  update: SubjectGrantUpdate,
): Promise<SubjectAccessResponse> {
  const key = requireSubjectKey(kind, id);
  await requireManage(env, session, key);
  if (!(WRITABLE_GRANT_PRINCIPAL_KINDS as readonly string[]).includes(update.principal_kind)) {
    throw new ControlError('That kind of grant is not built yet.', 400, 'invalid_request');
  }
  if (update.principal_kind === 'peer_workspace') {
    const answer = await writePeerGrant(env, session, key, update);
    forget(session);
    return { ...(await readSubjectAccess(env, session, key.kind, key.id)), ...answer };
  }
  const principalKind = update.principal_kind;
  if (principalKind === 'agent' && update.role === 'manage') {
    throw new ControlError('An agent can read or write a subject, never manage who reaches it.', 400, 'invalid_request');
  }
  if (principalKind === 'guest') return writeGuestGrant(env, session, key, update);
  // A member is a current human with a member role; an agent is on this
  // workspace's roster (agents.ts), whose rows carry kind = 'agent'.
  const person = principalKind === 'member'
    ? await env.USAGE.prepare(
      `SELECT sub FROM people
       WHERE email = ?1 AND kind = 'human' AND revoked_at IS NULL AND role IN ('admin', 'member')`,
    ).bind(update.email).first<{ sub: string }>()
    : (await agentByEmail(env, update.email));
  if (!person) {
    throw new ControlError(principalKind === 'member' ? 'No current member has that address.' : 'No agent on the roster has that address.', 404, 'person_not_found');
  }
  const now = Date.now();
  await env.USAGE.batch([
    env.USAGE.prepare(
      `UPDATE subject_grants SET role = ?5
       WHERE kind = ?1 AND subject_id = ?2 AND principal_kind = ?3 AND principal_id = ?4 AND revoked_at IS NULL`,
    ).bind(key.kind, key.id, principalKind, person.sub, update.role),
    env.USAGE.prepare(
      `INSERT INTO subject_grants (id, kind, subject_id, principal_kind, principal_id, role, granted_by, granted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), key.kind, key.id, principalKind, person.sub, update.role, session.sub, now),
  ]);
  forget(session);
  await recordAdminAction(env, session, 'subject.grant', keyString(key.kind, key.id), `${principalKind}:${update.email}:${update.role}`);
  return readSubjectAccess(env, session, key.kind, key.id);
}

/**
 * A guest grant (slice 4): an address outside the workspace, `read` or
 * `write` on this subject's guest thread. Every call mints a new link and
 * replaces the old one's hash, so granting again is also how a member
 * re-sends a lost link. The link is in this answer only.
 */
async function writeGuestGrant(
  env: Env,
  session: RoleSession,
  key: SubjectKey,
  update: Extract<SubjectGrantUpdate, { email: string }>,
): Promise<SubjectAccessResponse> {
  if (update.role === 'manage') {
    throw new ControlError('A guest can read or post, never manage who reaches a subject.', 400, 'invalid_request');
  }
  // A member is granted as a member; a guest is somebody outside.
  if (isMemberEmail(env, update.email)) {
    throw new ControlError('That address is a member here. Grant it as a member.', 400, 'invalid_request');
  }
  if (await agentByEmail(env, update.email)) {
    throw new ControlError('That address is an agent here. Grant it as an agent.', 400, 'invalid_request');
  }
  const subject = workModelEnabled(env) ? await fetchCrmSubject(env, key.kind, key.id) : null;
  if (!subject) throw new ControlError('No such subject.', 404, 'subject_not_found');
  const link = await mintGuestLink();
  const now = Date.now();
  await env.USAGE.batch([
    env.USAGE.prepare(
      `UPDATE subject_grants SET role = ?4, link_hash = ?5
       WHERE kind = ?1 AND subject_id = ?2 AND principal_kind = 'guest' AND principal_id = ?3 AND revoked_at IS NULL`,
    ).bind(key.kind, key.id, update.email, update.role, link.hash),
    env.USAGE.prepare(
      `INSERT INTO subject_grants (id, kind, subject_id, principal_kind, principal_id, role, granted_by, granted_at, link_hash)
       VALUES (?1, ?2, ?3, 'guest', ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), key.kind, key.id, update.email, update.role, session.sub, now, link.hash),
  ]);
  await ensureGuestThread(env, key.kind, key.id, subject.title);
  forget(session);
  await recordAdminAction(env, session, 'subject.grant', keyString(key.kind, key.id), `guest:${update.email}:${update.role}`);
  return { ...(await readSubjectAccess(env, session, key.kind, key.id)), guest_link: guestLinkURL(env, link.token) };
}

/**
 * Revoke one grant. The last `manage` grant on a restricted subject stays:
 * removing it would leave the subject to admins alone, and that is a
 * decision an admin makes by setting it back to `workspace` first.
 */
export async function revokeSubjectGrant(
  env: Env,
  session: RoleSession,
  kind: string,
  id: string,
  grantId: string,
): Promise<SubjectAccessResponse> {
  const key = requireSubjectKey(kind, id);
  await requireManage(env, session, key);
  const grants = await liveGrants(env, key);
  const grant = grants.find((row) => row.id === grantId);
  if (!grant) throw new ControlError('No such grant on this subject.', 404, 'invalid_request');
  if (grant.role === 'manage' && (await visibilityOf(env, key)) === 'restricted'
    && grants.filter((row) => row.role === 'manage').length === 1) {
    throw new ControlError('A restricted subject keeps at least one manager.', 409, 'access_change_refused');
  }
  await env.USAGE.prepare('UPDATE subject_grants SET revoked_at = ?3, link_hash = NULL WHERE id = ?1 AND kind = ?2 AND revoked_at IS NULL')
    .bind(grant.id, key.kind, Date.now())
    .run();
  forget(session);
  await recordAdminAction(env, session, 'subject.revoke', keyString(key.kind, key.id), `${grant.principal_kind}:${grant.email ?? grant.principal_id}`);
  return readSubjectAccess(env, session, key.kind, key.id);
}

/**
 * SQL that is true when the subject named by `kindColumn`/`idColumn` is
 * hidden from the member bound at `subParam` (for example `?1`), or, when
 * `agentParam` binds a non-empty agent `sub`, from that agent acting for
 * them. For queries that cannot take a view, such as the thread list: a
 * restricted subject's channel drops out unless the member is an admin or
 * holds a grant, and, for an agent, unless the agent holds one too. A row
 * whose kind is not a subject kind (a DM, Team) never matches.
 */
export function subjectHiddenSql(kindColumn: string, idColumn: string, subParam: string, agentParam: string): string {
  const granted = (kind: string, param: string) => `EXISTS (
         SELECT 1 FROM subject_grants sg
          WHERE sg.kind = sv.kind AND sg.subject_id = sv.subject_id
            AND sg.principal_kind = '${kind}' AND sg.principal_id = ${param}
            AND sg.revoked_at IS NULL)`;
  // A guest thread's parent is `<kind>:<id>`: it follows its subject.
  return `EXISTS (
    SELECT 1 FROM subject_visibility sv
     WHERE ((sv.kind = ${kindColumn} AND sv.subject_id = ${idColumn})
         OR (${kindColumn} = 'guest' AND sv.kind || ':' || sv.subject_id = ${idColumn}))
       AND (
         (NOT EXISTS (SELECT 1 FROM people sp WHERE sp.sub = ${subParam} AND sp.role = 'admin')
          AND NOT ${granted('member', subParam)})
         OR (${agentParam} <> '' AND NOT ${granted('agent', agentParam)})))`;
}

/** The agent `sub` a session acts as, or '' for a person: the bind for `subjectHiddenSql`'s `agentParam`. */
export function sessionAgentBind(session: OwnerSession): string {
  return (session as { agentSub?: string }).agentSub ?? '';
}

/** The subject a Core task, goal-less work item or interaction sits on. */
export function taskKey(row: Parameters<typeof taskSubject>[0]): SubjectKey | null {
  return taskSubject(row);
}

/** The subject a Core interaction is filed on: project, lead, event, then the organization as a partner. */
export function interactionKey(row: {
  project_id?: string | null | undefined;
  lead_id?: string | null | undefined;
  event_id?: string | null | undefined;
  organization_id?: string | null | undefined;
}): SubjectKey | null {
  if (row.project_id) return { kind: 'project', id: row.project_id };
  if (row.lead_id) return { kind: 'lead', id: row.lead_id };
  if (row.event_id) return { kind: 'event', id: row.event_id };
  if (row.organization_id) return { kind: 'organization', id: row.organization_id };
  return null;
}

/** A Docs subject link (`core:<kind>:<id>`); an organization is a partner. Contacts and offers are not subjects. */
export function docsSubjectKey(link: { kind: string; subject_id: string }): SubjectKey | null {
  if (link.kind === 'organization') return { kind: 'organization', id: link.subject_id };
  if (link.kind === 'project' || link.kind === 'lead') return { kind: link.kind, id: link.subject_id };
  return null;
}

/** True when the caller sees every subject a document is filed on. A document on any hidden subject is hidden. */
export function canSeeDocument(view: SubjectAccessView, subjects: ReadonlyArray<{ kind: string; subject_id: string }> | null | undefined): boolean {
  return (subjects ?? []).every((link) => {
    const key = docsSubjectKey(link);
    return !key || view.canSee(key.kind, key.id);
  });
}

/** A search or permalink door that names a subject (`subject:<kind>:<id>`); any other door names none. */
export function doorKey(door: string | null | undefined): SubjectKey | null {
  const parsed = door ? parseSearchDoor(door) : null;
  return parsed?.to === 'subject' ? { kind: parsed.subjectKind, id: parsed.id } : null;
}

/** A Core record by its entity (`leads`, `projects`, `organizations`), as the raw record doors carry it. An organization is a partner. */
export function coreEntityKey(entity: string, id: string): SubjectKey | null {
  switch (entity) {
    case 'lead':
    case 'leads': return { kind: 'lead', id };
    case 'project':
    case 'projects': return { kind: 'project', id };
    case 'organization':
    case 'organizations': return { kind: 'organization', id };
    case 'event':
    case 'events': return { kind: 'event', id };
    default: return null;
  }
}

/** A favorite that pins a subject. Pins on tasks, issues, documents and threads open through their own guarded routes. */
export function favoriteSubjectKey(kind: string, targetRef: string): SubjectKey | null {
  switch (kind) {
    case 'crm.lead': return { kind: 'lead', id: targetRef };
    case 'crm.project': return { kind: 'project', id: targetRef };
    case 'crm.partner': return { kind: 'organization', id: targetRef };
    case 'cms.event': return { kind: 'event', id: targetRef };
    default: return null;
  }
}

/** The subject a raw Core record names: the record itself for a lead, project or organization, and the filing for an interaction. Contacts name none. */
export function coreRecordKey(entity: string, record: unknown): SubjectKey | null {
  if (!record || typeof record !== 'object') return null;
  const row = record as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  if (entity === 'interactions') {
    return interactionKey({
      project_id: text(row.project_id),
      lead_id: text(row.lead_id),
      event_id: text(row.event_id),
      organization_id: text(row.organization_id),
    });
  }
  const id = text(row.id);
  return id ? coreEntityKey(entity, id) : null;
}

/** A raw Core or CMS list (`{ data: [...] }`, or a bare array) with the rows this caller cannot see dropped. */
export function filterCoreRecords<T>(view: SubjectAccessView, entity: string, body: T): T {
  if (Array.isArray(body)) return view.filter(body, (row) => coreRecordKey(entity, row)) as T;
  if (!body || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data)) return body;
  const data = (body as unknown as { data: unknown[] }).data;
  return { ...body, data: view.filter(data, (row) => coreRecordKey(entity, row)) };
}

/**
 * Which agents a thread's lines may reach (docs/ACCESS.md slice 2). `null`
 * means every agent: the thread is not a restricted subject's channel. On a
 * restricted channel it is the agents holding a live grant on the subject;
 * `need: 'write'` counts only `write` grants (an agent never holds `manage`).
 * An unreadable store reaches nobody.
 */
export async function agentsReachingThread(env: Env, threadId: string, need: 'read' | 'write' = 'read'): Promise<Set<string> | null> {
  try {
    const restricted = await env.USAGE.prepare(
      `SELECT sv.kind, sv.subject_id FROM threads t
         JOIN subject_visibility sv ON (sv.kind = t.kind AND sv.subject_id = t.parent_id)
           OR (t.kind = 'guest' AND sv.kind || ':' || sv.subject_id = t.parent_id)
        WHERE t.id = ?1`,
    ).bind(threadId).first<{ kind: string; subject_id: string }>();
    if (!restricted) return null;
    const { results } = await env.USAGE.prepare(
      `SELECT principal_id FROM subject_grants
        WHERE kind = ?1 AND subject_id = ?2 AND principal_kind = 'agent' AND revoked_at IS NULL
          AND (?3 = 'read' OR role = 'write')`,
    ).bind(restricted.kind, restricted.subject_id, need).all<{ principal_id: string }>();
    return new Set((results ?? []).map((row) => row.principal_id));
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'subject_access.agents.read.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return new Set();
  }
}
