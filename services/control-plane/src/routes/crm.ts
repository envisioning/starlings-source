import type { SubjectSubmissionResponse } from '@starlings/contracts/forms';
import {
  crmInteractionCreateSchema,
  crmInteractionUpdateSchema,
  type CrmInteractionDeleteResponse,
  type CrmInteractionResponse,
} from '@starlings/contracts/crm';
import { requireResponsiblePerson } from '../responsible';
import { interestSubmissionForLead } from '../interest';
import { formSubmissionForLead } from '../forms';
import { inboxQuerySchema } from '@starlings/contracts/inbox';
import { RETIRED_INBOX_SOURCES } from '@starlings/contracts/inbox-values';
import { isMemberEmail } from '../workspace-identity';
import { taskSubject } from '@starlings/contracts/standard-records';
import { actorName, recordDecision } from '../crm-actions';
import { requestVia } from '../auth';
import {
  type CrmDecisionResponse,
  type CrmDecisionsResponse,
  type CrmSubject,
  type CrmGoalResponse,
  type CrmGoalsResponse,
  type CrmTaskDeleteResponse,
  type CrmOrganizationProjectTasksResponse,
  type CrmTaskResponse,
  type CrmTasksResponse,
  cmsWriteBodySchema,
  crmDecisionCreateSchema,
  crmDecisionsQuerySchema,
  crmGoalCreateSchema,
  crmGoalUpdateSchema,
  crmGoalsQuerySchema,
  crmTaskCreateSchema,
  crmTaskUpdateSchema,
  crmTasksQuerySchema,
  taskSubjectKeys,
} from '../contracts';
import { purgeCoreCache, staleOnError } from '../core-cache';
import {
  createCmsRecord,
  createCrmGoal,
  createCrmTask,
  deleteCmsRecord,
  fetchCmsList,
  fetchCmsRecord,
  fetchCrmDecisions,
  fetchCrmGoals,
  fetchCrmTask,
  fetchCrmTasks,
  isCmsEntityId,
  lookupCrmSubjectById,
  taskCacheKeys,
  updateCmsRecord,
  updateCrmGoal,
  updateCrmTask,
  deleteCrmTask,
  createCrmInteraction,
  deleteCrmInteraction,
  fetchCrmInteraction,
  updateCrmInteraction,
} from '../crm';
import {
  answerDecisionAsk,
  applyDecisionAskDefault,
  createDecisionAsk,
  listDecisionAsks,
  withdrawDecisionAsk,
  type RecordCoreDecision,
} from '../decision-asks';
import { postSubjectEvent } from '../threads';
import {
  type DecisionAskResponse,
  type DecisionAsksResponse,
  decisionAskAnswerSchema,
  decisionAskCreateSchema,
  decisionAskWithdrawSchema,
  decisionAsksQuerySchema,
} from '@starlings/contracts/decision-asks';
import { addCORS } from '../cors';
import { mirrorLegacyFavoriteChange, queueFavoriteChange, shouldQueueFavoriteFailure, sharedFavoriteRows } from '../favorite-routes';
import type { RoleSession } from '../capabilities';
import { type CrmBoardResponse, fetchBoard } from '../board';
import {
  coreEntityKey,
  coreRecordKey,
  doorKey,
  favoriteSubjectKey,
  filterCoreRecords,
  interactionKey,
  readSubjectAccess,
  revokeSubjectGrant,
  subjectAccessFor,
  type SubjectAccessView,
  type SubjectKey,
  taskKey,
  writeSubjectGrant,
  writeSubjectVisibility,
} from '../subject-access';
import {
  filterBoard,
  filterFeed,
  filterInbox,
  filterMyWork,
  filterSubjectCounts,
  filterSubjectDetail,
  filterUnowned,
  requireRepoVisible,
} from '../subject-access-filters';
import {
  type PeerWorkspace,
  type PeerWorkspaceTokenResponse,
  type PeerWorkspacesResponse,
  type SubjectAccessResponse,
  subjectGrantUpdateSchema,
  subjectVisibilityUpdateSchema,
} from '@starlings/contracts/subject-access';
import { listPeerWorkspaces, revokePeerCredential, rotatePeerToken } from '../peer-workspaces';
import {
  CRM_ISSUE_SORTS,
  type CommercialSummary,
  type ControlErrorBody,
  type CoreTokenResponse,
  type CrmGithubLoginResponse,
  type CrmGithubReposResponse,
  type CrmInteractionsResponse,
  type CrmIssue,
  type CrmIssueCreateInput,
  type CrmIssueDetailResponse,
  type CrmIssueFacetsResponse,
  type CrmIssueResponse,
  type CrmIssueSort,
  type CrmIssueUpdateInput,
  type CrmIssuesResponse,
  type CrmMyWorkResponse,
  type CrmContact,
  type CrmContactDetail,
  type CrmContactResponse,
  type CrmContactsResponse,
  type CrmSubjectCommercialResponse,
  type CrmContactDeleteResponse,
  type CrmContactOptionsResponse,
  type CrmOrganizationResponse,
  type CrmOrganizationsResponse,
  type CrmProjectRepoResponse,
  type CrmRecentlyClosedWorkResponse,
  type CrmUnownedWorkResponse,
  type CrmSubjectCountsResponse,
  type CrmSubjectDetail,
  type CrmSubjectDetailResponse,
  type OrganizationRelationship,
  type CrmLeadWinResponse,
  type CrmSubjectRelated,
  type CrmInteractionRow,
  type CrmSubjectMutationResponse,
  type CrmOrganizationDeleteResponse,
  type CrmSubjectsResponse,
  type CrmTeamResponse,
  type JsonValue,
  type OkResponse,
  type PullsResponse,
  type RecentFeedResponse,
  type SearchResponse,
  type UntriagedTouchDismissResponse,
  type UntriagedTouchesResponse,
  cmsEventImageRequestSchema,
  cmsTechnologyImageRequestSchema,
  coreTokenRequestSchema,
  crmAvatarQuerySchema,
  crmGithubLoginSchema,
  crmGithubReposQuerySchema,
  crmInteractionsQuerySchema,
  crmIssueCreateSchema,
  crmIssueRefQuerySchema,
  crmIssueUpdateSchema,
  crmLeadUpdateSchema,
  crmLeadWinSchema,
  OPEN_TASK_STATUSES,
  crmMyWorkQuerySchema,
  crmContactCreateSchema,
  crmContactUpdateSchema,
  crmContactsQuerySchema,
  crmOrganizationCreateSchema,
  crmOrganizationUpdateSchema,
  crmOrganizationsQuerySchema,
  crmProjectQuerySchema,
  crmProjectRepoCreateSchema,
  crmProjectUpdateSchema,
  crmRepoQuerySchema,
  crmSubjectCountsQuerySchema,
  crmSubjectCreateCommandSchema,
  crmSubjectsQuerySchema,
  salesInboxQuerySchema,
} from '../contracts';
import {
  addCoreFavorite,
  createCoreRecord,
  createCrmContact,
  createCrmOrganization,
  createCrmProjectRepo,
  crmContactOrganization,
  fetchCrmContactDetail,
  fetchCrmContacts,
  fetchCrmSubjectCommercial,
  updateCrmContact,
  deleteCrmContact,
  fetchCrmContactOptions,
  createCrmSubject,
  crmSyncEnabled,
  githubIssuesEnabled,
  workModelEnabled,
  coreRecordGroup,
  deleteCoreOrganization,
  deleteCrmOrganization,
  updateCrmOrganization,
  mergeCoreRecords,
  exchangeCoreToken,
  fetchCmsRegistry,
  fetchCoreFieldsRecord,
  fetchCoreRegistry,
  fetchCrmCommercialSummary,
  fetchCrmGithubRepos,
  fetchCrmInteractions,
  fetchCrmIssue,
  fetchCrmIssueFacets,
  fetchCrmIssues,
  fetchCrmMyWork,
  fetchCrmProjectRepos,
  fetchCrmSubjectCounts,
  fetchCrmSubjectDetail,
  fetchCrmSubjects,
  crmMemberIdForEmail,
  fetchCrmTeam,
  fetchGithubAvatar,
  fetchUntriagedTouches,
  generateCmsEventImage,
  generateCmsTechnologyImage,
  listCoreFavorites,
  listCoreRecords,
  projectRepoLinks,
  removeCoreFavorite,
  searchCoreRecords,
  searchCrmOrganizations,
  setCrmGithubLogin,
  setUntriagedTouchDismissed,
  updateCoreFieldsRecord,
  updateCrmSubject,
  writeCrmIssue,
} from '../crm';
import { createD1CoreRecord, deleteD1CoreOrganization, fetchD1CoreRecord, listD1CoreRecords, updateD1CoreRecord } from '../core-records-d1';
import { usesCoreFor } from '../work-store';
import { ControlError } from '../errors';
import { favoriteMigrationStatus, favoriteRowsForMember, subjectStateWithSharedStars } from '../favorite-sync';
import { fetchRecentFeed } from '../feed';
import { githubAppConnected } from '../github-app';
import { linkGithubRepoToProject, listProjectPulls, searchGithubRepos } from '../github-connector';
import { assertTrustedMutation, json, jsonConditional, parseFormBody, readBoundedJSON, subjectForm } from '../http';
import { fetchInbox } from '../inbox';
import { availableInboxSources } from '../inbox-audience';
import { setInboxDismissed } from '../inbox-dismissed';
import { fetchRecentlyClosedWork } from '../recently-closed';
import { fetchUnownedWork } from '../unowned';
import { boundedNumber, parseQuery } from '../route-util';
import { starredFavoriteRows } from '../search';
import { readSubjectState, writeSubjectState, writeWorkPreferences } from '../subject-state';
import { postIssueEvent, withLastActivity } from '../threads';
import {
  type CoreRegistryResponse,
  type CoreSearchResponse,
  coreFieldsWriteBodySchema,
  coreMergeBodySchema,
  isCoreMergeEntity,
  coreRecordListQueryFor,
  coreRecordNeedsOrganization,
  coreRecordOrganizationSchema,
  coreSearchQuerySchema,
  isCoreRecordEntity,
} from '@starlings/contracts/core-fields';
import {
  type FavoriteMigrationStatusResponse,
  type FavoriteMutationResponse,
  type FavoriteRemoveResponse,
  type FavoriteRow,
  type FavoritesResponse,
  favoriteTargetQuerySchema,
  favoriteTargetSchema,
} from '@starlings/contracts/favorites';
import type { InboxDismissResponse, InboxResponse } from '@starlings/contracts/inbox';
import {
  type SubjectStateResponse,
  type SubjectStateUpdateResponse,
  subjectStateUpdateSchema,
  workPreferencesUpdateSchema,
} from '@starlings/contracts/subject-state';
import { PARAMS, defineRoute, type Route } from '../route-types';
import { requireSubjectKindOn, subjectKindOn, workModulesOn } from '../work-modules';
import { organizationRelationships } from '@starlings/contracts/subject-status';
import type { SubjectKind } from '@starlings/contracts/subject-kinds';

/** Projects one organization's By project grouping reads at most: one Core read each. */
const ORGANIZATION_PROJECT_TASKS_LIMIT = 25;

/**
 * A subject's detail as this person reads it: `related` names other subjects
 * (a partner's projects and leads, the lead-to-project edge of ADR 0008), so
 * it drops the ones they cannot see, and the leads when Sales is off.
 */
async function readableSubjectDetail<T extends { related?: CrmSubjectRelated | undefined }>(env: Env, owner: RoleSession, subject: T): Promise<T> {
  const visible = filterSubjectDetail(await subjectAccessFor(env, owner), subject);
  if (!visible.related || visible.related.leads.length === 0 || await subjectKindOn(env, 'lead')) return visible;
  return { ...visible, related: { ...visible.related, leads: [] } };
}

/**
 * An organization's relationships, from what this person can see
 * of it: its related projects and leads after access, its marks, and an
 * active license when the Licenses work module is on. A failed license read
 * leaves that one fact out rather than failing the detail.
 */
async function organizationRelationshipsFor(env: Env, owner: RoleSession, subject: CrmSubjectDetail): Promise<OrganizationRelationship[]> {
  let activeLicense = false;
  if (crmSyncEnabled(env) && (await workModulesOn(env)).includes('licenses')) {
    try {
      const { licenses } = await fetchCrmSubjectCommercial(env, owner.email, 'organization', subject.id, { offers: false, licenses: true });
      activeLicense = (licenses ?? []).some((license) => license.is_active);
    } catch (error) {
      console.warn('organization licenses failed', subject.id, error instanceof Error ? error.message : error);
    }
  }
  return organizationRelationships({
    is_partner: subject.is_partner,
    is_existing_client: subject.is_existing_client,
    projects: subject.related?.projects ?? [],
    leads: subject.related?.leads ?? [],
    activeLicense,
  });
}

/**
 * A project's History reads its lead's History across `projects.lead_id`
 * (ADR 0008): the lead's interactions, when this person sees the lead and
 * Sales is on. Best effort: the project's own History never fails for it.
 */
async function leadHistory(env: Env, access: SubjectAccessView, projectId: string, limit: number): Promise<CrmInteractionRow[]> {
  try {
    const leadId = (await fetchCrmSubjectDetail(env, 'project', projectId)).lead_id;
    if (!leadId || !access.canSee('lead', leadId) || !(await subjectKindOn(env, 'lead'))) return [];
    return await fetchCrmInteractions(env, { leadId }, limit);
  } catch (error) {
    console.warn('lead history failed', projectId, error instanceof Error ? error.message : error);
    return [];
  }
}

/** The project's rows and its lead's, newest first, each once, the lead's marked. */
function withLeadHistory(own: CrmInteractionRow[], lead: CrmInteractionRow[], limit: number): CrmInteractionRow[] {
  if (lead.length === 0) return own;
  const seen = new Set(own.map((row) => row.id));
  const time = (row: CrmInteractionRow) => Date.parse(row.occurred_at ?? row.created_at ?? '') || 0;
  return [...own, ...lead.filter((row) => !seen.has(row.id)).map((row) => ({ ...row, from_lead: true }))]
    .sort((a, b) => time(b) - time(a))
    .slice(0, limit);
}

/**
 * The person's subject state, with the stars Core shares when the cutover is
 * on. GET and PATCH answer with the same read, so it is one function.
 */
async function subjectStateAnswer(env: Env, owner: RoleSession): Promise<Response> {
  const read = await readSubjectState(env, owner.sub, owner.role, availableInboxSources(env, owner, await workModulesOn(env)));
  const state = { ...read, states: (await subjectAccessFor(env, owner)).filter(read.states, (row) => row) };
  if (env.FAVORITES_READS_FROM_CORE === 'true') {
    try {
      const rows = await listCoreFavorites(env, owner.email);
      return json(subjectStateWithSharedStars(state, await favoriteRowsForMember(env, owner.sub, rows)) satisfies SubjectStateResponse);
    } catch (error) {
      // Keep the legacy D1 state visible during a partial Core outage.
      if (!shouldQueueFavoriteFailure(error, env)) throw error;
    }
  }
  return json(state satisfies SubjectStateResponse);
}

/**
 * The quiet line a project channel gets when somebody files or closes an issue
 * from Meet, so the conversation about a project and the work on it stay in
 * one place. `postIssueEvent` does the checking; this only reads the request.
 *
 * **Filing always reports; changing reports a state change and nothing else.**
 * A relabel or a retitle is housekeeping, and a channel that narrates every
 * one of them is a channel people mute.
 *
 * The state is taken as intent rather than as a transition: Meet does not know
 * what the issue was before GitHub answered. Closing something already closed
 * therefore writes the same line twice — which the event's dedupe key turns
 * into writing it once, the same mechanism that keeps Core's webhook from
 * repeating it later.
 */
async function reportIssueChange(
  env: Env,
  actor: string,
  body: CrmIssueCreateInput | CrmIssueUpdateInput,
  written: unknown,
): Promise<void> {
  // Core answers with the issue it wrote; without a number there is nothing to
  // point at, and a line with no ref is a line nobody can open.
  const issue = written as Partial<CrmIssue> | null;
  if (!issue || !issue.number || !issue.owner || !issue.repo) return;
  const title = issue.title ?? body.title ?? `#${issue.number}`;
  const where = { owner: issue.owner, repo: issue.repo, number: issue.number, title, actor };

  if (!('number' in body)) {
    await postIssueEvent(env, { ...where, projectID: body.project_id, verb: 'filed' });
    return;
  }
  if (!body.project_id || !body.state) return;
  const verb = body.state === 'open'
    ? 'reopened'
    : body.state_reason === 'not_planned' ? 'closed_not_planned' : 'closed';
  await postIssueEvent(env, { ...where, projectID: body.project_id, verb });
}

/** Optional fields to the nullable shape the cache keys read. */
const subjectOf = (value: { project_id?: string | null | undefined; lead_id?: string | null | undefined; event_id?: string | null | undefined; organization_id?: string | null | undefined; meeting_id?: string | null | undefined }) => ({
  project_id: value.project_id ?? null, lead_id: value.lead_id ?? null, event_id: value.event_id ?? null,
  organization_id: value.organization_id ?? null, meeting_id: value.meeting_id ?? null,
});


/** Each subject an interaction names, as a write: an organization, a lead and a project may all be set. */
function requireInteractionWrite(
  access: Awaited<ReturnType<typeof subjectAccessFor>>,
  row: { organization_id?: string | null | undefined; lead_id?: string | null | undefined; project_id?: string | null | undefined },
): void {
  if (row.project_id) access.requireWrite('project', row.project_id);
  if (row.lead_id) access.requireWrite('lead', row.lead_id);
  if (row.organization_id) access.requireWrite('organization', row.organization_id);
}

export const crmRoutes: readonly Route[] = [
  // Who work can be assigned to. Envisioning-only like the rest of the CRM
  // surface, and served from Core rather than from Meet's own sign-in ledger —
  // a colleague who has never opened Meet is still assignable work.
  defineRoute({
    method: 'GET',
    path: '/api/crm/team',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      return json({ members: await fetchCrmTeam(env) } satisfies CrmTeamResponse);
    },
  }),

  // GitHub repository links. With Meet's App configured, the picker lists
  // what that App sees and a link is Meet's mapping, written through to
  // the work store ( step 2). Without it, the work store holds both:
  // Core, or D1 on a D1 workspace (work-d1.ts).
  defineRoute({
    method: 'GET',
    path: '/api/crm/github-repos',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url }) => {
      const query = parseQuery(crmGithubReposQuerySchema, url).q;
      if (await githubAppConnected(env)) {
        return json({ repos: await searchGithubRepos(env, query) } satisfies CrmGithubReposResponse);
      }
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      return json({
        repos: await fetchCrmGithubRepos(env, query),
      } satisfies CrmGithubReposResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/crm/project-repos',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      const projectId = parseQuery(crmProjectQuerySchema, url).project_id;
      (await subjectAccessFor(env, owner)).requireSee('project', projectId);
      if (await githubAppConnected(env)) {
        // The same union the issues list reads, so the two never disagree.
        const links = await projectRepoLinks(env, projectId);
        return json({
          repos: links.map((link) => ({
            id: `${link.owner}/${link.repo}`,
            owner: link.owner,
            repo: link.repo,
            label: link.label,
            milestone: null,
            is_primary: link.is_primary,
          })),
        } satisfies CrmGithubReposResponse);
      }
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      return json({
        repos: await fetchCrmProjectRepos(env, projectId),
      } satisfies CrmGithubReposResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/crm/project-repos',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = crmProjectRepoCreateSchema.parse(await readBoundedJSON(request));
      (await subjectAccessFor(env, owner)).requireWrite('project', body.project_id);
      if (await githubAppConnected(env)) {
        return json({
          repo: await linkGithubRepoToProject(env, body, owner.email),
        } satisfies CrmProjectRepoResponse, 201);
      }
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      return json({
        repo: await createCrmProjectRepo(env, body, owner.email),
      } satisfies CrmProjectRepoResponse, 201);
    },
  }),

  // A project's GitHub issues, for drawing beside its CRM tasks. Read only —
  // an issue stays GitHub's row, and Meet links out rather than copying.
  // Pull requests on a project's mapped repositories, from Meet's own sync
  //. Not through Core: the rows are in D1 already.
  defineRoute({
    method: 'GET',
    path: '/api/crm/pulls',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      const projectId = parseQuery(crmProjectQuerySchema, url).project_id;
      (await subjectAccessFor(env, owner)).requireSee('project', projectId);
      return json(await listProjectPulls(env, projectId) satisfies PullsResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/crm/issues',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      const projectId = url.searchParams.get('project_id') ?? '';
      if (!/^[0-9a-f-]{36}$/iu.test(projectId)) {
        return json({ error: 'project_id must be a uuid.' }, 400);
      }
      (await subjectAccessFor(env, owner)).requireSee('project', projectId);
      if (!githubIssuesEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const stateParam = url.searchParams.get('state');
      const state = stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open';
      // Filters and order are GitHub's vocabulary all the way down: the client
      // names them, this forwards them, Core hands them to GitHub. Anything
      // unrecognized is dropped rather than passed on as a guess.
      const sortParam = url.searchParams.get('sort');
      const directionParam = url.searchParams.get('direction');
      return json(await fetchCrmIssues(env, {
        project_id: projectId,
        state,
        labels: url.searchParams.get('labels') ?? undefined,
        assignee: url.searchParams.get('assignee') ?? undefined,
        milestone: url.searchParams.get('milestone') ?? undefined,
        creator: url.searchParams.get('creator') ?? undefined,
        sort: CRM_ISSUE_SORTS.includes(sortParam as CrmIssueSort) ? sortParam as CrmIssueSort : undefined,
        direction: directionParam === 'asc' ? 'asc' : directionParam === 'desc' ? 'desc' : undefined,
        limit: boundedNumber(url.searchParams.get('limit'), 1, 100),
        page: boundedNumber(url.searchParams.get('page'), 1, 50),
      }) satisfies CrmIssuesResponse);
    },
  }),

  // Somebody's GitHub picture, fetched here rather than by the device — see
  // `fetchGithubAvatar`. Answers an image, not JSON, so it is the one CRM
  // route whose body is not a contract type.
  defineRoute({
    method: 'GET',
    path: '/api/crm/avatar',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, url }) => {
      const query = parseQuery(crmAvatarQuerySchema, url);
      return addCORS(await fetchGithubAvatar(query.url, query.size), request, env);
    },
  }),

  // What an issue in this repository could be set to. Its own route rather
  // than a mode of the issue read: a picker asks once and reuses the answer,
  // and an issue read happens every time somebody clicks a row.
  defineRoute({
    method: 'GET',
    path: '/api/crm/issue-facets',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      if (!githubIssuesEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const query = parseQuery(crmRepoQuerySchema, url);
      await requireRepoVisible(env, owner, query.owner, query.repo);
      return json(await fetchCrmIssueFacets(env, query.owner, query.repo) satisfies CrmIssueFacetsResponse);
    },
  }),

  // One issue, opened in the app rather than in a browser.
  defineRoute({
    method: 'GET',
    path: '/api/crm/issue',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      if (!githubIssuesEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const query = parseQuery(crmIssueRefQuerySchema, url);
      await requireRepoVisible(env, owner, query.owner, query.repo);
      const issue = await fetchCrmIssue(env, query.owner, query.repo, query.number);
      if (issue === null) throw new ControlError('Issue not found.', 404);
      return json({ issue } satisfies CrmIssueDetailResponse);
    },
  }),

  // What the signed-in member owes, across every project and lead. The address
  // is taken from the session: nobody asks what a colleague is carrying.
  defineRoute({
    method: 'GET',
    path: '/api/crm/mine',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const work = await fetchCrmMyWork(env, owner.email);
      return jsonConditional(request, await filterMyWork(env, await subjectAccessFor(env, owner), work) satisfies CrmMyWorkResponse);
    },
  }),

  // Recently finished work the signed-in member can undo. The Worker filters
  // the shared board result to this member's assigned tasks and GitHub login.
  defineRoute({
    method: 'GET',
    path: '/api/crm/recently-closed',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      return jsonConditional(
        request,
        await fetchRecentlyClosedWork(env, owner.email, await subjectAccessFor(env, owner)) satisfies CrmRecentlyClosedWorkResponse,
      );
    },
  }),

  // Open work nobody on our side holds, on every subject (docs/BOARD.md
  // §Unowned): Overview's UNOWNED list. Company work, like the board it
  // reads, so members only; the shared rule decides who counts as nobody.
  defineRoute({
    method: 'GET',
    path: '/api/crm/unowned',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const work = await fetchUnownedWork(env);
      return jsonConditional(request, await filterUnowned(env, await subjectAccessFor(env, owner), work) satisfies CrmUnownedWorkResponse);
    },
  }),

  // Every open card on every subject, for the board (docs/BOARD.md). Members
  // only, like the rest of the CRM family: a task in the company CRM is
  // company work. `finished_since` widens or narrows the done and dropped
  // columns; the default is a week.
  defineRoute({
    method: 'GET',
    path: '/api/crm/board',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const sinceRaw = url.searchParams.get('finished_since');
      const sinceMs = sinceRaw ? Date.parse(sinceRaw) : Number.NaN;
      const access = await subjectAccessFor(env, owner);
      // One project's board: the project's page draws it.
      const projectId = url.searchParams.get('project_id')?.trim() || null;
      let project: CrmSubject | undefined;
      if (projectId) {
        const found = access.canSee('project', projectId) ? await lookupCrmSubjectById(env, 'project', projectId) : { found: false as const };
        if (!found.found) throw new ControlError('Project not found.', 404);
        project = found.subject;
      }
      const board = await fetchBoard(env, {
        ...(Number.isNaN(sinceMs) ? {} : { finishedSinceMs: sinceMs }),
        ...(project ? { project } : {}),
      });
      return json(await filterBoard(env, access, board) satisfies CrmBoardResponse);
    },
  }),

  // The cross-subject feed — docs/TIMELINE.md Phase 3. Members only, like the
  // board: this is company work, not anyone's private data, and the same
  // "every open subject" fan-out the board makes.
  defineRoute({
    method: 'GET',
    path: '/api/crm/feed',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, url, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const limit = boundedNumber(url.searchParams.get('limit'), 1, 100);
      const access = await subjectAccessFor(env, owner);
      const feed = await fetchRecentFeed(env, { ...(limit === undefined ? {} : { limit }), include: (subject) => access.canSee(subject.kind, subject.id) });
      return jsonConditional(request, filterFeed(access, feed) satisfies RecentFeedResponse);
    },
  }),

  // The Sales inbox: every CRM-originated touch with no Meet subject yet —
  // contact form, support case, pricing request, Future Readiness Assessment
  // (docs/WORK.md "Channels on the work itself";). Members
  // only, like the rest of the CRM family — this is company sales activity,
  // not anyone's private data. Reads Core's `/api/agent/untriaged-touches`
  // through the owner's own broker PAT, because that
  // route is PAT-scoped rather than one of the HMAC `meet-*` projections.
  //
  // No per-source filtering: the issue leaves open whether every contact-form
  // submission belongs here, even ones that already skip `createLead`, and
  // asks not to decide that silently. This defaults wide — whatever Core's
  // feed returns, unfiltered — flagged back on the issue rather than narrowed
  // here.
  defineRoute({
    method: 'GET',
    path: '/api/crm/sales-inbox',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const query = parseQuery(salesInboxQuerySchema, url);
      const touches = await fetchUntriagedTouches(env, owner.email, { limit: query.limit, offset: query.offset, includeDismissed: query.include_dismissed });
      const access = await subjectAccessFor(env, owner);
      return json({
        ...touches,
        data: access.filter(touches.data, (touch) => touch.existing_lead_id ? { kind: 'lead', id: touch.existing_lead_id } : null),
      } satisfies UntriagedTouchesResponse);
    },
  }),

  // The Home commercial card, on a Core workspace only: a narrow, read-only
  // projection of Core's dashboard through the owner's broker PAT, or of D1 once
  // the commercial group moved.
  defineRoute({
    method: 'GET',
    path: '/api/crm/commercial-summary',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      return json(await fetchCrmCommercialSummary(env, owner.email) satisfies CommercialSummary);
    },
  }),

  // CMS: website content (research, technologies, events, newsletter, …) in
  // Core's CMS data space, read and written as the member through the
  // Worker's cms-editor broker PAT (`corePatFetch(…, 'cms')`). Core owns the
  // registry, the validation and the audit row; this is a projection with a
  // capability check in front, the same shape as the sales inbox. Delete is
  // Core's to allow: only research link rows have it; content is unpublished.
  defineRoute({
    method: 'GET',
    path: '/api/cms/registry',
    gate: { kind: 'capability', capability: 'cmsContent' },
    handler: async ({ env, owner }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      return json(await fetchCmsRegistry(env, owner.email) satisfies JsonValue);
    },
  }),

  // Core's CRM registry for the web: a subject's Fields pane and
  // the palette's Core search. Mac and iOS read Core directly with a device
  // PAT; the browser holds none, so the Worker answers as the member with the
  // broker PAT, the same arrangement as `/api/cms/*` and the sales inbox. The
  // record door takes only the entities behind Work's subjects: the web does
  // not browse Core generically. No create and no delete.
  defineRoute({
    method: 'GET',
    path: '/api/core/registry',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'Core is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      return json(await fetchCoreRegistry(env, owner.email) satisfies CoreRegistryResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/core/search',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'Core is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const query = parseQuery(coreSearchQuerySchema, url);
      const found = await searchCoreRecords(env, owner.email, query);
      const access = await subjectAccessFor(env, owner);
      return json({ ...found, data: access.filter(found.data, (hit) => coreEntityKey(hit.entity, hit.id)) } satisfies CoreSearchResponse);
    },
  }),

  // INBOX: one per-user feed of things with a resolution, and a capped tail
  // of what happened on the subjects you follow ( decision 4, slice
  // 2b). Never cached across people — half of it is yours alone.
  defineRoute({
    method: 'GET',
    path: '/api/crm/inbox',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, url, env, owner }) => {
      const query = parseQuery(inboxQuerySchema, url);
      const inbox = await fetchInbox(env, owner, query.questions, query.cards, query.followups, query.calendar);
      return jsonConditional(request, await filterInbox(env, await subjectAccessFor(env, owner), inbox) satisfies InboxResponse);
    },
  }),

  // Favorites have one shared Core backing. During the bridge, pending D1
  // mutations remain visible here and old CRM clients retain their state API.
  defineRoute({
    method: 'GET',
    path: '/api/crm/favorites',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner }) => {
      const result = await sharedFavoriteRows(env, owner.sub, owner.email);
      const access = await subjectAccessFor(env, owner);
      return json({
        favorites: access.filter(result.favorites, (row) => favoriteSubjectKey(row.kind, row.target_ref)),
        synced: result.synced,
      } satisfies FavoritesResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/crm/favorites',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const target = favoriteTargetSchema.parse(await readBoundedJSON(request));
      const pinned = favoriteSubjectKey(target.kind, target.target_ref);
      if (pinned) (await subjectAccessFor(env, owner)).requireSee(pinned.kind, pinned.id);
      let favorite: FavoriteRow;
      try {
        favorite = await addCoreFavorite(env, owner.email, target);
      } catch (error) {
        if (!shouldQueueFavoriteFailure(error, env)) throw error;
        await queueFavoriteChange(env, owner.sub, target, true);
        favorite = {
          kind: target.kind,
          target_ref: target.target_ref,
          created_at: new Date().toISOString(),
        };
        return json({ favorite, synced: false } satisfies FavoriteMutationResponse, 202);
      }
      await mirrorLegacyFavoriteChange(env, owner.sub, favorite, true);
      return json({ favorite, synced: true } satisfies FavoriteMutationResponse);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/crm/favorites',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ env, url, owner }) => {
      const target = favoriteTargetSchema.parse(parseQuery(favoriteTargetQuerySchema, url));
      try {
        await removeCoreFavorite(env, owner.email, target);
      } catch (error) {
        if (!shouldQueueFavoriteFailure(error, env)) throw error;
        await queueFavoriteChange(env, owner.sub, target, false);
        return json({ removed: true, synced: false } satisfies FavoriteRemoveResponse, 202);
      }
      await mirrorLegacyFavoriteChange(env, owner.sub, target, false);
      return json({ removed: true, synced: true } satisfies FavoriteRemoveResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/crm/favorites/migration-status',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner }) => {
      let rows: FavoriteRow[] = [];
      let sharedAvailable = true;
      try {
        rows = await listCoreFavorites(env, owner.email);
      } catch (error) {
        if (!shouldQueueFavoriteFailure(error, env)) throw error;
        sharedAvailable = false;
      }
      return json(await favoriteMigrationStatus(env, owner.sub, rows, sharedAvailable) satisfies FavoriteMigrationStatusResponse);
    },
  }),

  // Home's QUICK ACCESS list: the starred subjects as search rows, resolved
  // once here so the Mac, the phone and the browser draw one shared strip.
  defineRoute({
    method: 'GET',
    path: '/api/crm/starred',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, ctx, owner }) => {
      const { favorites } = await sharedFavoriteRows(env, owner.sub, owner.email);
      const access = await subjectAccessFor(env, owner);
      const visible = access.filter(favorites, (row) => favoriteSubjectKey(row.kind, row.target_ref));
      const starred = await starredFavoriteRows(request, env, ctx, owner, visible);
      return json({ ...starred, rows: access.filter(starred.rows, (row) => doorKey(row.door)) } satisfies SearchResponse);
    },
  }),

  // One colleague's open work, for the person surface.
  //
  // The same Core read as `/api/crm/mine`, pointed at somebody else — which is
  // the whole of the difference and the whole of the risk, so the address is
  // checked before it is used. Envisioning members only, and only Envisioning
  // addresses: a roster the whole team can already read is one thing, and a
  // route that would fetch work for an arbitrary email is another.
  //
  // Nothing here is private to its assignee — a task in the company CRM is
  // company work, and "who owes what" is the question the surface exists to
  // answer. See docs/PRIVACY.md.
  defineRoute({
    method: 'GET',
    path: '/api/crm/work',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const assignee = parseQuery(crmMyWorkQuerySchema, url).assignee_email;
      if (!isMemberEmail(env, assignee)) {
        return json(
          { error: 'That address is not on your team.', code: 'room_not_found' } satisfies ControlErrorBody,
          404,
        );
      }
      const work = await fetchCrmMyWork(env, assignee);
      return json(await filterMyWork(env, await subjectAccessFor(env, owner), work) satisfies CrmMyWorkResponse);
    },
  }),

  // Your own GitHub username, so your issues can be found. Only ever your own:
  // the address is the session's, never the body's.
  defineRoute({
    method: 'PATCH',
    path: '/api/crm/mine',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const body = crmGithubLoginSchema.parse(await readBoundedJSON(request));
      const login = body.github_login?.trim() || null;
      return json({ github_login: await setCrmGithubLogin(env, owner.email, login) } satisfies CrmGithubLoginResponse);
    },
  }),

  // A Core PAT for the signed-in owner: the door to Core's registry (Work's
  // Core block, All fields, registry search). Brokered, not stored — the
  // Worker proves the owner to Core and hands the token straight back.
  defineRoute({
    method: 'POST',
    path: '/api/core/token',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'Core is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const body = coreTokenRequestSchema.parse(await readBoundedJSON(request));
      return json(await exchangeCoreToken(env, owner.email, body.device_name) satisfies CoreTokenResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/crm/subjects',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, url, owner }) => {
      const query = parseQuery(crmSubjectsQuerySchema, url);
      // A kind whose work module is off lists nothing (docs/WORK_MODEL.md).
      if (!(await subjectKindOn(env, query.kind))) {
        return json({ subjects: [], has_more: false } satisfies CrmSubjectsResponse);
      }
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const found = await fetchCrmSubjects(
        env,
        query.kind,
        query.q,
        query.status,
        undefined,
        query.kind === 'event' ? query.today : undefined,
        query.kind === 'organization' ? {
          partner: query.partner,
          agency: query.agency,
          existing_client: query.existing_client,
          industry: query.industry,
          country: query.country,
        } : undefined,
        query.kind === 'lead' ? query.source : undefined,
      );
      const access = await subjectAccessFor(env, owner);
      return jsonConditional(request, {
        subjects: await withLastActivity(env, owner, access.filter(found.subjects, (subject) => subject)),
        has_more: found.hasMore,
        ...(found.facets ? { facets: found.facets } : {}),
      } satisfies CrmSubjectsResponse);
    },
  }),

  // Work's relationship picker uses Core's owner-scoped search API. The
  // Worker holds the short-lived broker PAT; the browser never receives it.
  defineRoute({
    method: 'GET',
    path: '/api/crm/organizations',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      const query = parseQuery(crmOrganizationsQuerySchema, url);
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      return json({ organizations: await searchCrmOrganizations(env, owner.email, query.q) } satisfies CrmOrganizationsResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/crm/organizations',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const body = parseFormBody(crmOrganizationCreateSchema, 'organization', await readBoundedJSON(request));
      const organization = await createCrmOrganization(env, owner.email, body.name);
      return json({ organization } satisfies CrmOrganizationResponse, 201);
    },
  }),

  // Contacts on every workspace (docs/RELATIONSHIPS.md slice 2).
  // A contact is seen through its organization: a member who cannot see a
  // restricted organization does not see its contacts, and writes one only
  // where they could write the organization.
  defineRoute({
    method: 'GET',
    path: '/api/crm/contacts',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const query = parseQuery(crmContactsQuerySchema, url);
      const access = await subjectAccessFor(env, owner);
      if (query.organization_id) access.requireSee('organization', query.organization_id);
      const ids = query.ids?.split(',').map((id) => id.trim()).filter((id) => /^[0-9a-f-]{36}$/iu.test(id));
      const emails = query.emails?.split(',').map((email) => email.trim().toLowerCase()).filter((email) => /^[^@\s]+@[^@\s]+$/u.test(email));
      const found = await fetchCrmContacts(env, owner.email, {
        q: query.q,
        organizationId: query.organization_id ?? null,
        ...(ids ? { ids } : {}),
        ...(emails ? { emails: [...new Set(emails)] } : {}),
        limit: query.limit,
        filter: {
          country: query.country,
          partner: query.partner,
          existing_client: query.existing_client,
          signals_outreach_status: query.signals_outreach_status,
          preferred_language: query.preferred_language,
        },
        facets: query.facets,
      });
      return json({
        contacts: access.filter(found.contacts, contactKey),
        has_more: found.hasMore,
        ...(found.facets ? { facets: found.facets } : {}),
      } satisfies CrmContactsResponse);
    },
  }),

  // What the contact editor offers: characteristic names and languages.
  defineRoute({
    method: 'GET',
    path: '/api/crm/contact-options',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      return json(await fetchCrmContactOptions(env, owner.email) satisfies CrmContactOptionsResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/crm/contacts',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const body = parseFormBody(crmContactCreateSchema, 'contact', await readBoundedJSON(request));
      const access = await subjectAccessFor(env, owner);
      if (body.organization_id) access.requireWrite('organization', body.organization_id);
      const contact = await createCrmContact(env, owner.email, body);
      return json({ contact: readableContact(access, contact) } satisfies CrmContactResponse, 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/crm/contacts/:id',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const access = await subjectAccessFor(env, owner);
      const contact = await fetchCrmContactDetail(env, owner.email, params.id!);
      requireSeeContact(access, contact);
      return json({ contact: readableContact(access, contact) } satisfies CrmContactResponse);
    },
  }),

  // Delete is refused while a call or a task references the contact.
  defineRoute({
    method: ['PATCH', 'DELETE'],
    path: '/api/crm/contacts/:id',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const access = await subjectAccessFor(env, owner);
      const current = await crmContactOrganization(env, owner.email, params.id!);
      if (current) access.requireWrite('organization', current);
      if (request.method === 'DELETE') {
        return json(await deleteCrmContact(env, owner.email, params.id!) satisfies CrmContactDeleteResponse);
      }
      const body = parseFormBody(crmContactUpdateSchema, 'contact', await readBoundedJSON(request));
      if (body.organization_id) access.requireWrite('organization', body.organization_id);
      const contact = await updateCrmContact(env, owner.email, params.id!, body);
      return json({ contact: readableContact(access, contact) } satisfies CrmContactResponse);
    },
  }),

  // The sidebar badges, one request per kind (docs/WORK.md). Partners have
  // no status, so the kind is the two that do.
  defineRoute({
    method: 'GET',
    path: '/api/crm/subject-counts',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, url, owner }) => {
      const query = parseQuery(crmSubjectCountsQuerySchema, url);
      if (!(await subjectKindOn(env, query.kind))) return json({ counts: {} } satisfies CrmSubjectCountsResponse);
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const counts = await fetchCrmSubjectCounts(env, query.kind, query.q);
      return jsonConditional(
        request,
        await filterSubjectCounts(env, await subjectAccessFor(env, owner), query.kind, query.q, counts) satisfies CrmSubjectCountsResponse,
      );
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/crm/interactions',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, url, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const query = parseQuery(crmInteractionsQuerySchema, url);
      const access = await subjectAccessFor(env, owner);
      const asked = interactionKey(query);
      if (asked) access.requireSee(asked.kind, asked.id);
      const interactions = await fetchCrmInteractions(
        env,
        { projectId: query.project_id ?? null, leadId: query.lead_id ?? null, organizationId: query.organization_id ?? null },
        query.limit,
      );
      const history = query.project_id
        ? withLeadHistory(interactions, await leadHistory(env, access, query.project_id, query.limit), query.limit)
        : interactions;
      return jsonConditional(request, { interactions: access.filter(history, interactionKey) } satisfies CrmInteractionsResponse);
    },
  }),

  // A call, meeting or note logged by hand on a subject's History.
  // Writing on every subject the row names is the right. The group's store
  // takes it: Core's agent route, or D1 once the `interactions` group moved.
  defineRoute({
    method: 'POST',
    path: '/api/crm/interactions',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const body = crmInteractionCreateSchema.parse(await readBoundedJSON(request));
      requireInteractionWrite(await subjectAccessFor(env, owner), body);
      return json({ interaction: await createCrmInteraction(env, owner.email, body) } satisfies CrmInteractionResponse, 201);
    },
  }),

  defineRoute({
    method: ['PATCH', 'DELETE'],
    path: '/api/crm/interactions/:id',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const current = await fetchCrmInteraction(env, owner.email, params.id!);
      if (!current) return json({ error: 'Interaction not found.', code: 'request_not_found' } satisfies ControlErrorBody, 404);
      const access = await subjectAccessFor(env, owner);
      // Where the row is now, and where an edit would file it: both are writes.
      const on = interactionKey(current);
      if (on) access.requireWrite(on.kind, on.id);
      if (request.method === 'DELETE') {
        return json(await deleteCrmInteraction(env, owner.email, params.id!) satisfies CrmInteractionDeleteResponse);
      }
      const body = crmInteractionUpdateSchema.parse(await readBoundedJSON(request));
      requireInteractionWrite(access, body);
      return json({ interaction: await updateCrmInteraction(env, owner.email, params.id!, body) } satisfies CrmInteractionResponse);
    },
  }),

  // One image in a house look for an event, generated by Core and written to
  // the row's image_url (docs/EVENTS_AGENT.md §Images). Only events have a
  // generator, so the entity is part of the path, not a parameter.
  defineRoute({
    method: 'POST',
    path: '/api/cms/events/:id/image',
    params: { id: { re: '[^/]+', sample: 'sample' } },
    gate: { kind: 'capability', capability: 'cmsContent' },
    handler: async ({ request, env, owner, params }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      assertTrustedMutation(request, env);
      (await subjectAccessFor(env, owner)).requireWrite('event', decodeURIComponent(params.id!));
      const body = cmsEventImageRequestSchema.parse(await readBoundedJSON(request));
      return json(await generateCmsEventImage(env, owner.email, decodeURIComponent(params.id!), body) satisfies JsonValue);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/cms/technologies/:id/image',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'cmsContent' },
    handler: async ({ request, env, owner, params }) => {
      if (!crmSyncEnabled(env)) return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      assertTrustedMutation(request, env);
      const body = cmsTechnologyImageRequestSchema.parse(await readBoundedJSON(request));
      return json(await generateCmsTechnologyImage(env, owner.email, params.id!, body) satisfies JsonValue);
    },
  }),

  // Core's records whole, for a Claude (docs/MCP.md, `cms` with a CRM entity):
  // a list with Core's own filters, and a new organization, contact,
  // interaction, lead or project with any field Core's schema takes. Edits go
  // through `/api/core/fields/:entity/:id`. Only an organization with nothing
  // pointing at it is deleted, there; Core's own DELETE stays in Core.
  defineRoute({
    method: ['GET', 'POST'],
    path: '/api/core/records/:entity',
    params: { entity: { re: '[a-z_]{1,64}', sample: 'organizations' } },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, url, owner, params }) => {
      const entity = params.entity!;
      if (!isCoreRecordEntity(entity)) throw new ControlError('Unknown Core record type.', 404);
      // The record's group decides the store: Core while it is
      // there, D1 once it has moved, in the same record shape.
      const onCore = usesCoreFor(env, coreRecordGroup(entity));
      if (onCore && !crmSyncEnabled(env)) {
        return json({ error: 'Core is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const access = await subjectAccessFor(env, owner);
      if (request.method === 'GET') {
        const params = coreRecordListQueryFor(entity).parse(Object.fromEntries(url.searchParams));
        const records = onCore ? await listCoreRecords(env, owner.email, entity, params) : await listD1CoreRecords(env, entity, params);
        return json(filterCoreRecords(access, entity, records) satisfies JsonValue);
      }
      assertTrustedMutation(request, env);
      const body = coreFieldsWriteBodySchema.parse(await readBoundedJSON(request));
      if (coreRecordNeedsOrganization(entity)) coreRecordOrganizationSchema.parse(body);
      // A new interaction is filed onto a subject: that is a write there.
      const filed = coreRecordKey(entity === 'interactions' ? entity : '', body);
      if (filed) access.requireWrite(filed.kind, filed.id);
      const created = onCore
        ? await createCoreRecord(env, owner.email, entity, body)
        : await createD1CoreRecord(env, owner.email, entity, body);
      return json(created satisfies JsonValue, 201);
    },
  }),

  defineRoute({
    method: ['GET', 'PATCH', 'DELETE'],
    path: '/api/core/fields/:entity/:id',
    params: { entity: { re: '[a-z_]{1,64}', sample: 'organizations' }, id: { re: '[^/]+', sample: 'sample' } },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, owner, params }) => {
      const entity = params.entity!;
      if (!isCoreRecordEntity(entity)) throw new ControlError('Fields are for organizations, contacts, interactions, projects and leads.', 404);
      const onCore = usesCoreFor(env, coreRecordGroup(entity));
      if (onCore && !crmSyncEnabled(env)) {
        return json({ error: 'Core is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const read = (recordId: string) => (onCore ? fetchCoreFieldsRecord(env, owner.email, entity, recordId) : fetchD1CoreRecord(env, entity, recordId));
      const id = decodeURIComponent(params.id!);
      const access = await subjectAccessFor(env, owner);
      const own = coreEntityKey(entity, id);
      if (own) {
        if (request.method === 'GET') access.requireSee(own.kind, own.id);
        else access.requireWrite(own.kind, own.id);
      } else if (entity === 'interactions') {
        // An interaction is reached through the subject it is filed on.
        const record = await read(id);
        const filed = coreRecordKey(entity, record && typeof record === 'object' && !Array.isArray(record) ? record.data : null);
        if (filed) {
          if (request.method === 'GET') access.requireSee(filed.kind, filed.id);
          else access.requireWrite(filed.kind, filed.id);
        }
      }
      if (request.method === 'DELETE') {
        if (entity !== 'organizations') throw new ControlError('Only an organization is deleted here, and only when nothing points at it.', 400);
        assertTrustedMutation(request, env);
        const deleted = onCore ? await deleteCoreOrganization(env, owner.email, id) : await deleteD1CoreOrganization(env, owner.email, id);
        return json(deleted satisfies JsonValue);
      }
      if (request.method === 'GET') {
        return json(await read(id) satisfies JsonValue);
      }
      assertTrustedMutation(request, env);
      const body = coreFieldsWriteBodySchema.parse(await readBoundedJSON(request));
      const updated = onCore
        ? await updateCoreFieldsRecord(env, owner.email, entity, id, body)
        : await updateD1CoreRecord(env, owner.email, entity, id, body);
      return json(updated satisfies JsonValue);
    },
  }),

  // A merge, for a Claude (docs/MCP.md §CRM records): organizations,
  // contacts or leads, as the member. Core's own merge while the subjects
  // group answers from Core, the Worker's over D1 after.
  defineRoute({
    method: 'POST',
    path: '/api/core/merge/:entity',
    params: { entity: { re: '[a-z_]{1,64}', sample: 'contacts' } },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, owner, params }) => {
      const entity = params.entity!;
      if (!isCoreMergeEntity(entity)) throw new ControlError('Only organizations, contacts and leads are merged.', 404);
      // Core merges until the subjects group moves; then D1 does.
      if (usesCoreFor(env, 'subjects') && !crmSyncEnabled(env)) {
        return json({ error: 'Core is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      assertTrustedMutation(request, env);
      const body = coreMergeBodySchema.parse(await readBoundedJSON(request));
      const access = await subjectAccessFor(env, owner);
      for (const id of body.ids) {
        const key = coreEntityKey(entity, id);
        if (key) access.requireWrite(key.kind, key.id);
      }
      return json(await mergeCoreRecords(env, owner.email, entity, body.ids) satisfies JsonValue);
    },
  }),

  // An INBOX item with no other resolution leaves by hand: POST dismisses,
  // DELETE brings it back. Reader state, per person (migration 0039).
  defineRoute({
    method: ['POST', 'DELETE'],
    path: '/api/crm/inbox/:key/dismiss',
    params: { key: { re: '[^/]+', sample: 'sample' } },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, owner, params }) => {
      const key = decodeURIComponent(params.key!);
      const dismissed = request.method === 'POST';
      await setInboxDismissed(env, owner.sub, key, dismissed);
      return json({ ok: true, key, dismissed } satisfies InboxDismissResponse);
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/crm/subject-state/:kind/:id',
    params: { kind: { re: 'lead|project|organization|partner|event', sample: 'lead' }, id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = subjectStateUpdateSchema.parse(await readBoundedJSON(request));
      (await subjectAccessFor(env, owner)).requireSee(params.kind!, params.id!);
      const state = await writeSubjectState(
        env,
        owner.sub,
        params.kind! as 'lead' | 'project' | 'organization' | 'event',
        params.id!,
        body,
      );
      return json({ state } satisfies SubjectStateUpdateResponse);
    },
  }),

  defineRoute({
    method: ['POST', 'DELETE'],
    path: '/api/crm/sales-inbox/:id/dismiss',
    params: { id: { re: '[^/]+', sample: 'sample' } },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const touchId = decodeURIComponent(params.id!);
      const dismissed = await setUntriagedTouchDismissed(env, owner.email, touchId, request.method === 'POST');
      return json({ ok: true, dismissed } satisfies UntriagedTouchDismissResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/crm/subjects',
    // `crmWork`, like every other work-graph write: MCP's `task` reaches this
    // route (`action: "create_lead"`), and docs/MCP.md rule 1 wants a capability.
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = parseFormBody(crmSubjectCreateCommandSchema, subjectForm, await readBoundedJSON(request));
      await requireSubjectKindOn(env, body.kind);
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      return json({
        subject: await readableSubjectDetail(env, owner, await createCrmSubject(env, body, owner.email)),
      } satisfies CrmSubjectMutationResponse, 201);
    },
  }),

  // Partners and events read through the same shape but never write: one is
  // an organization in Core (PARTNERS (HQ Docs)), the other a CMS row
  // (docs/EVENTS.md). PATCH below keeps the two-kind match, so a partner or
  // event PATCH is simply not a route.
  defineRoute({
    method: 'GET',
    path: '/api/crm/subjects/:kind/:id',
    params: { kind: { re: 'lead|project|organization|partner|event', sample: 'lead' }, id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      await requireSubjectKindOn(env, params.kind as SubjectKind);
      const access = await subjectAccessFor(env, owner);
      access.requireSee(params.kind!, params.id!);
      const subject = await fetchCrmSubjectDetail(
        env,
        params.kind as 'lead' | 'project' | 'organization' | 'event',
        params.id!,
      );
      // A merged id answers its survivor: the survivor's own access decides.
      if (subject.merged_from) access.requireSee(subject.kind, subject.id);
      const readable = await readableSubjectDetail(env, owner, subject);
      if (readable.kind !== 'organization') return json({ subject: readable } satisfies CrmSubjectDetailResponse);
      return json({ subject: { ...readable, relationships: await organizationRelationshipsFor(env, owner, readable) } } satisfies CrmSubjectDetailResponse);
    },
  }),

  // A lead's or an organization's offers and licences: anyone who
  // sees the subject reads them. A list is null when its work module is off.
  defineRoute({
    method: 'GET',
    path: '/api/crm/subjects/:kind/:id/commercial',
    params: { kind: { re: 'lead|organization', sample: 'lead' }, id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const kind = params.kind as 'lead' | 'organization';
      await requireSubjectKindOn(env, kind);
      const access = await subjectAccessFor(env, owner);
      access.requireSee(kind, params.id!);
      const modules = await workModulesOn(env);
      const on = { offers: modules.includes('offers'), licenses: modules.includes('licenses') };
      // Once the group answers from D1, Core's sync does not matter.
      if ((!on.offers && !on.licenses) || (usesCoreFor(env, 'commercial') && !crmSyncEnabled(env))) {
        return json({ offers: null, licenses: null } satisfies CrmSubjectCommercialResponse);
      }
      return json(await fetchCrmSubjectCommercial(env, owner.email, kind, params.id!, on) satisfies CrmSubjectCommercialResponse);
    },
  }),

  // The form answers that filed a lead (docs/FORMS.md): anyone who sees the
  // lead reads them, as they read its notes. Null for a lead a member made.
  defineRoute({
    method: 'GET',
    path: '/api/crm/subjects/lead/:id/submission',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      await requireSubjectKindOn(env, 'lead');
      (await subjectAccessFor(env, owner)).requireSee('lead', params.id!);
      const submission = await formSubmissionForLead(env, params.id!) ?? await interestSubmissionForLead(env, params.id!);
      return json({ submission } satisfies SubjectSubmissionResponse);
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/crm/subjects/:kind/:id',
    params: { kind: { re: 'lead|project', sample: 'lead' }, id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const kind = params.kind as 'lead' | 'project';
      await requireSubjectKindOn(env, kind);
      (await subjectAccessFor(env, owner)).requireWrite(kind, params.id!);
      const body = kind === 'lead'
        ? parseFormBody(crmLeadUpdateSchema, 'lead', await readBoundedJSON(request))
        : parseFormBody(crmProjectUpdateSchema, 'project', await readBoundedJSON(request));
      // Responsible is always a person on this workspace, never an agent
      // (docs/OWNERSHIP.md decision 7). Core cannot tell; the roster can.
      if (body.responsible_email) await requireResponsiblePerson(env, body.responsible_email);
      return json({
        subject: await readableSubjectDetail(env, owner, await updateCrmSubject(env, kind, params.id!, body, owner.email)),
      } satisfies CrmSubjectMutationResponse);
    },
  }),

  // An organization's fields and its guarded delete, on the
  // subjects group's store: Core while the group is there, D1 once it has
  // moved. The delete is refused while any record points at the organization.
  defineRoute({
    method: ['PATCH', 'DELETE'],
    path: '/api/crm/subjects/organization/:id',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      await requireSubjectKindOn(env, 'organization');
      (await subjectAccessFor(env, owner)).requireWrite('organization', params.id!);
      if (request.method === 'DELETE') {
        return json(await deleteCrmOrganization(env, owner.email, params.id!) satisfies CrmOrganizationDeleteResponse);
      }
      const body = crmOrganizationUpdateSchema.parse(await readBoundedJSON(request));
      return json({
        subject: await readableSubjectDetail(env, owner, await updateCrmOrganization(env, owner.email, params.id!, body)),
      } satisfies CrmSubjectMutationResponse);
    },
  }),

  // Win (ADR 0008): the project first, then the tasks, then the lead's
  // status, so a failure leaves a linked project on an open lead and never a
  // won lead with no project. The same order on Core and on D1.
  defineRoute({
    method: 'POST',
    path: '/api/crm/subjects/lead/:id/win',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      await requireSubjectKindOn(env, 'lead');
      const access = await subjectAccessFor(env, owner);
      access.requireWrite('lead', params.id!);
      const body = crmLeadWinSchema.parse(await readBoundedJSON(request));
      const lead = await fetchCrmSubjectDetail(env, 'lead', params.id!);
      if (lead.status === 'Closed Won' || lead.status === 'Closed Lost') {
        return json({ error: 'This lead is already closed.', code: 'request_already_decided' } satisfies ControlErrorBody, 409);
      }
      if (!lead.organization_id) {
        return json({ error: 'Give this lead an organization first.', code: 'invalid_request' } satisfies ControlErrorBody, 400);
      }
      const project = await createCrmSubject(env, {
        kind: 'project',
        title: body.title?.trim() || lead.title,
        organization_id: lead.organization_id,
        contact_ids: lead.contact_id ? [lead.contact_id] : [],
        lead_id: lead.id,
        status: 'Active',
      }, owner.email);
      // Only the lead's own open tasks move; any other id is reported unmoved.
      const open = new Set((await fetchCrmTasks(env, { leadId: lead.id }))
        .filter((task) => (OPEN_TASK_STATUSES as readonly string[]).includes(task.status))
        .map((task) => task.id));
      const moved: string[] = [];
      const unmoved: string[] = [];
      for (const id of body.task_ids) {
        if (!open.has(id)) { unmoved.push(id); continue; }
        try {
          await updateCrmTask(env, id, { actor_email: owner.email, project_id: project.id });
          moved.push(id);
        } catch (error) {
          console.warn('win: task move failed', id, error instanceof Error ? error.message : error);
          unmoved.push(id);
        }
      }
      if (moved.length > 0) await purgeCoreCache(taskCacheKeys({ lead_id: lead.id }));
      let leadClosed = true;
      try {
        await updateCrmSubject(env, 'lead', lead.id, { status: 'Closed Won' }, owner.email);
      } catch (error) {
        console.warn('win: lead status failed', lead.id, error instanceof Error ? error.message : error);
        leadClosed = false;
      }
      return json({
        project: await readableSubjectDetail(env, owner, await fetchCrmSubjectDetail(env, 'project', project.id)),
        moved_task_ids: moved,
        unmoved_task_ids: unmoved,
        lead_closed: leadClosed,
      } satisfies CrmLeadWinResponse, 201);
    },
  }),

  // Who reaches a subject (docs/ACCESS.md). Anyone who sees the subject reads
  // the list; only a `manage` holder or an admin changes it, and every change
  // goes to the act record.
  defineRoute({
    method: 'GET',
    path: '/api/crm/subjects/:kind/:id/access',
    params: { kind: { re: 'lead|project|organization|partner|event', sample: 'lead' }, id: { re: '[^/]+', sample: 'sample' } },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner, params }) =>
      json(await readSubjectAccess(env, owner, params.kind!, params.id!) satisfies SubjectAccessResponse),
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/crm/subjects/:kind/:id/visibility',
    params: { kind: { re: 'lead|project|organization|partner|event', sample: 'lead' }, id: { re: '[^/]+', sample: 'sample' } },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = subjectVisibilityUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeSubjectVisibility(env, owner, params.kind!, params.id!, body.visibility) satisfies SubjectAccessResponse);
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/crm/subjects/:kind/:id/grants',
    params: { kind: { re: 'lead|project|organization|partner|event', sample: 'lead' }, id: { re: '[^/]+', sample: 'sample' } },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = subjectGrantUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeSubjectGrant(env, owner, params.kind!, params.id!, body) satisfies SubjectAccessResponse);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/crm/subjects/:kind/:id/grants/:grant',
    params: { kind: { re: 'lead|project|organization|partner|event', sample: 'lead' }, id: { re: '[^/]+', sample: 'sample' }, grant: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ env, owner, params }) =>
      json(await revokeSubjectGrant(env, owner, params.kind!, params.id!, params.grant!) satisfies SubjectAccessResponse),
  }),

  // Peer organizations (docs/ACCESS.md slice 5). Members list them to share a
  // subject with one; only an admin revokes one or issues a new token.
  defineRoute({
    method: 'GET',
    path: '/api/peer-workspaces',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env }) => json(await listPeerWorkspaces(env) satisfies PeerWorkspacesResponse),
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/peer-workspaces/:organizationId',
    params: { organizationId: { re: '[^/]{1,64}', sample: 'sample' } },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner, params }) =>
      json({ peer: await revokePeerCredential(env, owner, params.organizationId!) } satisfies { peer: PeerWorkspace }),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/peer-workspaces/:organizationId/token',
    params: { organizationId: { re: '[^/]{1,64}', sample: 'sample' } },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner, params }) =>
      json(await rotatePeerToken(env, owner, params.organizationId!) satisfies PeerWorkspaceTokenResponse),
  }),

  // Filing and changing an issue. The author is the signed-in member, taken
  // from the session rather than the body — a client that could name its own
  // author could write into the record as somebody else.
  defineRoute({
    method: ['POST', 'PATCH'],
    path: '/api/crm/issue',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner }) => {
      if (!githubIssuesEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const raw = await readBoundedJSON(request);
      const body = request.method === 'POST'
        ? crmIssueCreateSchema.parse(raw)
        : crmIssueUpdateSchema.parse(raw);
      const access = await subjectAccessFor(env, owner);
      if (body.project_id) access.requireWrite('project', body.project_id);
      if ('owner' in body && 'repo' in body) await requireRepoVisible(env, owner, body.owner, body.repo);
      const issue = await writeCrmIssue(env, request.method as 'POST' | 'PATCH', body, owner.email);
      if (!issue) throw new ControlError('Core issue write returned no issue.', 502);
      // And say so in the project's channel. After the write, on `waitUntil`, and
      // silent when there is nothing worth a line: an event never gets to fail
      // the change it reports, and a label edit is not news.
      // Named for the Claude when one filed it: this is the only line an MCP
      // `create_issue` leaves, and the one Core's webhook dedupes against.
      ctx.waitUntil(reportIssueChange(env, actorName(owner, await requestVia(request, env)), body, issue));
      return json({ issue } satisfies CrmIssueResponse, request.method === 'POST' ? 201 : 200);
    },
  }),

  // Per-user subject state: star / mute, and the SALES opt-in. Mutes and work
  // preferences remain in D1; a configured cutover reads only star bits from
  // Core. Until then the D1 view stays authoritative and its outbox is drained
  // independently, so a partial Core outage never loses an old-client write.
  // ( decision 5, slice 2). Overrides in D1, the default rule in
  // `@starlings/contracts/subject-state`; the read returns both so the client
  // resolves a row without carrying the role table. Same capability as the
  // rest of the work graph — a community session has no subjects to follow.
  defineRoute({
    method: 'GET',
    path: '/api/crm/subject-state',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner }) => subjectStateAnswer(env, owner),
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/crm/subject-state',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = workPreferencesUpdateSchema.parse(withoutRetiredInboxSources(await readBoundedJSON(request)));
      await writeWorkPreferences(env, owner.sub, body);
      return subjectStateAnswer(env, owner);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/crm/tasks',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, url, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const query = parseQuery(crmTasksQuerySchema, url);
      const access = await subjectAccessFor(env, owner);
      const asked = taskKey(query);
      if (asked) access.requireSee(asked.kind, asked.id);
      const subjectId = query.project_id ?? query.lead_id ?? query.event_id ?? query.organization_id ?? query.meeting_id ?? query.signals_account_id ?? 'all';
      const tasks = await staleOnError(`tasks-open/${subjectId}`, () => fetchCrmTasks(env, {
        projectId: query.project_id ?? null, leadId: query.lead_id ?? null, eventId: query.event_id ?? null,
        organizationId: query.organization_id ?? null, meetingId: query.meeting_id ?? null,
        signalsAccountId: query.signals_account_id ?? null,
      }));
      return jsonConditional(request, { tasks: access.filter(tasks, taskKey) } satisfies CrmTasksResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/crm/tasks',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, ctx, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      assertTrustedMutation(request, env);
      const body = crmTaskCreateSchema.parse(await readBoundedJSON(request));
      const target = taskKey(body);
      if (target) (await subjectAccessFor(env, owner)).requireWrite(target.kind, target.id);
      const create: Parameters<typeof createCrmTask>[1] = {
        title: body.title,
        notes: body.notes ?? null,
        project_id: body.project_id ?? null,
        lead_id: body.lead_id ?? null,
        event_id: body.event_id ?? null,
        organization_id: body.organization_id ?? null,
        signals_account_id: body.signals_account_id ?? null,
        // The meeting is the subject only when nothing else is.
        meeting_id: !body.project_id && !body.lead_id && !body.event_id && !body.organization_id && !body.signals_account_id ? body.meeting_id ?? null : null,
        actor_email: owner.email,
      };
      if (body.status !== undefined) create.status = body.status;
      if (body.responsible_party !== undefined) create.responsible_party = body.responsible_party;
      if (body.assigned_to !== undefined) create.assigned_to = body.assigned_to;
      // A new task is the creator's unless the create says otherwise
      //: no `assigned_to` assigns the caller; `null` is nobody.
      // Only a team task has an assignee, so a client or unassigned party
      // keeps its choice.
      else if (body.responsible_party === undefined || body.responsible_party === 'team') {
        const creator = await crmMemberIdForEmail(env, owner.email);
        if (creator) {
          create.assigned_to = creator;
          create.responsible_party = 'team';
        }
      }
      if (body.due_date !== undefined) create.due_date = body.due_date;
      if (body.goal_id !== undefined) create.goal_id = body.goal_id;
      const task = await createCrmTask(env, create);
      // Only work the meeting produced is reported into the channel: a task
      // typed by hand in Work is already in front of the person typing it.
      const subject = taskSubject(body);
      if (body.source === 'suggestion' && subject) {
        const refs: Array<{ kind: 'task' | 'meeting'; id: string }> = [{ kind: 'task', id: task.id }];
        if (body.meeting_id) refs.push({ kind: 'meeting', id: body.meeting_id });
        ctx.waitUntil(postSubjectEvent(
          env,
          subject,
          `New task from the meeting: ${body.title}`,
          refs,
          { actor: { sub: owner.sub, email: owner.email } },
        ));
      }
      return json({ task } satisfies CrmTaskResponse, 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/crm/tasks/:id',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const task = await fetchCrmTask(env, params.id!);
      if (!task) return json({ error: 'Task not found.', code: 'request_not_found' } satisfies ControlErrorBody, 404);
      const on = taskKey(task);
      if (on) (await subjectAccessFor(env, owner)).requireSee(on.kind, on.id);
      return json({ task } satisfies CrmTaskResponse);
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/crm/tasks/:id',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, ctx, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      assertTrustedMutation(request, env);
      const body = crmTaskUpdateSchema.parse(await readBoundedJSON(request));
      const access = await subjectAccessFor(env, owner);
      if (access.readOnly.length > 0) {
        // Where the task is now, and where a move would put it: both are writes.
        const current = await fetchCrmTask(env, params.id!);
        const on = current ? taskKey(current) : null;
        if (on) access.requireWrite(on.kind, on.id);
        const keys = taskSubjectKeys(body);
        const moving = keys.length > 0 ? taskKey(Object.fromEntries(keys.map((key) => [key, body[key] ?? null]))) : null;
        if (moving) access.requireWrite(moving.kind, moving.id);
      }
      const patch: Parameters<typeof updateCrmTask>[2] = { actor_email: owner.email };
      if (body.title !== undefined) patch.title = body.title;
      if (body.notes !== undefined) patch.notes = body.notes;
      if (body.status !== undefined) patch.status = body.status;
      if (body.responsible_party !== undefined) patch.responsible_party = body.responsible_party;
      if (body.assigned_to !== undefined) patch.assigned_to = body.assigned_to;
      if (body.due_date !== undefined) patch.due_date = body.due_date;
      if (body.goal_id !== undefined) patch.goal_id = body.goal_id;
      // Move to…: the one subject named goes to Core, which
      // clears the other four; the list it left is dropped from the cache
      // here, since Core answers with where the task is now, not where it was.
      for (const key of taskSubjectKeys(body)) patch[key] = body[key] ?? null;
      const task = await updateCrmTask(env, params.id!, patch);
      if (body.moved_from) await purgeCoreCache(taskCacheKeys(subjectOf(body.moved_from)));
      // Phase 2 of docs/TIMELINE.md: unlike creation (a task typed by hand is
      // already in front of the person typing it — see the comment on the
      // POST above), a task finishing is news for everyone else on the
      // subject, whoever created it. No dedupe key: a task marked complete
      // twice is two real events, the same way ending an already-ended
      // meeting is guarded by state rather than an idempotency key elsewhere.
      const subject = taskSubject(task);
      if (patch.status === 'completed' && subject) {
        ctx.waitUntil(postSubjectEvent(
          env,
          subject,
          `${actorName(owner, await requestVia(request, env))} completed: ${task.title}`,
          [{ kind: 'task', id: task.id }],
          { actor: { sub: owner.sub, email: owner.email } },
        ));
      }
      return json({ task } satisfies CrmTaskResponse);
    },
  }),

  // An organization's open tasks by project: the Tasks pane's
  // By project grouping, in place of Core's board by project. One read per
  // project the member can see, as the subject Tasks pane reads them, so the
  // per-project cache serves both. Bounded: an organization with more
  // projects groups the first ones.
  defineRoute({
    method: 'GET',
    path: '/api/crm/subjects/organization/:id/project-tasks',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      await requireSubjectKindOn(env, 'organization');
      const access = await subjectAccessFor(env, owner);
      access.requireSee('organization', params.id!);
      const organization = await fetchCrmSubjectDetail(env, 'organization', params.id!);
      const projects = access.filter(organization.related?.projects ?? [], (project) => ({ kind: 'project', id: project.id }))
        .slice(0, ORGANIZATION_PROJECT_TASKS_LIMIT);
      let partial = false;
      const groups = await Promise.all(projects.map(async (project) => {
        try {
          const tasks = await staleOnError(`tasks-open/${project.id}`, () => fetchCrmTasks(env, { projectId: project.id }));
          return { id: project.id, title: project.title, status: project.status, tasks };
        } catch {
          partial = true;
          return { id: project.id, title: project.title, status: project.status, tasks: [] };
        }
      }));
      return jsonConditional(request, {
        projects: groups.filter((group) => group.tasks.length > 0),
        partial,
      } satisfies CrmOrganizationProjectTasksResponse);
    },
  }),

  // Delete: the task goes from the store that holds the `tasks`
  // group. The clients ask first. Writing on the task's subject is the right.
  defineRoute({
    method: 'DELETE',
    path: '/api/crm/tasks/:id',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const current = await fetchCrmTask(env, params.id!);
      if (!current) return json({ error: 'Task not found.', code: 'request_not_found' } satisfies ControlErrorBody, 404);
      const on = taskKey(current);
      if (on) (await subjectAccessFor(env, owner)).requireWrite(on.kind, on.id);
      return json(await deleteCrmTask(env, params.id!, owner.email) satisfies CrmTaskDeleteResponse);
    },
  }),

  // Goals: a title with a status on one project. No channel line:
  // a goal is direction, not an event, and the Overview lists it.
  defineRoute({
    method: 'GET',
    path: '/api/crm/goals',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, url, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const query = parseQuery(crmGoalsQuerySchema, url);
      (await subjectAccessFor(env, owner)).requireSee('project', query.project_id);
      const goals = await fetchCrmGoals(env, query.project_id, query.include_closed);
      return jsonConditional(request, { goals } satisfies CrmGoalsResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/crm/goals',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      assertTrustedMutation(request, env);
      const body = crmGoalCreateSchema.parse(await readBoundedJSON(request));
      (await subjectAccessFor(env, owner)).requireWrite('project', body.project_id);
      const goal = await createCrmGoal(env, { ...body, actor_email: owner.email });
      return json({ goal } satisfies CrmGoalResponse, 201);
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/crm/goals/:id',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, owner, params }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      assertTrustedMutation(request, env);
      const body = crmGoalUpdateSchema.parse(await readBoundedJSON(request));
      if (Object.keys(body).length === 0) return json({ error: 'Nothing to change. Send at least one field.' }, 400);
      // Core reads a goal by its project only, so a goal on a project this
      // caller cannot write is found by reading those projects' goals.
      const access = await subjectAccessFor(env, owner);
      for (const project of access.readOnly.filter((key) => key.kind === 'project')) {
        if ((await fetchCrmGoals(env, project.id, true)).some((goal) => goal.id === params.id)) {
          access.requireWrite(project.kind, project.id);
        }
      }
      const goal = await updateCrmGoal(env, params.id!, { ...body, actor_email: owner.email });
      return json({ goal } satisfies CrmGoalResponse);
    },
  }),

  // Decisions: something the team settled, on one subject. The
  // subject's channel gets a line: the channel is the record (docs/BOARD.md
  // decision 6), and a decision is news for everyone on the subject.
  defineRoute({
    method: 'GET',
    path: '/api/crm/decisions',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, url, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const query = parseQuery(crmDecisionsQuerySchema, url);
      (await subjectAccessFor(env, owner)).requireSee(query.subject_kind, query.subject_id);
      const decisions = await fetchCrmDecisions(env, { kind: query.subject_kind, id: query.subject_id }, query.limit);
      return jsonConditional(request, { decisions } satisfies CrmDecisionsResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/crm/decisions',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, ctx, owner }) => {
      if (!workModelEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      assertTrustedMutation(request, env);
      const body = crmDecisionCreateSchema.parse(await readBoundedJSON(request));
      (await subjectAccessFor(env, owner)).requireWrite(body.subject_kind, body.subject_id);
      const decision = await recordDecision(env, ctx, owner, body);
      return json({ decision } satisfies CrmDecisionResponse, 201);
    },
  }),

  // Open decisions (migration 0063): questions waiting on one member,
  // filed by an agent through MCP `ask_decision` and answered from INBOX.
  // Meet's own D1; an answer on a subject is then recorded in Core once,
  // best effort — the answer is stored first and never lost to Core.
  defineRoute({
    method: 'GET',
    path: '/api/decision-asks',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, url, owner }) => {
      const query = parseQuery(decisionAsksQuerySchema, url);
      return json({ asks: await listDecisionAsks(env, owner, query) } satisfies DecisionAsksResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/decision-asks',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, owner }) => {
      assertTrustedMutation(request, env);
      const body = decisionAskCreateSchema.parse(await readBoundedJSON(request));
      return json({ ask: await createDecisionAsk(env, owner, body) } satisfies DecisionAskResponse, 201);
    },
  }),

  // An ask answered, withdrawn, or settled by its default. The answer is
  // recorded on the Core subject too when CRM sync is on.
  defineRoute({
    method: 'POST',
    path: '/api/decision-asks/:id/answer',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const record: RecordCoreDecision | null = workModelEnabled(env)
        ? (body) => recordDecision(env, ctx, owner, body)
        : null;
      const body = decisionAskAnswerSchema.parse(await readBoundedJSON(request));
      return json({ ask: await answerDecisionAsk(env, owner, params.id!, body, record) } satisfies DecisionAskResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/decision-asks/:id/withdraw',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = decisionAskWithdrawSchema.parse(await readBoundedJSON(request));
      return json({ ask: await withdrawDecisionAsk(env, owner, params.id!, body) } satisfies DecisionAskResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/decision-asks/:id/apply-default',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ env, ctx, owner, params }) => {
      const record: RecordCoreDecision | null = workModelEnabled(env)
        ? (body) => recordDecision(env, ctx, owner, body)
        : null;
      return json({ ask: await applyDecisionAskDefault(env, owner, params.id!, record) } satisfies DecisionAskResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/cms/:entity',
    params: { entity: { re: '[a-z][a-z0-9_]{1,63}', sample: 'research' } },
    gate: { kind: 'capability', capability: 'cmsContent' },
    handler: async ({ env, url, owner, params }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const entity = params.entity!;
      if (!isCmsEntityId(entity)) throw new ControlError('Unknown CMS entity.', 404);
      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (/^[a-z][a-z0-9_]{0,63}$/u.test(key)) query[key] = value.slice(0, 500);
      }
      const list = await fetchCmsList(env, owner.email, entity, query);
      return json((entity === 'events' ? filterCoreRecords(await subjectAccessFor(env, owner), entity, list) : list) satisfies JsonValue);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/cms/:entity/:id',
    params: { entity: { re: '[a-z][a-z0-9_]{1,63}', sample: 'research' } },
    gate: { kind: 'capability', capability: 'cmsContent' },
    handler: async ({ env, owner, params }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const entity = params.entity!;
      if (!isCmsEntityId(entity)) throw new ControlError('Unknown CMS entity.', 404);
      const id = decodeURIComponent(params.id!);
      if (entity === 'events') (await subjectAccessFor(env, owner)).requireSee('event', id);
      return json(await fetchCmsRecord(env, owner.email, entity, id) satisfies JsonValue);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/cms/:entity',
    params: { entity: { re: '[a-z][a-z0-9_]{1,63}', sample: 'research' } },
    gate: { kind: 'capability', capability: 'cmsContent', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const entity = params.entity!;
      if (!isCmsEntityId(entity)) throw new ControlError('Unknown CMS entity.', 404);
      const body = cmsWriteBodySchema.parse(await readBoundedJSON(request));
      return json(await createCmsRecord(env, owner.email, entity, body) satisfies JsonValue, 201);
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/cms/:entity/:id',
    params: { entity: { re: '[a-z][a-z0-9_]{1,63}', sample: 'research' } },
    gate: { kind: 'capability', capability: 'cmsContent', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const entity = params.entity!;
      if (!isCmsEntityId(entity)) throw new ControlError('Unknown CMS entity.', 404);
      const id = decodeURIComponent(params.id!);
      if (entity === 'events') (await subjectAccessFor(env, owner)).requireWrite('event', id);
      const body = cmsWriteBodySchema.parse(await readBoundedJSON(request));
      return json(await updateCmsRecord(env, owner.email, entity, id, body) satisfies JsonValue);
    },
  }),

  // Delete is Core's to allow: only research link rows have it
  // (capabilities.delete); content answers 404 and is unpublished instead.
  defineRoute({
    method: 'DELETE',
    path: '/api/cms/:entity/:id',
    params: { entity: { re: '[a-z][a-z0-9_]{1,63}', sample: 'research' } },
    gate: { kind: 'capability', capability: 'cmsContent', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      if (!crmSyncEnabled(env)) {
        return json({ error: 'CRM sync is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const entity = params.entity!;
      if (!isCmsEntityId(entity)) throw new ControlError('Unknown CMS entity.', 404);
      const id = decodeURIComponent(params.id!);
      if (entity === 'events') (await subjectAccessFor(env, owner)).requireWrite('event', id);
      return json(await deleteCmsRecord(env, owner.email, entity, id) satisfies JsonValue);
    },
  }),
];

/**
 * Settings sends the whole `inbox_sources` map back. An installed client
 * from before a source retired still names it; drop those keys so its other
 * switches keep working, rather than refusing the whole write.
 */
function withoutRetiredInboxSources(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const sources = (body as { inbox_sources?: unknown }).inbox_sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return body;
  const kept = Object.fromEntries(Object.entries(sources).filter(([key]) => !(RETIRED_INBOX_SOURCES as readonly string[]).includes(key)));
  return { ...body, inbox_sources: kept };
}

/** A contact is seen through its organization (docs/ACCESS.md); one with none is the workspace's. */
function contactKey(contact: Pick<CrmContact, 'organization_id'>): SubjectKey | null {
  return contact.organization_id ? { kind: 'organization', id: contact.organization_id } : null;
}

/** 404, as a hidden subject is, when the contact's organization is out of reach. */
function requireSeeContact(access: SubjectAccessView, contact: CrmContactDetail): void {
  if (contact.organization_id && !access.canSee('organization', contact.organization_id)) {
    throw new ControlError('No contact with that id.', 404, 'request_not_found');
  }
}

/** The contact page with the work and calls this member cannot see left out. */
function readableContact(access: SubjectAccessView, contact: CrmContactDetail): CrmContactDetail {
  return {
    ...contact,
    projects: access.filter(contact.projects, (row) => ({ kind: 'project', id: row.id })),
    leads: access.filter(contact.leads, (row) => ({ kind: 'lead', id: row.id })),
    interactions: access.filter(contact.interactions, interactionKey),
  };
}
