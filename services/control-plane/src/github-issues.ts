// GitHub issues read and written by Meet's own App ( step 1). A port
// of core-web's `src/lib/github.ts`: the same projection to `CrmIssue`, the
// same attribution line on every write, the same "a refused timeline still
// reads" rule. `crm.ts` calls this when the App is configured and Core's
// `meet-github-issues` route otherwise, so a deployment without the App
// keeps working through Core until it is retired.
import type {
  CrmIssue,
  CrmIssueComment,
  CrmIssueDetail,
  CrmIssueEvent,
  CrmIssueFacetsResponse,
  CrmIssueLabel,
  CrmIssueMilestone,
  CrmIssueUser,
  CrmSubIssue,
} from './contracts';
import { z } from 'zod';
import { GithubError, githubRaw } from './github-app';
import { readUpstreamJson, type UpstreamRead } from './upstream';

// ------------------------------------------------------------- the projection

// GitHub's REST shapes, loose, and only the fields this file reads.
// Everything the projection already defaults stays optional; what it cannot
// do without (an issue's number, title, state, link) is required.

/** Where a GitHub read is from, for the `upstream.shape` log. The path has no query values. */
function githubRead(route: string): UpstreamRead {
  return { source: 'github', route, error: GithubError };
}

const githubUserSchema = z.looseObject({
  login: z.string().optional(),
  avatar_url: z.string().nullish(),
});

const githubLabelSchema = z.looseObject({
  name: z.string().optional(),
  color: z.string().nullish(),
  description: z.string().nullish(),
});

const githubMilestoneSchema = z.looseObject({
  title: z.string().optional(),
  number: z.number().optional(),
  state: z.enum(['open', 'closed']).optional(),
  due_on: z.string().nullish(),
});

/** The fields of GitHub's issue payload this app reads. */
const issueRowSchema = z.looseObject({
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  html_url: z.string(),
  body: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  state_reason: z.string().nullish(),
  pull_request: z.unknown().optional(),
  labels: z.array(z.union([z.string(), githubLabelSchema])).optional(),
  assignee: githubUserSchema.nullish(),
  assignees: z.array(githubUserSchema).nullish(),
  user: githubUserSchema.nullish(),
  type: z.union([z.string(), z.looseObject({ name: z.string().optional() })]).nullish(),
  milestone: githubMilestoneSchema.nullish(),
  comments: z.number().optional(),
  reactions: z.record(z.string(), z.unknown()).nullish(),
  sub_issues_summary: z.looseObject({
    total: z.number().optional(),
    completed: z.number().optional(),
    percent_completed: z.number().optional(),
  }).nullish(),
});
type IssueRow = z.infer<typeof issueRowSchema>;

const commentRowSchema = z.looseObject({
  id: z.number(),
  user: githubUserSchema.nullish(),
  body: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string().nullish(),
  html_url: z.string(),
  reactions: z.record(z.string(), z.unknown()).nullish(),
});

const linkedIssueSchema = z.looseObject({
  number: z.number().optional(),
  title: z.string().optional(),
  html_url: z.string().optional(),
});

/**
 * One timeline event. Every kind has its own payload and most are dropped
 * (`TIMELINE_KINDS`), so every field is optional and read only when present.
 */
const timelineRowSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).nullish(),
  event: z.string().nullish(),
  created_at: z.string().nullish(),
  actor: z.looseObject({ login: z.string().optional() }).nullish(),
  label: z.looseObject({ name: z.string().optional(), color: z.string().nullish() }).nullish(),
  assignee: z.looseObject({ login: z.string().optional() }).nullish(),
  milestone: z.looseObject({ title: z.string().optional() }).nullish(),
  rename: z.looseObject({ from: z.string().optional(), to: z.string().optional() }).nullish(),
  state_reason: z.string().nullish(),
  html_url: z.string().nullish(),
  source: z.looseObject({ issue: linkedIssueSchema.optional() }).nullish(),
  issue: linkedIssueSchema.nullish(),
});
type TimelineRow = z.infer<typeof timelineRowSchema>;

const subIssueRowSchema = z.looseObject({
  number: z.number().optional(),
  title: z.string().optional(),
  state: z.enum(['open', 'closed']).optional(),
  html_url: z.string().optional(),
});

function mapLabels(raw: IssueRow['labels']): CrmIssueLabel[] {
  return (raw ?? [])
    .map((label) => (typeof label === 'string'
      ? { name: label, color: null, description: null }
      : { name: label.name ?? '', color: label.color ?? null, description: label.description ?? null }))
    .filter((label) => Boolean(label.name));
}

function mapUser(raw: z.infer<typeof githubUserSchema> | null | undefined): CrmIssueUser | null {
  return raw?.login ? { login: raw.login, avatar_url: raw.avatar_url ?? null } : null;
}

/** Reactions arrive with `url` and `total_count` among the emoji; only set tallies travel. */
function mapReactions(raw: Record<string, unknown> | null | undefined): Record<string, number> | null {
  if (!raw) return null;
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'url' || key === 'total_count') continue;
    if (typeof value === 'number' && value > 0) counts[key] = value;
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

/** One issue row, normalized. Every read path goes through here. */
export function mapIssue(owner: string, repo: string, row: IssueRow): CrmIssue {
  const labels = mapLabels(row.labels);
  const assignees = (row.assignees ?? []).map(mapUser).filter((user): user is CrmIssueUser => user !== null);
  const summary = row.sub_issues_summary;
  return {
    id: `${owner}/${repo}#${row.number}`,
    number: row.number,
    owner,
    repo,
    title: row.title,
    state: row.state,
    url: row.html_url,
    labels: labels.map((label) => label.name),
    label_details: labels,
    assignee_login: assignees[0]?.login ?? row.assignee?.login ?? null,
    assignees,
    author: mapUser(row.user),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    closed_at: row.closed_at ?? null,
    state_reason: row.state_reason ?? null,
    issue_type: (typeof row.type === 'string' ? row.type : row.type?.name) ?? null,
    milestone: row.milestone?.title ?? null,
    milestone_detail: row.milestone?.title
      ? {
        title: row.milestone.title,
        number: row.milestone.number ?? null,
        state: row.milestone.state ?? null,
        due_on: row.milestone.due_on ?? null,
      }
      : null,
    comments: row.comments ?? 0,
    reactions: mapReactions(row.reactions),
    sub_issues: summary && (summary.total ?? 0) > 0
      ? {
        total: summary.total ?? 0,
        completed: summary.completed ?? 0,
        percent_completed: summary.percent_completed ?? 0,
      }
      : null,
  };
}

// ------------------------------------------------------------------ the list

export interface RepoLink {
  owner: string;
  repo: string;
  /** Scopes a shared repository to one project's issues. */
  label: string | null;
  is_primary: boolean;
}

export interface IssueListOptions {
  state?: 'open' | 'closed' | 'all' | undefined;
  /** Comma separated, ANDed, GitHub's own spelling. */
  labels?: string | undefined;
  assignee?: string | undefined;
  milestone?: string | undefined;
  creator?: string | undefined;
  sort?: 'created' | 'updated' | 'comments' | undefined;
  direction?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  page?: number | undefined;
}

async function repoIssues(env: Env, link: RepoLink, options: IssueListOptions): Promise<{ issues: CrmIssue[]; has_more: boolean }> {
  const perPage = Math.min(options.limit ?? 100, 100);
  const searchParams: Record<string, string> = {
    state: options.state ?? 'open',
    per_page: String(perPage),
    sort: options.sort ?? 'updated',
    direction: options.direction ?? 'desc',
    page: String(Math.max(options.page ?? 1, 1)),
  };
  // The link's label scopes a shared repository; a caller's labels narrow it
  // further. GitHub ANDs a comma-separated list, which is what both mean.
  const labels = [...new Set([link.label, ...(options.labels ?? '').split(',').map((label) => label.trim())].filter(Boolean))];
  if (labels.length > 0) searchParams.labels = labels.join(',');
  if (options.assignee) searchParams.assignee = options.assignee;
  if (options.milestone) searchParams.milestone = options.milestone;
  if (options.creator) searchParams.creator = options.creator;

  const response = await githubRaw(env, `/repos/${link.owner}/${link.repo}/issues`, { searchParams });
  if (!response.ok) throw new GithubError(`GitHub issues failed (${response.status}).`, 502);
  const rows = await readUpstreamJson(response, z.array(issueRowSchema), githubRead('GET /repos/:owner/:repo/issues'));
  return {
    // The issues endpoint returns pull requests too. A PR is not a task.
    issues: rows.filter((row) => !row.pull_request).map((row) => mapIssue(link.owner, link.repo, row)),
    // Counted before the PRs are dropped: a full page is a full page.
    has_more: rows.length >= perPage,
  };
}

function comparator(sort: 'created' | 'updated' | 'comments', direction: 'asc' | 'desc') {
  const sign = direction === 'asc' ? -1 : 1;
  return (left: CrmIssue, right: CrmIssue) => {
    if (sort === 'comments') return sign * (right.comments - left.comments);
    const key = sort === 'created' ? 'created_at' : 'updated_at';
    return sign * ((right[key] ?? '').localeCompare(left[key] ?? ''));
  };
}

/**
 * A project's issues across every repository it is linked to, one GitHub
 * call per link, merged and put back in the asked order. One unreachable
 * repository blanks itself, never the others.
 */
export async function listProjectIssues(
  env: Env,
  links: RepoLink[],
  options: IssueListOptions,
): Promise<{ issues: CrmIssue[]; linked: boolean; has_more: boolean }> {
  if (links.length === 0) return { issues: [], linked: false, has_more: false };
  const results = await Promise.all(links.map(async (link) => {
    try {
      return await repoIssues(env, link, options);
    } catch (cause) {
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'github.issues.repo_failed',
        repo: `${link.owner}/${link.repo}`,
        error: cause instanceof Error ? cause.message : 'Unknown error',
      }));
      return { issues: [] as CrmIssue[], has_more: false };
    }
  }));
  // A repository linked twice under different labels can return the same
  // issue twice; the reader wants it once.
  const seen = new Set<string>();
  const issues = results.flatMap((result) => result.issues).filter((issue) => {
    if (seen.has(issue.id)) return false;
    seen.add(issue.id);
    return true;
  }).sort(comparator(options.sort ?? 'updated', options.direction ?? 'desc'));
  return { issues, linked: true, has_more: results.some((result) => result.has_more) };
}

// ---------------------------------------------------------------- the detail

/** Events worth a line. Anything else is dropped rather than drawn badly. */
const TIMELINE_KINDS = new Set([
  'labeled', 'unlabeled', 'assigned', 'unassigned', 'milestoned', 'demilestoned',
  'renamed', 'closed', 'reopened', 'referenced', 'cross-referenced', 'connected',
  'disconnected', 'marked_as_duplicate', 'unmarked_as_duplicate', 'locked',
  'unlocked', 'pinned', 'unpinned', 'transferred', 'converted_to_discussion',
  'parent_issue_added', 'parent_issue_removed', 'sub_issue_added', 'sub_issue_removed',
]);

function mapTimelineEvent(row: TimelineRow, index: number): CrmIssueEvent | null {
  const kind = row.event ?? '';
  if (!TIMELINE_KINDS.has(kind)) return null;
  // A cross-reference is the one event whose point is the thing on the other
  // end, so it is named by that rather than by its own actor.
  const referenced = row.source?.issue ?? row.issue ?? null;
  const subject = row.assignee?.login
    ?? row.milestone?.title
    ?? row.rename?.to
    ?? (referenced?.number ? `#${referenced.number}` : null);
  return {
    id: `${kind}-${row.id ?? `${index}-${row.created_at ?? ''}`}`,
    kind,
    actor: row.actor?.login ?? null,
    created_at: row.created_at ?? null,
    label: row.label?.name ? { name: row.label.name, color: row.label.color ?? null, description: null } : null,
    subject,
    url: referenced?.html_url ?? row.html_url ?? null,
    state_reason: row.state_reason ?? null,
  };
}

/**
 * Everything needed to read an issue without leaving the app. The body and
 * the comments are the point; the timeline and the children are niceties,
 * and a repository that refuses either still reads.
 */
export async function readIssue(env: Env, owner: string, repo: string, number: number): Promise<CrmIssueDetail> {
  const base = `/repos/${owner}/${repo}/issues/${number}`;
  const [issueResponse, commentsResponse, timelineResponse, childrenResponse] = await Promise.all([
    githubRaw(env, base),
    githubRaw(env, `${base}/comments`, { searchParams: { per_page: '100' } }),
    githubRaw(env, `${base}/timeline`, { searchParams: { per_page: '100' } }),
    githubRaw(env, `${base}/sub_issues`, { searchParams: { per_page: '100' } }),
  ]);
  if (issueResponse.status === 404) throw new GithubError('Issue not found.', 404, 'room_not_found');
  if (!issueResponse.ok) throw new GithubError(`GitHub issue failed (${issueResponse.status}).`, 502);
  const row = await readUpstreamJson(issueResponse, issueRowSchema, githubRead('GET /repos/:owner/:repo/issues/:number'));

  const comments: CrmIssueComment[] = commentsResponse.ok
    ? (await readUpstreamJson(commentsResponse, z.array(commentRowSchema), githubRead('GET /repos/:owner/:repo/issues/:number/comments'))).map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? 'unknown',
      author_avatar_url: comment.user?.avatar_url ?? null,
      body: comment.body ?? '',
      created_at: comment.created_at,
      updated_at: comment.updated_at && comment.updated_at !== comment.created_at ? comment.updated_at : null,
      url: comment.html_url,
      reactions: mapReactions(comment.reactions),
    }))
    : [];

  // A nicety, like a refused timeline: a shape GitHub changed is logged by
  // the read and the issue still opens without it.
  const timeline = timelineResponse.ok
    ? (await niceToHave(readUpstreamJson(timelineResponse, z.array(timelineRowSchema), githubRead('GET /repos/:owner/:repo/issues/:number/timeline'))))
      .map(mapTimelineEvent).filter((event): event is CrmIssueEvent => event !== null)
    : [];

  const children: CrmSubIssue[] = childrenResponse.ok
    ? (await niceToHave(readUpstreamJson(childrenResponse, z.array(subIssueRowSchema), githubRead('GET /repos/:owner/:repo/issues/:number/sub_issues'))))
      .filter((child) => typeof child.number === 'number')
      .map((child) => ({ number: child.number ?? 0, title: child.title ?? '', state: child.state ?? 'open', url: child.html_url ?? '' }))
    : [];

  return {
    ...mapIssue(owner, repo, row),
    comments: row.comments ?? comments.length,
    body: row.body ?? '',
    comments_list: comments,
    timeline,
    sub_issue_list: children,
  };
}

/** An optional part of the detail: its shape failure is already logged, so it reads as empty. */
async function niceToHave<Row>(read: Promise<Row[]>): Promise<Row[]> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof GithubError && error.code === 'upstream_shape') return [];
    throw error;
  }
}

// ---------------------------------------------------------------- the facets

/** What an issue in this repository could be set to. Each part optional in the answer. */
export async function readRepoFacets(env: Env, owner: string, repo: string): Promise<CrmIssueFacetsResponse> {
  const [labelsResponse, milestonesResponse, assigneesResponse] = await Promise.all([
    githubRaw(env, `/repos/${owner}/${repo}/labels`, { searchParams: { per_page: '100' } }),
    githubRaw(env, `/repos/${owner}/${repo}/milestones`, { searchParams: { state: 'open', per_page: '100', sort: 'due_on' } }),
    githubRaw(env, `/repos/${owner}/${repo}/assignees`, { searchParams: { per_page: '100' } }),
  ]);
  const labels: CrmIssueLabel[] = labelsResponse.ok
    ? (await readUpstreamJson(labelsResponse, z.array(githubLabelSchema), githubRead('GET /repos/:owner/:repo/labels')))
      .filter((row) => Boolean(row.name))
      .map((row) => ({ name: row.name ?? '', color: row.color ?? null, description: row.description ?? null }))
    : [];
  const milestones: CrmIssueMilestone[] = milestonesResponse.ok
    ? (await readUpstreamJson(milestonesResponse, z.array(githubMilestoneSchema), githubRead('GET /repos/:owner/:repo/milestones')))
      .filter((row) => Boolean(row.title))
      .map((row) => ({ title: row.title ?? '', number: row.number ?? null, state: row.state ?? null, due_on: row.due_on ?? null }))
    : [];
  const assignees: CrmIssueUser[] = assigneesResponse.ok
    ? (await readUpstreamJson(assigneesResponse, z.array(githubUserSchema), githubRead('GET /repos/:owner/:repo/assignees')))
      .filter((row) => Boolean(row.login))
      .map((row) => ({ login: row.login ?? '', avatar_url: row.avatar_url ?? null }))
    : [];
  return { labels, milestones, assignees };
}

// ---------------------------------------------------------------- the writes

/**
 * The App writes as itself, and Meet members are not necessarily GitHub
 * users, so every write says which human asked for it. The same line Core's
 * App wrote, so history reads the same across the switch.
 */
function attributed(body: string, actor: string): string {
  const text = body.trim();
  const note = `_Written by ${actor} from Starlings._`;
  return text ? `${text}\n\n${note}` : note;
}

export async function createIssue(
  env: Env,
  link: RepoLink,
  input: { title: string; body?: string | undefined; labels?: string[] | undefined; assignees?: string[] | undefined; milestone?: number | undefined },
  actor: string,
): Promise<CrmIssue> {
  // A scoped link means its issues carry that label, or the new one would
  // not appear in the list it was created from.
  const labels = [...(input.labels ?? []), ...(link.label ? [link.label] : [])];
  const response = await githubRaw(env, `/repos/${link.owner}/${link.repo}/issues`, {
    method: 'POST',
    body: {
      title: input.title,
      body: attributed(input.body ?? '', actor),
      ...(labels.length ? { labels } : {}),
      ...(input.assignees?.length ? { assignees: input.assignees } : {}),
      ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
    },
  });
  if (!response.ok) throw new GithubError(`GitHub issue create failed (${response.status}).`, 502);
  return mapIssue(link.owner, link.repo, await readUpstreamJson(response, issueRowSchema, githubRead('POST /repos/:owner/:repo/issues')));
}

export async function updateIssue(
  env: Env,
  owner: string,
  repo: string,
  number: number,
  input: {
    title?: string | undefined;
    body?: string | undefined;
    state?: 'open' | 'closed' | undefined;
    state_reason?: 'completed' | 'not_planned' | undefined;
    labels?: string[] | undefined;
    assignees?: string[] | undefined;
    milestone?: number | null | undefined;
    comment?: string | undefined;
  },
  actor: string,
): Promise<CrmIssueDetail> {
  // A comment and an edit can arrive together: closing something with a
  // reason is one intention, and the reason should not need a second trip.
  if (input.comment) {
    const response = await githubRaw(env, `/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: { body: attributed(input.comment, actor) },
    });
    if (!response.ok) throw new GithubError(`GitHub comment failed (${response.status}).`, 502);
  }
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = attributed(input.body, actor);
  if (input.state !== undefined) patch.state = input.state;
  // Deciding against work is not finishing it; meaningless on its own, so it
  // only travels with a close.
  if (input.state_reason !== undefined && input.state === 'closed') patch.state_reason = input.state_reason;
  // Each of these replaces the whole set, GitHub's own PATCH semantics.
  if (input.labels !== undefined) patch.labels = input.labels;
  if (input.assignees !== undefined) patch.assignees = input.assignees;
  if (input.milestone !== undefined) patch.milestone = input.milestone;
  if (Object.keys(patch).length > 0) {
    const response = await githubRaw(env, `/repos/${owner}/${repo}/issues/${number}`, { method: 'PATCH', body: patch });
    if (!response.ok) throw new GithubError(`GitHub issue update failed (${response.status}).`, 502);
  }
  return readIssue(env, owner, repo, number);
}
