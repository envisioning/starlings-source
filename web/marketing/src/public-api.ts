import type { ControlErrorCode, ControlErrorBody } from '@starlings/contracts';
import { interestConfirmResponseSchema, type InterestConfirmResponse } from '@starlings/contracts/interest';
class PublicRequestError extends Error {
  constructor(message: string, readonly code?: ControlErrorCode) { super(message); }
}
export function errorCodeOf(error: unknown): ControlErrorCode | undefined {
  return error instanceof PublicRequestError ? error.code : undefined;
}
/** How long a send may take before the site gives up and offers Retry. */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * The product site can submit an enquiry. It has no session-bearing API client.
 * A timeout or a dropped connection throws the fallback error with no code,
 * which the form treats as worth a retry.
 */
export async function apiFetch(path: '/interest', options: { body: unknown; fallbackError: string }): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new PublicRequestError(options.fallbackError);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ControlErrorBody | null;
    throw new PublicRequestError(body?.error ?? options.fallbackError, body?.code);
  }
}

/**
 * The person confirms what their agent sent (docs/FORMS.md §Agents). A spent
 * or expired link throws with `link_expired`; anything else unreadable throws
 * the fallback error.
 */
export async function confirmInterest(token: string, fallbackError: string): Promise<InterestConfirmResponse> {
  let response: Response;
  try {
    response = await fetch('/api/interest/confirm', { method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new PublicRequestError(fallbackError);
  }
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const error = body as ControlErrorBody | null;
    throw new PublicRequestError(error?.error ?? fallbackError, error?.code);
  }
  const parsed = interestConfirmResponseSchema.safeParse(body);
  if (!parsed.success) throw new PublicRequestError(fallbackError);
  return parsed.data;
}

/**
 * A signup call (docs/ONBOARDING.md §The signup page). The site Worker answers
 * every outcome as a contract shape, a refusal included, so the body is read
 * whatever the status. A body the contract does not parse, a timeout or a
 * dropped connection throws the fallback error.
 */
export async function signupFetch<T>(path: '/signup/view' | '/signup/slug' | '/signup/submit', options: {
  body: unknown;
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } };
  fallbackError: string;
  signal?: AbortSignal;
}): Promise<T> {
  let raw: unknown;
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(`/api${path}`, { method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    raw = await response.json();
  } catch (caught) {
    if (options.signal?.aborted) throw caught;
    throw new PublicRequestError(options.fallbackError);
  }
  const parsed = options.schema.safeParse(raw);
  if (!parsed.success) throw new PublicRequestError(options.fallbackError);
  return parsed.data;
}
