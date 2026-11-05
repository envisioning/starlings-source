import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import {
  supportLineConnectResponseSchema,
  supportLineConnectSchema,
  type HelpResponse,
  type HelpSend,
  type OwnerSession,
  type SupportLineConnectResponse,
} from './contracts';
import type { RoleSession } from './capabilities';
import { hmacSHA256Hex, openSecret, sealSecret, verifyTimedSignature, type SealedSecret } from './crypto';
import { ControlError } from './errors';
import { guestThreadAccess, guestThreadId, guestThreadSubject, type GuestSession } from './guests';
import { fetchCrmTask, updateCrmTask } from './crm';
import { fileSupportRequest } from './support-requests';
import { threadStub } from './threads';
import { FINISHED_TASK_STATUSES, supportConversationsResponseSchema, type HelpConversation, type HelpStatusResponse, type InboxItem, type SupportConversation } from './contracts';
import { rotatePeerToken, writePeerGrant } from './peer-workspaces';
import { d1CreateOrganization } from './work-d1';
import { workspaceDisplayName } from './workspace-profile';

/**
 * The support line (docs/SUPPORT.md). Every workspace talks to
 * starlings-hq through a peer grant on the workspace's own organization in
 * hq. The workspace connects itself on first use: its Worker signs a
 * request with the shared `SUPPORT_LINK_KEY`; hq makes the organization,
 * grants it write on that organization's guest thread, and answers the peer
 * token once. The workspace seals the token in its D1 and from then on
 * reads and writes the thread through hq's `/mcp`, naming the member.
 */

const SETTING_KEY = 'support_line';
const SYSTEM_ACTOR: RoleSession = { sub: 'system:support-line', email: `support-line@${WORKSPACE_HOST_SUFFIX}`, name: 'Support line', role: 'admin' };

function trimOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/u, '');
}

/** True on the workspace that answers support lines: hq. */
export function isSupportHq(env: Pick<Env, 'SUPPORT_HQ_ORIGIN' | 'PUBLIC_API_ORIGIN'>): boolean {
  const hq = env.SUPPORT_HQ_ORIGIN?.trim();
  return !!hq && trimOrigin(hq) === trimOrigin(env.PUBLIC_API_ORIGIN);
}

async function linkKey(env: Env): Promise<string> {
  const binding = (env as { SHARED_SUPPORT_LINK_KEY?: SecretsStoreSecret }).SHARED_SUPPORT_LINK_KEY;
  const key = binding ? await binding.get().catch(() => '') : '';
  if (!key) throw new ControlError('The support line is not configured here.', 503, 'not_configured');
  return key;
}

// --- hq: answer a workspace -------------------------------------------------

/**
 * A workspace's own origin, which names its line: https, nothing after the
 * host. The shared-key signature, not the host, proves the caller is one of
 * our Workers; Envisioning's API still answers on workers.dev.
 */
function workspaceOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search) {
    throw new ControlError('A support line names a workspace by its https origin.', 400, 'invalid_request');
  }
  return url.origin;
}

/**
 * `POST /api/support-line/connect` on hq. Connecting again rotates the
 * token, so a workspace that lost its copy gets a new one and the old one
 * stops working.
 */
export async function connectSupportLine(env: Env, request: Request, rawBody: string): Promise<SupportLineConnectResponse> {
  if (!isSupportHq(env)) throw new ControlError('This workspace does not answer support lines.', 404, 'request_not_found');
  const key = await linkKey(env);
  const timestamp = request.headers.get('x-support-timestamp') ?? '';
  const signature = request.headers.get('x-support-signature') ?? '';
  if (!(await verifyTimedSignature(key, { timestamp, signature, message: `${timestamp}.${rawBody}` }))) {
    throw new ControlError('That support line request is not signed.', 401, 'owner_auth_required');
  }
  const body = supportLineConnectSchema.parse(JSON.parse(rawBody));
  const origin = workspaceOrigin(body.origin);

  const line = await env.USAGE.prepare('SELECT organization_id FROM support_lines WHERE origin = ?1')
    .bind(origin).first<{ organization_id: string }>();
  let organizationId = line?.organization_id ?? null;
  let token: string | undefined;
  if (organizationId) {
    token = (await rotatePeerToken(env, SYSTEM_ACTOR, organizationId)).peer_token;
  } else {
    const organization = await d1CreateOrganization(env, SYSTEM_ACTOR.email, body.name);
    organizationId = organization.id;
    const granted = await writePeerGrant(env, SYSTEM_ACTOR, { kind: 'organization', id: organizationId }, {
      principal_kind: 'peer_workspace',
      peer: { organization_id: organizationId },
      role: 'write',
    });
    token = granted.peer_token ?? (await rotatePeerToken(env, SYSTEM_ACTOR, organizationId)).peer_token;
    await env.USAGE.prepare('INSERT INTO support_lines (origin, organization_id, created_at) VALUES (?1, ?2, ?3)')
      .bind(origin, organizationId, Date.now()).run();
  }
  return {
    peer_token: token,
    mcp_url: `${trimOrigin(env.PUBLIC_API_ORIGIN)}/mcp`,
    thread_id: await guestThreadId('organization', organizationId),
  };
}

// --- hq: conversations on a support line ------------------------------------

const CONVERSATION_PAGES = 4;

/** The organization behind a peer session, when it is a workspace's support line. */
async function supportLineOrganization(env: Env, peer: GuestSession): Promise<string | null> {
  if (!peer.sub.startsWith('peer:')) return null;
  const organizationId = peer.sub.slice('peer:'.length);
  const row = await env.USAGE.prepare('SELECT 1 AS one FROM support_lines WHERE organization_id = ?1').bind(organizationId).first();
  return row ? organizationId : null;
}

const finished = (status: string | null | undefined): boolean => (FINISHED_TASK_STATUSES as readonly string[]).includes(status ?? '');

/**
 * After a workspace writes on its support line: a new
 * conversation becomes a card on the workspace's organization; a reply in a
 * conversation whose card is finished opens the card again.
 */
export async function afterSupportLinePost(
  env: Env,
  peer: GuestSession,
  input: { threadId: string; messageId: string; text: string; author?: string | undefined; replyTo?: string | undefined },
): Promise<void> {
  const organizationId = await supportLineOrganization(env, peer);
  if (!organizationId) return;
  if (!input.replyTo) {
    await fileSupportRequest(env, {
      threadId: input.threadId,
      messageId: input.messageId,
      subject: { kind: 'organization', id: organizationId },
      text: input.text,
      sender: input.author ? `${input.author} (${peer.name})` : peer.name,
      actorEmail: SYSTEM_ACTOR.email,
    });
    return;
  }
  const request = await env.USAGE.prepare('SELECT task_id FROM support_requests WHERE thread_id = ?1 AND message_id = ?2')
    .bind(input.threadId, input.replyTo).first<{ task_id: string }>();
  if (!request) return;
  const task = await fetchCrmTask(env, request.task_id);
  if (task && finished(task.status)) await updateCrmTask(env, request.task_id, { status: 'pending', actor_email: SYSTEM_ACTOR.email });
}

/**
 * hq's `support_conversations` tool: the support line's thread as
 * conversations, each a first line and the replies under it, with its state.
 * `resolved` when its card is finished; `waiting` when Starlings support
 * wrote last; `open` otherwise.
 */
export async function supportConversations(env: Env, peer: GuestSession, threadId: string): Promise<SupportConversation[]> {
  await guestThreadAccess(env, peer, threadId);
  const stub = threadStub(env, threadId);
  const rows: Awaited<ReturnType<typeof stub.messages>>['messages'] = [];
  let before: string | undefined;
  for (let page = 0; page < CONVERSATION_PAGES; page += 1) {
    const read = await stub.messages(peer.sub, { before, limit: 50 });
    rows.push(...read.messages);
    if (!read.olderCursor) break;
    before = read.olderCursor;
  }
  const lines = rows.filter((row) => row.type === 'text' && row.deleted_at === undefined).sort((a, b) => a.sent_at - b.sent_at);
  const byRoot = new Map<string, SupportConversation>();
  for (const row of lines) {
    const line = { id: row.id, sender_name: row.sender_name ?? row.sender_email.split('@')[0] ?? '', mine: row.sender_email === peer.email, text: row.text, sent_at: row.sent_at };
    const root = row.reply_to_message_id ? byRoot.get(row.reply_to_message_id) : undefined;
    if (root) {
      root.lines.push(line);
      root.last_at = row.sent_at;
    } else if (!row.reply_to_message_id) {
      byRoot.set(row.id, { id: row.id, state: 'open', last_at: row.sent_at, lines: [line] });
    }
  }
  const { results } = await env.USAGE.prepare('SELECT message_id, task_id FROM support_requests WHERE thread_id = ?1')
    .bind(threadId).all<{ message_id: string; task_id: string }>();
  const cards = new Map(results.map((row) => [row.message_id, row.task_id]));
  const conversations = [...byRoot.values()];
  await Promise.all(conversations.map(async (conversation) => {
    const taskId = cards.get(conversation.id);
    const task = taskId ? await fetchCrmTask(env, taskId).catch(() => null) : null;
    const last = conversation.lines[conversation.lines.length - 1]!;
    conversation.state = task && finished(task.status) ? 'resolved' : last.mine ? 'open' : 'waiting';
  }));
  return conversations.sort((a, b) => b.last_at - a.last_at);
}

// --- a workspace: talk to hq ------------------------------------------------

interface StoredLine { token: SealedSecret; mcp_url: string; thread_id: string }

function helpAvailable(env: Env): boolean {
  return !!env.SUPPORT_HQ_ORIGIN?.trim() && !isSupportHq(env);
}

async function readStoredLine(env: Env): Promise<{ token: string; mcpURL: string; threadId: string } | null> {
  const row = await env.USAGE.prepare('SELECT value FROM workspace_settings WHERE key = ?1').bind(SETTING_KEY).first<{ value: string }>();
  if (!row) return null;
  const stored = JSON.parse(row.value) as StoredLine;
  return { token: await openSecret(env.GOOGLE_TOKEN_ENCRYPTION_KEY, stored.token), mcpURL: stored.mcp_url, threadId: stored.thread_id };
}

async function connect(env: Env): Promise<{ token: string; mcpURL: string; threadId: string }> {
  const key = await linkKey(env);
  const body = JSON.stringify({ origin: trimOrigin(env.PUBLIC_API_ORIGIN), name: await workspaceDisplayName(env) });
  const timestamp = String(Date.now());
  const response = await fetch(`${trimOrigin(env.SUPPORT_HQ_ORIGIN)}/api/support-line/connect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-support-timestamp': timestamp,
      'x-support-signature': await hmacSHA256Hex(key, `${timestamp}.${body}`),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new ControlError('Couldn’t reach Starlings support.', 502, 'peer_unavailable');
  const answer = supportLineConnectResponseSchema.parse(await response.json());
  const stored: StoredLine = {
    token: await sealSecret(env.GOOGLE_TOKEN_ENCRYPTION_KEY, answer.peer_token),
    mcp_url: answer.mcp_url,
    thread_id: answer.thread_id,
  };
  await env.USAGE.prepare(`INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(key) DO UPDATE SET value = ?2, updated_by = ?3, updated_at = ?4`)
    .bind(SETTING_KEY, JSON.stringify(stored), SYSTEM_ACTOR.email, Date.now()).run();
  return { token: answer.peer_token, mcpURL: answer.mcp_url, threadId: answer.thread_id };
}

/** One tool call on hq's `/mcp`. Null when the token no longer opens anything. */
async function callHq(line: { token: string; mcpURL: string }, name: string, args: Record<string, unknown>): Promise<unknown | null> {
  const response = await fetch(line.mcpURL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${line.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new ControlError('Couldn’t reach Starlings support.', 502, 'peer_unavailable');
  const rpc = await response.json() as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }; error?: { message?: string } };
  const text = rpc.result?.content?.find((part) => part.type === 'text')?.text;
  if (rpc.error || rpc.result?.isError || text === undefined) throw new ControlError('Starlings support refused that.', 502, 'peer_unavailable');
  return JSON.parse(text) as unknown;
}

/** Run `name` with the stored line; connect, or reconnect once when hq no longer knows the token. */
async function withLine(env: Env, name: string, args: (threadId: string) => Record<string, unknown>): Promise<unknown> {
  let line = await readStoredLine(env) ?? await connect(env);
  let result = await callHq(line, name, args(line.threadId));
  if (result === null) {
    line = await connect(env);
    result = await callHq(line, name, args(line.threadId));
  }
  if (result === null) throw new ControlError('Starlings support refused this workspace.', 502, 'peer_unavailable');
  return result;
}

const CONVERSATIONS_TTL_MS = 60_000;
let conversationsCache: { at: number; conversations: SupportConversation[] } | null = null;

/** Every conversation on this workspace's support line, read from hq and kept for a minute. */
async function hqConversations(env: Env, fresh = false): Promise<SupportConversation[]> {
  if (!fresh && conversationsCache && Date.now() - conversationsCache.at < CONVERSATIONS_TTL_MS) return conversationsCache.conversations;
  const answer = supportConversationsResponseSchema.parse(await withLine(env, 'support_conversations', (threadId) => ({ thread_id: threadId })));
  conversationsCache = { at: Date.now(), conversations: answer.conversations };
  return answer.conversations;
}

interface ConversationRow { conversation_id: string; member_sub: string; seen_at: number }

async function conversationRows(env: Env): Promise<Map<string, ConversationRow>> {
  const { results } = await env.USAGE.prepare('SELECT conversation_id, member_sub, seen_at FROM help_conversations').all<ConversationRow>();
  return new Map(results.map((row) => [row.conversation_id, row]));
}

/** Starlings support wrote after `seenAt`. */
function repliedSince(conversation: SupportConversation, seenAt: number): boolean {
  return conversation.lines.some((line) => !line.mine && line.sent_at > seenAt);
}

/** A member's own conversations; an admin's view also has everybody else's. */
async function memberConversations(env: Env, owner: RoleSession, fresh = false): Promise<HelpConversation[]> {
  const [conversations, rows] = await Promise.all([hqConversations(env, fresh), conversationRows(env)]);
  const admin = owner.role === 'admin';
  return conversations.flatMap((conversation) => {
    const row = rows.get(conversation.id);
    const mine = row?.member_sub === owner.sub;
    if (!mine && !admin) return [];
    return [{ ...conversation, started_by_me: mine, unread: mine && repliedSince(conversation, row.seen_at) }];
  });
}

export async function readHelp(env: Env, owner: RoleSession): Promise<HelpResponse> {
  if (!helpAvailable(env)) return { available: false, conversations: [] };
  return { available: true, conversations: await memberConversations(env, owner) };
}

/** What the Help button's badge needs: how many of this member's conversations have an unread reply. */
export async function readHelpStatus(env: Env, owner: RoleSession): Promise<HelpStatusResponse> {
  if (!helpAvailable(env)) return { available: false, unread: 0 };
  const conversations = await memberConversations(env, owner).catch(() => [] as HelpConversation[]);
  return { available: true, unread: conversations.filter((conversation) => conversation.unread).length };
}

/** The member read a conversation: its replies so far are no longer unread. */
export async function markHelpSeen(env: Env, owner: RoleSession, conversationId: string): Promise<HelpStatusResponse> {
  await env.USAGE.prepare('UPDATE help_conversations SET seen_at = ?3 WHERE conversation_id = ?1 AND member_sub = ?2')
    .bind(conversationId, owner.sub, Date.now()).run();
  return readHelpStatus(env, owner);
}

/** INBOX rows: Starlings support answered a conversation this member started. */
export async function supportInboxItems(env: Env, owner: RoleSession): Promise<InboxItem[]> {
  if (!helpAvailable(env)) return [];
  const conversations = await memberConversations(env, owner);
  return conversations.filter((conversation) => conversation.unread).map((conversation) => {
    const reply = [...conversation.lines].reverse().find((line) => !line.mine)!;
    return {
      source: 'support' as const,
      key: `support:${conversation.id}:${reply.sent_at}`,
      at: reply.sent_at,
      conversation_id: conversation.id,
      preview: reply.text.split('\n')[0]!.slice(0, 160),
    };
  });
}

/** The details a line to hq carries under its text: one short line, never the member's content. */
function helpFooter(env: Env, body: HelpSend, workspace: string): string {
  const facts = [body.app_version ? `Starlings ${body.app_version}` : null, workspace, body.request_id ? `request ${body.request_id}` : null].filter(Boolean);
  const debug = body.debug?.trim() ? `\n\nDebug details:\n${body.debug.trim()}` : '';
  return `\n\n${facts.join(' · ')}${debug}`;
}

export async function sendHelp(env: Env, owner: RoleSession, body: HelpSend): Promise<HelpResponse> {
  if (!helpAvailable(env)) throw new ControlError('Help is not available on this workspace.', 404, 'request_not_found');
  const workspace = await workspaceDisplayName(env);
  // A reply carries only what the member typed; a new conversation says where it came from.
  const text = (body.conversation_id ? body.text : `${body.text}${helpFooter(env, body, workspace)}`).slice(0, 4_000);
  const sent = await withLine(env, 'send_message', (threadId) => ({
    thread_id: threadId,
    text,
    author: owner.name || owner.email,
    ...(body.conversation_id ? { reply_to: body.conversation_id } : {}),
  })) as { message_id?: string };
  const now = Date.now();
  if (!body.conversation_id && sent.message_id) {
    await env.USAGE.prepare('INSERT OR IGNORE INTO help_conversations (conversation_id, member_sub, created_at, seen_at) VALUES (?1, ?2, ?3, ?3)')
      .bind(sent.message_id, owner.sub, now).run();
  } else if (body.conversation_id) {
    await env.USAGE.prepare('UPDATE help_conversations SET seen_at = ?3 WHERE conversation_id = ?1 AND member_sub = ?2')
      .bind(body.conversation_id, owner.sub, now).run();
  }
  return { available: true, conversations: await memberConversations(env, owner, true) };
}
