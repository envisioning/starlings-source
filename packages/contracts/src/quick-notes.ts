import { z } from 'zod';

/** Quick Notes are captured before a subject, assignee, or date is known. */
export const QUICK_NOTE_BODY_MAX_CHARS = 5_000;

export const QUICK_NOTE_SOURCES = ['home', 'work', 'meeting', 'watch'] as const;
export type QuickNoteSource = (typeof QUICK_NOTE_SOURCES)[number];
export const quickNoteSourceSchema = z.enum(QUICK_NOTE_SOURCES);

/** Context is deliberately small until a capture surface needs another link. */
export const quickNoteContextSchema = z.object({
  meeting_id: z.string().uuid(),
}).strict();
export type QuickNoteContext = z.infer<typeof quickNoteContextSchema>;

/**
 * A note starts with a capital, whichever keyboard typed it. Only the first
 * letter changes; the rest of the body is the owner's, verbatim.
 */
export function capitalizeQuickNoteBody(body: string): string {
  return body.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

const quickNoteBodySchema = z.string().trim().min(1).max(QUICK_NOTE_BODY_MAX_CHARS)
  .transform(capitalizeQuickNoteBody);

/** How far back a client's capture time may reach: an outbox older than this sends now. */
export const QUICK_NOTE_CAPTURE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A client saves a note on the device first and sends it later.
 * `id` is minted by the client, so a retry after a lost response finds the
 * note it already made instead of making a second one. `captured_at` is when
 * the person wrote it (epoch milliseconds), so a note sent an hour late still
 * says when it was written. Both are optional: MCP and older apps send neither.
 */
export const quickNoteCreateSchema = z.object({
  body: quickNoteBodySchema,
  source: quickNoteSourceSchema.default('home'),
  context: quickNoteContextSchema.nullable().optional(),
  id: z.string().uuid().optional(),
  captured_at: z.number().int().positive().optional(),
});
export type QuickNoteCreateInput = z.infer<typeof quickNoteCreateSchema>;

/** `PATCH /api/quick-notes/:id`: the body is the only thing an owner rewrites. */
export const quickNoteUpdateSchema = z.object({
  body: quickNoteBodySchema,
}).strict();
export type QuickNoteUpdateInput = z.infer<typeof quickNoteUpdateSchema>;

/**
 * Where a note went. `id` is whatever the destination calls the thing that
 * was made: a Core task or Docs document id (uuid), a thread message id, or a
 * GitHub issue's `owner/repo#number` — so it is an opaque string, not a uuid.
 */
export const QUICK_NOTE_PROMOTION_KINDS = ['task', 'issue', 'retained_note', 'message', 'doc'] as const;
export type QuickNotePromotionKind = (typeof QUICK_NOTE_PROMOTION_KINDS)[number];
export const quickNotePromotionKindSchema = z.enum(QUICK_NOTE_PROMOTION_KINDS);

export const quickNotePromoteSchema = z.object({
  kind: quickNotePromotionKindSchema,
  id: z.string().trim().min(1).max(200),
}).strict();
export type QuickNotePromoteInput = z.infer<typeof quickNotePromoteSchema>;

/** The lifecycle fields are present from the first write so promotion stays traceable. */
export const QUICK_NOTE_STATES = ['open', 'dismissed', 'promoted'] as const;
export type QuickNoteState = (typeof QUICK_NOTE_STATES)[number];
export const quickNoteStateSchema = z.enum(QUICK_NOTE_STATES);

export const quickNotePromotionSchema = z.object({
  kind: quickNotePromotionKindSchema,
  id: z.string(),
  promoted_at: z.string(),
});
export type QuickNotePromotion = z.infer<typeof quickNotePromotionSchema>;

export const quickNoteSchema = z.object({
  id: z.string(),
  body: z.string(),
  source: quickNoteSourceSchema,
  context: quickNoteContextSchema.nullable(),
  state: quickNoteStateSchema,
  promotion: quickNotePromotionSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type QuickNote = z.infer<typeof quickNoteSchema>;

export const quickNotesResponseSchema = z.object({
  notes: z.array(quickNoteSchema),
});
export type QuickNotesResponse = z.infer<typeof quickNotesResponseSchema>;

export const quickNoteResponseSchema = z.object({
  note: quickNoteSchema,
});
export type QuickNoteResponse = z.infer<typeof quickNoteResponseSchema>;

export const quickNoteDeleteResponseSchema = z.object({
  ok: z.literal(true),
});
export type QuickNoteDeleteResponse = z.infer<typeof quickNoteDeleteResponseSchema>;
