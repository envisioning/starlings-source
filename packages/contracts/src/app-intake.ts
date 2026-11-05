import { z } from 'zod';

/**
 * The app channel door (docs/SUPPORT.md): a
 * workspace's own backend bridges its app's support DM to the workspace.
 * A workspace's own backend is the caller. The wire is fixed with that backend; a
 * change here is a change on both sides.
 *
 * Both directions carry `X-Starlings-Timestamp` (Unix ms) and
 * `X-Starlings-Signature`, the hex HMAC-SHA256 of
 * `<direction>.<timestamp>.<rawBody>`. The key is the shared 64-hex
 * `APP_INTAKE_KEY` decoded to its 32 bytes, not the hex text.
 */

export const APP_INTAKE_BODY_MAX_BYTES = 16_384;
/**
 * The longest text the wire takes. The backend sends a message of up to
 * 10,000 characters; the Worker clips the line it writes to
 * `MESSAGE_TEXT_MAX_CHARS`, as forwarded email does. The whole text stays in
 * the app's DM.
 */
export const APP_INTAKE_TEXT_MAX_CHARS = 10_000;
export const APP_INTAKE_TIMESTAMP_HEADER = 'x-starlings-timestamp';
export const APP_INTAKE_SIGNATURE_HEADER = 'x-starlings-signature';
/** The signed string's first part: which way the request goes, so a request cannot be replayed the other way. */
export const APP_INTAKE_DIRECTIONS = ['intake', 'reply'] as const;
export type AppIntakeDirection = (typeof APP_INTAKE_DIRECTIONS)[number];

/** The string both sides sign. */
export function appIntakeSignedString(direction: AppIntakeDirection, timestamp: string, rawBody: string): string {
  return `${direction}.${timestamp}.${rawBody}`;
}

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((value) => value || undefined);

export const appIntakeReporterSchema = z.object({
  ref: z.string().trim().min(1).max(255),
  handle: optionalText(64),
  name: optionalText(120),
}).strict();

export const appIntakeReportSchema = z.object({
  platform: z.enum(['ios', 'android']),
  app_version: optionalText(40),
  build: z.number().int().nonnegative().nullish().transform((value) => value ?? undefined),
  labels: z.array(z.string().trim().min(1).max(40)).max(10).nullish().transform((value) => value ?? []),
  has_logs: z.boolean().nullish().transform((value) => value ?? false),
  screenshot_count: z.number().int().min(0).max(10).nullish().transform((value) => value ?? 0),
  /** A link back into the backend. The Worker checks its host and never fetches it. */
  attachments_url: z.string().trim().max(500).url().refine((value) => value.startsWith('https://'), 'attachments_url must be https')
    .nullish().transform((value) => value || undefined),
}).strict();

/** The backend → Starlings: `POST /api/support/app-intake`. */
export const appIntakeSubmissionSchema = z.object({
  message_id: z.string().trim().min(1).max(255),
  kind: z.enum(['message', 'report']),
  reporter: appIntakeReporterSchema,
  text: z.string().trim().min(1).max(APP_INTAKE_TEXT_MAX_CHARS),
  report: appIntakeReportSchema.nullish().transform((value) => value ?? undefined),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'report' && !value.report) ctx.addIssue({ code: 'custom', path: ['report'], message: 'A report carries report.' });
  if (value.kind === 'message' && value.report) ctx.addIssue({ code: 'custom', path: ['report'], message: 'Only a report carries report.' });
});
export type AppIntakeSubmission = z.infer<typeof appIntakeSubmissionSchema>;

export const appIntakeResponseSchema = z.object({ ok: z.literal(true), thread_id: z.string() });
export type AppIntakeResponse = z.infer<typeof appIntakeResponseSchema>;

/** Starlings → the backend: a member's reply, `POST APP_INTAKE_REPLY_URL`. It answers 204. */
export const appIntakeReplySchema = z.object({
  message_id: z.string().min(1),
  reporter_ref: z.string().min(1).max(255),
  text: z.string().min(1),
  author: z.object({ name: z.string() }).strict(),
}).strict();
export type AppIntakeReply = z.infer<typeof appIntakeReplySchema>;
