import { z } from 'zod';
import { crmTaskSchema } from './crm';

/**
 * Support requests (docs/SUPPORT.md): a card a member made from one line a
 * guest or an organization wrote in a subject's guest thread. The card is an
 * ordinary task on that subject; the request is the link back to the line.
 */

/** `POST /api/threads/{thread}/messages/{message}/request`. With no title, the line's first words are the title. */
export const supportRequestCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});
export type SupportRequestCreate = z.infer<typeof supportRequestCreateSchema>;

export const supportRequestSchema = z.object({
  task_id: z.string(),
  message_id: z.string(),
  /** Epoch milliseconds. */
  created_at: z.number().int(),
});
export type SupportRequest = z.infer<typeof supportRequestSchema>;

export const supportRequestCreateResponseSchema = z.object({
  task: crmTaskSchema,
  request: supportRequestSchema,
});
export type SupportRequestCreateResponse = z.infer<typeof supportRequestCreateResponseSchema>;

/** `GET /api/threads/{thread}/requests`: the cards made from this guest thread's lines. */
export const supportRequestsResponseSchema = z.object({
  requests: z.array(supportRequestSchema),
});
export type SupportRequestsResponse = z.infer<typeof supportRequestsResponseSchema>;
