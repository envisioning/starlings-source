// Cloudflare Turnstile verification for the Worker's public write routes.
import { ControlError } from './errors';

const SITEVERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type HumanSurface = 'always' | 'browser';

/**
 * Verify a Turnstile token, or do nothing at all.
 *
 * **The secret is the switch.** With `TURNSTILE_SECRET_KEY` unset — local dev,
 * the test Worker, and every deploy before the widget exists — this returns
 * immediately and the route is protected by rate limiting alone.
 *
 * Keep the two halves in step. A `VITE_TURNSTILE_SITE_KEY` in the web bundle
 * with no secret here is theatre — every token goes unchecked. A secret here
 * with no sitekey in the bundle locks every *browser* guest out of every room,
 * because the SPA has nothing to solve and this throws on the missing token.
 *
 * Native Mac/iOS knocks never solve a widget and must not start failing the
 * day the secret is set. `surface: 'browser'` skips any request that lacks
 * Fetch Metadata (`Sec-Fetch-Site`). Real browsers always send that header on
 * `fetch()` and page POSTs, and JavaScript cannot strip it. `URLSession` never
 * sends it. Do not key this off `client.app` in the JSON body — that field is
 * self-reported and a bot can lie. Curl omitting the header still skips, which
 * is the same bar native has today: origin check, rate limit, then lobby.
 */
export async function assertHuman(
  request: Request,
  env: Env,
  token: string | undefined,
  surface: HumanSurface = 'always',
): Promise<void> {
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return;
  if (surface === 'browser' && !isBrowserFetch(request)) return;
  if (!token) throw new ControlError('Bot check missing.', 403, 'turnstile_failed');

  let outcome: { success?: boolean } | null = null;
  try {
    outcome = await siteverify(request, secret, token);
  } catch {
    // Fail open. siteverify being unreachable is our outage, and it must not
    // stand between a guest and a meeting they were invited to. Rate limiting
    // is still in front of every route that calls this.
    return;
  }
  if (!outcome?.success) throw new ControlError('Bot check failed.', 403, 'turnstile_failed');
}

/**
 * The same check for a route that writes records for a caller nobody knows
 * (`public-leads.ts`). It fails closed: no secret or no answer from siteverify
 * refuses the call, where `assertHuman` lets it through.
 */
export async function assertHumanFailClosed(request: Request, env: Env, token: string | undefined): Promise<void> {
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) throw new ControlError('Bot check is not available.', 503, 'not_configured');
  if (!token) throw new ControlError('Bot check missing.', 403, 'turnstile_failed');
  let outcome: { success?: boolean } | null = null;
  try {
    outcome = await siteverify(request, secret, token);
  } catch {
    throw new ControlError('Bot check is not available.', 503, 'not_configured');
  }
  if (!outcome?.success) throw new ControlError('Bot check failed.', 403, 'turnstile_failed');
}

async function siteverify(request: Request, secret: string, token: string): Promise<{ success?: boolean } | null> {
  const form = new FormData();
  form.set('secret', secret);
  form.set('response', token);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.set('remoteip', ip);
  const response = await fetch(SITEVERIFY_ENDPOINT, { method: 'POST', body: form });
  return (await response.json()) as { success?: boolean } | null;
}

/** True when this request came from a browser's fetch/navigation, not URLSession. */
export function isBrowserFetch(request: Request): boolean {
  return request.headers.has('sec-fetch-site');
}

/**
 * Verify `turnstile_token` on a JSON body and return the rest, so an upstream
 * (Core's book route) never sees a Meet-only field it would 400 on.
 */
export async function assertHumanJsonBody(
  request: Request,
  env: Env,
  raw: string,
  surface: HumanSurface = 'always',
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ControlError('Request body must be valid JSON.', 400, 'invalid_request');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ControlError('Request body must be a JSON object.', 400, 'invalid_request');
  }
  const record = { ...(parsed as Record<string, unknown>) };
  const token = typeof record.turnstile_token === 'string' ? record.turnstile_token : undefined;
  delete record.turnstile_token;
  await assertHuman(request, env, token, surface);
  return JSON.stringify(record);
}
