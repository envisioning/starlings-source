// Request/response plumbing shared by every route module.
import { JSON_BODY_MAX_BYTES } from '@keep/contracts';
import { AuthError, KeepError } from './errors';

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/**
 * A cookie mutation must come from the web origin; a bearer mutation is a
 * device, not a browser, and carries no ambient credential to forge. This
 * plus SameSite=Lax is the whole CSRF story.
 */
export function assertTrustedMutation(request: Request, env: Env): void {
  if (request.headers.get('authorization')?.startsWith('Bearer ')) return;
  assertWebOrigin(request, env);
}

/** Same-origin form posts send no Origin header; only reject one that is present and wrong. */
export function assertWebOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== env.WEB_ORIGIN) {
    throw new AuthError('Untrusted request origin.', 403, 'forbidden');
  }
}

/**
 * Spend one token against a Workers rate-limit binding, keyed per caller.
 * A missing binding is not an error — the test Worker has none.
 */
export async function assertUnderRateLimit(limiter: RateLimit | undefined, key: string): Promise<void> {
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) {
    throw new KeepError('Too many reveals — wait a minute and try again.', 429, 'rate_limited');
  }
}

export async function readBoundedText(request: Request, maxBytes = JSON_BODY_MAX_BYTES): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(request, maxBytes));
}

export async function readBoundedJSON(request: Request, maxBytes = JSON_BODY_MAX_BYTES): Promise<unknown> {
  const text = await readBoundedText(request, maxBytes);
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new KeepError('Request body must be valid JSON.', 400, 'invalid_request');
  }
}

async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new KeepError('Request body is too large.', 413, 'invalid_request');
    }
    chunks.push(result.value);
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
