// The GitHub connector (docs/GITHUB_CONNECTOR.md): repositories
// mapped to subjects, pull requests read by an hourly pass into
// `github_pulls`, and the ledger that says how far each repository has been
// read. Issues keep their path through Core; this is the second list.
//
// The mapping, the ledger and the pulse are `import-ledger.ts`, shared with
// every other connector (docs/CONNECTORS.md).
import type {
  ConnectorStatus,
  CrmGithubRepo,
  GithubConnectorResponse,
  GithubConnectorRow,
  GithubMappingInput,
  GithubRepoJob,
  ImportItemState,
  PullCheckState,
  PullItem,
  PullReviewState,
  PullState,
  PullsResponse,
} from './contracts';
import { createCrmProjectRepo, fetchCrmProjectRepos, fetchCrmSubject, workModelEnabled } from './crm';
import { ControlError } from './errors';
import {
  GithubRateLimited,
  githubAppAvailable,
  githubConnection,
  githubFetch,
  githubGet,
  listInstallationRepositories,
  type GithubCheckRun,
  type GithubPull,
  type GithubRepository,
  type GithubReview,
} from './github-app';
import {
  connectorPulse,
  readItem,
  readItems,
  readMapping,
  readMappings,
  resetItems,
  stateOf,
  touchConnector,
  writeItem,
  writeMapping,
  type ItemRow,
  type MappingRow as LedgerMapping,
} from './import-ledger';
import { noteGithubRepositories } from './github-renames';
import { githubIssueEventKey, githubIssueLine, postSubjectEvent, type GithubIssueVerb } from './threads';

const SOURCE = 'github';
/**
 * The issues phase keeps its cursor in its own ledger row rather than a second
 * column on `import_ledger`, which every connector shares. A separate
 * `source` is invisible to `readItems`, so the connector card still counts
 * pulls and nothing but pulls.
 */
const ISSUE_SOURCE = 'github-issues';
/** Pulls per page the sync asks for. GitHub caps at 100; 50 keeps a job short. */
const PAGE_SIZE = 50;
/** The scheduled pass runs every five minutes; the sync wants one tick an hour. */
const SYNC_INTERVAL_MS = 55 * 60_000;
/** A webhook older than this while the sync still finds news is the stale case. */
const WEBHOOK_STALE_MS = 24 * 60 * 60_000;
/**
 * Lines one issues page may write. A repository whose whole backlog is touched
 * at once — a label rename, a milestone close — must not turn one pass into a
 * hundred channel lines. Past the cap the pass still advances its cursor, so
 * the overflow is dropped rather than replayed on the next pass.
 */
const ANNOUNCE_CAP = 20;

export class GithubConnectorError extends ControlError {}

/** The kill switch is on and this workspace connected GitHub through the broker. */
export async function githubSyncEnabled(env: Env): Promise<boolean> {
  return String(env.GITHUB_SYNC_ENABLED ?? 'off') === 'on' && (await githubConnection(env)) !== null;
}

const repoId = (owner: string, repo: string): string => `${owner}/${repo}`;

/**
 * Both halves of one repository's pass, each from its own cursor.
 *
 * The phases are queued side by side rather than chained, because they answer
 * to different failures: a pulls pass that keeps failing on a rate limit must
 * not also stop the channel lines, which are the half a person notices
 *.
 */
async function enqueueRepoPasses(env: Env, owner: string, repo: string): Promise<void> {
  const id = repoId(owner, repo);
  const [pulls, issues] = await Promise.all([readItem(env, SOURCE, id), readItem(env, ISSUE_SOURCE, id)]);
  await env.IMPORT_JOBS.send({ kind: 'github-repo', owner, repo, phase: 'pulls', since: pulls?.cursor ?? null } satisfies GithubRepoJob);
  await env.IMPORT_JOBS.send({ kind: 'github-repo', owner, repo, phase: 'issues', since: issues?.cursor ?? null } satisfies GithubRepoJob);
}

function log(level: 'info' | 'error', message: string, data: Record<string, unknown>): void {
  const entry = JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...data });
  if (level === 'error') console.error(entry);
  else console.log(entry);
}

// ---------------------------------------------------------------- the ledger

type MappingRow = LedgerMapping<'project' | 'lead'>;

function toRow(repo: GithubRepository, mapping: MappingRow | null | undefined, item: ItemRow | null | undefined): GithubConnectorRow {
  return {
    id: repo.full_name,
    owner: repo.owner.login,
    repo: repo.name,
    description: repo.description,
    private: repo.private,
    archived: repo.archived,
    pushed_at: repo.pushed_at,
    open_issues: repo.open_issues_count,
    mapping: mapping
      ? {
        subject_kind: mapping.subject_kind,
        subject_id: mapping.subject_id,
        subject_title: mapping.subject_title,
        decided_by: mapping.decided_by,
        decided_at: mapping.decided_at,
      }
      : null,
    state: stateOf(mapping, item),
    pulls: item?.count ?? 0,
    cursor: item?.cursor ?? null,
    last_synced_at: item?.last_synced_at ?? null,
    error: item?.error ?? null,
  };
}

// ------------------------------------------------------------------ the list

/**
 * `/connectors/github`: every repository the App sees, with its mapping and
 * ledger. A workspace that has not connected GitHub gets no rows and
 * `connected: false`, so the page offers Connect GitHub.
 */
export async function githubConnectorList(env: Env): Promise<GithubConnectorResponse> {
  if (!githubAppAvailable(env)) {
    throw new GithubConnectorError('The GitHub connector is not configured.', 503, 'not_configured');
  }
  const connection = await githubConnection(env);
  if (!connection) return { configured: true, connected: false, account: null, enabled: false, rows: [] };
  // The list first: a repository renamed on GitHub moves its stored rows to
  // the new name before the mappings are read.
  const repos = await listInstallationRepositories(env);
  await noteGithubRepositories(env, repos);
  const [mappings, items] = await Promise.all([
    readMappings<'project' | 'lead'>(env, SOURCE),
    readItems(env, SOURCE),
  ]);
  repos.sort((a, b) => (b.pushed_at ?? '').localeCompare(a.pushed_at ?? ''));
  return {
    configured: true,
    connected: true,
    account: connection.account,
    enabled: await githubSyncEnabled(env),
    rows: repos.map((repo) => toRow(repo, mappings.get(repo.full_name), items.get(repo.full_name))),
  };
}

async function readRepository(env: Env, owner: string, repo: string): Promise<GithubRepository> {
  return githubGet<GithubRepository>(env, `/repos/${owner}/${repo}`);
}

/**
 * The decision: map a repository to a subject, or skip it. A project mapping
 * is written through to the work store's project link (Core's, or D1's on a
 * D1 workspace) so the issues list shows the same repository. That write is best effort:
 * Core refusing (a shared repository needs a label there) leaves Meet's
 * mapping in place and the pulls sync running.
 */
export async function saveGithubMapping(
  env: Env,
  owner: string,
  repo: string,
  input: GithubMappingInput,
  actor: string,
): Promise<GithubConnectorRow> {
  if (!(await githubConnection(env))) {
    throw new GithubConnectorError('GitHub is not connected.', 503, 'not_configured');
  }
  // GitHub answers an old name with the renamed repository: map it under the
  // name it has now.
  const repository = await readRepository(env, owner, repo);
  await noteGithubRepositories(env, [repository]);
  owner = repository.owner.login;
  repo = repository.name;
  const id = repoId(owner, repo);
  await writeMapping(env, SOURCE, id, { ...input, subject_title: input.subject_title ?? null }, actor);

  if (input.subject_kind === 'project' && input.subject_id && workModelEnabled(env)) {
    try {
      const linked = await fetchCrmProjectRepos(env, input.subject_id);
      if (!linked.some((link) => link.owner === owner && link.repo === repo)) {
        await createCrmProjectRepo(env, { project_id: input.subject_id, owner, repo }, actor);
      }
    } catch (error) {
      log('error', 'github.mapping.core_link_failed', {
        repo: id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  if (input.subject_kind) {
    const existing = await readItem(env, SOURCE, id);
    if (!existing || existing.status === 'failed') {
      await writeItem(env, SOURCE, id, { status: 'queued', error: null });
    }
    if (await githubSyncEnabled(env)) await enqueueRepoPasses(env, owner, repo);
  }

  const [mapping, item] = await Promise.all([readMapping<'project' | 'lead'>(env, SOURCE, id), readItem(env, SOURCE, id)]);
  return toRow(repository, mapping, item);
}

/** The picker's row for one repository: a mapping has no label or milestone. */
function linkRow(owner: string, repo: string, isPrimary: boolean): CrmGithubRepo {
  return { id: repoId(owner, repo), owner, repo, label: null, milestone: null, is_primary: isPrimary };
}

/**
 * Repositories this App can see, for the Work link picker. Archived ones are
 * left out: nothing new is filed there. Newest push first, fifty at most.
 */
export async function searchGithubRepos(env: Env, query: string): Promise<CrmGithubRepo[]> {
  const needle = query.trim().toLowerCase();
  const repos = await listInstallationRepositories(env);
  await noteGithubRepositories(env, repos);
  return repos
    .filter((repo) => !repo.archived && (!needle || repo.full_name.toLowerCase().includes(needle)))
    .sort((a, b) => (b.pushed_at ?? '').localeCompare(a.pushed_at ?? ''))
    .slice(0, 50)
    .map((repo) => linkRow(repo.owner.login, repo.name, false));
}

/**
 * Link a repository to a project from Work ( step 2): Meet's mapping,
 * written through to Core by `saveGithubMapping`. A mapping holds one subject,
 * so a repository that already serves another subject is refused rather than
 * moved.
 */
export async function linkGithubRepoToProject(
  env: Env,
  input: { project_id: string; owner: string; repo: string; is_primary?: boolean | undefined },
  actor: string,
): Promise<CrmGithubRepo> {
  // The names go into a GitHub API path: the connector route's pattern, here too.
  const name = /^[A-Za-z0-9_.-]{1,100}$/u;
  if (!name.test(input.owner) || !name.test(input.repo)) {
    throw new GithubConnectorError('That is not a repository name.', 400, 'invalid_request');
  }
  const id = repoId(input.owner, input.repo);
  const existing = await readMapping<'project' | 'lead'>(env, SOURCE, id);
  if (existing?.subject_id && existing.subject_id !== input.project_id) {
    const other = existing.subject_title ?? 'another subject';
    throw new GithubConnectorError(`${id} already serves ${other}.`, 409, 'invalid_request');
  }
  const project = await fetchCrmSubject(env, 'project', input.project_id).catch(() => null);
  await saveGithubMapping(env, input.owner, input.repo, {
    subject_kind: 'project',
    subject_id: input.project_id,
    subject_title: project?.title ?? existing?.subject_title ?? null,
  }, actor);
  return linkRow(input.owner, input.repo, input.is_primary ?? false);
}

/** Enqueue one repository's pass now, from the list's Sync button. */
export async function syncGithubRepoNow(env: Env, owner: string, repo: string): Promise<void> {
  if (!(await githubSyncEnabled(env))) {
    throw new GithubConnectorError('The GitHub sync is off.', 503, 'not_configured');
  }
  const id = repoId(owner, repo);
  const mapping = await readMapping<'project' | 'lead'>(env, SOURCE, id);
  if (!mapping?.subject_kind) throw new GithubConnectorError('Map the repository first.', 409, 'invalid_request');
  await writeItem(env, SOURCE, id, { status: 'queued', error: null });
  await enqueueRepoPasses(env, owner, repo);
}

/**
 * Reverse one repository: every pull it wrote goes, the cursor resets, the
 * mapping stays. Required before the first production mapping, because the
 * first one will be wrong somewhere.
 */
export async function reverseGithubRepo(env: Env, owner: string, repo: string): Promise<{ removed: number }> {
  const id = repoId(owner, repo);
  const result = await env.USAGE.prepare('DELETE FROM github_pulls WHERE owner = ?1 AND repo = ?2').bind(owner, repo).run();
  await resetItems(env, [SOURCE, ISSUE_SOURCE], id);
  return { removed: result.meta.changes ?? 0 };
}

// ------------------------------------------------------------------ the sync

function pullState(pull: GithubPull): PullState {
  if (pull.merged_at) return 'merged';
  if (pull.state === 'closed') return 'closed';
  if (pull.draft) return 'draft';
  return 'open';
}

function reviewState(pull: GithubPull, reviews: GithubReview[]): PullReviewState {
  // Latest verdict per reviewer; a later approval clears an earlier request.
  const latest = new Map<string, GithubReview['state']>();
  for (const review of reviews) {
    if (!review.user || review.state === 'COMMENTED' || review.state === 'PENDING') continue;
    latest.set(review.user.login, review.state);
  }
  const verdicts = [...latest.values()];
  if (verdicts.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (verdicts.includes('APPROVED')) return 'approved';
  if ((pull.requested_reviewers?.length ?? 0) > 0) return 'requested';
  return 'none';
}

function checkState(runs: GithubCheckRun[]): PullCheckState {
  if (runs.length === 0) return 'none';
  if (runs.some((run) => run.status !== 'completed')) return 'pending';
  if (runs.some((run) => run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'action_required')) return 'failure';
  return 'success';
}

/** `Closes #12`, `fixes #7`, `resolves #3` — GitHub's own keyword list. */
function closesFrom(body: string | null): number[] {
  if (!body) return [];
  const numbers = new Set<number>();
  for (const match of body.matchAll(/\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d{1,7})\b/giu)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

async function upsertPull(env: Env, owner: string, repo: string, pull: GithubPull, review: PullReviewState, checks: PullCheckState): Promise<void> {
  await env.USAGE.prepare(
    `INSERT INTO github_pulls (id, owner, repo, number, title, url, state, review, checks, author_login, closes, head_ref, head_sha, created_at, updated_at, merged_at, closed_at, synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, url = excluded.url, state = excluded.state, review = excluded.review,
       checks = excluded.checks, author_login = excluded.author_login, closes = excluded.closes,
       head_ref = excluded.head_ref, head_sha = excluded.head_sha, updated_at = excluded.updated_at,
       merged_at = excluded.merged_at, closed_at = excluded.closed_at, synced_at = excluded.synced_at`,
  ).bind(
    `${owner}/${repo}#${pull.number}`, owner, repo, pull.number, pull.title.slice(0, 500), pull.html_url,
    pullState(pull), review, checks, pull.user?.login ?? null, JSON.stringify(closesFrom(pull.body)),
    pull.head?.ref ?? null, pull.head?.sha ?? null, pull.created_at, pull.updated_at, pull.merged_at, pull.closed_at, Date.now(),
  ).run();
}

/**
 * One page of one repository's pulls, newest updated first. Stops at the
 * first pull not newer than `since` (the last pass's cursor), else enqueues
 * the next page. Reviews and checks are read for open pulls only: a merged
 * pull's verdict is history GitHub keeps.
 */
async function processPullsPage(env: Env, job: GithubRepoJob): Promise<void> {
  const { owner, repo } = job;
  const id = repoId(owner, repo);
  if (!(await githubSyncEnabled(env))) {
    log('info', 'github.sync.skipped', { repo: id, reason: 'disabled' });
    return;
  }
  const mapping = await readMapping<'project' | 'lead'>(env, SOURCE, id);
  if (!mapping?.subject_kind) {
    log('info', 'github.sync.skipped', { repo: id, reason: 'unmapped' });
    return;
  }
  const page = job.page ?? 1;
  const item = await readItem(env, SOURCE, id);
  await writeItem(env, SOURCE, id, { status: 'importing', error: null });

  let pulls: GithubPull[];
  let hasNext: boolean;
  try {
    const result = await githubFetch<GithubPull>(env, `/repos/${owner}/${repo}/pulls`, {
      searchParams: { state: 'all', sort: 'updated', direction: 'desc', per_page: String(PAGE_SIZE), page: String(page) },
    });
    pulls = result.items;
    hasNext = result.hasNext;
  } catch (error) {
    if (error instanceof GithubRateLimited) {
      await env.IMPORT_JOBS.send(job, { delaySeconds: Math.min(3600, Math.max(30, error.retryAfterSeconds)) });
      log('info', 'github.sync.rate_limited', { repo: id, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    await writeItem(env, SOURCE, id, { status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' });
    throw error;
  }

  let newest = job.newest ?? null;
  let reachedCursor = false;
  let written = 0;
  for (const pull of pulls) {
    if (job.since && pull.updated_at <= job.since) { reachedCursor = true; break; }
    if (!newest || pull.updated_at > newest) newest = pull.updated_at;
    let review: PullReviewState = 'none';
    let checks: PullCheckState = 'none';
    if (pull.state === 'open') {
      const [reviews, runs] = await Promise.all([
        githubFetch<GithubReview>(env, `/repos/${owner}/${repo}/pulls/${pull.number}/reviews`, { searchParams: { per_page: '100' } }),
        githubFetch<GithubCheckRun>(env, `/repos/${owner}/${repo}/commits/${pull.head.sha}/check-runs`, { searchParams: { per_page: '100' } }),
      ]);
      review = reviewState(pull, reviews.items);
      checks = checkState(runs.items);
    }
    await upsertPull(env, owner, repo, pull, review, checks);
    written += 1;
  }

  const count = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM github_pulls WHERE owner = ?1 AND repo = ?2')
    .bind(owner, repo).first<{ n: number }>();

  if (hasNext && !reachedCursor) {
    await writeItem(env, SOURCE, id, { status: 'importing', count: count?.n ?? 0 });
    await env.IMPORT_JOBS.send({ ...job, page: page + 1, newest } satisfies GithubRepoJob);
    log('info', 'github.sync.page', { repo: id, page, written });
    return;
  }

  await writeItem(env, SOURCE, id, {
    status: 'synced',
    cursor: newest ?? job.since ?? item?.cursor ?? null,
    backfill_done: 1,
    count: count?.n ?? 0,
    last_synced_at: Date.now(),
    error: null,
  });
  await touchConnector(env, 'github', 'sync');
  log('info', 'github.sync.done', { repo: id, pages: page, written, cursor: newest ?? job.since ?? null });
}

// --------------------------------------------------------- the issues phase

/** The fields of GitHub's issue list this phase reads. */
export interface GithubIssueRow {
  number: number;
  title: string;
  state: 'open' | 'closed';
  state_reason?: string | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  user?: { login: string } | null;
  closed_by?: { login: string } | null;
  /** Present on a pull request. GitHub's issues list returns both kinds. */
  pull_request?: unknown;
}

/**
 * What an issue changed since the cursor is worth saying, and who did it.
 *
 * Only two changes are reported, because only two are certain from a list
 * payload: an issue filed after the cursor, and an issue closed after it. An
 * open issue that was created before the cursor has been edited somehow — a
 * label, an assignee, a comment, or a reopen — and the list cannot tell which,
 * so the sync says nothing rather than guess. The webhook reports reopens
 * whenever it is healthy.
 */
export function issueChange(issue: GithubIssueRow, since: string): { verb: GithubIssueVerb; actor: string | null } | null {
  if (issue.state === 'closed') {
    if (!issue.closed_at || issue.closed_at <= since) return null;
    return {
      verb: issue.state_reason === 'not_planned' ? 'closed_not_planned' : 'closed',
      actor: issue.closed_by?.login ?? null,
    };
  }
  if (issue.created_at <= since) return null;
  return { verb: 'filed', actor: issue.user?.login ?? null };
}

/**
 * One page of one repository's issues, newest updated first, written as
 * channel lines on the mapped subject.
 *
 * Nothing is stored: issues are read live everywhere else in Meet, and this
 * phase exists only to produce the lines Core's webhook produces when it
 * works. Both reporters derive the message id from `githubIssueEventKey`, so
 * whichever arrives second writes nothing — a healthy webhook always wins on
 * speed and keeps its better attribution.
 *
 * The first pass on a repository announces nothing. It reads one page, takes
 * the newest `updated_at` as the cursor, and stops: a repository's whole issue
 * history is not news, and there is no store to backfill into.
 */
async function processIssuesPage(env: Env, job: GithubRepoJob): Promise<void> {
  const { owner, repo } = job;
  const id = repoId(owner, repo);
  if (!(await githubSyncEnabled(env))) {
    log('info', 'github.issues.skipped', { repo: id, reason: 'disabled' });
    return;
  }
  const mapping = await readMapping<'project' | 'lead'>(env, SOURCE, id);
  if (!mapping?.subject_kind || !mapping.subject_id) {
    log('info', 'github.issues.skipped', { repo: id, reason: 'unmapped' });
    return;
  }
  const page = job.page ?? 1;
  const first = !job.since;

  let issues: GithubIssueRow[];
  let hasNext: boolean;
  try {
    const result = await githubFetch<GithubIssueRow>(env, `/repos/${owner}/${repo}/issues`, {
      searchParams: { state: 'all', sort: 'updated', direction: 'desc', per_page: String(PAGE_SIZE), page: String(page) },
    });
    issues = result.items;
    hasNext = result.hasNext;
  } catch (error) {
    if (error instanceof GithubRateLimited) {
      await env.IMPORT_JOBS.send(job, { delaySeconds: Math.min(3600, Math.max(30, error.retryAfterSeconds)) });
      log('info', 'github.issues.rate_limited', { repo: id, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    await writeItem(env, ISSUE_SOURCE, id, { status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' });
    throw error;
  }

  const subject = { kind: mapping.subject_kind, id: mapping.subject_id };
  let newest = job.newest ?? null;
  let reachedCursor = false;
  let said = 0;
  for (const issue of issues) {
    if (issue.pull_request) continue;
    if (job.since && issue.updated_at <= job.since) { reachedCursor = true; break; }
    if (!newest || issue.updated_at > newest) newest = issue.updated_at;
    if (first || said >= ANNOUNCE_CAP) continue;
    const change = issueChange(issue, job.since!);
    if (!change) continue;
    const ref = `${owner}/${repo}#${issue.number}`;
    await postSubjectEvent(
      env,
      subject,
      githubIssueLine({ actor: change.actor, number: issue.number, title: issue.title, verb: change.verb }),
      [{ kind: 'issue', id: ref }],
      { dedupeKey: githubIssueEventKey(ref, change.verb) },
    );
    said += 1;
  }

  if (!first && hasNext && !reachedCursor && said < ANNOUNCE_CAP) {
    await env.IMPORT_JOBS.send({ ...job, page: page + 1, newest } satisfies GithubRepoJob);
    log('info', 'github.issues.page', { repo: id, page, said });
    return;
  }

  await writeItem(env, ISSUE_SOURCE, id, {
    status: 'synced',
    cursor: newest ?? job.since ?? null,
    backfill_done: 1,
    last_synced_at: Date.now(),
    error: null,
  });
  log('info', 'github.issues.done', { repo: id, pages: page, said, first, cursor: newest ?? job.since ?? null });
}

/** One page of one repository's pass. `phase` says which half; see the schema. */
export async function processGithubRepoJob(env: Env, job: GithubRepoJob): Promise<void> {
  if (job.phase === 'issues') return processIssuesPage(env, job);
  return processPullsPage(env, job);
}

/**
 * The hourly pass, called from the five-minute cron. Gated by the `tick`
 * pulse so the other four ticks do nothing. Every mapped repository whose
 * backfill is complete gets one job with its cursor; one still backfilling
 * or already queued is left to the job chain it is on.
 */
export async function enqueueGithubSync(env: Env, now: number): Promise<number> {
  if (!(await githubSyncEnabled(env))) return 0;
  const pulse = await connectorPulse(env, 'github');
  if (pulse.tick && now - pulse.tick < SYNC_INTERVAL_MS) return 0;
  await touchConnector(env, 'github', 'tick');
  try {
    await noteGithubRepositories(env, await listInstallationRepositories(env));
  } catch (error) {
    // A failed list leaves the names as they are; the pass still runs on them.
    log('error', 'github.sync.rename_check_failed', { error: error instanceof Error ? error.message : 'Unknown error' });
  }
  const [mappings, items] = await Promise.all([readMappings<'project' | 'lead'>(env, SOURCE), readItems(env, SOURCE)]);
  let queued = 0;
  for (const mapping of mappings.values()) {
    if (!mapping.subject_kind) continue;
    const item = items.get(mapping.external_id);
    if (item?.status === 'importing' || item?.status === 'queued') continue;
    const [owner, repo] = mapping.external_id.split('/', 2);
    if (!owner || !repo) continue;
    await writeItem(env, SOURCE, mapping.external_id, { status: 'queued', error: null });
    await enqueueRepoPasses(env, owner, repo);
    queued += 1;
  }
  if (queued) log('info', 'github.sync.tick', { queued });
  return queued;
}

// ---------------------------------------------------------------- the card

export async function githubConnectorStatus(env: Env): Promise<ConnectorStatus> {
  const configured = (await githubConnection(env)) !== null;
  const [mappings, items, pulse] = await Promise.all([
    readMappings<'project' | 'lead'>(env, SOURCE).catch(() => new Map<string, MappingRow>()),
    readItems(env, SOURCE).catch(() => new Map<string, ItemRow>()),
    connectorPulse(env, 'github'),
  ]);
  const mapped = [...mappings.values()].filter((row) => row.subject_kind);
  const now = Date.now();
  const lastWebhook = pulse.webhook ?? null;
  const lastSync = pulse.sync ?? null;
  // Stale: the sync ran inside the last day and the webhook did not.
  const stale = Boolean(lastSync && now - lastSync < WEBHOOK_STALE_MS && (!lastWebhook || now - lastWebhook > WEBHOOK_STALE_MS));
  return {
    id: 'github',
    configured,
    imported: [...items.values()].reduce((sum, row) => sum + row.count, 0),
    unfiled: mapped.filter((row) => !items.get(row.external_id)?.backfill_done).length,
    suggested: 0,
    accepted: 0,
    corrected: 0,
    suggesting: false,
    last_webhook_at: lastWebhook,
    last_import_at: mapped.length ? Math.max(...mapped.map((row) => row.decided_at)) : null,
    last_sync_at: lastSync,
    enabled: await githubSyncEnabled(env),
    stale,
  };
}

// --------------------------------------------------------------- the pulls

/**
 * The pulls on a project's mapped repositories, newest updated first. A
 * repository counts as the project's if Meet's mapping says so or Core's
 * project link does; the union, so a repository linked in Core before this
 * connector existed still lists its pulls once the sync has read it.
 */
export async function listProjectPulls(env: Env, projectId: string): Promise<PullsResponse> {
  const repos = new Set<string>();
  const { results } = await env.USAGE.prepare(
    `SELECT external_id FROM import_mappings WHERE source = ?1 AND subject_kind = 'project' AND subject_id = ?2`,
  ).bind(SOURCE, projectId).all<{ external_id: string }>();
  for (const row of results) repos.add(row.external_id);
  if (workModelEnabled(env)) {
    try {
      for (const link of await fetchCrmProjectRepos(env, projectId)) repos.add(repoId(link.owner, link.repo));
    } catch {
      // Core down: Meet's own mappings still answer.
    }
  }
  if (repos.size === 0) return { pulls: [], mapped: false };
  const pulls: PullItem[] = [];
  for (const id of repos) {
    const [owner, repo] = id.split('/', 2);
    if (!owner || !repo) continue;
    const rows = await env.USAGE.prepare(
      `SELECT id, owner, repo, number, title, url, state, review, checks, author_login, closes, head_ref, created_at, updated_at, merged_at, closed_at
         FROM github_pulls WHERE owner = ?1 AND repo = ?2 ORDER BY updated_at DESC LIMIT 200`,
    ).bind(owner, repo).all<{
      id: string; owner: string; repo: string; number: number; title: string; url: string; state: PullState;
      review: PullReviewState; checks: PullCheckState; author_login: string | null; closes: string; head_ref: string | null;
      created_at: string | null; updated_at: string | null; merged_at: string | null; closed_at: string | null;
    }>();
    for (const row of rows.results) {
      let closes: number[] = [];
      try { closes = JSON.parse(row.closes) as number[]; } catch { /* a malformed row lists no links */ }
      pulls.push({ ...row, closes });
    }
  }
  pulls.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  return { pulls, mapped: true };
}
