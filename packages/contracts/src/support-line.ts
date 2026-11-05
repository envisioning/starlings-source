import { z } from 'zod';

/**
 * The support line (docs/SUPPORT.md): every Starlings workspace
 * talks to starlings-hq through a peer grant. On first use the workspace's
 * Worker asks hq to connect it, signed with the shared `SUPPORT_LINK_KEY`;
 * hq makes the workspace's organization, grants it write on that
 * organization's guest thread, and answers the peer token once.
 */

/** `POST /api/support-line/connect` on hq, server to server. */
export const supportLineConnectSchema = z.object({
  /** The asking workspace's own origin, `https://<slug>.<suffix>`. */
  origin: z.string().url().max(200),
  /** The workspace's name, the organization's name in hq. */
  name: z.string().trim().min(1).max(120),
}).strict();
export type SupportLineConnect = z.infer<typeof supportLineConnectSchema>;

export const supportLineConnectResponseSchema = z.object({
  peer_token: z.string(),
  mcp_url: z.string().url(),
  thread_id: z.string(),
});
export type SupportLineConnectResponse = z.infer<typeof supportLineConnectResponseSchema>;

/**
 * One support conversation: a top-level line in the workspace's
 * guest thread on hq, with its replies under it. Its state is read on hq:
 * `resolved` when the conversation's card is finished, `waiting` when
 * Starlings support wrote last, `open` otherwise.
 */
export const SUPPORT_CONVERSATION_STATES = ['open', 'waiting', 'resolved'] as const;
export const supportConversationStateSchema = z.enum(SUPPORT_CONVERSATION_STATES);
export type SupportConversationState = z.infer<typeof supportConversationStateSchema>;

export const supportConversationLineSchema = z.object({
  id: z.string(),
  sender_name: z.string(),
  /** True for a line the workspace wrote; false for Starlings support. */
  mine: z.boolean(),
  text: z.string(),
  sent_at: z.number().int(),
});
export type SupportConversationLine = z.infer<typeof supportConversationLineSchema>;

/** As hq's `support_conversations` tool answers: every conversation, newest activity first. */
export const supportConversationSchema = z.object({
  /** The id of the conversation's first line. */
  id: z.string(),
  state: supportConversationStateSchema,
  /** Epoch milliseconds of the last line. */
  last_at: z.number().int(),
  lines: z.array(supportConversationLineSchema),
});
export type SupportConversation = z.infer<typeof supportConversationSchema>;

export const supportConversationsResponseSchema = z.object({
  conversations: z.array(supportConversationSchema),
});

/** A conversation as a member of the workspace reads it in Help. */
export const helpConversationSchema = supportConversationSchema.extend({
  /** True when Starlings support wrote since this member last opened it. */
  unread: z.boolean(),
  /** True when this member started it. An admin also sees the others. */
  started_by_me: z.boolean(),
});
export type HelpConversation = z.infer<typeof helpConversationSchema>;

/** `GET /api/help`. `available` is false where no hq is configured, and on hq itself. */
export const helpResponseSchema = z.object({
  available: z.boolean(),
  conversations: z.array(helpConversationSchema),
});
export type HelpResponse = z.infer<typeof helpResponseSchema>;

/** `GET /api/help/status`: what the Help button's badge needs, cached for a minute. */
export const helpStatusResponseSchema = z.object({
  available: z.boolean(),
  unread: z.number().int().nonnegative(),
});
export type HelpStatusResponse = z.infer<typeof helpStatusResponseSchema>;

/** `POST /api/help`: a new conversation, or with `conversation_id` a reply in one. */
export const helpSendSchema = z.object({
  text: z.string().trim().min(1).max(4_000),
  conversation_id: z.string().trim().min(1).max(80).optional(),
  /** The request id of the error the member came from, when they came from one. */
  request_id: z.string().trim().max(80).optional(),
  /** The app's version, as the client knows it. */
  app_version: z.string().trim().max(40).optional(),
  /** The Debug dump, only when the member ticked the box. */
  debug: z.string().max(8_000).optional(),
}).strict();
export type HelpSend = z.infer<typeof helpSendSchema>;
