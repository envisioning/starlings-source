import { apiBase, responseError } from './config';
import { recordMeetError } from './meeting-error-log';
import { reportApiFailure } from './operational-errors';
import { t } from './i18n';

/**
 * The one place a browser request to the control plane is built: JSON body,
 * bearer header, keepalive, and the error-body → Error mapping.
 *
 * Being the one place, it is also where every control-plane failure is recorded
 * for the Debug report — callers that swallow an error (polls, presence beats)
 * still leave a trace of why.
 */
export async function apiFetch<T>(path: string, options: {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string;
  fallbackError: string;
  keepalive?: boolean;
  noStore?: boolean;
  signal?: AbortSignal;
}): Promise<T> {
  const result = await apiFetchConditional<T>(path, options);
  // Without `ifNoneMatch` the Worker never answers 304, so this is the body.
  if (result.unchanged) throw new Error(options.fallbackError);
  return result.value;
}

/**
 * `apiFetch` for a snapshotted list read (docs/CACHING.md §Revalidation): the
 * snapshot's validator goes out as `If-None-Match`, and a 304 comes back as
 * `{ unchanged: true, etag }` with no body — the caller keeps what it has.
 */
export async function apiFetchConditional<T>(path: string, options: {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string;
  fallbackError: string;
  keepalive?: boolean;
  noStore?: boolean;
  ifNoneMatch?: string | null;
  /** Aborting cancels the request itself, not only the wait for it. */
  signal?: AbortSignal;
}): Promise<{ unchanged: false; value: T; etag: string | null } | { unchanged: true; etag: string | null }> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.ifNoneMatch ? { 'if-none-match': options.ifNoneMatch } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.keepalive ? { keepalive: true } : {}),
      ...(options.noStore ? { cache: 'no-store' as RequestCache } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // Offline, DNS, CORS — never reached the Worker, so there is no status
    // to report and this is the only record that it happened. An abort is
    // the caller's own doing and leaves no record.
    if (!options.signal?.aborted) {
      recordMeetError(requestContext(method, path), error);
      // The reporter decides what counts: a read that failed here does not.
      reportApiFailure({ method, path }, error);
    }
    throw error;
  }
  if (response.status === 304 && options.ifNoneMatch) {
    return { unchanged: true, etag: response.headers.get('etag') };
  }
  if (!response.ok) {
    const failure = await responseError(response, options.fallbackError);
    recordMeetError(requestContext(method, path), failure);
    reportApiFailure({ method, path }, failure);
    throw failure;
  }
  return { unchanged: false, value: await readJSON<T>(response, method, path), etag: response.headers.get('etag') };
}

/**
 * A 2xx whose body is not JSON is the Worker's fault, not the caller's. A
 * 204 has no body by design, so its failed parse is not reported.
 */
async function readJSON<T>(response: Response, method: string, path: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch (error) {
    if (response.status !== 204) reportApiFailure({ method, path, decode: true }, error);
    throw error;
  }
}

/**
 * Raw bytes, not JSON. The one request here that carries megabytes, so it
 * skips `JSON.stringify` entirely and sends the file as its own body.
 *
 * Shares the error mapping and the Debug-report trail with `apiFetch`, because
 * an upload that fails is exactly the kind of thing somebody reports.
 */
export async function apiUpload<T>(path: string, file: Blob, fallbackError: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method: 'PUT',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch (error) {
    recordMeetError(requestContext('PUT', path), error);
    reportApiFailure({ method: 'PUT', path }, error);
    throw error;
  }
  if (!response.ok) {
    const failure = await responseError(response, fallbackError);
    recordMeetError(requestContext('PUT', path), failure);
    reportApiFailure({ method: 'PUT', path }, failure);
    throw failure;
  }
  return await readJSON<T>(response, 'PUT', path);
}

/**
 * An authenticated read served as an object URL, for drawing an attachment.
 *
 * A plain `<img src>` would be an unauthenticated request, and the route
 * refuses those — which is the point: an attachment is private to the members
 * of its conversation, so its bytes can never be a link somebody passes on.
 * The caller owns the URL and must revoke it.
 */
export async function apiObjectURL(path: string): Promise<string | null> {
  try {
    const response = await fetch(`${apiBase}${path}`);
    if (!response.ok) return null;
    return URL.createObjectURL(await response.blob());
  } catch (error) {
    recordMeetError(requestContext('GET', path), error);
    return null;
  }
}

/** Vite-only: mint the owner cookie, then the caller reloads. */
export async function mintLocalOwnerSession(): Promise<void> {
  await apiFetch('/dev/session', {
    method: 'POST',
    body: { name: 'Rosa', email: 'rosa@example.com' },
    fallbackError: t('Couldn’t sign in.'),
  });
}

/** `POST /rooms/rosa/join-requests` — path only, so query tokens never land in a report. */
function requestContext(method: string, path: string): string {
  return `${method} ${path.split('?')[0]}`;
}
