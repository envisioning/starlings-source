// What the dashboard draws, from `GET /api/fleet` (docs/OPS_CONSOLE.md
// §Dashboard). One fetch, parsed against the contract, then summed across
// the workspaces that answered. Pure functions after the fetch.
import {
  formatOpsTime,
  OPS_FEATURES,
  OPS_MILESTONES,
  OPS_SERVICE_KINDS,
  type OpsServiceKind,
  opsFleetSchema,
  type OpsFleet,
  type OpsProduct,
  type OpsTally,
  type OpsWorkspaceMetadata,
} from '@starlings/contracts/ops';
import { WORK_MODULE_LABELS, WORK_MODULES } from '@starlings/contracts/work-modules';

export type FleetLoad =
  | { state: 'loading' }
  | { state: 'ready'; fleet: OpsFleet }
  | { state: 'error'; message: string };

/** One read of the fleet. A redirect to the Access sign-in is a failed fetch: the page asks for a reload. */
export async function loadFleet(signal?: AbortSignal): Promise<OpsFleet> {
  const response = await fetch('/api/fleet', { credentials: 'same-origin', signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 403 ? 'Not allowed.' : `The console answered ${response.status}.`);
  return opsFleetSchema.parse(await response.json());
}

/** A workspace that answered, with its product block when its Worker reports one. */
export interface LiveWorkspace {
  slug: string;
  host: string;
  metadata: OpsWorkspaceMetadata;
  product: OpsProduct | null;
}

/**
 * The fleet narrowed to one workspace: its row, its Docs and Keep, its cost.
 * The shared plan fees are the fleet's, so a single workspace carries none.
 */
export function scopeFleet(fleet: OpsFleet, slug: string | null): OpsFleet {
  if (slug === null) return fleet;
  return {
    ...fleet,
    workspaces: fleet.workspaces.filter((row) => row.slug === slug),
    services: fleet.services.filter((row) => row.slug === slug),
    costs: fleet.costs.filter((cost) => cost.slug === slug),
    shared_usd: 0,
  };
}

export function liveWorkspaces(fleet: OpsFleet): LiveWorkspace[] {
  return fleet.workspaces.flatMap((row) => row.ok
    ? [{ slug: row.slug, host: row.host, metadata: row.metadata, product: row.metadata.product }]
    : []);
}

const sum = <T>(items: T[], value: (item: T) => number) => items.reduce((total, item) => total + value(item), 0);

/** A labelled count from a workspace's `counts`, or 0. */
export function countOf(metadata: OpsWorkspaceMetadata, label: string): number {
  return metadata.counts.find((count) => count.label === label)?.value ?? 0;
}

/** Tallies with the same key summed across workspaces, largest first. */
export function mergeTallies(lists: OpsTally[][]): OpsTally[] {
  const merged = new Map<string, number>();
  for (const list of lists) for (const { key, value } of list) merged.set(key, (merged.get(key) ?? 0) + value);
  return [...merged].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
}

/** `YYYY-MM` for the UTC month of `ms`. */
export function utcMonth(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export interface FleetTotals {
  workspaces: number;
  answering: number;
  /** Workspaces whose D1 did not answer the migration read. */
  degraded: number;
  members: number;
  agents: number;
  joined30d: number;
  active: { day: number; week: number; month: number };
  signins: { day: number; week: number; month: number };
  devices: { total: number; active: number; outdated: number };
  mcp: { grants: number; active: number; calls7d: number };
  calendar: number;
  /** Guests let into calls in the last 30 days. */
  guests30d: number;
  meetings30d: number;
  errors7d: number;
  failures7d: number;
  deadJobs: number;
  costThisMonth: number;
  /** Workspaces on a build that does not report the product block yet. */
  withoutProduct: number;
}

export function fleetTotals(fleet: OpsFleet): FleetTotals {
  const live = liveWorkspaces(fleet);
  const products = live.flatMap((workspace) => workspace.product ? [workspace.product] : []);
  const month = utcMonth(fleet.checked_at);
  return {
    workspaces: fleet.workspaces.length,
    answering: live.length,
    degraded: live.filter((workspace) => workspace.metadata.migration === null).length,
    members: sum(live, (workspace) => workspace.metadata.members),
    agents: sum(live, (workspace) => workspace.metadata.agents),
    joined30d: sum(products, (product) => product.people.joined_30d),
    active: {
      day: sum(products, (product) => product.active.day),
      week: sum(products, (product) => product.active.week),
      month: sum(products, (product) => product.active.month),
    },
    signins: {
      day: sum(products, (product) => product.signins.day),
      week: sum(products, (product) => product.signins.week),
      month: sum(products, (product) => product.signins.month),
    },
    devices: {
      total: sum(products, (product) => product.devices.total),
      active: sum(products, (product) => product.devices.active_30d),
      outdated: sum(products, (product) => product.devices.outdated),
    },
    mcp: {
      grants: sum(products, (product) => product.connections.mcp_grants),
      active: sum(products, (product) => product.connections.mcp_active_30d),
      calls7d: sum(live, (workspace) => countOf(workspace.metadata, 'MCP calls, 7 days')),
    },
    calendar: sum(products, (product) => product.connections.calendar),
    guests30d: sum(products, (product) => product.daily.reduce((total, day) => total + day.guests, 0)),
    meetings30d: sum(live, (workspace) => countOf(workspace.metadata, 'Meetings, 30 days')),
    errors7d: sum(products, (product) => product.health.errors_7d),
    failures7d: sum(products, (product) => product.health.failures_7d),
    deadJobs: sum(products, (product) => product.health.dead_jobs),
    costThisMonth: fleet.shared_usd + sum(fleet.costs.filter((cost) => cost.month === month), (cost) => cost.usd),
    withoutProduct: live.length - products.length,
  };
}

export type DailyMetric = 'signins' | 'meetings' | 'guests' | 'mcp_calls' | 'errors';
export const DAILY_METRICS: { key: DailyMetric; label: string }[] = [
  { key: 'signins', label: 'Sign-ins' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'guests', label: 'Guests' },
  { key: 'mcp_calls', label: 'MCP calls' },
  { key: 'errors', label: 'Errors' },
];

/** One row per day, one column per workspace slug, for a stacked chart of `metric`. */
export function dailySeries(live: LiveWorkspace[], metric: DailyMetric): Record<string, string | number>[] {
  const days = new Map<string, Record<string, string | number>>();
  for (const workspace of live) {
    for (const entry of workspace.product?.daily ?? []) {
      const row = days.get(entry.day) ?? { day: entry.day };
      row[workspace.slug] = entry[metric];
      days.set(entry.day, row);
    }
  }
  return [...days.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

export type HistoryMetric = 'active_day' | 'active_week' | 'active_month' | 'members';
export const HISTORY_METRICS: { key: HistoryMetric; label: string }[] = [
  { key: 'members', label: 'Members' },
  { key: 'active_month', label: 'Active, 30 days' },
  { key: 'active_week', label: 'Active, 7 days' },
  { key: 'active_day', label: 'Active that day' },
];

/**
 * One row per day of `ops_daily`, summed across the workspaces. A day only
 * counts the workspaces that wrote a row for it; the table starts with the
 * release that added it.
 */
export function historySeries(live: LiveWorkspace[]): Record<string, string | number>[] {
  const days = new Map<string, Record<string, string | number>>();
  for (const workspace of live) {
    for (const entry of workspace.product?.history ?? []) {
      const row = days.get(entry.day) ?? { day: entry.day, members: 0, active_day: 0, active_week: 0, active_month: 0 };
      for (const { key } of HISTORY_METRICS) row[key] = Number(row[key] ?? 0) + entry[key];
      days.set(entry.day, row);
    }
  }
  return [...days.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

const DAY_MS = 86_400_000;

/** Whole UTC days from `from` to `to`, both epoch milliseconds. */
export function daysBetween(from: number, to: number): number {
  return Math.floor((to - from) / DAY_MS);
}

/** One workspace's activation: each milestone with its day after the first sign-in, the share reached, and the next one. */
export function activationOf(workspace: LiveWorkspace, now: number) {
  const activation = workspace.product?.activation ?? null;
  if (!activation) return null;
  const at = new Map(activation.milestones.map((entry) => [entry.key, entry.at]));
  const start = at.get('first_signin') ?? null;
  const store = workspace.metadata.work_store;
  const milestones = OPS_MILESTONES.map(({ key, label }) => {
    const time = at.get(key) ?? null;
    // A Core workspace's first project is in Core: unknown here, not missing.
    const unknown = key === 'first_project' && store === 'core';
    return { key, label, at: time, unknown, day: time !== null && start !== null ? Math.max(0, daysBetween(start, time)) : null };
  });
  const known = milestones.filter((entry) => !entry.unknown);
  return {
    start,
    ageDays: start === null ? null : daysBetween(start, now),
    milestones,
    reached: known.filter((entry) => entry.at !== null).length,
    total: known.length,
    next: known.find((entry) => entry.at === null) ?? null,
    aliveDay14: activation.alive_day14,
  };
}

/** How many workspaces have each work module on, in Admin's order. */
export function moduleAdoption(live: LiveWorkspace[]): { key: string; label: string; on: string[] }[] {
  return WORK_MODULES.map((module) => ({
    key: module,
    label: WORK_MODULE_LABELS[module],
    on: live.filter((workspace) => workspace.product?.work_modules.includes(module)).map((workspace) => workspace.slug),
  }));
}

export const FEATURES = OPS_FEATURES;

/** Every count label any workspace reports, in the order they first appear. */
export function recordLabels(live: LiveWorkspace[]): string[] {
  const labels: string[] = [];
  for (const workspace of live) for (const count of workspace.metadata.counts) if (!labels.includes(count.label)) labels.push(count.label);
  return labels;
}

export const SERVICE_KINDS = OPS_SERVICE_KINDS;

/** One workspace's Docs or Keep row from the fleet, or undefined when the workspace has none. */
export function serviceOf(fleet: OpsFleet, slug: string, kind: OpsServiceKind): OpsFleet['services'][number] | undefined {
  return fleet.services.find((row) => row.slug === slug && row.kind === kind);
}

/** Docs or Keep across the fleet: its counts summed by label, and how many workspaces have it and answered. */
export function serviceTotals(fleet: OpsFleet, kind: OpsServiceKind): { counts: OpsTally[]; workspaces: number; answering: number } {
  const rows = fleet.services.filter((row) => row.kind === kind);
  const counts: OpsTally[] = [];
  for (const row of rows) {
    if (!row.ok) continue;
    for (const { label, value } of row.metadata.counts) {
      const existing = counts.find((count) => count.key === label);
      if (existing) existing.value += value;
      else counts.push({ key: label, value });
    }
  }
  return { counts, workspaces: rows.length, answering: rows.filter((row) => row.ok).length };
}

/** Every count label a workspace's Docs or Keep reports, in the order they first appear. */
export function serviceLabels(fleet: OpsFleet, kind: OpsServiceKind): string[] {
  return serviceTotals(fleet, kind).counts.map((count) => count.key);
}

/** Tallies of one string field across workspaces: plan, suite, store. */
export function mix(values: string[]): OpsTally[] {
  return mergeTallies([values.map((key) => ({ key, value: 1 }))]);
}

const integer = new Intl.NumberFormat('en-US');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export const formatNumber = (value: number) => integer.format(value);
export const formatUSD = (value: number) => usd.format(value);

/** A share as a whole percent, or a dash-free `n/a` when there is no base. */
export function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : 'n/a';
}

/** `2026-10-04 13:05 UTC`, the 24-hour clock. */
export const formatUTC = formatOpsTime;

/** `Oct 4` for a `YYYY-MM-DD` day, in UTC. */
export function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
