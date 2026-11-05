// Request/response plumbing shared by every route module.
import { JSON_BODY_MAX_BYTES } from '@docs/contracts';
import { AuthError, DocsError } from './errors';

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/** Trusted mutations come from the web origin (browser) or carry a bearer token. */
export function assertTrustedMutation(request: Request, env: Env): void {
  if (request.headers.get('authorization')?.startsWith('Bearer ')) return;
  assertWebOrigin(request, env);
}

export function assertWebOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('origin');
  // Same-origin form posts and non-CORS navigations send no Origin header at
  // all; only reject a header that is present and wrong.
  if (origin !== null && origin !== env.WEB_ORIGIN) {
    throw new AuthError('Untrusted request origin.', 403, 'forbidden');
  }
}

/**
 * Spend one token against a Workers rate-limit binding, keyed per caller IP.
 * A missing binding is not an error — the test Worker has none — so never let
 * this be the only thing standing in front of something expensive.
 */
export async function assertUnderRateLimit(
  limiter: RateLimit | undefined,
  request: Request,
  scope: string,
): Promise<void> {
  if (!limiter) return;
  const key = `${scope}:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`;
  const { success } = await limiter.limit({ key });
  if (!success) {
    throw new DocsError('Too many requests — wait a minute and try again.', 429, 'rate_limited');
  }
}

export async function readBoundedJSON(request: Request, maxBytes = JSON_BODY_MAX_BYTES): Promise<unknown> {
  const text = await readBoundedText(request, maxBytes);
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DocsError('Request body must be valid JSON.', 400, 'invalid_request');
  }
}

export async function readBoundedText(request: Request, maxBytes = JSON_BODY_MAX_BYTES): Promise<string> {
  const bytes = await readBoundedBytes(request, maxBytes);
  return new TextDecoder().decode(bytes);
}

export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
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
      throw new DocsError('Request body is too large.', 413, 'invalid_request');
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

/** Request metadata every audit row records. */
export function requestContext(request: Request): {
  ip: string | null;
  userAgent: string | null;
  referrer: string | null;
} {
  return {
    ip: request.headers.get('cf-connecting-ip'),
    userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
    referrer: request.headers.get('referer')?.slice(0, 2000) ?? null,
  };
}
