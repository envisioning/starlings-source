// Request/response plumbing shared by the router and the schedule proxy.
import { isWorkspaceOrigin } from './workspace-origins';
import { JSON_BODY_MAX_BYTES } from './contracts';
import { AuthError, ControlError, FieldError } from './errors';
import { formRefusal, type FormID } from '@starlings/contracts/form-fields';
import type { z } from 'zod';
import { isBearerRequest } from './auth';
import { RoomError } from './room-coordinator';

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

/**
 * `json`, plus a validator (docs/CACHING.md §Revalidation). The body is hashed
 * into a weak ETag; a request carrying it back in `If-None-Match` gets 304 and
 * no body, and the client keeps painting its snapshot.
 *
 * Honest about what it saves: the Worker still did the read — this spares the
 * bytes and the client's decode, not the Core fan-out behind it. Weak, because
 * the hash is over our serialization and nothing byte-range-fetches this.
 */
export async function jsonConditional(request: Request, value: unknown): Promise<Response> {
  const body = JSON.stringify(value);
  const etag = await weakETag(body);
  if (matchesETag(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-store' } });
  }
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', etag },
  });
}

async function weakETag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `W/"${hex}"`;
}

/** RFC 9110 §13.1.2 weak comparison: `W/` prefixes are ignored, `*` matches anything. */
function matchesETag(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = (tag: string) => tag.trim().replace(/^W\//u, '');
  return header.split(',').some((candidate) => strip(candidate) === strip(etag));
}

/** Trusted mutations come from the web origin (browser) or carry a bearer token (native). */
export function assertTrustedMutation(request: Request, env: Env): void {
  if (isBearerRequest(request)) return;
  assertWebOrigin(request, env);
}

export function assertWebOrigin(request: Request, env: Env): void {
  if (!isWorkspaceOrigin(request.headers.get('origin'), env)) throw new AuthError('Untrusted request origin.', 403, 'untrusted_origin');
}

/**
 * Spend one token against a Workers rate-limit binding, keyed per caller IP.
 *
 * A missing binding is not an error: the vitest Worker has none, and neither
 * does any deploy from a wrangler config that predates them. The route then
 * behaves exactly as it did before — so never let this be the *only* thing
 * standing in front of something expensive.
 *
 * Windows are 10s or 60s (Cloudflare's own constraint), so these are burst
 * guards, not hourly quotas. Sustained abuse is Turnstile's job.
 */
export async function assertUnderRateLimit(
  limiter: RateLimit | undefined,
  request: Request,
  scope: string,
  /** Narrows the bucket below the address — a room, so one room's crowd is not another room's. */
  within?: string,
): Promise<void> {
  if (!limiter) return;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const key = within ? `${scope}:${within}:${ip}` : `${scope}:${ip}`;
  const { success } = await limiter.limit({ key });
  if (!success) {
    throw new ControlError('Too many requests — wait a minute and try again.', 429, 'rate_limited');
  }
}

export async function readBoundedJSON(request: Request, maxBytes = JSON_BODY_MAX_BYTES): Promise<unknown> {
  const text = await readBoundedText(request, maxBytes);
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new RoomError('Request body must be valid JSON.', 400, 'invalid_request');
  }
}

export async function readBoundedText(request: Request | Response, maxBytes = JSON_BODY_MAX_BYTES): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(request, maxBytes));
}

/**
 * The same bounded read for a body that is not text — an uploaded profile
 * picture is the only one so far. Streamed and counted rather than buffered
 * whole by `arrayBuffer()`, so an oversized upload is refused while it is
 * still arriving instead of after it has all been held.
 */
export async function readBoundedBytes(request: Request | Response, maxBytes = JSON_BODY_MAX_BYTES): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new RoomError('Request body is too large.', 413, 'invalid_request');
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

/**
 * A Work form's body, parsed. A refusal that names one of the form's fields
 * answers 400 with a sentence for that field and the field's key
 * (`formRefusal`), never zod's own words ("Invalid UUID"). Any other refusal
 * throws as a plain parse would.
 */
export function parseFormBody<Schema extends z.ZodType>(schema: Schema, form: FormID | ((input: unknown) => FormID), input: unknown): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const refusal = formRefusal(typeof form === 'function' ? form(input) : form, parsed.error.issues);
  if (refusal) throw new FieldError(refusal.message, refusal.field);
  throw parsed.error;
}

/** A subject create names its form by `kind`: a lead's, or else a project's. */
export const subjectForm = (input: unknown): FormID =>
  typeof input === 'object' && input !== null && (input as { kind?: unknown }).kind === 'lead' ? 'lead' : 'project';
