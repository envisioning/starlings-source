import { recordAdminAction } from '../admin-audit';
import { beeperConnectorStatus } from '../beeper-connector';
import {
  type ConnectorReverseResponse,
  type ConnectorsResponse,
  type GithubConnectorResponse,
  type GithubMappingResponse,
  type GoogleGrantResponse,
  type GranolaBackfillResponse,
  type GranolaCategoryResponse,
  type GranolaImportResponse,
  type GranolaLedgerResponse,
  type GranolaNotesResponse,
  type GranolaProposalsResponse,
  type GranolaRefreshResponse,
  type GranolaSuggestResponse,
  type SlackConnectorResponse,
  type SlackMappingResponse,
  type SyncQueuedResponse,
  githubMappingSchema,
  googleGrantStartQuerySchema,
  granolaImportSchema,
  meetingCategorySchema,
  slackMappingSchema,
} from '../contracts';
import {
  githubConnectorList,
  githubConnectorStatus,
  reverseGithubRepo,
  saveGithubMapping,
  syncGithubRepoNow,
} from '../github-connector';
import { completeGithubConnect, disconnectGithub, startGithubConnect } from '../github-connect';
import { completeCentralGoogleGrant, completeGoogleGrant, disconnectGoogleGrant, googleGrantStatus, startGoogleGrant } from '../google-grants';
import {
  connectorsStatus,
  fileGranolaNote,
  granolaLedgerView,
  granolaNotesPage,
  granolaProposals,
  importGranolaNotes,
  queueGranolaSuggestions,
  refreshGranolaIndex,
  startGranolaBackfill,
} from '../granola';
import { json, readBoundedJSON } from '../http';
import { parseQuery } from '../route-util';
import {
  reverseSlackChannel,
  saveSlackMapping,
  slackConnectorList,
  slackConnectorStatus,
  syncSlackChannelNow,
} from '../slack-connector';
import { postSubjectEvent, subjectOfCategory } from '../threads';
import { defineRoute, type Param, type Route } from '../route-types';

const SLACK_CHANNEL: Param = { re: '[A-Z0-9]{1,32}', sample: 'C0123' };
const GITHUB_NAME: Param = { re: '[A-Za-z0-9_.-]{1,100}', sample: 'envisioning' };
const GRANOLA_NOTE: Param = { re: '[A-Za-z0-9_-]{1,128}', sample: 'not_1' };

/** Every outside source and where it stands, for `/admin/connectors`. Health only, no content: every member may look. */
async function connectorsOverview(env: Env): Promise<Response> {
  const status = await connectorsStatus(env);
  status.connectors.push(await githubConnectorStatus(env));
  status.connectors.push(await slackConnectorStatus(env));
  status.connectors.push(await beeperConnectorStatus(env));
  return json(status satisfies ConnectorsResponse);
}

export const connectorsRoutes: readonly Route[] = [
  // Starts the historical import. An operator action with a real cost in
  // Granola's rate limit, not something the webhook secret should be able
  // to trigger.
  defineRoute({
    method: 'POST',
    path: '/api/granola/backfill',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = await readBoundedJSON(request) as { months?: unknown };
      const months = typeof body?.months === 'number' && Number.isFinite(body.months)
        ? Math.trunc(body.months)
        : 24;
      const started = await startGranolaBackfill(env, months);
      await recordAdminAction(env, owner, 'granola.backfill', null, `${months} months`);
      return json(started satisfies GranolaBackfillResponse);
    },
  }),

  // The Google connector grant (docs/CONNECTORS.md): a member's
  // own read access to their Gmail and Drive. Per member, never admin: the
  // mailbox is theirs, and so is the decision to connect it.
  defineRoute({
    method: 'GET',
    path: '/api/connectors/google',
    gate: { kind: 'capability', capability: 'googleGrant' },
    handler: async ({ env, owner }) => json(await googleGrantStatus(env, owner) satisfies GoogleGrantResponse),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/connectors/google/connect/start',
    gate: { kind: 'capability', capability: 'googleGrant' },
    handler: async ({ env, url, owner, request }) => startGoogleGrant(env, owner, parseQuery(googleGrantStartQuerySchema, url), request),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/connectors/google/connect/callback',
    gate: { kind: 'capability', capability: 'googleGrant' },
    handler: async ({ request, env, owner }) => completeGoogleGrant(request, env, owner),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/connectors/google/connect/complete',
    gate: { kind: 'capability', capability: 'googleGrant' },
    handler: async ({ request, env, owner }) => completeCentralGoogleGrant(request, env, owner),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/connectors/google/disconnect',
    gate: { kind: 'capability', capability: 'googleGrant', origin: 'trusted' },
    handler: async ({ env, owner }) => json(await disconnectGoogleGrant(env, owner) satisfies GoogleGrantResponse),
  }),

  // The Slack import (docs/SLACK_IMPORT.md): the channel list with
  // each mapping, the mapping write, a sync now, and the reverse. Admin
  // throughout; the token is ours, the channels are the company's.
  defineRoute({
    method: 'GET',
    path: '/api/connectors/slack',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await slackConnectorList(env) satisfies SlackConnectorResponse),
  }),

  // The GitHub connector (docs/GITHUB_CONNECTOR.md): the
  // repository list with each mapping, the mapping write, a sync now, and
  // the reverse. Admin throughout; the App is ours, the repositories are
  // the company's.
  defineRoute({
    method: 'GET',
    path: '/api/connectors/github',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await githubConnectorList(env) satisfies GithubConnectorResponse),
  }),

  // Connect GitHub through the Starlings App's token broker (github-connect.ts):
  // the start sends the browser to the App's install page, the auth host
  // proves the person can reach the installation, and the complete redeems
  // the code with this browser's cookie. Disconnect forgets the installation.
  defineRoute({
    method: 'GET',
    path: '/api/connectors/github/connect/start',
    gate: { kind: 'admin' },
    handler: async ({ request, env }) => startGithubConnect(request, env),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/connectors/github/connect/complete',
    gate: { kind: 'admin' },
    handler: async ({ request, env, owner }) => {
      const response = await completeGithubConnect(request, env);
      await recordAdminAction(env, owner, 'github.connect', 'github', 'connected');
      return response;
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/connectors/github/disconnect',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner }) => {
      const result = await disconnectGithub(env);
      await recordAdminAction(env, owner, 'github.disconnect', 'github', `${result.removed} removed`);
      return json(result satisfies ConnectorReverseResponse);
    },
  }),

  // The import list: Granola's history beside Core's ledger. Admin
  // only, like the backfill — the key is one person's, and it reaches notes
  // that are theirs alone or were shared only with them.
  defineRoute({
    method: 'GET',
    path: '/api/granola/notes',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await granolaNotesPage(env) satisfies GranolaNotesResponse),
  }),

  // Read what Granola has that the index does not: one page when nothing is new.
  defineRoute({
    method: 'POST',
    path: '/api/granola/refresh',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env }) => json(await refreshGranolaIndex(env) satisfies GranolaRefreshResponse),
  }),

  // Core's side alone, for the list's import poll.
  defineRoute({
    method: 'GET',
    path: '/api/granola/ledger',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await granolaLedgerView(env) satisfies GranolaLedgerResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/granola/import',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = granolaImportSchema.parse(await readBoundedJSON(request));
      const queued = await importGranolaNotes(env, body.note_ids);
      await recordAdminAction(env, owner, 'granola.import', null, `${queued} queued`);
      return json({ queued } satisfies GranolaImportResponse);
    },
  }),

  // The leads the unfiled meetings suggest but Core does not hold.
  // A read: one proposal per company, confirmed by a person or ignored.
  defineRoute({
    method: 'GET',
    path: '/api/granola/proposals',
    gate: { kind: 'admin' },
    handler: async ({ env }) => json(await granolaProposals(env) satisfies GranolaProposalsResponse),
  }),

  // Suggestions for the backlog that imported without one (no credits, an
  // outage). Admin action; nothing here writes Core.
  defineRoute({
    method: 'POST',
    path: '/api/granola/suggest',
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env }) => json(await queueGranolaSuggestions(env) satisfies GranolaSuggestResponse),
  }),

  // Every connector route is an admin act, like `/api/admin/*`: the Granola
  // key is one person's and reaches their private notes, and a mapping or a
  // reverse changes what the whole company sees. Every read and write takes the
  // admin gate, and a write that changes company data leaves an `admin_audit`
  // row. See
  // docs/ADMIN.md §11.
  //
  // Every outside source and where it stands, for `/admin/connectors`. The
  // bare `/api/connectors` is the same answer at its old address.
  defineRoute({
    method: 'GET',
    path: '/api/admin/connectors',
    gate: { kind: 'admin' },
    handler: ({ env }) => connectorsOverview(env),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/connectors',
    gate: { kind: 'admin' },
    handler: ({ env }) => connectorsOverview(env),
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/connectors/slack/:channelId',
    params: { channelId: SLACK_CHANNEL },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const channelId = params.channelId!;
      const body = slackMappingSchema.parse(await readBoundedJSON(request));
      const row = await saveSlackMapping(env, channelId, body, owner.email);
      await recordAdminAction(env, owner, 'slack.map', channelId, body.subject_kind ?? 'skip');
      return json({ row } satisfies SlackMappingResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/connectors/slack/:channelId/sync',
    params: { channelId: SLACK_CHANNEL },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, params }) => {
      await syncSlackChannelNow(env, params.channelId!);
      return json({ queued: 1 } satisfies SyncQueuedResponse);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/connectors/slack/:channelId/items',
    params: { channelId: SLACK_CHANNEL },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      const channelId = params.channelId!;
      const reversed = await reverseSlackChannel(env, channelId);
      await recordAdminAction(env, owner, 'slack.reverse', channelId, `${reversed.removed} removed`);
      return json(reversed satisfies ConnectorReverseResponse);
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/connectors/github/:repoOwner/:repoName',
    params: { repoOwner: GITHUB_NAME, repoName: { re: GITHUB_NAME.re, sample: 'meet' } },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const { repoOwner, repoName } = params;
      const body = githubMappingSchema.parse(await readBoundedJSON(request));
      const row = await saveGithubMapping(env, repoOwner!, repoName!, body, owner.email);
      await recordAdminAction(env, owner, 'github.map', `${repoOwner}/${repoName}`, body.subject_kind ?? 'skip');
      return json({ row } satisfies GithubMappingResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/connectors/github/:repoOwner/:repoName/sync',
    params: { repoOwner: GITHUB_NAME, repoName: { re: GITHUB_NAME.re, sample: 'meet' } },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, params }) => {
      await syncGithubRepoNow(env, params.repoOwner!, params.repoName!);
      return json({ queued: 1 } satisfies SyncQueuedResponse);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/connectors/github/:repoOwner/:repoName/items',
    params: { repoOwner: GITHUB_NAME, repoName: { re: GITHUB_NAME.re, sample: 'meet' } },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      const { repoOwner, repoName } = params;
      const reversed = await reverseGithubRepo(env, repoOwner!, repoName!);
      await recordAdminAction(env, owner, 'github.reverse', `${repoOwner}/${repoName}`, `${reversed.removed} removed`);
      return json(reversed satisfies ConnectorReverseResponse);
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/granola/notes/:noteId/category',
    params: { noteId: GRANOLA_NOTE },
    gate: { kind: 'admin', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const noteId = params.noteId!;
      const body = meetingCategorySchema.parse(await readBoundedJSON(request));
      const category = await fileGranolaNote(env, noteId, {
        meetingKind: body.meeting_kind,
        leadId: body.meeting_kind === 'lead' ? body.lead_id ?? null : null,
        projectId: body.meeting_kind === 'project' ? body.project_id ?? null : null,
        eventId: body.meeting_kind === 'event' ? body.event_id ?? null : null,
        partnerOrganizationId: body.meeting_kind === 'partner' ? body.partner_organization_id ?? null : null,
        categorizedBy: owner.email,
      });
      await recordAdminAction(env, owner, 'granola.file', noteId, category.meeting_kind);
      // Say so in the subject's channel, as filing a Meet meeting does.
      const filedUnder = subjectOfCategory({
        meetingKind: category.meeting_kind,
        leadId: category.lead_id,
        projectId: category.project_id,
        partnerOrganizationId: category.partner_organization_id ?? null,
      });
      if (filedUnder) {
        ctx.waitUntil(postSubjectEvent(
          env,
          filedUnder,
          `${owner.name || owner.email} filed a meeting here`,
          [],
          { actor: { sub: owner.sub, email: owner.email } },
        ));
      }
      return json(category satisfies GranolaCategoryResponse);
    },
  }),
];
