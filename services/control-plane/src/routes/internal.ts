import { handleGranolaWebhook, type GranolaWebhookResponse } from '../granola';
import { handleInternalCoreRead } from '../core-reads';
import { handleInternalCoreWrite, readCoreCall } from '../core-writes';
import { handleInternalChannelEvent, handleInternalKeepRelease, handleInternalPing } from '../internal';
import type { InternalChannelEventResponse, InternalKeepReleaseFetchResponse, InternalPingResponse } from '../contracts';
import { json } from '../http';
import { handleMeetingAgentContext, handleMeetingAgentCommit, handleMeetingAgentStatus } from '../meeting-agent-tools';
import type { MeetingAgentContext, MeetingAgentReceipt, MeetingAgentStatus } from '@starlings/contracts/meeting-agent';
import type { ManagedAgentBootstrapResponse } from '@starlings/contracts/managed-agent';
import { handleManagedAgentProvision } from '../managed-agent-provisioning';
import { signalsBillingEventSchema, signalsUsageSnapshotSchema, type SignalsFactResponse } from '@starlings/contracts/licenses';
import { applySignalsBillingEvent, applySignalsUsage, assertSignalsFactsHere } from '../licenses-d1';
import { defineRoute, type Route } from '../route-types';

/**
 * Service-to-service doors: no session, a signature over the body. Each
 * handler verifies it (it needs the raw body), is rate limited, and answers
 * 404 when the caller names no key or the door's secret is unset. See
 * docs/AGENTS_SURFACE.md.
 */
export const internalRoutes: readonly Route[] = [
  defineRoute({
    method: 'POST',
    path: '/api/internal/managed-agent/provision',
    gate: { kind: 'internal-hmac', reason: 'Ephemeral per-workspace operator bootstrap, purpose and path bound; no agent or human session' },
    handler: async ({ request, env }) => json(await handleManagedAgentProvision(request, env) satisfies ManagedAgentBootstrapResponse),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/internal/meeting-agent/context',
    gate: { kind: 'internal-hmac', reason: 'Managed agent key plus a persisted exact meeting grant; current human and agent access' },
    handler: async ({ request, env }) => json(await handleMeetingAgentContext(request, env) satisfies MeetingAgentContext),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/internal/meeting-agent/commit',
    gate: { kind: 'internal-hmac', reason: 'Managed agent key, current meeting grant and optimistic source/result revisions' },
    handler: async ({ request, env }) => json(await handleMeetingAgentCommit(request, env) satisfies MeetingAgentReceipt),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/internal/meeting-agent/status',
    gate: { kind: 'internal-hmac', reason: 'Managed agent key plus current read authority for this run; receipt recovery' },
    handler: async ({ request, env }) => json(await handleMeetingAgentStatus(request, env) satisfies MeetingAgentStatus),
  }),
  // The one inbound trust edge: Core's GitHub webhook and every agent write a
  // conversation through here. No session, HMAC only, rate limited, and 404
  // without a key id. See docs/AGENTS_SURFACE.md.
  defineRoute({
    method: 'POST',
    path: '/api/internal/channel-events',
    gate: { kind: 'internal-hmac', reason: 'HMAC with the caller\'s own inbound key, named by x-internal-key-id' },
    handler: async ({ request, env }) => json(await handleInternalChannelEvent(request, env) satisfies InternalChannelEventResponse),
  }),

  // An agent fetches the Keep release a member approved on its card
  //: its own key only, its own card only. Meet mints the Keep token
  // for the call; the agent never holds one.
  defineRoute({
    method: 'POST',
    path: '/api/internal/keep-release',
    gate: { kind: 'internal-hmac', reason: 'HMAC with the agent\'s own inbound key; the card must be its own approved request' },
    handler: async ({ request, env }) => json(await handleInternalKeepRelease(request, env) satisfies InternalKeepReleaseFetchResponse),
  }),

  // Core's own writers (public forms, webhooks, offer acceptance) write
  // organizations, contacts, leads and projects through here, so the Worker is
  // the one write path for the group. Core's key only.
  defineRoute({
    method: 'POST',
    path: '/api/internal/core-writes',
    gate: { kind: 'internal-hmac', reason: 'HMAC with Core\'s own inbound key; one CRM row per call, forwarded to the group\'s store' },
    handler: async ({ request, env }) => handleInternalCoreWrite(request, env),
  }),

  // Core's own flows read the same group here once it has moved to D1
  //: a row, a contact by address, the public project page.
  defineRoute({
    method: 'POST',
    path: '/api/internal/core-reads',
    gate: { kind: 'internal-hmac', reason: 'HMAC with Core\'s own inbound key; reads group 1 from D1 after the subjects flip' },
    handler: async ({ request, env }) => handleInternalCoreRead(request, env),
  }),

  // What Signals produces, on the licence with that `signals_org_id` (decided by
  // MZ, 2026-11-05). Core's two public routes verify the producer and forward here
  // once the commercial group moved; while Core holds it, these answer 409.
  defineRoute({
    method: 'POST',
    path: '/api/internal/signals-usage',
    gate: { kind: 'internal-hmac', reason: 'HMAC with Core\'s own inbound key; one usage snapshot on one licence' },
    handler: async ({ request, env }) => {
      const body = await readCoreCall(request, env, 'core-writes');
      assertSignalsFactsHere(env);
      const snapshot = signalsUsageSnapshotSchema.parse(body);
      return json(await applySignalsUsage(env, snapshot) satisfies SignalsFactResponse);
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/internal/signals-billing-events',
    gate: { kind: 'internal-hmac', reason: 'HMAC with Core\'s own inbound key; one billing fact on one licence' },
    handler: async ({ request, env }) => {
      const body = await readCoreCall(request, env, 'core-writes');
      assertSignalsFactsHere(env);
      const event = signalsBillingEventSchema.parse(body);
      return json(await applySignalsBillingEvent(env, event) satisfies SignalsFactResponse);
    },
  }),

  // The same locks, no write: Core's hourly canary proves the secret and the
  // route without leaving a line anywhere.
  defineRoute({
    method: 'POST',
    path: '/api/internal/ping',
    gate: { kind: 'internal-hmac', reason: 'HMAC with the caller\'s inbound key; writes nothing' },
    handler: async ({ request, env }) => json(await handleInternalPing(request, env) satisfies InternalPingResponse),
  }),

  // The second inbound door: Granola's note webhooks. Same four locks as the
  // one above, its own secret, and it writes to Core rather than to a
  // conversation. See docs/GRANOLA_BRIDGE.md.
  defineRoute({
    method: 'POST',
    path: '/api/internal/granola-webhook',
    gate: { kind: 'internal-hmac', reason: 'HMAC with Granola\'s webhook secret' },
    handler: async ({ request, env }) => json(await handleGranolaWebhook(request, env) satisfies GranolaWebhookResponse),
  }),
];
