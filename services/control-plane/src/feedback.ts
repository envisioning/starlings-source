// Bug reports from the browser, filed as GitHub issues.
import type { FeedbackInput } from './contracts';
import { ControlError } from './errors';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const TITLE_MAX_CHARS = 72;

/**
 * File a guest's bug report as an issue on `GITHUB_ISSUES_REPO`.
 *
 * Needs a fine-grained token with Issues: read *and* write on that one repo, in
 * `GITHUB_ISSUES_TOKEN`. Both absent by default, which is what keeps this route
 * off in dev and in tests: without them the caller gets `not_configured` and the
 * browser falls back to copy-to-clipboard.
 *
 * The token is a write credential for the tracker, so nothing about the request
 * is echoed into logs — a failure here logs the GitHub status and nothing else.
 */
export async function fileFeedbackIssue(env: Env, input: FeedbackInput): Promise<void> {
  await createTrackerIssue(env, {
    title: issueTitle(input.message),
    body: issueBody(input),
    // Both labels are created on demand if they do not exist yet. They are
    // the handle for bulk-closing a spam wave without reading each one.
    labels: ['bug-report', 'from-web'],
  });
}

/**
 * Open one issue on `GITHUB_ISSUES_REPO`. Shared by every public form that
 * lands in the tracker (bug reports), so the token, the
 * `not_configured` fallback and the no-echo rule live in one place.
 */
export async function createTrackerIssue(
  env: Env,
  issue: { title: string; body: string; labels: string[] },
): Promise<void> {
  const token = env.GITHUB_ISSUES_TOKEN?.trim();
  const repo = env.GITHUB_ISSUES_REPO?.trim();
  if (!token || !repo) {
    throw new ControlError('Bug reports are not configured.', 503, 'not_configured');
  }

  const response = await fetch(`${GITHUB_API_ORIGIN}/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      'content-type': 'application/json',
      // GitHub rejects API requests that do not name a client.
      'user-agent': 'meet-control-plane',
    },
    body: JSON.stringify(issue),
  });

  if (!response.ok) {
    throw new ControlError(`Could not file the report (GitHub ${response.status}).`, 502);
  }
}

/** First line of the report, short enough to read in a list. Exported for tests. */
export function issueTitle(message: string): string {
  const firstLine = message.split('\n', 1)[0]?.trim() ?? '';
  const subject = firstLine || 'Bug report from Starlings';
  return subject.length > TITLE_MAX_CHARS
    ? `${subject.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`
    : subject;
}

/** Exported for tests — the fence guard below is the part worth pinning down. */
export function issueBody(input: FeedbackInput): string {
  const sections = [
    input.message,
    '---',
    [
      `- Room: ${input.room_slug ? `\`${input.room_slug}\`` : '—'}`,
      `- Filed: ${new Date().toISOString()}`,
    ].join('\n'),
  ];

  if (input.report) {
    sections.push(
      ['<details>', '<summary>Debug report</summary>', '', fenced(input.report), '', '</details>'].join('\n'),
    );
  }

  sections.push(
    '_Filed from Starlings by someone who is not a GitHub user — '
      + 'commenting here does not reach them._',
  );
  return sections.join('\n\n');
}

/**
 * Wrap untrusted text in a code fence long enough that the text cannot close
 * it. Without this, a report containing its own triple-backtick run escapes the
 * block and the rest renders as markdown.
 */
export function fenced(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}
