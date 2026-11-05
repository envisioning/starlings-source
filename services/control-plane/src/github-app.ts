// The Starlings GitHub App, the workspace side (docs/GITHUB_CONNECTOR.md "One
// App, one broker"). The connector sync (github-connector.ts) and the issues
// path read api.github.com with an installation token. This Worker holds no
// App key: it asks the token broker in starlings-auth over the `GITHUB`
// service binding, whose props name this workspace, and the broker mints a
// token only for the installation this workspace connected.
import {
  GITHUB_BROKER_VERSION,
  githubStatusResultSchema,
  githubTokenResultSchema,
  type GithubBeginInput,
  type GithubCompleteInput,
  type GithubConnection,
  type GithubPlainInput,
} from '@starlings/contracts/github-app';
import { ControlError } from './errors';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

export class GithubError extends ControlError {}

/** The RPC surface of `GithubService` in src/auth-worker/index.ts. Answers are decoded, never trusted. No argument names a workspace. */
export interface GithubBrokerBinding {
  begin(input: GithubBeginInput): Promise<unknown>;
  complete(input: GithubCompleteInput): Promise<unknown>;
  status(input: GithubPlainInput): Promise<unknown>;
  token(input: GithubPlainInput): Promise<unknown>;
  disconnect(input: GithubPlainInput): Promise<unknown>;
}

/** The `GITHUB` binding, or null on a Worker that has none. */
export function githubBroker(env: Env): GithubBrokerBinding | null {
  const binding = (env as { GITHUB?: unknown }).GITHUB;
  return binding && typeof (binding as { token?: unknown }).token === 'function' ? binding as GithubBrokerBinding : null;
}

/** True when this Worker can reach the broker. Whether the workspace connected GitHub is `githubConnection`. */
export function githubAppAvailable(env: Env): boolean {
  return githubBroker(env) !== null;
}

const plain = { v: GITHUB_BROKER_VERSION } as const;
/** Per isolate and per workspace origin: tests run several workspaces in one isolate. */
const cacheKey = (env: Env) => String(env.WEB_ORIGIN ?? '');
/** A connect or a disconnect clears it; an uninstall on GitHub shows within this long. */
const STATUS_TTL_MS = 60_000;
const statuses = new Map<string, { at: number; connection: GithubConnection | null }>();

/**
 * The installation this workspace connected, or null: no binding, the broker
 * holds no App, or nothing is connected. A broker that does not answer reads
 * as not connected and is logged.
 */
export async function githubConnection(env: Env): Promise<GithubConnection | null> {
  const broker = githubBroker(env);
  if (!broker) return null;
  const held = statuses.get(cacheKey(env));
  if (held && Date.now() - held.at < STATUS_TTL_MS) return held.connection;
  let connection: GithubConnection | null = null;
  try {
    const answer = githubStatusResultSchema.parse(await broker.status(plain));
    connection = answer.ok ? answer.connection : null;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'github.broker.status_failed', error: error instanceof Error ? error.name : 'unknown' }));
    return null;
  }
  statuses.set(cacheKey(env), { at: Date.now(), connection });
  return connection;
}

/** The App can read for this workspace: a binding, and an installation connected through it. The kill switch is separate. */
export async function githubAppConnected(env: Env): Promise<boolean> {
  return (await githubConnection(env)) !== null;
}

// ------------------------------------------------- the installation token

/**
 * One token per workspace per isolate, renewed five minutes before GitHub
 * expires it. Never written anywhere: a queue message or a D1 row holding it
 * would be a credential at rest, and the broker mints one in one call.
 */
const tokens = new Map<string, { token: string; expiresAt: number }>();

export function resetGithubTokenCache(): void {
  tokens.clear();
  statuses.clear();
}

async function installationToken(env: Env): Promise<string> {
  const key = cacheKey(env);
  const held = tokens.get(key);
  if (held && held.expiresAt - Date.now() > 5 * 60_000) return held.token;
  const broker = githubBroker(env);
  if (!broker) throw new GithubError('The GitHub connector is not configured.', 503, 'not_configured');
  const answer = githubTokenResultSchema.parse(await broker.token(plain));
  if (!answer.ok) {
    if (answer.reason === 'github_failed') throw new GithubError('GitHub refused the App.', 502);
    throw new GithubError('GitHub is not connected.', 503, 'not_configured');
  }
  tokens.set(key, { token: answer.token, expiresAt: answer.expiresAt });
  return answer.token;
}

// ------------------------------------------------------------------ fetch

export interface GithubPage<T> {
  items: T[];
  /** True when the `Link` header named a next page. */
  hasNext: boolean;
}

/**
 * One GitHub read as the App. A 401 drops the cached token and retries once,
 * because an installation token GitHub revoked early is the only 401 this
 * can meet. A secondary rate limit surfaces as `GithubRateLimited` with
 * `retryAfterSeconds`, so the queue can re-enqueue with a delay rather than
 * hammer.
 */
export interface GithubRawInit {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  searchParams?: Record<string, string>;
}

/**
 * The one HTTP call. Answers whatever GitHub answered, apart from the two
 * cases every caller handles the same way: a 401 drops the cached token and
 * retries once, and a rate limit throws `GithubRateLimited`. Callers that
 * treat a 404 as "none" (an issue's timeline, its children) read the status
 * themselves.
 */
export async function githubRaw(env: Env, path: string, init: GithubRawInit = {}): Promise<Response> {
  const url = new URL(path.startsWith('http') ? path : `${GITHUB_API_ORIGIN}${path}`);
  for (const [key, value] of Object.entries(init.searchParams ?? {})) url.searchParams.set(key, value);
  let retried = false;
  for (;;) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await installationToken(env)}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      'user-agent': 'meet-control-plane',
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 && !retried) {
      retried = true;
      resetGithubTokenCache();
      continue;
    }
    if (response.status === 403 || response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '60');
      throw new GithubRateLimited(`GitHub rate limit (${response.status}).`, Number.isFinite(retryAfter) ? retryAfter : 60);
    }
    return response;
  }
}

async function githubRequest(env: Env, path: string, searchParams: Record<string, string>): Promise<{ body: unknown; link: string }> {
  const response = await githubRaw(env, path, { searchParams });
  const pathname = new URL(path.startsWith('http') ? path : `${GITHUB_API_ORIGIN}${path}`).pathname;
  if (response.status === 404) {
    throw new GithubError(`GitHub has no ${pathname}.`, 404, 'room_not_found');
  }
  if (!response.ok) {
    throw new GithubError(`GitHub answered ${response.status} for ${pathname}.`, 502);
  }
  return { body: await response.json(), link: response.headers.get('link') ?? '' };
}

/** A list endpoint: the items, and whether the `Link` header named a next page. */
export async function githubFetch<T>(env: Env, path: string, init: { searchParams?: Record<string, string> } = {}): Promise<GithubPage<T>> {
  const { body, link } = await githubRequest(env, path, init.searchParams ?? {});
  const wrapped = body as T[] | { repositories?: T[]; check_runs?: T[] };
  const items = Array.isArray(wrapped) ? wrapped : (wrapped.repositories ?? wrapped.check_runs ?? []);
  return { items, hasNext: /rel="next"/u.test(link) };
}

/** A single-resource endpoint. */
export async function githubGet<T>(env: Env, path: string): Promise<T> {
  const { body } = await githubRequest(env, path, {});
  return body as T;
}

export class GithubRateLimited extends GithubError {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message, 429);
  }
}

// -------------------------------------------------------------- the shapes

export interface GithubRepository {
  /** GitHub's numeric id: the one name a rename keeps. */
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  archived: boolean;
  pushed_at: string | null;
  open_issues_count: number;
}

export interface GithubPull {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  body: string | null;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  requested_reviewers?: Array<{ login: string }>;
}

export interface GithubReview {
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  user: { login: string } | null;
  submitted_at: string | null;
}

export interface GithubCheckRun {
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
}

/** Every repository the installation can see, all pages. */
export async function listInstallationRepositories(env: Env): Promise<GithubRepository[]> {
  const repos: GithubRepository[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await githubFetch<GithubRepository>(env, '/installation/repositories', {
      searchParams: { per_page: '100', page: String(page) },
    });
    repos.push(...result.items);
    if (!result.hasNext) break;
  }
  return repos;
}
