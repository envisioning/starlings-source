import { z } from 'zod';

/**
 * What a workspace tells the platform operator console (docs/OPS_CONSOLE.md,
 *). The `starlings-ops` Worker reads it from each workspace's
 * `OpsService` entrypoint over a service binding. It is metadata only: names,
 * versions, counts and one time. It never carries a record, a message, a
 * transcript, a document or an address. The object is strict, so a field
 * added here without a review of this rule fails the parse.
 */
/**
 * One labelled count: how many rows of one kind a Worker holds. The label is
 * a fixed string in the Worker's code, never a value read from a row.
 */
export const opsCountSchema = z.strictObject({
  label: z.string().min(1).max(40),
  value: z.number().int().nonnegative(),
});
export type OpsCount = z.infer<typeof opsCountSchema>;
export const opsCountsSchema = z.array(opsCountSchema).max(24);

/**
 * Model calls and tokens for one provider, model and purpose in one month,
 * from the workspace's `model_usage` table. `purpose` is a fixed string in
 * the Worker's code (`notes`, `task-candidates`, ...); `model` is a model id
 * from the Worker's configuration or the provider's answer.
 */
export const opsModelUsageSchema = z.strictObject({
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(120),
  purpose: z.string().min(1).max(40),
  calls: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
export type OpsModelUsage = z.infer<typeof opsModelUsageSchema>;

/**
 * What one workspace used in one UTC month: the quantities a provider bills
 * for. The console prices them (docs/OPS_CONSOLE.md §Costs); the workspace
 * reports quantities only, never a cost and never a record.
 */
export const opsUsageMonthSchema = z.strictObject({
  /** `YYYY-MM`, UTC. */
  month: z.string().regex(/^\d{4}-\d{2}$/u),
  meetings: z.number().int().nonnegative(),
  meetings_with_notes: z.number().int().nonnegative(),
  /** Connected time summed over every participant, from the clients' reports. */
  participant_minutes: z.number().int().nonnegative(),
  /** Media bytes the clients received from LiveKit, from their RTP counters. */
  downstream_bytes: z.number().int().nonnegative(),
  /** Notes mails sent after meetings. */
  emails_sent: z.number().int().nonnegative(),
  mcp_calls: z.number().int().nonnegative(),
  models: z.array(opsModelUsageSchema).max(40),
});
export type OpsUsageMonth = z.infer<typeof opsUsageMonthSchema>;

const opsInt = z.number().int().nonnegative();

/** One count under a fixed key: a client, a platform, a version. Never a value read from a person. */
export const opsTallySchema = z.strictObject({
  key: z.string().min(1).max(40),
  value: opsInt,
});
export type OpsTally = z.infer<typeof opsTallySchema>;

/** People counted over the last day, 7 days and 30 days. */
export const opsWindowsSchema = z.strictObject({ day: opsInt, week: opsInt, month: opsInt });
export type OpsWindows = z.infer<typeof opsWindowsSchema>;

/** One UTC day of activity, for the dashboard's charts. */
export const opsDaySchema = z.strictObject({
  /** `YYYY-MM-DD`, UTC. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  signins: opsInt,
  meetings: opsInt,
  mcp_calls: opsInt,
  /** Operational errors the clients and the Worker reported. */
  errors: opsInt,
  /** Guests a host let into a call (`usage_events` of kind `admit`). 0 from a Worker built before it existed. */
  guests: opsInt.default(0),
});
export type OpsDay = z.infer<typeof opsDaySchema>;

/** One UTC day of the workspace's `ops_daily` row: how many people used it. */
export const opsHistoryDaySchema = z.strictObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  members: opsInt,
  active_day: opsInt,
  active_week: opsInt,
  active_month: opsInt,
  active_web: opsInt,
  active_mac: opsInt,
  active_ios: opsInt,
  devices_active: opsInt,
  agents_active: opsInt,
});
export type OpsHistoryDay = z.infer<typeof opsHistoryDaySchema>;

/**
 * The first times a workspace reached, in the order a new workspace usually
 * reaches them, with the word the dashboard shows. Each is read from the
 * first row its table holds (`ops-history.ts`).
 */
export const OPS_MILESTONES = [
  { key: 'first_signin', label: 'First sign-in' },
  { key: 'second_member', label: 'Second member' },
  { key: 'third_member', label: 'Third member' },
  { key: 'first_call', label: 'First call' },
  { key: 'first_guest', label: 'First guest in a call' },
  { key: 'first_notes', label: 'First meeting notes' },
  { key: 'first_calendar', label: 'First calendar connected' },
  { key: 'first_device', label: 'First Mac or iPhone' },
  { key: 'first_agent', label: 'First agent connected' },
  { key: 'first_project', label: 'First project' },
] as const;
export type OpsMilestoneKey = (typeof OPS_MILESTONES)[number]['key'];

export const opsActivationSchema = z.strictObject({
  /** Each milestone in `OPS_MILESTONES` order, with its time in epoch milliseconds, or null when not reached or not known here. */
  milestones: z.array(z.strictObject({ key: z.string().max(40), at: z.number().nullable() })).max(16),
  /** At least three members active in the second week after the first sign-in. Null while too young, or with no row for that day. */
  alive_day14: z.boolean().nullable(),
});
export type OpsActivation = z.infer<typeof opsActivationSchema>;

/**
 * How the product is used in one workspace (docs/OPS_CONSOLE.md §Dashboard).
 * Counts, flags, fixed keys and app versions only. Same rule as the rest of
 * the metadata: never a record, a name or an address.
 */
export const opsProductSchema = z.strictObject({
  /** `free` or `pro` (BUSINESS (HQ Docs)). */
  plan: z.string().max(20),
  /** `google`, `microsoft` or `other`. */
  suite: z.string().max(20),
  /** The work modules in force, from `WORK_MODULES`. */
  work_modules: z.array(z.string().max(40)).max(16),
  /** Each feature this deployment can turn on, and whether it is on. Keys from `OPS_FEATURES`. */
  features: z.array(z.strictObject({ key: z.string().max(40), on: z.boolean() })).max(16),
  people: z.strictObject({
    admins: opsInt,
    /** Role `community`. */
    community: opsInt,
    revoked: opsInt,
    /** Members whose first sign-in is in the last 30 days. */
    joined_30d: opsInt,
  }),
  /** Members seen in each window (`last_seen_at`). */
  active: opsWindowsSchema,
  /** Members seen on each client in the last 30 days: `web`, `mac`, `ios`. */
  active_clients: z.array(opsTallySchema).max(8),
  /** Sign-ins in each window (`usage_events` of kind `signin`). */
  signins: opsWindowsSchema,
  /** Sign-ins per client in the last 30 days. */
  signin_clients: z.array(opsTallySchema).max(8),
  /** Native devices signed in (`owner_devices`). */
  devices: z.strictObject({
    total: opsInt,
    /** Renewed their session in the last 30 days. */
    active_30d: opsInt,
    /** Active, and below the minimum recommended version for their platform. */
    outdated: opsInt,
  }),
  /** Active devices per platform: `macos`, `ios`, `watchos`. */
  device_platforms: z.array(opsTallySchema).max(8),
  /** Active devices per `<platform> <version>`. */
  app_versions: z.array(opsTallySchema).max(30),
  connections: z.strictObject({
    /** Members with a Google grant. */
    calendar: opsInt,
    /** MCP grants that are not revoked. */
    mcp_grants: opsInt,
    /** MCP grants with a call in the last 30 days. */
    mcp_active_30d: opsInt,
  }),
  health: z.strictObject({
    errors_7d: opsInt,
    failures_7d: opsInt,
    dead_jobs: opsInt,
  }),
  /** The last 30 UTC days, oldest first, today last. */
  daily: z.array(opsDaySchema).max(31),
  /** `ops_daily`, up to 120 days, oldest first. Empty from a Worker built before it existed. */
  history: z.array(opsHistoryDaySchema).max(120).default([]),
  /** Null from a Worker built before it existed. */
  activation: opsActivationSchema.nullable().default(null),
});
export type OpsProduct = z.infer<typeof opsProductSchema>;

/** The features `opsProductSchema.features` reports, in display order, with the word the dashboard shows. */
export const OPS_FEATURES = [
  { key: 'notes', label: 'Meeting notes' },
  { key: 'task_suggestions', label: 'Task suggestions' },
  { key: 'granola_suggestions', label: 'Granola filing' },
  { key: 'crm_sync', label: 'CRM sync' },
  { key: 'github_sync', label: 'GitHub sync' },
  { key: 'slack_import', label: 'Slack import' },
] as const;
export type OpsFeatureKey = (typeof OPS_FEATURES)[number]['key'];

export const opsWorkspaceMetadataSchema = z.strictObject({
  /** The workspace's own slug, from its `<slug>.<suffix>` origin. Null when it has none. */
  slug: z.string().nullable(),
  /** `WORKSPACE_NAME`, or Envisioning's default name when it is unset. */
  name: z.string(),
  /** `core` or `d1` (docs/WORKSPACE_STORE.md). */
  work_store: z.string(),
  /** The commit the Worker was built from, or `unknown`. */
  build: z.string(),
  /** The newest D1 migration applied, or null when D1 does not answer. */
  migration: z.string().nullable(),
  /** People of kind `human` who are not revoked. */
  members: z.number().int().nonnegative(),
  /** People of kind `agent`. */
  agents: z.number().int().nonnegative(),
  /** The newest `last_seen_at` of a member, in epoch milliseconds, or null. */
  last_activity_at: z.number().nullable(),
  /** Row counts from the workspace's D1, in display order. Empty from a Worker built before they existed. */
  counts: opsCountsSchema.default([]),
  /** This month and the month before, newest first. Empty from a Worker built before it existed. */
  usage: z.array(opsUsageMonthSchema).max(2).default([]),
  /** Product telemetry for the dashboard. Null from a Worker built before it existed, or when the read failed. */
  product: opsProductSchema.nullable().default(null),
});
export type OpsWorkspaceMetadata = z.infer<typeof opsWorkspaceMetadataSchema>;

/**
 * The `starlings-ops` service binding that reaches one workspace:
 * `WORKSPACE_<SLUG>`, hyphens as underscores. A slug has no underscore
 * (ADR 0004 decision 4), so the name maps back to one slug.
 */
export const OPS_BINDING_PREFIX = 'WORKSPACE_';
export function opsBindingName(slug: string): string {
  return `${OPS_BINDING_PREFIX}${slug.toUpperCase().replaceAll('-', '_')}`;
}
export function opsBindingSlug(binding: string): string | null {
  if (!binding.startsWith(OPS_BINDING_PREFIX)) return null;
  const slug = binding.slice(OPS_BINDING_PREFIX.length).toLowerCase().replaceAll('_', '-');
  return /^[a-z0-9-]+$/u.test(slug) ? slug : null;
}

/** The entrypoint every workspace Worker exports for the console. */
export const OPS_ENTRYPOINT = 'OpsService';

/** The fields of `OpsWorkspaceMetadata`, in order. The tests compare against this list. */
export const OPS_METADATA_FIELDS = Object.keys(opsWorkspaceMetadataSchema.shape) as (keyof OpsWorkspaceMetadata)[];

/**
 * What a workspace's Docs or Keep tells the console. Same rule as a
 * workspace: names, counts and times, never a record. The service Worker
 * lives in its own repository and parses its answer against its own copy of
 * this shape; the console parses it again here.
 */
export const opsServiceMetadataSchema = z.strictObject({
  /** The service's kind, `docs` or `keep`, whatever the Worker's name. */
  service: z.string(),
  /** The newest D1 migration applied, or null when D1 does not answer. */
  migration: z.string().nullable(),
  /** Row counts, in display order. */
  counts: opsCountsSchema,
  /** The newest write the service recorded, in epoch milliseconds, or null. */
  last_activity_at: z.number().nullable(),
});
export type OpsServiceMetadata = z.infer<typeof opsServiceMetadataSchema>;

/**
 * A workspace's own services that report to the console: its Docs and Keep
 * Workers (`DOCS` and `KEEP` in its wrangler config). The console binds each
 * one's `OpsService` as `<BINDING>_<SLUG>`: `DOCS_HQ`, `KEEP_ENVISIONING`.
 * `scripts/check-production-config.mjs` keeps those bindings equal to the
 * workspaces' own.
 */
export const OPS_SERVICE_KINDS = [
  { kind: 'docs', label: 'Docs', binding: 'DOCS' },
  { kind: 'keep', label: 'Keep', binding: 'KEEP' },
] as const;
export type OpsServiceKind = (typeof OPS_SERVICE_KINDS)[number]['kind'];

/** `DOCS_HQ` for hq's Docs. Hyphens become underscores, as in `opsBindingName`. */
export function opsServiceBindingName(kind: OpsServiceKind, slug: string): string {
  const entry = OPS_SERVICE_KINDS.find((candidate) => candidate.kind === kind)!;
  return `${entry.binding}_${slug.toUpperCase().replaceAll('-', '_')}`;
}

/** The kind and workspace a `<BINDING>_<SLUG>` binding reaches, or null. */
export function opsServiceBinding(binding: string): { kind: OpsServiceKind; slug: string } | null {
  for (const entry of OPS_SERVICE_KINDS) {
    const prefix = `${entry.binding}_`;
    if (!binding.startsWith(prefix)) continue;
    const slug = binding.slice(prefix.length).toLowerCase().replaceAll('_', '-');
    if (/^[a-z0-9-]+$/u.test(slug)) return { kind: entry.kind, slug };
  }
  return null;
}

/** One workspace as `GET /api/fleet` reports it: its metadata, or why it did not answer. */
export const opsFleetWorkspaceSchema = z.discriminatedUnion('ok', [
  z.strictObject({ slug: z.string(), host: z.string(), ok: z.literal(true), metadata: opsWorkspaceMetadataSchema }),
  z.strictObject({ slug: z.string(), host: z.string(), ok: z.literal(false), error: z.string() }),
]);
export type OpsFleetWorkspace = z.infer<typeof opsFleetWorkspaceSchema>;

const opsServiceKindSchema = z.enum(['docs', 'keep'] as const satisfies readonly OpsServiceKind[]);

/** One workspace's Docs or Keep as `GET /api/fleet` reports it. A workspace without one has no row. */
export const opsFleetServiceSchema = z.discriminatedUnion('ok', [
  z.strictObject({ slug: z.string(), kind: opsServiceKindSchema, ok: z.literal(true), metadata: opsServiceMetadataSchema }),
  z.strictObject({ slug: z.string(), kind: opsServiceKindSchema, ok: z.literal(false), error: z.string() }),
]);
export type OpsFleetService = z.infer<typeof opsFleetServiceSchema>;

/** What one workspace cost this month to date and the month before, priced by the console (`costs.ts`). */
export const opsFleetCostSchema = z.strictObject({
  slug: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/u),
  usd: z.number().nonnegative(),
});
export type OpsFleetCost = z.infer<typeof opsFleetCostSchema>;

/**
 * `GET /api/fleet` on the ops host: what the dashboard draws. The
 * console asks every workspace and service at once and answers with all of
 * them, a failed one as an error row.
 */
export const opsFleetSchema = z.strictObject({
  checked_at: z.number(),
  workspaces: z.array(opsFleetWorkspaceSchema),
  services: z.array(opsFleetServiceSchema),
  costs: z.array(opsFleetCostSchema),
  /** Shared plan fees, paid once for the fleet, in USD a month. */
  shared_usd: z.number().nonnegative(),
  /** Sign-up requests that wait for an operator, or null when starlings-auth did not answer. */
  pending_requests: opsInt.nullable(),
});
export type OpsFleet = z.infer<typeof opsFleetSchema>;

/** `2026-10-04 13:05 UTC`, the 24-hour clock (AGENTS.md invariant 20). The console's pages and the dashboard both write times with it. */
export function formatOpsTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'Never';
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The console's pages, in nav order. The dashboard (web/ops) draws the first
 * three in place; Costs and Requests are the Worker's own server-rendered
 * pages. Both draw their nav from this list.
 */
export const OPS_PAGES = [
  { href: '/', label: 'Overview', dashboard: true },
  { href: '/workspaces', label: 'Workspaces', dashboard: true },
  { href: '/records', label: 'Records', dashboard: true },
  { href: '/costs', label: 'Costs', dashboard: false },
  { href: '/requests', label: 'Requests', dashboard: false },
] as const;

/** A dashboard page, one URL each. `/workspaces/<slug>` is one workspace's own overview. */
export type OpsDashboardRoute =
  | { page: 'overview' }
  | { page: 'workspaces' }
  | { page: 'workspace'; slug: string }
  | { page: 'records' };

/** The dashboard page a path names, or null. The Worker answers each with index.html; the app draws it. */
export function opsDashboardRoute(pathname: string): OpsDashboardRoute | null {
  const path = pathname.replace(/\/+$/u, '') || '/';
  if (path === '/') return { page: 'overview' };
  if (path === '/workspaces') return { page: 'workspaces' };
  if (path === '/records') return { page: 'records' };
  const workspace = /^\/workspaces\/([a-z0-9-]+)$/u.exec(path);
  return workspace ? { page: 'workspace', slug: workspace[1]! } : null;
}
