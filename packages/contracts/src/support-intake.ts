import { z } from 'zod';
import { MESSAGE_TEXT_MAX_CHARS } from './limits';

export const SUPPORT_INTAKE_BODY_MAX_BYTES = 12_000;

/** An anonymous public contact message, sent from /support. */
export const supportIntakeSubmissionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(320),
  message: z.string().trim().min(1).max(MESSAGE_TEXT_MAX_CHARS),
  request_id: z.string().uuid(),
  turnstile_token: z.string().trim().min(1).max(2048).optional(),
}).strict();
export type SupportIntakeSubmission = z.infer<typeof supportIntakeSubmissionSchema>;

export const supportIntakeResponseSchema = z.object({ ok: z.literal(true) });
export type SupportIntakeResponse = z.infer<typeof supportIntakeResponseSchema>;
