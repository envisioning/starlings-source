// The Slack import (docs/SLACK_IMPORT.md): channels mapped to
// subject channels, history read by a paced job chain into the subject's
// thread as ordinary messages carrying their original time and `origin`,
// and an hourly pass that keeps every mapped channel current.
//
// The shape is the GitHub connector's (github-connector.ts): the same
// `import_mappings` / `import_ledger` rows under `source = 'slack'`, the same
// page job that enqueues its successor, the same card. What differs is the
// destination — a thread's Durable Object, not a table of Meet's own — so
// reverse asks the thread to drop the rows it imported.
import type {
  ConnectorStatus,
  ImportItemState,
  SlackChannelJob,
  SlackConnectorResponse,
  SlackConnectorRow,
  SlackMappingInput,
  SlackSubjectKind,
} from './contracts';
import { ControlError } from './errors';
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
import {
  SlackRateLimited,
  slackAuth,
  slackChannel,
  slackConfigured,
  slackHistory,
  slackListChannels,
  slackListUsers,
  slackReplies,
  slackTextToMarkdown,
  slackTsToMillis,
  type SlackChannel,
  type SlackMessage,
  type SlackUser,
} from './slack';
import {
  appendInboundMessage,
  ensureTeamThread,
  inboundMessageId,
  memberByEmail,
  resolveSubjectThread,
  threadStub,
} from './threads';

const SOURCE = 'slack';
/** Messages per history call. Slack clamps a restricted-tier app lower; the paging absorbs it. */
const PAGE_SIZE = 200;
/** The scheduled pass runs every five minutes; the sync wants one tick an hour. */
const SYNC_INTERVAL_MS = 55 * 60_000;
/** The user directory is re-read when older than this. */
const USERS_STALE_MS = 24 * 60 * 60_000;
/**
 * A sync pass re-reads this far behind its cursor, so a reply under a parent
 * from the last week lands. Inserts are idempotent, so the re-read costs
 * calls, not duplicates. A reply under an older parent waits for a reverse
 * and re-import; Slack has no "threads changed since" to ask.
 */
const REPLY_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
/** Message subtypes that are channel housekeeping, not something somebody said. */
const DROPPED_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive',
  'channel_unarchive', 'group_join', 'group_leave', 'group_topic', 'group_purpose', 'group_name', 'group_archive',
  'group_unarchive', 'bot_message', 'bot_add', 'bot_remove', 'pinned_item', 'unpinned_item', 'ekm_access_denied',
  'sh_room_created', 'tombstone', 'joiner_notification', 'reminder_add', 'huddle_thread',
]);

export class SlackConnectorError extends ControlError {}

export function slackImportEnabled(env: Env): boolean {
  return slackConfigured(env) && String(env.SLACK_IMPORT_ENABLED ?? 'off') === 'on';
}

function log(level: 'info' | 'error', message: string, data: Record<string, unknown>): void {
  const entry = JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...data });
  if (level === 'error') console.error(entry);
  else console.log(entry);
}

// ---------------------------------------------------------------- the ledger

type MappingRow = LedgerMapping<SlackSubjectKind>;

function toRow(channel: SlackChannel, mapping: MappingRow | null | undefined, item: ItemRow | null | undefined): SlackConnectorRow {
  return {
    id: channel.id,
    name: channel.name,
    purpose: channel.purpose?.value?.trim() || null,
    private: channel.is_private === true,
    shared: channel.is_ext_shared === true || channel.is_shared === true,
    archived: channel.is_archived === true,
    members: channel.num_members ?? 0,
    created: channel.created,
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
    messages: item?.count ?? 0,
    cursor: item?.cursor ?? null,
    last_synced_at: item?.last_synced_at ?? null,
    error: item?.error ?? null,
  };
}

// ------------------------------------------------------------- the people

interface SlackUserRow {
  id: string;
  team_id: string | null;
  name: string | null;
  email: string | null;
  is_bot: number;
}

/**
 * The workspace directory, in D1, so a page of history resolves its senders
 * without a call per message. Re-read once a day, and on first use.
 */
async function ensureUsers(env: Env): Promise<Map<string, SlackUserRow>> {
  const pulse = await connectorPulse(env, 'slack');
  if (!pulse.users || Date.now() - pulse.users > USERS_STALE_MS) {
    const users = await slackListUsers(env);
    const statements = users.map((user) => env.USAGE.prepare(
      `INSERT INTO slack_users (id, team_id, name, email, is_bot, deleted, synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET
         team_id = excluded.team_id, name = excluded.name, email = excluded.email,
         is_bot = excluded.is_bot, deleted = excluded.deleted, synced_at = excluded.synced_at`,
    ).bind(
      user.id,
      user.team_id ?? null,
      displayName(user),
      user.profile?.email?.toLowerCase() ?? null,
      user.is_bot || user.is_app_user ? 1 : 0,
      user.deleted ? 1 : 0,
      Date.now(),
    ));
    for (let index = 0; index < statements.length; index += 100) {
      await env.USAGE.batch(statements.slice(index, index + 100));
    }
    await env.USAGE.prepare(
      `INSERT INTO connector_pulse (connector, event, at) VALUES ('slack', 'users', ?1)
       ON CONFLICT(connector, event) DO UPDATE SET at = excluded.at`,
    ).bind(Date.now()).run();
  }
  const { results } = await env.USAGE.prepare('SELECT id, team_id, name, email, is_bot FROM slack_users').all<SlackUserRow>();
  return new Map(results.map((row) => [row.id, row]));
}

function displayName(user: SlackUser): string | null {
  return user.real_name?.trim() || user.profile?.real_name?.trim() || user.profile?.display_name?.trim() || user.name?.trim() || null;
}

type Sender = { sub: string; email: string; name: string };

/**
 * Who said it. A workspace member with an Envisioning address is their
 * `people` row, so the row is theirs on every client. Anybody else — a Slack
 * Connect partner, a guest — is a ghost: a stable `slack:` sub that can never
 * sign in, with the name and address Slack had. A bot is nobody, and its
 * messages are dropped by the caller.
 */
async function resolveSender(
  env: Env,
  users: Map<string, SlackUserRow>,
  teamId: string,
  userId: string,
  cache: Map<string, Sender | null>,
): Promise<Sender | null> {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;
  const user = users.get(userId);
  let sender: Sender | null;
  if (user?.is_bot) {
    sender = null;
  } else {
    const email = user?.email ?? null;
    const member = email ? await memberByEmail(env, email) : null;
    sender = member
      ? { sub: member.sub, email: member.email, name: user?.name ?? member.email.split('@')[0] ?? member.email }
      : {
        sub: `slack:${user?.team_id ?? teamId}:${userId}`,
        email: email ?? `${userId.toLowerCase()}@slack.invalid`,
        name: user?.name ?? userId,
      };
  }
  cache.set(userId, sender);
  return sender;
}

// ------------------------------------------------------------------ the list

/** `/connectors/slack`: every channel the token's user is in, with its mapping and ledger. */
export async function slackConnectorList(env: Env): Promise<SlackConnectorResponse> {
  if (!slackConfigured(env)) {
    throw new SlackConnectorError('The Slack import is not configured.', 503, 'not_configured');
  }
  const [auth, channels, mappings, items] = await Promise.all([
    slackAuth(env),
    slackListChannels(env),
    readMappings<SlackSubjectKind>(env, SOURCE),
    readItems(env, SOURCE),
  ]);
  channels.sort((a, b) => a.name.localeCompare(b.name));
  return {
    configured: true,
    enabled: slackImportEnabled(env),
    team: auth.team,
    rows: channels.map((channel) => toRow(channel, mappings.get(channel.id), items.get(channel.id))),
  };
}

/**
 * The thread a mapping lands in. Resolved on every job rather than stored,
 * so a subject renamed or re-titled in Core still finds its channel, and a
 * mapping to a subject Core no longer has fails loudly on the ledger.
 */
async function threadFor(env: Env, mapping: MappingRow): Promise<string> {
  if (mapping.subject_kind === 'team') return (await ensureTeamThread(env)).id;
  if (mapping.subject_kind && mapping.subject_id) {
    return (await resolveSubjectThread(env, { kind: mapping.subject_kind, id: mapping.subject_id })).id;
  }
  throw new SlackConnectorError('The channel is not mapped.', 409, 'invalid_request');
}

/** The decision: map a channel to a subject channel, Team, or skip it. */
export async function saveSlackMapping(
  env: Env,
  channelId: string,
  input: SlackMappingInput,
  actor: string,
): Promise<SlackConnectorRow> {
  if (!slackConfigured(env)) {
    throw new SlackConnectorError('The Slack import is not configured.', 503, 'not_configured');
  }
  const channel = await slackChannel(env, channelId);
  await writeMapping(env, SOURCE, channelId, {
    subject_kind: input.subject_kind,
    subject_id: input.subject_id,
    subject_title: input.subject_kind === 'team' ? 'Team' : input.subject_title ?? null,
  }, actor);

  if (input.subject_kind) {
    const existing = await readItem(env, SOURCE, channelId);
    if (!existing || existing.status === 'failed') {
      await writeItem(env, SOURCE, channelId, { status: 'queued', error: null });
    }
    if (slackImportEnabled(env)) {
      await env.IMPORT_JOBS.send({ kind: 'slack-channel', channelId, oldest: lookback(existing?.cursor ?? null) } satisfies SlackChannelJob);
    }
  }

  const [mapping, item] = await Promise.all([readMapping<SlackSubjectKind>(env, SOURCE, channelId), readItem(env, SOURCE, channelId)]);
  return toRow(channel, mapping, item);
}

/** Enqueue one channel's pass now, from the list's Sync button. */
export async function syncSlackChannelNow(env: Env, channelId: string): Promise<void> {
  if (!slackImportEnabled(env)) {
    throw new SlackConnectorError('The Slack import is off.', 503, 'not_configured');
  }
  const mapping = await readMapping<SlackSubjectKind>(env, SOURCE, channelId);
  if (!mapping?.subject_kind) throw new SlackConnectorError('Map the channel first.', 409, 'invalid_request');
  const item = await readItem(env, SOURCE, channelId);
  await writeItem(env, SOURCE, channelId, { status: 'queued', error: null });
  await env.IMPORT_JOBS.send({ kind: 'slack-channel', channelId, oldest: lookback(item?.cursor ?? null) } satisfies SlackChannelJob);
}

/**
 * Reverse one channel: every row it wrote into the subject's thread goes,
 * the cursor resets, the mapping stays. Required before the first production
 * mapping, because the first one will be wrong somewhere.
 */
export async function reverseSlackChannel(env: Env, channelId: string): Promise<{ removed: number }> {
  const mapping = await readMapping<SlackSubjectKind>(env, SOURCE, channelId);
  let removed = 0;
  if (mapping?.subject_kind) {
    const threadId = await threadFor(env, mapping);
    removed = (await threadStub(env, threadId).removeImported('slack', channelId)).removed;
  }
  await resetItems(env, [SOURCE], channelId);
  return { removed };
}

// ------------------------------------------------------------------ the sync

/** The cursor minus the reply look-back, as a Slack `ts`. Null stays null: the backfill reads everything. */
function lookback(cursor: string | null): string | null {
  if (!cursor) return null;
  const seconds = Number(cursor);
  if (!Number.isFinite(seconds)) return cursor;
  return Math.max(0, seconds - REPLY_LOOKBACK_SECONDS).toFixed(6);
}

function keep(message: SlackMessage): boolean {
  if (message.type !== 'message') return false;
  if (message.subtype && DROPPED_SUBTYPES.has(message.subtype)) return false;
  if (message.bot_id && !message.user) return false;
  if (!message.user) return false;
  return Boolean(message.text?.trim()) || Boolean(message.files?.length);
}

/** The line as it lands: the text, then any file as a link to where it still is. */
function bodyOf(message: SlackMessage, lookup: Parameters<typeof slackTextToMarkdown>[1]): string {
  const parts: string[] = [];
  const text = message.text?.trim();
  if (text) parts.push(slackTextToMarkdown(text, lookup));
  for (const file of message.files ?? []) {
    const name = file.title || file.name || 'file';
    parts.push(file.permalink ? `[${name}](${file.permalink})` : name);
  }
  return parts.join('\n\n');
}

/** A reply is prefixed with a line of the parent it answers, since Meet threads are flat. */
function replyBody(parent: string, body: string): string {
  const quote = parent.replace(/\s+/gu, ' ').trim();
  const head = quote.length > 80 ? `${quote.slice(0, 79)}…` : quote;
  return `> ${head}\n\n${body}`;
}

/**
 * One page of one channel's history, newest first, then every reply under
 * the parents on that page. Stops when the next page would be at or before
 * the cursor, else enqueues the next page. A rate limit re-enqueues the same
 * page after Slack's `Retry-After`.
 */
export async function processSlackChannelJob(env: Env, job: SlackChannelJob): Promise<void> {
  const { channelId } = job;
  if (!slackImportEnabled(env)) {
    log('info', 'slack.sync.skipped', { channel: channelId, reason: 'disabled' });
    return;
  }
  const mapping = await readMapping<SlackSubjectKind>(env, SOURCE, channelId);
  if (!mapping?.subject_kind) {
    log('info', 'slack.sync.skipped', { channel: channelId, reason: 'unmapped' });
    return;
  }
  const item = await readItem(env, SOURCE, channelId);
  await writeItem(env, SOURCE, channelId, { status: 'importing', error: null });

  let threadId: string;
  let users: Map<string, SlackUserRow>;
  let teamId: string;
  let page: Awaited<ReturnType<typeof slackHistory>>;
  try {
    [threadId, users, { team_id: teamId }] = await Promise.all([threadFor(env, mapping), ensureUsers(env), slackAuth(env)]);
    page = await slackHistory(env, channelId, { oldest: job.oldest ?? null, cursor: job.page ?? null, limit: PAGE_SIZE });
  } catch (error) {
    if (error instanceof SlackRateLimited) {
      await env.IMPORT_JOBS.send(job, { delaySeconds: Math.min(3600, Math.max(30, error.retryAfterSeconds)) });
      log('info', 'slack.sync.rate_limited', { channel: channelId, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    await writeItem(env, SOURCE, channelId, { status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' });
    throw error;
  }

  const senders = new Map<string, Sender | null>();
  const lookup = {
    user: (id: string) => users.get(id)?.name ?? null,
    channel: () => null,
  };
  let newest = job.newest ?? null;
  let written = job.written ?? 0;

  const land = async (message: SlackMessage, text: string): Promise<void> => {
    const sender = message.user ? await resolveSender(env, users, teamId, message.user, senders) : null;
    if (!sender) return;
    const result = await appendInboundMessage(env, {
      threadId,
      messageId: await inboundMessageId(threadId, `slack:${channelId}:${message.ts}`),
      sender,
      text,
      type: 'text',
      refs: [],
      sentAt: slackTsToMillis(message.ts),
      origin: { kind: 'slack', ref: channelId },
    });
    if (!result.duplicate) written += 1;
  };

  try {
    for (const message of page.messages) {
      if (!newest || Number(message.ts) > Number(newest)) newest = message.ts;
      if (!keep(message)) continue;
      const body = bodyOf(message, lookup);
      await land(message, body);
      // Replies live under the parent, not in the channel's own page.
      if ((message.reply_count ?? 0) > 0 && message.thread_ts === message.ts) {
        for (const reply of await slackReplies(env, channelId, message.ts)) {
          if (!keep(reply)) continue;
          await land(reply, replyBody(body, bodyOf(reply, lookup)));
        }
      }
    }
  } catch (error) {
    if (error instanceof SlackRateLimited) {
      // The page is re-read whole; every row already landed is a duplicate.
      await env.IMPORT_JOBS.send({ ...job, newest, written }, { delaySeconds: Math.min(3600, Math.max(30, error.retryAfterSeconds)) });
      log('info', 'slack.sync.rate_limited', { channel: channelId, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    await writeItem(env, SOURCE, channelId, { status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' });
    throw error;
  }

  const total = (item?.count ?? 0) + written - (job.written ?? 0);
  if (page.nextCursor) {
    await writeItem(env, SOURCE, channelId, { status: 'importing', count: total });
    await env.IMPORT_JOBS.send({ ...job, page: page.nextCursor, newest, written } satisfies SlackChannelJob);
    log('info', 'slack.sync.page', { channel: channelId, written });
    return;
  }

  await writeItem(env, SOURCE, channelId, {
    status: 'synced',
    cursor: newest ?? item?.cursor ?? null,
    backfill_done: 1,
    count: total,
    last_synced_at: Date.now(),
    error: null,
  });
  await touchConnector(env, 'slack', 'sync');
  log('info', 'slack.sync.done', { channel: channelId, written, cursor: newest ?? null });
}

/**
 * The hourly pass, called from the five-minute cron and gated by the `tick`
 * pulse. Every mapped channel whose backfill is complete gets one job from
 * its cursor, less the reply look-back; one still backfilling or already
 * queued is left to the job chain it is on.
 */
export async function enqueueSlackSync(env: Env, now: number): Promise<number> {
  if (!slackImportEnabled(env)) return 0;
  const pulse = await connectorPulse(env, 'slack');
  if (pulse.tick && now - pulse.tick < SYNC_INTERVAL_MS) return 0;
  await touchConnector(env, 'slack', 'tick');
  const [mappings, items] = await Promise.all([readMappings<SlackSubjectKind>(env, SOURCE), readItems(env, SOURCE)]);
  let queued = 0;
  for (const mapping of mappings.values()) {
    if (!mapping.subject_kind) continue;
    const item = items.get(mapping.external_id);
    if (item?.status === 'importing' || item?.status === 'queued') continue;
    await writeItem(env, SOURCE, mapping.external_id, { status: 'queued', error: null });
    await env.IMPORT_JOBS.send({
      kind: 'slack-channel',
      channelId: mapping.external_id,
      oldest: item?.backfill_done ? lookback(item.cursor) : null,
    } satisfies SlackChannelJob);
    queued += 1;
  }
  if (queued) log('info', 'slack.sync.tick', { queued });
  return queued;
}

// ---------------------------------------------------------------- the card

export async function slackConnectorStatus(env: Env): Promise<ConnectorStatus> {
  const [mappings, items, pulse] = await Promise.all([
    readMappings<SlackSubjectKind>(env, SOURCE).catch(() => new Map<string, MappingRow>()),
    readItems(env, SOURCE).catch(() => new Map<string, ItemRow>()),
    connectorPulse(env, 'slack'),
  ]);
  const mapped = [...mappings.values()].filter((row) => row.subject_kind);
  return {
    id: 'slack',
    configured: slackConfigured(env),
    imported: [...items.values()].reduce((sum, row) => sum + row.count, 0),
    unfiled: mapped.filter((row) => !items.get(row.external_id)?.backfill_done).length,
    suggested: 0,
    accepted: 0,
    corrected: 0,
    suggesting: false,
    last_webhook_at: null,
    last_import_at: mapped.length ? Math.max(...mapped.map((row) => row.decided_at)) : null,
    last_sync_at: pulse.sync ?? null,
    enabled: slackImportEnabled(env),
  };
}
