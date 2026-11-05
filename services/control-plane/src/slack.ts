// The Slack Web API, read only, for the channel import (slack-connector.ts,
// docs/SLACK_IMPORT.md). One user token, one workspace; the token's user is
// the one whose channels are visible, and nothing here writes to Slack.
import { ControlError } from './errors';

const SLACK_API_ORIGIN = 'https://slack.com/api';

export class SlackError extends ControlError {}

export class SlackRateLimited extends SlackError {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message, 429);
  }
}

/** The token is present. The kill switch (`SLACK_IMPORT_ENABLED`) is separate. */
export function slackConfigured(env: Env): boolean {
  return Boolean(env.SLACK_USER_TOKEN?.trim());
}

// -------------------------------------------------------------- the shapes

export interface SlackChannel {
  id: string;
  name: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_shared?: boolean;
  is_ext_shared?: boolean;
  is_member?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  created: number;
  num_members?: number;
  purpose?: { value?: string };
}

export interface SlackUser {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_stranger?: boolean;
  profile?: { email?: string; real_name?: string; display_name?: string };
}

export interface SlackMessage {
  type: string;
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: Array<{ name?: string; title?: string; permalink?: string }>;
}

export interface SlackAuth {
  team: string;
  team_id: string;
  user_id: string;
}

// ---------------------------------------------------------------- the call

interface SlackEnvelope {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

/**
 * One GET. Slack answers 200 with `ok: false` for most failures and 429 with
 * `Retry-After` for the rate limit; both surface as typed errors so the sync
 * re-enqueues on the second and records the first.
 */
export async function slackCall<T extends SlackEnvelope>(
  env: Env,
  method: string,
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const token = env.SLACK_USER_TOKEN?.trim();
  if (!token) throw new SlackError('The Slack import is not configured.', 503, 'not_configured');
  const url = new URL(`${SLACK_API_ORIGIN}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'meet-control-plane' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') ?? '60');
    throw new SlackRateLimited('Slack rate limit.', Number.isFinite(retryAfter) ? retryAfter : 60);
  }
  if (!response.ok) throw new SlackError(`Slack answered ${response.status} for ${method}.`, 502);
  const body = await response.json() as T;
  if (!body.ok) {
    if (body.error === 'ratelimited') throw new SlackRateLimited('Slack rate limit.', 60);
    throw new SlackError(`Slack refused ${method}: ${body.error ?? 'unknown'}.`, 502);
  }
  return body;
}

/** Who the token is: the workspace name is the page header. */
export async function slackAuth(env: Env): Promise<SlackAuth> {
  const body = await slackCall<SlackEnvelope & SlackAuth>(env, 'auth.test');
  return { team: body.team, team_id: body.team_id, user_id: body.user_id };
}

/** Every channel the token's user is in, public and private, archived included. */
export async function slackListChannels(env: Env): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const body = await slackCall<SlackEnvelope & { channels: SlackChannel[] }>(env, 'conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: 'false',
      limit: '200',
      cursor,
    });
    channels.push(...body.channels.filter((channel) => channel.is_member !== false && !channel.is_im && !channel.is_mpim));
    cursor = body.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return channels;
}

export async function slackChannel(env: Env, id: string): Promise<SlackChannel> {
  const body = await slackCall<SlackEnvelope & { channel: SlackChannel }>(env, 'conversations.info', { channel: id });
  return body.channel;
}

/** The whole directory, paged. Refreshed into `slack_users` once a day. */
export async function slackListUsers(env: Env): Promise<SlackUser[]> {
  const users: SlackUser[] = [];
  let cursor: string | undefined;
  do {
    const body = await slackCall<SlackEnvelope & { members: SlackUser[] }>(env, 'users.list', { limit: '200', cursor });
    users.push(...body.members);
    cursor = body.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return users;
}

export interface SlackHistoryPage {
  messages: SlackMessage[];
  nextCursor: string | null;
}

/**
 * One page of a channel, newest first. `limit` is the ceiling; a workspace
 * on the restricted tier gets fewer per call and the paging absorbs it.
 */
export async function slackHistory(
  env: Env,
  channel: string,
  options: { oldest?: string | null; cursor?: string | null; limit?: number },
): Promise<SlackHistoryPage> {
  const body = await slackCall<SlackEnvelope & { messages: SlackMessage[]; has_more?: boolean }>(env, 'conversations.history', {
    channel,
    oldest: options.oldest ?? undefined,
    cursor: options.cursor ?? undefined,
    limit: String(options.limit ?? 200),
  });
  return { messages: body.messages, nextCursor: body.response_metadata?.next_cursor || null };
}

/** Every reply under one parent, oldest first, the parent itself dropped. */
export async function slackReplies(env: Env, channel: string, parentTs: string): Promise<SlackMessage[]> {
  const replies: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const body = await slackCall<SlackEnvelope & { messages: SlackMessage[] }>(env, 'conversations.replies', {
      channel,
      ts: parentTs,
      limit: '200',
      cursor,
    });
    replies.push(...body.messages.filter((message) => message.ts !== parentTs));
    cursor = body.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return replies;
}

// ---------------------------------------------------------------- the text

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>' };

/**
 * Slack mrkdwn to the Markdown Meet renders. Mentions become names, channel
 * references their `#name`, links `[label](url)`, and the three emphasis
 * marks Slack spells differently become Markdown's. Anything else is left
 * as typed.
 */
export function slackTextToMarkdown(
  text: string,
  lookup: { user: (id: string) => string | null; channel: (id: string) => string | null },
): string {
  let out = text.replace(/<([^<>]+)>/gu, (whole, inner: string) => {
    if (inner.startsWith('@')) {
      const [id] = inner.slice(1).split('|', 1);
      return `@${lookup.user(id ?? '') ?? inner.split('|')[1] ?? id}`;
    }
    if (inner.startsWith('#')) {
      const [id, label] = inner.slice(1).split('|', 2);
      return `#${label ?? lookup.channel(id ?? '') ?? id}`;
    }
    if (inner.startsWith('!')) {
      const [keyword, label] = inner.slice(1).split('|', 2);
      if (keyword === 'channel' || keyword === 'here' || keyword === 'everyone') return `@${keyword}`;
      if (keyword?.startsWith('subteam^')) return `@${label ?? 'group'}`;
      if (keyword?.startsWith('date^')) return label ?? whole;
      return label ?? whole;
    }
    const [url, label] = inner.split('|', 2);
    if (!url) return whole;
    if (url.startsWith('mailto:')) return label ?? url.slice(7);
    return label && label !== url ? `[${label}](${url})` : url;
  });
  out = out.replace(/&(amp|lt|gt);/gu, (entity) => ENTITIES[entity] ?? entity);
  // Emphasis: `*bold*` → `**bold**`, `~strike~` → `~~strike~~`. Italic `_x_`
  // is already Markdown. Code spans and blocks are left alone by excluding
  // them from the scan.
  out = out.split(/(```[\s\S]*?```|`[^`\n]*`)/u).map((piece, index) => {
    if (index % 2 === 1) return piece;
    return piece
      .replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s.,;:!?)])/gu, '$1**$2**')
      .replace(/(^|[\s(])~([^~\n]+?)~(?=$|[\s.,;:!?)])/gu, '$1~~$2~~');
  }).join('');
  return out.trim();
}

/** Slack `ts` (`1700000000.123456`, seconds) to milliseconds. */
export function slackTsToMillis(ts: string): number {
  const seconds = Number(ts);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : Date.now();
}
