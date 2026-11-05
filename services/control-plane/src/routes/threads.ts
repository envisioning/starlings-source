import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentStagedResponse,
  type AttachmentUploadedResponse,
  type MessageEditResponse,
  type MessageReactionsResponse,
  type MessageWithdrawResponse,
  type SentMessageResponse,
  type ThreadArchiveResponse,
  type ThreadChangesResponse,
  type ThreadMessagesResponse,
  type CardLinesResponse,
  cardLinesQuerySchema,
  type ThreadMessagesSinceResponse,
  type ThreadMuteResponse,
  type ThreadQuestionAnswerResponse,
  type ThreadReleaseUpdateResponse,
  type ThreadReadResponse,
  type ThreadResponse,
  type ThreadsResponse,
  attachmentCreateSchema,
  messageReactionSchema,
  threadArchiveSchema,
  threadChangesQuerySchema,
  threadCreateSchema,
  threadMessageEditSchema,
  threadMessageSendSchema,
  threadMessagesQuerySchema,
  threadMuteSchema,
  threadQuestionAnswerRequestSchema,
  threadReleaseUpdateRequestSchema,
  threadReadSchema,
  supportRequestCreateSchema,
  helpSendSchema,
  type HelpResponse,
  type HelpStatusResponse,
  type SupportRequestCreateResponse,
  type SupportRequestsResponse,
} from '../contracts';
import { requestVia } from '../auth';
import { ControlError } from '../errors';
import { json, readBoundedBytes, readBoundedJSON } from '../http';
import {
  answerThreadQuestion,
  editMessage,
  listThreads,
  markThreadRead,
  openDirectThread,
  openSubjectThread,
  openTeamThread,
  reactToMessage,
  readCardLines,
  readThread,
  readThreadChanges,
  readThreadChangesFeed,
  sendMessage,
  serveAttachment,
  setThreadArchived,
  setThreadMute,
  stageAttachment,
  updateThreadRelease,
  uploadAttachment,
  withdrawMessage,
} from '../threads';
import { defineRoute, type Param, type Route } from '../route-types';
import { createSupportRequest, readSupportRequests } from '../support-requests';
import { markHelpSeen, readHelp, readHelpStatus, sendHelp } from '../support-line';

// Thread ids are `dm_` + a base64url digest, so the charset is mixed case
// plus `-` and `_` — a lowercase-only pattern silently 404s every thread.
const ID: Param = { re: '[A-Za-z0-9_-]{4,72}', sample: 'thread_sample' };

export const threadsRoutes: readonly Route[] = [
  defineRoute({
    method: 'GET',
    path: '/api/threads/messages',
    gate: { kind: 'capability', capability: 'conversations' },
    handler: async ({ env, url, owner }) => {
      const query = threadChangesQuerySchema.parse(Object.fromEntries(url.searchParams));
      return json(await readThreadChangesFeed(owner, env, query.since, query.limit) satisfies ThreadChangesResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/threads',
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = threadCreateSchema.parse(await readBoundedJSON(request));
      // A private conversation is addressed by naming the people in it — one of
      // them or several, the same route either way; a channel by naming what it
      // is about. A subject id is resolved against Core before anything is
      // created, so the title never comes from the client.
      let thread;
      if ('peer_email' in body) {
        thread = await openDirectThread(owner, env, [body.peer_email]);
      } else if ('peer_emails' in body) {
        thread = await openDirectThread(owner, env, body.peer_emails);
      } else if (body.kind === 'team') {
        thread = await openTeamThread(owner, env);
      } else {
        thread = await openSubjectThread(owner, env, body.kind, body.subject_id);
      }
      return json({ thread } satisfies ThreadResponse);
    },
  }),

  // Direct messages. Envisioning-only, exactly like presence — a thread is
  // never addressable with a lobby token, a booking token, or an artifact
  // principal. Membership is the authorization, and a non-member sees the same
  // 404 a missing thread does.
  defineRoute({
    method: 'GET',
    path: '/api/threads',
    gate: { kind: 'capability', capability: 'conversations' },
    handler: async ({ env, owner }) => json(await listThreads(owner, env) satisfies ThreadsResponse),
  }),

  // Help: this workspace's conversation with Starlings support,
  // through the support line's peer grant on hq. Any member reads and writes.
  defineRoute({
    method: 'GET',
    path: '/api/help',
    gate: { kind: 'capability', capability: 'conversations' },
    handler: async ({ env, owner }) => json(await readHelp(env, owner) satisfies HelpResponse),
  }),

  // The Help button's badge: how many of your conversations have an
  // unread reply. Read from hq, kept for a minute.
  defineRoute({
    method: 'GET',
    path: '/api/help/status',
    gate: { kind: 'capability', capability: 'conversations' },
    handler: async ({ env, owner }) => json(await readHelpStatus(env, owner) satisfies HelpStatusResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/help/:conversationId/seen',
    params: { conversationId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ env, owner, params }) => json(await markHelpSeen(env, owner, params.conversationId!) satisfies HelpStatusResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/help',
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = helpSendSchema.parse(await readBoundedJSON(request));
      return json(await sendHelp(env, owner, body) satisfies HelpResponse);
    },
  }),

  // Support requests (docs/SUPPORT.md): a card from one line a guest or an
  // organization wrote in a subject's guest thread.
  defineRoute({
    method: 'POST',
    path: '/api/threads/:threadId/messages/:messageId/request',
    params: { threadId: ID, messageId: ID },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = supportRequestCreateSchema.parse(await readBoundedJSON(request));
      return json(await createSupportRequest(env, owner, params.threadId!, params.messageId!, body.title) satisfies SupportRequestCreateResponse, 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/threads/:threadId/requests',
    params: { threadId: ID },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner, params }) => json({ requests: await readSupportRequests(env, owner, params.threadId!) } satisfies SupportRequestsResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/threads/:threadId/questions/:questionId/answer',
    params: { threadId: ID, questionId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const body = threadQuestionAnswerRequestSchema.parse(await readBoundedJSON(request));
      return json(await answerThreadQuestion(owner,
        env,
        params.threadId!,
        params.questionId!,
        body.option_ids,
        ctx,
      ) satisfies ThreadQuestionAnswerResponse);
    },
  }),

  // An agent's Keep release card: the device that approved or ended
  // the release in Keep records it here. Keep is the authority.
  defineRoute({
    method: 'POST',
    path: '/api/threads/:threadId/releases/:messageId',
    params: { threadId: ID, messageId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const body = threadReleaseUpdateRequestSchema.parse(await readBoundedJSON(request));
      return json(await updateThreadRelease(owner, env, params.threadId!, params.messageId!, body, ctx) satisfies ThreadReleaseUpdateResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/card-lines',
    gate: { kind: 'capability', capability: 'conversations' },
    handler: async ({ env, url, owner }) => {
      const query = cardLinesQuerySchema.parse({ kind: url.searchParams.get('kind'), id: url.searchParams.get('id') });
      return json({ lines: await readCardLines(owner, env, query) } satisfies CardLinesResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/threads/:threadId/messages',
    params: { threadId: ID },
    gate: { kind: 'capability', capability: 'conversations' },
    handler: async ({ env, url, owner, params }) => {
      const raw: Record<string, string> = {};
      const before = url.searchParams.get('before');
      const since = url.searchParams.get('since');
      const limit = url.searchParams.get('limit');
      if (before !== null) raw.before = before;
      if (since !== null) raw.since = since;
      if (limit !== null) raw.limit = limit;
      const query = threadMessagesQuerySchema.parse(raw);
      if (query.since !== undefined) {
        if (query.before !== undefined) {
          throw new ControlError('Pass either before or since, not both.', 400, 'invalid_request');
        }
        return json(await readThreadChanges(owner, env, params.threadId!, query.since, query.limit) satisfies ThreadMessagesSinceResponse);
      }
      return json(await readThread(owner, env, params.threadId!, query) satisfies ThreadMessagesResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/threads/:threadId/messages',
    params: { threadId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const body = threadMessageSendSchema.parse(await readBoundedJSON(request));
      return json(await sendMessage(owner, env, params.threadId!, body, ctx, await requestVia(request, env)) satisfies SentMessageResponse, 201);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/threads/:threadId/read',
    params: { threadId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = threadReadSchema.parse(await readBoundedJSON(request));
      return json(await markThreadRead(owner, env, params.threadId!, body.at) satisfies ThreadReadResponse);
    },
  }),

  // Per-member, like a mute. No archive to browse: the roster is already the
  // index, so an archived DM comes back by clicking the person.
  defineRoute({
    method: 'POST',
    path: '/api/threads/:threadId/archive',
    params: { threadId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = threadArchiveSchema.parse(await readBoundedJSON(request));
      return json(await setThreadArchived(owner, env, params.threadId!, body.archived) satisfies ThreadArchiveResponse);
    },
  }),

  // Per-member, like read state: a channel one person has heard enough of is
  // still the channel everybody else is working in.
  defineRoute({
    method: 'POST',
    path: '/api/threads/:threadId/mute',
    params: { threadId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = threadMuteSchema.parse(await readBoundedJSON(request));
      return json(await setThreadMute(owner, env, params.threadId!, body.until) satisfies ThreadMuteResponse);
    },
  }),

  // Reserve somewhere to put a file. The bytes follow on the path this
  // returns — small transactional write first, large fallible one second.
  defineRoute({
    method: 'POST',
    path: '/api/threads/:threadId/attachments',
    params: { threadId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = attachmentCreateSchema.parse(await readBoundedJSON(request));
      return json(await stageAttachment(owner, env, params.threadId!, body) satisfies AttachmentStagedResponse, 201);
    },
  }),

  // One message, or one file. Both carry a second id.
  defineRoute({
    method: 'POST',
    path: '/api/threads/:threadId/messages/:messageId/reactions',
    params: { threadId: ID, messageId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const body = messageReactionSchema.parse(await readBoundedJSON(request));
      return json(await reactToMessage(owner, env, params.threadId!, params.messageId!, body.emoji, ctx) satisfies MessageReactionsResponse);
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/threads/:threadId/messages/:messageId',
    params: { threadId: ID, messageId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = threadMessageEditSchema.parse(await readBoundedJSON(request));
      return json(await editMessage(owner, env, params.threadId!, params.messageId!, body.text) satisfies MessageEditResponse);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/threads/:threadId/messages/:messageId',
    params: { threadId: ID, messageId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ env, ctx, owner, params }) => json(
      await withdrawMessage(owner, env, params.threadId!, params.messageId!, ctx) satisfies MessageWithdrawResponse,
    ),
  }),

  // Raw bytes, not JSON: the body cap here is the attachment ceiling, and
  // routing it through `readBoundedJSON` would base64 a video into memory.
  // Streamed and counted rather than buffered whole, exactly like the avatar
  // upload: an oversized file is refused while it is still arriving instead of
  // after all of it has been held.
  defineRoute({
    method: 'PUT',
    path: '/api/threads/:threadId/attachments/:attachmentId',
    params: { threadId: ID, attachmentId: ID },
    gate: { kind: 'capability', capability: 'conversations', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const bytes = await readBoundedBytes(request, ATTACHMENT_MAX_BYTES);
      return json(await uploadAttachment(owner, env, params.threadId!, params.attachmentId!, bytes) satisfies AttachmentUploadedResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/threads/:threadId/attachments/:attachmentId',
    params: { threadId: ID, attachmentId: ID },
    gate: { kind: 'capability', capability: 'conversations' },
    handler: ({ env, owner, params }) => serveAttachment(owner, env, params.threadId!, params.attachmentId!),
  }),
];
