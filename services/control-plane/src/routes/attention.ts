import { attentionListQuerySchema, attentionResolveInputSchema, type AttentionListResponse, type AttentionRequest, type AttentionResolveResponse } from '@starlings/contracts';
import { listAttentionForOwner, readAttentionForOwner, resolveAttentionForOwner } from '../attention-api';
import { workModelEnabled } from '../crm';
import { recordDecision } from '../crm-actions';
import { json, readBoundedJSON } from '../http';
import { defineRoute, type Route } from '../route-types';

export const attentionRoutes: readonly Route[] = [
  defineRoute({
    method: 'GET',
    path: '/api/attention',
    gate: { kind: 'capability', capability: 'conversations' },
    handler: async ({ env, owner, url }) => json({ requests: await listAttentionForOwner(env, owner,
      attentionListQuerySchema.parse(Object.fromEntries(url.searchParams))) } satisfies AttentionListResponse),
  }),
  defineRoute({
    method: 'GET',
    path: '/api/attention/:id',
    gate: { kind: 'capability', capability: 'conversations' },
    handler: async ({ env, owner, params }) => json(await readAttentionForOwner(env, owner, decodeURIComponent(params.id!)) satisfies AttentionRequest),
  }),
  defineRoute({
    method: 'POST',
    path: '/api/attention/:id/resolve',
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ env, owner, params, request, ctx }) => json(await resolveAttentionForOwner(env, owner, decodeURIComponent(params.id!),
      attentionResolveInputSchema.parse(await readBoundedJSON(request)),
      workModelEnabled(env) ? (body) => recordDecision(env, ctx, owner, body) : null, ctx) satisfies AttentionResolveResponse),
  }),
];
