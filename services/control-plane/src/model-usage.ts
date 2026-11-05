// Model calls and tokens per day (docs/OPERATIONS.md §Model usage).
//
// Usage is recorded and alerted on; nothing is cut off, so a meeting never
// loses its notes to a cap. Provider budget alerts live in each console.

import type { ModelUsageRow } from './contracts';
import { recordFailure } from './ops';

/**
 * Who billed the call. `ai-gateway` is Vercel AI Gateway, which carries the
 * Granola filing model when `AI_GATEWAY_API_KEY` is set.
 */
export type ModelProvider = 'anthropic' | 'workers-ai' | 'ai-gateway';

export interface ModelUsage {
  provider: ModelProvider;
  model: string;
  purpose: string;
  input: number;
  output: number;
}

/**
 * An estimate, not a count: characters / 4. Workers AI does not return token
 * counts for every model, so its rows use this for both directions.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Add one call to today's row. Best-effort: it never throws and never delays the answer it counts. */
export async function recordModelUsage(env: Partial<Pick<Env, 'USAGE'>>, usage: ModelUsage, now = Date.now()): Promise<void> {
  if (!env.USAGE) return;
  try {
    await env.USAGE.prepare(
      `INSERT INTO model_usage (day, provider, model, purpose, calls, input_tokens, output_tokens)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
       ON CONFLICT (day, provider, model, purpose) DO UPDATE SET
         calls = calls + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens`,
    ).bind(
      new Date(now).toISOString().slice(0, 10),
      usage.provider,
      usage.model.slice(0, 120),
      usage.purpose,
      Math.max(0, Math.round(usage.input)),
      Math.max(0, Math.round(usage.output)),
    ).run();
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'model.usage.record.failed',
      purpose: usage.purpose,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * Every input token Anthropic read: uncached, written to the cache, and read
 * from it. The cached ones bill lower, but they are still input.
 */
export function anthropicInputTokens(usage: { input_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

/** The text a Workers AI chat answer carries, for the output estimate. */
export function workersAIText(output: unknown): string {
  if (typeof output === 'string') return output;
  const response = (output as { response?: unknown } | null)?.response;
  if (typeof response === 'string') return response;
  return output === undefined || output === null ? '' : JSON.stringify(output);
}

/** True on the one five-minute tick after 00:00 UTC, once yesterday is complete. */
export function isDailyTick(scheduledTime: number): boolean {
  const at = new Date(scheduledTime);
  return at.getUTCHours() === 0 && at.getUTCMinutes() < 5;
}

/**
 * Sum yesterday's tokens (UTC) across every row. Over `SPEND_ALERT_DAILY_TOKENS`
 * counts one `model_spend` failure, which mails a person. Unset, zero or not
 * a number means no check. Answers the total.
 */
export async function checkModelSpend(env: Env, now = Date.now()): Promise<number> {
  const yesterday = new Date(now - 24 * 60 * 60_000).toISOString().slice(0, 10);
  const row = await env.USAGE.prepare(
    'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total FROM model_usage WHERE day = ?1',
  ).bind(yesterday).first<{ total: number }>();
  const total = row?.total ?? 0;
  const limit = Number(env.SPEND_ALERT_DAILY_TOKENS?.trim() ?? '');
  if (Number.isFinite(limit) && limit > 0 && total > limit) {
    await recordFailure(env, 'model_spend', `${total} tokens`, now);
  }
  return total;
}

/** The last `days` days, newest first. */
export async function modelUsageRows(env: Env, days: number, now = Date.now()): Promise<ModelUsageRow[]> {
  const since = new Date(now - (days - 1) * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const { results } = await env.USAGE.prepare(
    `SELECT day, provider, model, purpose, calls, input_tokens, output_tokens FROM model_usage
     WHERE day >= ?1 ORDER BY day DESC, provider, model, purpose LIMIT 2000`,
  ).bind(since).all<ModelUsageRow>();
  return results;
}
