// What the fleet costs, per workspace and per function (docs/OPS_CONSOLE.md
// §Costs). Each workspace reports billable quantities only
// (`OpsUsageMonth`); this file is the one place that turns them into money.
//
// The rates are provider list prices in USD, checked on RATES_CHECKED. They
// are marginal: the cost once a shared allowance (LiveKit's included minutes,
// Workers AI's free neurons) is used up. So a workspace's line is an upper
// bound, and the shared plan fees are listed once, below the workspaces.
// Change a rate here and in BUSINESS (HQ Docs) §Measured cost floor together.
import type { OpsModelUsage, OpsUsageMonth } from '@starlings/contracts/ops';
import { escapeHTML, opsDocument, type WorkspaceRow } from './page';

export const RATES_CHECKED = '2026-10-04';

/** LiveKit Cloud Build and Ship overage (livekit.com/pricing). */
export const MEDIA_RATES = { perParticipantMinute: 0.0005, perGB: 0.12 } as const;

/** Postmark Basic overage, per mail (postmarkapp.com/pricing). */
export const MAIL_RATE_PER_MESSAGE = 1.8 / 1000;

/** USD per million tokens. A key is `<provider>/<model>`; an Anthropic answer may add a date suffix, so the longest prefix wins. */
export const MODEL_RATES: Record<string, { input: number; output: number }> = {
  'anthropic/claude-fable-5': { input: 10, output: 50 },
  'anthropic/claude-opus-5-5': { input: 4, output: 20 },
  'anthropic/claude-opus-5': { input: 5, output: 25 },
  'anthropic/claude-sonnet-5-5': { input: 2, output: 10 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10 },
  'anthropic/claude-haiku-4-5': { input: 1, output: 5 },
  'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 0.293, output: 2.253 },
  'workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8': { input: 0.152, output: 0.287 },
};

/** The function a model purpose serves, as the page names it. An unknown purpose shows as itself. */
export const PURPOSE_LABELS: Record<string, string> = {
  notes: 'Meeting notes',
  'notes-fallback': 'Meeting notes, fallback',
  title: 'Meeting titles',
  'task-candidates': 'Task suggestions',
  'calendar-extract': 'Calendar extraction',
  'granola-suggest': 'Granola filing',
};

/** Plan fees paid once for the whole fleet, not per workspace. */
export const SHARED_PLANS: { label: string; usd: number; note: string }[] = [
  { label: 'Cloudflare Workers Paid', usd: 5, note: '10M requests, 30M CPU ms, D1 and Durable Object allowances included' },
  { label: 'LiveKit Cloud', usd: 0, note: 'Build plan: 5,000 minutes and 50 GB included. Ship is $50 with 150,000 minutes and 250 GB' },
  { label: 'Postmark', usd: 15, note: 'Basic: 10,000 mails included' },
];

/** The rate for one model, or null when the registry has none. */
export function modelRate(provider: string, model: string): { input: number; output: number } | null {
  const key = `${provider}/${model}`;
  let best: string | null = null;
  for (const candidate of Object.keys(MODEL_RATES)) {
    if ((key === candidate || key.startsWith(`${candidate}-`)) && (best === null || candidate.length > best.length)) best = candidate;
  }
  return best === null ? null : MODEL_RATES[best]!;
}

/** One function's line: what it used, and what that costs. `usd` is null when no rate is known. */
export interface CostLine {
  label: string;
  usage: string;
  usd: number | null;
}

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatUSD(usd: number | null): string {
  if (usd === null) return 'No rate';
  if (usd > 0 && usd < 0.01) return '< $0.01';
  return `$${decimal.format(usd)}`;
}

function tokens(n: number): string {
  return n >= 1_000_000 ? `${decimal.format(n / 1_000_000)}M` : n >= 1_000 ? `${integer.format(n / 1_000)}k` : integer.format(n);
}

function modelCost(row: OpsModelUsage): number | null {
  const rate = modelRate(row.provider, row.model);
  return rate === null ? null : (row.input_tokens * rate.input + row.output_tokens * rate.output) / 1_000_000;
}

/** The cost lines of one workspace's month: calls, mail, then one line per model purpose, then MCP. */
export function costLines(month: OpsUsageMonth): CostLine[] {
  const gb = month.downstream_bytes / 1e9;
  const lines: CostLine[] = [{
    label: 'Calls (media)',
    usage: `${integer.format(month.meetings)} meetings, ${integer.format(month.participant_minutes)} participant-minutes, ${decimal.format(gb)} GB`,
    usd: month.participant_minutes * MEDIA_RATES.perParticipantMinute + gb * MEDIA_RATES.perGB,
  }];

  const byPurpose = new Map<string, OpsModelUsage[]>();
  for (const row of month.models) byPurpose.set(row.purpose, [...(byPurpose.get(row.purpose) ?? []), row]);
  for (const [purpose, rows] of byPurpose) {
    const costs = rows.map(modelCost);
    const calls = rows.reduce((sum, row) => sum + row.calls, 0);
    const input = rows.reduce((sum, row) => sum + row.input_tokens, 0);
    const output = rows.reduce((sum, row) => sum + row.output_tokens, 0);
    const models = [...new Set(rows.map((row) => row.model))].join(', ');
    lines.push({
      label: PURPOSE_LABELS[purpose] ?? purpose,
      usage: `${integer.format(calls)} calls, ${tokens(input)} in, ${tokens(output)} out (${models})`,
      usd: costs.some((cost) => cost === null) ? null : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
    });
  }

  lines.push({
    label: 'Notes mail',
    usage: `${integer.format(month.emails_sent)} mails`,
    usd: month.emails_sent * MAIL_RATE_PER_MESSAGE,
  });
  lines.push({
    label: 'MCP calls',
    usage: `${integer.format(month.mcp_calls)} calls`,
    usd: 0,
  });
  return lines;
}

/** The sum of the lines that have a rate. */
export function totalUSD(lines: CostLine[]): number {
  return lines.reduce((sum, line) => sum + (line.usd ?? 0), 0);
}

function monthTable(slug: string, members: number, month: OpsUsageMonth): string {
  const lines = costLines(month);
  const total = totalUSD(lines);
  const unpriced = lines.some((line) => line.usd === null) ? ' <span class="warn">(a line has no rate)</span>' : '';
  const body = lines.map((line) =>
    `<tr><td>${escapeHTML(line.label)}</td><td>${escapeHTML(line.usage)}</td>`
    + `<td class="num${line.usd === null ? ' warn' : ''}">${escapeHTML(formatUSD(line.usd))}</td></tr>`).join('');
  const perMember = members > 0 ? `, ${escapeHTML(formatUSD(total / members))} per member` : '';
  return `<div class="card"><h3>${escapeHTML(slug)}, ${escapeHTML(month.month)}</h3>
<div class="wrap"><table>
<thead><tr><th>Function</th><th>Usage</th><th class="num">Cost</th></tr></thead>
<tbody>${body}</tbody>
<tfoot><tr><th>Total</th><th class="muted">${integer.format(members)} members${perMember}</th><th class="num">${escapeHTML(formatUSD(total))}${unpriced}</th></tr></tfoot>
</table></div></div>`;
}

export function renderCostsPage(rows: WorkspaceRow[], now = Date.now()): string {
  const answered = rows.filter((row): row is Extract<WorkspaceRow, { ok: true }> => row.ok);
  const months = [...new Set(answered.flatMap((row) => row.metadata.usage.map((month) => month.month)))].sort().reverse();

  const summaryHead = months.map((month) => `<th class="num">${escapeHTML(month)}</th>`).join('');
  const summaryRows = rows.map((row) => {
    if (!row.ok) return `<tr><td><strong>${escapeHTML(row.workspace.slug)}</strong></td><td colspan="${months.length + 1}" class="error">No answer: ${escapeHTML(row.error)}</td></tr>`;
    const cells = months.map((month) => {
      const usage = row.metadata.usage.find((entry) => entry.month === month);
      return `<td class="num">${usage ? escapeHTML(formatUSD(totalUSD(costLines(usage)))) : '<span class="muted">No data</span>'}</td>`;
    }).join('');
    return `<tr><td><strong>${escapeHTML(row.workspace.slug)}</strong></td><td class="num">${row.metadata.members}</td>${cells}</tr>`;
  }).join('');
  const fleetCells = months.map((month) => {
    const sum = answered.reduce((total, row) => {
      const usage = row.metadata.usage.find((entry) => entry.month === month);
      return total + (usage ? totalUSD(costLines(usage)) : 0);
    }, 0);
    return `<th class="num">${escapeHTML(formatUSD(sum))}</th>`;
  }).join('');

  const shared = SHARED_PLANS.map((plan) =>
    `<tr><td>${escapeHTML(plan.label)}</td><td class="muted">${escapeHTML(plan.note)}</td><td class="num">${escapeHTML(formatUSD(plan.usd))}</td></tr>`).join('');
  const sharedTotal = SHARED_PLANS.reduce((sum, plan) => sum + plan.usd, 0);

  const cards = answered.flatMap((row) =>
    row.metadata.usage.map((month) => monthTable(row.workspace.slug, row.metadata.members, month))).join('');

  return opsDocument('Costs', `<h1>Costs</h1>
<p>Checked ${escapeHTML(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC. List prices in USD from ${RATES_CHECKED}, after any shared allowance, so each line is an upper bound. The current month is month to date.</p>
<h2>Per workspace</h2>
<div class="wrap"><table>
<thead><tr><th>Workspace</th><th class="num">Members</th>${summaryHead}</tr></thead>
<tbody>${summaryRows || `<tr><td colspan="${months.length + 2}" class="error">No workspaces are bound.</td></tr>`}</tbody>
<tfoot><tr><th>All workspaces</th><th></th>${fleetCells}</tr></tfoot>
</table></div>
<h2>Shared plans, per month</h2>
<div class="wrap"><table>
<thead><tr><th>Plan</th><th>Includes</th><th class="num">Cost</th></tr></thead>
<tbody>${shared}</tbody>
<tfoot><tr><th>Total</th><th></th><th class="num">${escapeHTML(formatUSD(sharedTotal))}</th></tr></tfoot>
</table></div>
<h2>Per function</h2>
${cards || '<p>No usage reported yet.</p>'}`);
}
