import { z } from 'zod';
import { mcpCallEntrySchema } from './mcp';

export const adminPersonRoleValueSchema = z.enum(['member', 'admin']);
export type AdminPersonRole = z.infer<typeof adminPersonRoleValueSchema>;

export const adminThresholdBandSchema = z.enum(['green', 'amber', 'red']);
export type ThresholdBand = z.infer<typeof adminThresholdBandSchema>;

export const adminThresholdSchema = z.object({
  id: z.string(),
  label: z.string(),
  used: z.number(),
  limit: z.number(),
  unit: z.string(),
  source: z.string(),
  band: adminThresholdBandSchema,
  projected: z.number().optional(),
});
export type AdminThreshold = z.infer<typeof adminThresholdSchema>;

export const adminDownstreamUsageSchema = z.object({
  received_bytes: z.number(),
  reporting_sessions: z.number().int().nonnegative(),
  last_reported_at: z.number().nullable(),
});
export type AdminDownstreamUsage = z.infer<typeof adminDownstreamUsageSchema>;

export const adminPersonSchema = z.object({
  email: z.string(),
  name: z.string().nullable(),
  kind: z.enum(['human', 'agent']),
  hidden: z.boolean(),
  role: adminPersonRoleValueSchema,
  root: z.boolean(),
  retired: z.boolean(),
  revoked: z.boolean(),
  devices: z.number().int(),
  last_seen_at: z.number(),
  room_slug: z.string().nullable(),
  calendar_connected: z.boolean(),
  last_client: z.string().nullable(),
  meetings_hosted: z.number().int(),
});
export type AdminPerson = z.infer<typeof adminPersonSchema>;

export const adminMeetingSchema = z.object({
  meeting_id: z.string(),
  room_slug: z.string(),
  host_email: z.string(),
  title: z.string().nullable(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  duration_ms: z.number().nullable(),
  participant_count: z.number().int(),
  guest_count: z.number().int(),
  guest_domains: z.array(z.string()),
  was_booked: z.boolean(),
  meeting_kind: z.string().nullable(),
  worst_quality: z.string().nullable(),
  summary_generated: z.boolean(),
  crm_synced: z.boolean(),
});
export type AdminMeeting = z.infer<typeof adminMeetingSchema>;

export const adminCrmSyncStateSchema = z.enum(['on', 'off', 'not_configured']);
export type CrmSyncState = z.infer<typeof adminCrmSyncStateSchema>;

export const adminConfigurationSchema = z.object({
  rooms: z.array(z.object({ slug: z.string(), owner_email: z.string() })),
  livekit_minutes_limit: z.number(),
  concurrent_participant_cap: z.number(),
  crm_sync: adminCrmSyncStateSchema,
  notes: z.object({
    engine: z.enum(['claude', 'workers-ai', 'off']),
    model: z.string(),
  }),
  identity_domains: z.array(z.string()),
  environment: z.string(),
  /** Features that need a key; false says this workspace has them off. */
  features: z.object({
    bot_check: z.boolean(),
    bug_reports: z.boolean(),
    github_connector: z.boolean(),
  }),
});
export type AdminConfiguration = z.infer<typeof adminConfigurationSchema>;

export const adminAuditEntrySchema = z.object({
  ts: z.number(),
  actor_email: z.string(),
  action: z.string(),
  subject: z.string().nullable(),
  detail: z.string().nullable(),
});
export type AdminAuditEntry = z.infer<typeof adminAuditEntrySchema>;

/** Facts Meet observed at its agent hand-off and inbound-message boundaries. */
export const adminAgentActivityKindSchema = z.enum([
  'handoff',
  'accepted',
  'rejected',
  'delivery_failed',
  'reply',
  'watchdog_reset',
  'watchdog_reset_failed',
]);
export type AdminAgentActivityKind = z.infer<typeof adminAgentActivityKindSchema>;

export const adminAgentActivitySummarySchema = z.object({
  agent_email: z.string().email(),
  agent_name: z.string().nullable(),
  endpoint_configured: z.boolean(),
  /** `enrolled` joined through enrollment and can be removed in Admin; `config` comes from the old roster var. Null for a retired agent. */
  source: z.enum(['config', 'enrolled']).nullable(),
  /** Public origin only; endpoint paths and query strings are not exposed. */
  endpoint_origin: z.string().url().nullable(),
  handoffs: z.number().int(),
  accepted: z.number().int(),
  rejected: z.number().int(),
  delivery_failed: z.number().int(),
  replies: z.number().int(),
  watchdog_resets: z.number().int(),
  watchdog_reset_failures: z.number().int(),
  last_activity_at: z.number().nullable(),
  /**
   * An admin froze it: no hand-off goes to it, and its `/mcp`
   * door and inbound messages are refused. Null when it is running.
   */
  frozen_at: z.number().nullable(),
  frozen_by_email: z.string().nullable(),
});
export type AdminAgentActivitySummary = z.infer<typeof adminAgentActivitySummarySchema>;

export const adminAgentActivityEventSchema = z.object({
  agent_email: z.string().email(),
  agent_name: z.string().nullable(),
  kind: adminAgentActivityKindSchema,
  occurred_at: z.number(),
  /** Time to the runtime's HTTP response; this is not time to finish a run. */
  duration_ms: z.number().int().nonnegative().nullable(),
  response_status: z.number().int().nullable(),
});
export type AdminAgentActivityEvent = z.infer<typeof adminAgentActivityEventSchema>;

export const adminAgentActivityResponseSchema = z.object({
  generated_at: z.number(),
  window_days: z.literal(30),
  /** Activity the Meet Worker observed. Runtime-internal steps are not included. */
  source: z.literal('meet-observed'),
  totals: z.object({
    handoffs: z.number().int(),
    accepted: z.number().int(),
    rejected: z.number().int(),
    delivery_failed: z.number().int(),
    replies: z.number().int(),
    watchdog_resets: z.number().int(),
    watchdog_reset_failures: z.number().int(),
  }),
  agents: z.array(adminAgentActivitySummarySchema),
  events: z.array(adminAgentActivityEventSchema),
  events_truncated: z.boolean(),
});
export type AdminAgentActivityResponse = z.infer<typeof adminAgentActivityResponseSchema>;

/** `POST /api/admin/agents/:id/freeze` and `/unfreeze`: the agent's state after the write. */
export const adminAgentFreezeResponseSchema = z.object({
  agent_email: z.string().email(),
  frozen_at: z.number().nullable(),
  frozen_by_email: z.string().nullable(),
});
export type AdminAgentFreezeResponse = z.infer<typeof adminAgentFreezeResponseSchema>;

export const adminOverviewSchema = z.object({
  generated_at: z.number(),
  degraded: z.array(z.string()),
  meetings_source: z.enum(['ledger', 'rooms']),
  now: z.object({
    rooms_in_session: z.number(),
    participants_connected: z.number(),
    waiting: z.number(),
    rooms: z.array(z.object({
      slug: z.string(),
      host_email: z.string(),
      in_session: z.boolean(),
      participants: z.number(),
      waiting: z.number(),
    })),
  }),
  this_month: z.object({
    participant_minutes: z.number(),
    participant_minutes_limit: z.number(),
    projected_minutes: z.number(),
    meetings: z.number(),
    unique_hosts: z.number(),
    unique_guests: z.number(),
    average_duration_ms: z.number(),
    prior_meetings: z.number(),
    prior_minutes: z.number(),
    sparkline: z.array(z.object({ day: z.string(), meetings: z.number(), minutes: z.number() })),
  }),
  downstream_usage: adminDownstreamUsageSchema.nullable(),
  thresholds: z.array(adminThresholdSchema),
  people: z.array(adminPersonSchema),
  agents: z.array(adminPersonSchema),
  retired_agents: z.number(),
  meetings: z.array(adminMeetingSchema),
  funnel: z.object({
    knocks: z.number(),
    admitted: z.number(),
    rejected: z.number(),
    joined: z.number(),
    abandon_rate: z.number(),
    by_client: z.record(z.string(), z.number()),
    by_country: z.record(z.string(), z.number()),
  }),
  health: z.object({
    ended_without_summary: z.number(),
    crm_sync: adminCrmSyncStateSchema,
    poor_quality_participants: z.number(),
    reconnects: z.number(),
  }),
  configuration: adminConfigurationSchema,
  audit: z.array(adminAuditEntrySchema),
  jobs: z.record(z.string(), adminAuditEntrySchema),
  mcp_calls: z.array(mcpCallEntrySchema),
  /** `is_root`: an Envisioning root admin, who may change the workspace's plan. */
  viewer: z.object({ email: z.string(), is_admin: z.boolean(), is_root: z.boolean() }),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
