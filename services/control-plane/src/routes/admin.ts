import { readWorkspaceBackgrounds, writeWorkspaceBackgrounds, uploadWorkspaceBackground, removeWorkspaceBackground } from '../workspace-backgrounds';
import { workspaceBackgroundUpdateSchema, type WorkspaceBackgroundAdminResponse } from '@starlings/contracts/workspace-backgrounds';
import {
  adminAgentActivity,
  adminOverview,
  listPersonDevices,
  revokeDevice,
  setPersonAccess,
  setPersonRole,
  setPersonVisibility,
} from '../admin';
import { recordAdminAction } from '../admin-audit';
import { inviteMembers, listInvitations, resendInvitation, revokeInvitation } from '../invitations';
import type { AdminInvitationActionResponse, AdminInvitationsResponse, AdminInviteResponse } from '@starlings/contracts/invitations';
import { setAgentFrozen } from '../agent-freezes';
import { discardShortMeetings, queueFallbackRegeneration, regenerateNotes, retitleMeetings } from '../artifacts';
import { eraseMeeting } from '../meeting-erasure';
import { restoreObject } from '../backups';
import { objectMoveStatus, runObjectMove } from '../object-moves';
import { listOrphanChannels, removeChannel, restoreChannel } from '../channel-removal';
import {
  type AdminOverview,
  type AdminPersonAccessResponse,
  type AdminPersonDevicesResponse,
  type AdminPersonRoleResponse,
  type AdminPersonVisibilityResponse,
  type ChannelRemoveResponse,
  type ChannelRestoreResponse,
  type DeadJobsResponse,
  type DeliveriesReplayResponse,
  type DeliveriesResponse,
  type DiagnosticsListResponse,
  type DiscardShortMeetingsResponse,
  type EraseMeetingResponse,
  type LedgerBackfillResponse,
  type ModelUsageResponse,
  type NotesOwedResponse,
  type NotesOwedRetryResponse,
  type OperationalErrorOverview,
  type OpsFailuresResponse,
  type OrphanChannelsResponse,
  type RegenerateFallbackNotesResponse,
  type RegenerateNotesResponse,
  type ReplayJobsResponse,
  type RestoreObjectResponse,
  type RetitleMeetingsResponse,
  channelRemovalSchema,
  modelUsageQuerySchema,
  orphanChannelsQuerySchema,
  notesOwedRetrySchema,
  operationalErrorOverviewQuerySchema,
  regenerateFallbackNotesSchema,
  regenerateNotesSchema,
  replayJobsSchema,
  restoreObjectSchema,
  objectMoveRequestSchema,
  type ObjectMoveResponse,
  type ObjectMoveStatus,
  workGroupMoveRequestSchema,
  type WorkGroupMoveResponse,
  type WorkGroupStatus,
} from '../contracts';
import { runWorkGroupMove, workGroupStatus } from '../work-group-moves';
import { readSubjectSettings, writeSubjectSettings } from '../subject-settings';
import { readCommercialSettings, writeCommercialSettings } from '../commercial-settings';
import { commercialSettingsWriteSchema, type CommercialSettingsResponse } from '@starlings/contracts/commercial-settings';
import { listWorkActivity } from '../work-activity';
import { workActivityQuerySchema, type WorkActivityResponse } from '@starlings/contracts/work-activity';
import { subjectSettingsWriteSchema, type SubjectSettingsResponse } from '@starlings/contracts/subject-settings';
import { listDueDeliveries, sweepDeliveries } from '../deliveries';
import { diagnosticPayload, listDiagnostics } from '../diagnostics';
import { json, readBoundedJSON } from '../http';
import { backfillLedgerFromRooms } from '../ledger';
import { AuthError } from '../errors';
import { modelUsageRows } from '../model-usage';
import { operationalErrorOverview } from '../operational-errors';
import { resetOwedNotes, stuckOwedNotes } from '../notes-owed';
import { coreLastAccepted, deadJobSummary, isImportJob, readReleaseFeed, recentFailures, replayDeadJobs } from '../ops';
import { log, parseQuery } from '../route-util';
import type { AdminAgentActivityResponse, AdminAgentFreezeResponse } from '@starlings/contracts';
import { approveEnrollment, denyEnrollment, listEnrollments, removeEnrolledAgent } from '../agent-enrollment';
import { adminAgentEnrollmentApproveSchema, type AdminAgentEnrollmentDecisionResponse, type AdminAgentEnrollmentsResponse, type AdminAgentRemoveResponse } from '@starlings/contracts/agent-enrollment';
import { PARAMS, defineRoute, type Param, type Route } from '../route-types';
import { bookingReadiness, importCoreBookingSettings } from '../booking-import';
import { applyPersonIdSeed, planPersonIdSeed } from '../person-id-seed';
import type { PersonIdSeedPlan, PersonIdSeedResponse } from '@starlings/contracts/person-ids';
import { readVisitorHomeSetting, writeVisitorHome } from '../visitor-home';
import { readBookingNdaSetting, writeBookingNda } from '../booking-nda';
import { readWorkModulesSetting, writeWorkModules } from '../work-modules';
import { readSetup, writeSetupChecklist } from '../setup';
import { type SetupResponse, setupSettingUpdateSchema } from '@starlings/contracts/setup';
import { readWorkspaceBrand, removeWorkspaceMark, uploadWorkspaceMark, writeWorkspaceBrand } from '../workspace-profile';
import {
  type WorkspaceBrandAdminResponse,
  type WorkspaceSuiteAdminResponse,
  workspaceBrandUpdateSchema,
  workspaceSuiteUpdateSchema,
} from '@starlings/contracts/workspace-profile';
import { readWorkspaceSuite, writeWorkspaceSuite } from '../workspace-suite';
import { workspaceDefaultsSchema, type WorkspaceDefaultsAdminResponse } from '@starlings/contracts/workspace-defaults';
import { readWorkspaceDefaults, writeWorkspaceDefaults } from '../workspace-defaults';
import { type VisitorHomeAdminResponse, visitorHomeUpdateSchema } from '@starlings/contracts/visitor-home';
import {
  type BookingImportResponse,
  type BookingNdaAdminResponse,
  type BookingReadinessResponse,
  bookingNdaUpdateSchema,
} from '@starlings/contracts/booking-settings';
import { type WorkModulesAdminResponse, workModulesUpdateSchema } from '@starlings/contracts/work-modules-setting';
import { readWorkspacePlan, writeKeptProject, writeWorkspacePlan } from '../workspace-plan';
import { type WorkspacePlanResponse, workspaceKeptProjectUpdateSchema, workspacePlanUpdateSchema } from '@starlings/contracts/workspace-plan';

/** An agent's address as `AGENT_ROSTER` writes it, `@` plain or encoded. */
const AGENT: Param = { re: '[A-Za-z0-9._+-]+(?:@|%40)[A-Za-z0-9.-]+', sample: 'vocab@example.com' };
/** An enrollment's user code, with or without its dash. */
const ENROLL_CODE: Param = { re: '[A-Za-z0-9-]{8,9}', sample: 'ABCD-EFGH' };

/**
 * Admin and operations routes (docs/ADMIN.md §11). Every route is `admin`
 * (MZ, 2026-10-18: Admin is for admins only); every write adds the
 * trusted-origin check, so changing something every member sees is not the
 * same act as looking at it.
 */
export const adminRoutes: readonly Route[] = [
  defineRoute({
    method: 'GET',
    path: '/api/admin/overview',
    gate: { kind: 'admin' },
    // The gate has proved admin standing (a root or bootstrap admin's row may say member).
    handler: async ({ env, owner }) => json(await adminOverview(env, { ...owner, role: 'admin' }) satisfies AdminOverview),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/admin/agent-activity',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await adminAgentActivity(env) satisfies AdminAgentActivityResponse),
  }),

  // Freeze and unfreeze a roster agent: no deploy, effective on
  // the agent's next call. An admin write, like revoking a person.
  defineRoute({
    method: 'POST',
    path: '/api/admin/agents/:id/freeze',
    params: { id: AGENT },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner, params }) => json(await setAgentFrozen(env, owner, params.id!, true) satisfies AdminAgentFreezeResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/agents/:id/unfreeze',
    params: { id: AGENT },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner, params }) => json(await setAgentFrozen(env, owner, params.id!, false) satisfies AdminAgentFreezeResponse),
  }),

  // Agent enrollment (docs/AGENTS_SURFACE.md §Enrollment): the requests
  // waiting for an admin, and the admin's answer. Approval is what puts an
  // agent in front of the whole team, so it is an admin write.
  defineRoute({
    method: 'GET',
    path: '/api/admin/agent-enrollments',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json({ enrollments: await listEnrollments(env) } satisfies AdminAgentEnrollmentsResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/agent-enrollments/:code/approve',
    params: { code: ENROLL_CODE },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = adminAgentEnrollmentApproveSchema.parse(await readBoundedJSON(request));
      return json({ enrollment: await approveEnrollment(env, owner, params.code!, body) } satisfies AdminAgentEnrollmentDecisionResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/agent-enrollments/:code/deny',
    params: { code: ENROLL_CODE },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner, params }) => json({ enrollment: await denyEnrollment(env, owner, params.code!) } satisfies AdminAgentEnrollmentDecisionResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/agents/:id/remove',
    params: { id: AGENT },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner, params }) => json(await removeEnrolledAgent(env, owner, params.id!) satisfies AdminAgentRemoveResponse),
  }),

  // The Envisioning booking switch (docs/CORE_FOLD_PLAN.md §Phase 3d): copy
  // the hosts' Core settings once, and check every host before BOOKING_STORE
  // flips. Neither flips anything.
  defineRoute({
    method: 'POST',
    path: '/api/admin/booking/import-core',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, url }) => json({
      hosts: await importCoreBookingSettings(env, url.searchParams.get('overwrite') === '1'),
    } satisfies BookingImportResponse),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/admin/booking/readiness',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await bookingReadiness(env) satisfies BookingReadinessResponse),
  }),

  // Core fold phase 1 (docs/CORE_FOLD_PLAN.md §Phase 1): give every
  // person on a Core workspace the id of their Core user. GET is the dry run
  // and writes nothing. POST is the real run: it takes back the dry run's
  // `plan` and a settlement for every mismatch, and refuses anything else.
  defineRoute({
    method: 'GET',
    path: '/api/admin/person-ids/seed',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await planPersonIdSeed(env) satisfies PersonIdSeedPlan),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/person-ids/seed',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await applyPersonIdSeed(env, owner, await readBoundedJSON(request)) satisfies PersonIdSeedResponse),
  }),

  // Reads and writes take `admin`; writes add the trusted-origin check.
  // Changing something every member sees is not the same act as looking at it
  // — see docs/ADMIN.md §11.
  // Invitations (docs/ONBOARDING.md §Invitations): who may become
  // a member is an admin's call, so the list is admin-only too. Every write
  // is on the admin trail.
  defineRoute({
    method: 'GET',
    path: '/api/admin/invitations',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await listInvitations(env) satisfies AdminInvitationsResponse),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/admin/invitations',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await inviteMembers(env, owner, await readBoundedJSON(request)) satisfies AdminInviteResponse),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/admin/invitations/resend',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await resendInvitation(env, owner, await readBoundedJSON(request)) satisfies AdminInvitationActionResponse),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/admin/invitations/revoke',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await revokeInvitation(env, owner, await readBoundedJSON(request)) satisfies AdminInvitationActionResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/people/visibility',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await setPersonVisibility(env, owner, await readBoundedJSON(request)) satisfies AdminPersonVisibilityResponse),
  }),

  // What a signed-out visitor sees at the root. Every visitor sees it, so it
  // is an admin write. The root's own read is public (`GET /api/visitor-home`)
  // and leaves out the chosen member's address; this one names it.
  defineRoute({
    method: 'GET',
    path: '/api/admin/visitor-home',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await readVisitorHomeSetting(env) satisfies VisitorHomeAdminResponse),
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/admin/visitor-home',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = visitorHomeUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeVisitorHome(env, owner, body) satisfies VisitorHomeAdminResponse);
    },
  }),

  // The NDA a guest can ask to meet under on a booking page: a Docs document
  // (booking-nda.ts). Every booking page offers it, so it is an admin write.
  defineRoute({
    method: 'GET',
    path: '/api/admin/booking-nda',
    gate: { kind: 'admin' },
    handler: async ({ env, owner }) => json(await readBookingNdaSetting(env, owner) satisfies BookingNdaAdminResponse),
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/admin/booking-nda',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = bookingNdaUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeBookingNda(env, owner, body) satisfies BookingNdaAdminResponse);
    },
  }),

  // Which work modules the workspace has on (docs/WORK_MODEL.md).
  // Every client hides what is off; the choice is an admin's.
  defineRoute({
    method: 'GET',
    path: '/api/admin/work-modules',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await readWorkModulesSetting(env) satisfies WorkModulesAdminResponse),
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/admin/work-modules',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = workModulesUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeWorkModules(env, owner, body) satisfies WorkModulesAdminResponse);
    },
  }),

  // The setup checklist, off or on for the whole workspace (docs/ONBOARDING.md).
  // Off, no client draws the card; the steps still answer at /api/setup.
  defineRoute({
    method: 'PUT',
    path: '/api/admin/setup',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = setupSettingUpdateSchema.parse(await readBoundedJSON(request));
      await writeSetupChecklist(env, owner, body.on);
      // The gate proved an admin; the answer is the admin's own checklist.
      return json(await readSetup(env, { sub: owner.sub, email: owner.email, role: 'admin' }) satisfies SetupResponse);
    },
  }),

  // The workspace's plan. Every member reads it: the clients
  // draw the limit prompt and the read-only project from it. A root admin
  // sets the plan until billing does; the handler checks root.
  defineRoute({
    method: 'GET',
    path: '/api/workspace/plan',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env }) => json(await readWorkspacePlan(env) satisfies WorkspacePlanResponse),
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/admin/plan',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = workspacePlanUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeWorkspacePlan(env, owner, body.plan) satisfies WorkspacePlanResponse);
    },
  }),

  // On Free, an admin picks the one writable project, once.
  defineRoute({
    method: 'PUT',
    path: '/api/admin/plan/kept-project',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = workspaceKeptProjectUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeKeptProject(env, owner, body.project_id) satisfies WorkspacePlanResponse);
    },
  }),

  // The workspace's name, accent and mark: every member and
  // visitor sees them, so changing them is an admin write.
  defineRoute({
    method: 'GET',
    path: '/api/admin/workspace',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await readWorkspaceBrand(env) satisfies WorkspaceBrandAdminResponse),
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/admin/workspace',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = workspaceBrandUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeWorkspaceBrand(env, owner, body) satisfies WorkspaceBrandAdminResponse);
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/admin/workspace/mark',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await uploadWorkspaceMark(request, env, owner) satisfies WorkspaceBrandAdminResponse),
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/admin/workspace/mark',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner }) => json(await removeWorkspaceMark(env, owner) satisfies WorkspaceBrandAdminResponse),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/admin/workspace/defaults',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await readWorkspaceDefaults(env) satisfies WorkspaceDefaultsAdminResponse),
  }),
  defineRoute({
    method: 'PUT',
    path: '/api/admin/workspace/defaults',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await writeWorkspaceDefaults(env, owner, workspaceDefaultsSchema.parse(await readBoundedJSON(request))) satisfies WorkspaceDefaultsAdminResponse),
  }),

  // Where the workspace's mail and calendar live: Google, Microsoft or other.
  defineRoute({
    method: 'GET',
    path: '/api/admin/workspace/suite',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await readWorkspaceSuite(env) satisfies WorkspaceSuiteAdminResponse),
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/admin/workspace/suite',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = workspaceSuiteUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeWorkspaceSuite(env, owner, body) satisfies WorkspaceSuiteAdminResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/admin/workspace/backgrounds',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await readWorkspaceBackgrounds(env) satisfies WorkspaceBackgroundAdminResponse),
  }),
  defineRoute({
    method: 'PUT',
    path: '/api/admin/workspace/backgrounds',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await writeWorkspaceBackgrounds(env, owner, workspaceBackgroundUpdateSchema.parse(await readBoundedJSON(request))) satisfies WorkspaceBackgroundAdminResponse),
  }),
  defineRoute({
    method: 'PUT',
    path: '/api/admin/workspace/backgrounds/image',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await uploadWorkspaceBackground(request, env, owner) satisfies WorkspaceBackgroundAdminResponse),
  }),
  defineRoute({
    method: 'DELETE',
    path: '/api/admin/workspace/backgrounds/image',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner }) => json(await removeWorkspaceBackground(env, owner) satisfies WorkspaceBackgroundAdminResponse),
  }),

  // One-shot, idempotent, and safe to run again: the ledger's day one is
  // otherwise the account's day one. Decision 9 in docs/ADMIN.md.
  defineRoute({
    method: 'POST',
    path: '/api/admin/backfill',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner }) => {
      const report = await backfillLedgerFromRooms(env);
      // The run is the record: `/admin/jobs` says when each job last ran, and
      // an idempotent job over the whole account is one you want to know the
      // answer for before running it again (docs/ADMIN.md §10).
      await recordAdminAction(env, owner, 'job.backfill', null,
        `${report.meetings} from ${report.rooms} ${report.rooms === 1 ? 'room' : 'rooms'}`);
      return json(report satisfies LedgerBackfillResponse);
    },
  }),

  // One-off after: meetings titled "**Summary**" get a title from
  // their summary; Docs and Core follow through the meeting-log sync.
  // One meeting's notes, written again with the engine configured now — the
  // way to compare against Granola's note on the same meeting.
  defineRoute({
    method: 'POST',
    path: '/api/admin/regenerate-notes',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env }) => {
      const body = regenerateNotesSchema.parse(await readBoundedJSON(request));
      return json(await regenerateNotes(env, body.room_slug, body.meeting_id) satisfies RegenerateNotesResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/admin/diagnostics',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await listDiagnostics(env) satisfies DiagnosticsListResponse),
  }),

  // The grouped error overview, read by an admin's own Claude
  // through `starlings://operational-errors/{window}`. Admin only, and never an
  // agent: an agent acting for an admin borrows read authority over the
  // company, not over its operations (docs/MCP.md §Operational errors).
  defineRoute({
    method: 'GET',
    path: '/api/admin/operational-errors',
    gate: { kind: 'admin' },
    handler: async ({ env, owner, url }) => {
      if ((owner as { agentSub?: string }).agentSub) {
        throw new AuthError('An agent cannot read the error overview. The admin reads it in their own Claude.', 403, 'capability_denied');
      }
      const query = parseQuery(operationalErrorOverviewQuerySchema, url);
      return json(await operationalErrorOverview(env, query) satisfies OperationalErrorOverview);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/admin/diagnostics/:id',
    params: { id: PARAMS.uuid },
    gate: { kind: 'admin' },
    handler: async ({ env, params }) => {
      return new Response(await diagnosticPayload(env, params.id!), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    },
  }),

  // Every meeting the fallback model wrote since a date, queued to be
  // written again: the way back after Claude was unavailable.
  defineRoute({
    method: 'POST',
    path: '/api/admin/regenerate-fallback-notes',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = regenerateFallbackNotesSchema.parse(await readBoundedJSON(request));
      const report = await queueFallbackRegeneration(env, body.since_ms);
      await recordAdminAction(env, owner, 'job.regenerate-fallback-notes', null, `${report.queued} queued`);
      return json(report satisfies RegenerateFallbackNotesResponse);
    },
  }),

  // The way back from the dead queue: a job that exhausted its
  // retries is kept there, and this sends its body on the live queue again.
  // Every job is idempotent, so a replay of one that did land is harmless.
  // `{ dead: true }` replays every row the dead-letter consumer kept in D1
  // instead, and deletes each row once it is sent.
  defineRoute({
    method: 'POST',
    path: '/api/admin/replay-jobs',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = replayJobsSchema.parse(await readBoundedJSON(request));
      if ('dead' in body) {
        const queued = await replayDeadJobs(env);
        log('info', 'dead_job.replayed', { count: queued });
        await recordAdminAction(env, owner, 'job.replay-dead-jobs', null, `${queued} queued`);
        return json({ queued } satisfies ReplayJobsResponse);
      }
      const { jobs } = body;
      // Imports go back on their own queue.
      const imports = jobs.filter((job) => isImportJob(job));
      const rest = jobs.filter((job) => !isImportJob(job));
      if (imports.length > 0) await env.IMPORT_JOBS.sendBatch(imports.map((job) => ({ body: job })));
      if (rest.length > 0) await env.ARTIFACT_JOBS.sendBatch(rest.map((job) => ({ body: job })));
      log('info', 'artifact.replayed', { count: jobs.length });
      return json({ queued: jobs.length } satisfies ReplayJobsResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/admin/dead-jobs',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await deadJobSummary(env) satisfies DeadJobsResponse),
  }),

  // What the Worker counted about itself, for Admin › Operations.
  defineRoute({
    method: 'GET',
    path: '/api/admin/ops-failures',
    gate: { kind: 'admin' },
    handler: async ({ env }) => {
      return json({
        failures: await recentFailures(env),
        core_last_accepted_at: await coreLastAccepted(env),
        release: await readReleaseFeed().then(
          (release) => ({ version: release.version, published_at: release.published_at }),
          () => null,
        ),
      } satisfies OpsFailuresResponse);
    },
  }),

  // Restore one room or thread from a day's snapshot. An org
  // admin act, written to the audit trail with what it replaced.
  defineRoute({
    method: 'POST',
    path: '/api/admin/restore-object',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = restoreObjectSchema.parse(await readBoundedJSON(request));
      const tables = await restoreObject(env, body.kind, body.id, body.date);
      const rows = Object.values(tables).reduce((sum, count) => sum + count, 0);
      await recordAdminAction(env, owner, 'object.restore', `${body.kind}:${body.id}`, `${body.date}, ${rows} rows`);
      log('info', 'object.restored', { kind: body.kind, date: body.date, rows });
      return json({ kind: body.kind, id: body.id, date: body.date, tables } satisfies RestoreObjectResponse);
    },
  }),

  // Rooms and Quick Notes into the EU jurisdiction, one object at a time
  // (docs/ROOM_JURISDICTION_PLAN.md). Each act is in the audit trail.
  defineRoute({
    method: 'GET',
    path: '/api/admin/object-moves',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await objectMoveStatus(env) satisfies ObjectMoveStatus),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/admin/object-moves',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = objectMoveRequestSchema.parse(await readBoundedJSON(request));
      const results = await runObjectMove(env, body.action, body.namespace, body.name);
      for (const result of results) {
        if (result.outcome === 'skipped') continue;
        const detail = [result.outcome, result.rows === undefined ? null : `${result.rows} rows`, result.reason ?? null].filter(Boolean).join(', ');
        await recordAdminAction(env, owner, `object.${body.action}`, `${result.namespace}:${result.name}`, detail);
      }
      log('info', 'object.moves', {
        action: body.action,
        namespace: body.namespace,
        done: results.filter((result) => result.outcome !== 'skipped' && result.outcome !== 'failed').length,
        failed: results.filter((result) => result.outcome === 'failed').length,
      });
      return json({ results } satisfies ObjectMoveResponse);
    },
  }),

  // Table groups from Core to D1: freeze, copy, verify, diff (,
  // docs/CORE_FOLD_PLAN.md §The group move). None of them flips a store; a
  // deploy of WORK_STORE_<GROUP> does. Each act is in the audit trail.
  defineRoute({
    method: 'GET',
    path: '/api/admin/work-groups',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await workGroupStatus(env) satisfies WorkGroupStatus),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/admin/work-groups',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = workGroupMoveRequestSchema.parse(await readBoundedJSON(request));
      const result = await runWorkGroupMove(env, body);
      const detail = body.action === 'copy'
        ? `${Object.entries(result.copied ?? {}).map(([table, rows]) => `${table} ${rows}`).join(', ')}${result.next ? `, resume at ${result.next.table} ${result.next.offset}` : ''}`
        : body.action === 'verify'
          ? `${result.ok ? 'match' : 'mismatch'}: ${(result.tables ?? []).map((table) => `${table.table} ${table.core_rows}/${table.d1_rows}${table.match ? '' : ' differs'}`).join(', ')}`
          : body.action === 'diff'
            ? (result.diff ?? []).map((table) => `${table.table} +${table.added_or_changed.length} -${table.removed.length}`).join(', ')
            : body.action === 'repoint_merges'
              ? `${result.repoint?.merges ?? 0} merges, ${result.repoint?.moved ?? 0} rows, ${result.repoint?.failed.length ?? 0} refused`
              : '';
      await recordAdminAction(env, owner, `work_group.${body.action}`, body.table ? `${body.group}:${body.table}` : body.group, detail);
      log('info', 'work_group.move', { action: body.action, group: body.group, ok: result.ok ?? null });
      return json(result satisfies WorkGroupMoveResponse);
    },
  }),

  // The settings tables of the subjects group: characteristics
  // and contact sources. Editable once the group answers from D1; each
  // change is in the audit trail.
  defineRoute({
    method: 'GET',
    path: '/api/admin/records',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await readSubjectSettings(env) satisfies SubjectSettingsResponse),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/admin/records',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = subjectSettingsWriteSchema.parse(await readBoundedJSON(request));
      const result = await writeSubjectSettings(env, body);
      const { op, ...detail } = body;
      await recordAdminAction(env, owner, `records.${op}`, null, JSON.stringify(detail));
      return json(result satisfies SubjectSettingsResponse);
    },
  }),

  // The commercial group's settings. Editable once the group answers from D1.
  defineRoute({
    method: 'GET',
    path: '/api/admin/records/commercial',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await readCommercialSettings(env) satisfies CommercialSettingsResponse),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/admin/records/commercial',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = commercialSettingsWriteSchema.parse(await readBoundedJSON(request));
      const result = await writeCommercialSettings(env, owner.email, body);
      await recordAdminAction(env, owner, `records.commercial.${body.op}`, null, JSON.stringify({ table: body.table, id: 'id' in body ? body.id ?? null : null }));
      return json(result satisfies CommercialSettingsResponse);
    },
  }),

  // The activity trail of the work model on D1: every write the
  // Worker sent to D1, with Core's feed's filters. Admins only (MZ, 2026-10-22).
  defineRoute({
    method: 'GET',
    path: '/api/admin/activity',
    gate: { kind: 'admin' },
    handler: async ({ env, url }) => json(await listWorkActivity(env, parseQuery(workActivityQuerySchema, url)) satisfies WorkActivityResponse),
  }),

  // Channels whose subject Core no longer has, and the way to hide one and
  // bring it back. The check is by id and Core's own "not found";
  // a Core error refuses rather than reads as gone. Hiding leaves the
  // messages alone.
  defineRoute({
    method: 'GET',
    path: '/api/admin/channels/orphans',
    gate: { kind: 'admin' },
    handler: async ({ env, url }) => {
      const { offset } = parseQuery(orphanChannelsQuerySchema, url);
      return json(await listOrphanChannels(env, offset) satisfies OrphanChannelsResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/channels/remove',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = channelRemovalSchema.parse(await readBoundedJSON(request));
      return json(await removeChannel(env, owner, body.thread_id) satisfies ChannelRemoveResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/channels/restore',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = channelRemovalSchema.parse(await readBoundedJSON(request));
      return json(await restoreChannel(env, owner, body.thread_id) satisfies ChannelRestoreResponse);
    },
  }),

  // Model calls and tokens per day. Counts only; no text.
  defineRoute({
    method: 'GET',
    path: '/api/admin/model-usage',
    gate: { kind: 'admin' },
    handler: async ({ env, url }) => {
      const { days } = parseQuery(modelUsageQuerySchema, url);
      return json({ rows: await modelUsageRows(env, days) } satisfies ModelUsageResponse);
    },
  }),

  // Meetings the owed-notes sweep gave up on, and the way to try again
  //. Ids and times; no text.
  defineRoute({
    method: 'GET',
    path: '/api/admin/notes-owed',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json({ stuck: await stuckOwedNotes(env) } satisfies NotesOwedResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/notes-owed/retry',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = notesOwedRetrySchema.parse(await readBoundedJSON(request));
      const reset = await resetOwedNotes(env, body.room_slug, body.meeting_id);
      if (reset) await recordAdminAction(env, owner, 'job.retry-notes-owed', `${body.room_slug}/${body.meeting_id}`, null);
      return json({ reset } satisfies NotesOwedRetryResponse);
    },
  }),

  // What is still owed downstream, and one way to send it all again
  //. Revisions, counts and one error message per row; no text.
  defineRoute({
    method: 'GET',
    path: '/api/admin/deliveries',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json({ due: await listDueDeliveries(env) } satisfies DeliveriesResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/deliveries/replay',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env }) => {
      const { requeued } = await sweepDeliveries(env, Date.now(), 0);
      return json({ requeued } satisfies DeliveriesReplayResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/retitle-meetings',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner }) => {
      const report = await retitleMeetings(env);
      await recordAdminAction(env, owner, 'job.retitle-meetings', null,
        `${report.retitled.length} of ${report.considered} retitled`);
      return json(report satisfies RetitleMeetingsResponse);
    },
  }),

  // One-off behind MIN_MEETING_MILLISECONDS: meetings under a minute that
  // predate the rule are discarded the way the artifact job now does it.
  defineRoute({
    method: 'POST',
    path: '/api/admin/discard-short-meetings',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner }) => {
      const report = await discardShortMeetings(env);
      await recordAdminAction(env, owner, 'job.discard-short-meetings', null,
        `${report.discarded.length} discarded`);
      return json(report satisfies DiscardShortMeetingsResponse);
    },
  }),

  // Erase one ended meeting from every copy Starlings reaches, for a data
  // request (docs/DATA_REQUESTS.md). Sending it again finishes a
  // failed step; the receipt names each copy.
  defineRoute({
    method: 'POST',
    path: '/api/admin/erase-meeting',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await eraseMeeting(env, owner, await readBoundedJSON(request)) satisfies EraseMeetingResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/people/access',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await setPersonAccess(env, owner, await readBoundedJSON(request)) satisfies AdminPersonAccessResponse),
  }),

  // One person's signed-in Macs and phones, and the way to sign one out
  // without cutting the person off. The device write is the one admin write
  // allowed on yourself and on a root admin: a lost phone is not a lockout.
  defineRoute({
    method: 'GET',
    path: '/api/admin/people/devices',
    gate: { kind: 'admin' },
    handler: async ({ env, url }) => json(await listPersonDevices(env, url.searchParams.get('email')) satisfies AdminPersonDevicesResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/devices/revoke',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await revokeDevice(env, owner, await readBoundedJSON(request)) satisfies AdminPersonDevicesResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/admin/people/role',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => json(await setPersonRole(env, owner, await readBoundedJSON(request)) satisfies AdminPersonRoleResponse),
  }),
];
