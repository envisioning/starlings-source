import {
  appIntakeReplySchema,
  appIntakeSignedString,
  appIntakeSubmissionSchema,
  APP_INTAKE_SIGNATURE_HEADER,
  APP_INTAKE_TIMESTAMP_HEADER,
  type AppIntakeResponse,
  type AppIntakeSubmission,
} from '@starlings/contracts/app-intake';
import { MESSAGE_TEXT_MAX_CHARS } from '@starlings/contracts/limits';
import { hmacSHA256Hex, sha256, verifyTimedSignature } from './crypto';
import { ControlError } from './errors';
import { ensureIntakeThread } from './support-intake';
import { appendInboundMessage, inboundMessageId } from './threads';

/**
 * The app channel door (docs/SUPPORT.md). A
 * workspace's own backend bridges its app's support DM to the
 * workspace. Each app user has one private thread on `organization:intake`;
 * each request is one line, origin `app`, and an unanswered line is a
 * `guest` INBOX row, as for the website intake. There is no guest grant and
 * no mail: members read the thread only. A member's reply goes back to the
 * backend, signed, from `sendMessage` (`queueAppIntakeReply`).
 *
 * Data rule: the backend's logs, screenshots and images stay there. This
 * door takes text and metadata only, never fetches `attachments_url`, never
 * wakes an agent, and never logs a body, a reporter ref or a text.
 */

const APP_LABEL = 'App';
const REPLY_ATTEMPTS = 3;
const REPLY_BACKOFF_MS = [250, 1_000] as const;
const REPLY_TIMEOUT_MS = 5_000;

/**
 * The Secrets Store binding, when this workspace has one and the store holds
 * a value. The secret is 64 hex characters; both sides key the HMAC with the
 * 32 bytes it decodes to, never the hex text. Anything else is no key.
 */
async function intakeKey(env: Env): Promise<Uint8Array<ArrayBuffer> | null> {
  const binding = env.APP_INTAKE_KEY;
  if (!binding) return null;
  const hex = (await binding.get().catch(() => '')).trim();
  if (!/^[0-9a-f]{64}$/iu.test(hex)) return null;
  return Uint8Array.from(hex.match(/../gu)!, (pair) => parseInt(pair, 16));
}

function replyURL(env: Env): string {
  return (env.APP_INTAKE_REPLY_URL ?? '').trim();
}

function allowedAttachmentHosts(env: Env): Set<string> {
  const raw = env.APP_INTAKE_ALLOWED_ATTACHMENT_HOSTS ?? '';
  return new Set(raw.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
}

/** Stable, private thread per app user. */
export async function appIntakeThreadId(reporterRef: string): Promise<string> {
  return `gst_${(await sha256(`app-intake:${reporterRef}`)).slice(0, 32)}`;
}

/** Clipped to fit a thread line, as forwarded email is. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A report's text, then one line of metadata. A message is its text alone.
 * The line fits `MESSAGE_TEXT_MAX_CHARS`: the text is clipped, the metadata
 * line never is.
 */
export function appIntakeLine(submission: AppIntakeSubmission): string {
  const report = submission.report;
  if (!report) return clip(submission.text, MESSAGE_TEXT_MAX_CHARS);
  const facts = [
    report.platform === 'ios' ? 'iOS' : 'Android',
    report.app_version ? (report.build !== undefined ? `${report.app_version} (${report.build})` : report.app_version)
      : report.build !== undefined ? `build ${report.build}` : null,
    report.labels.length ? report.labels.join(', ') : null,
    `logs ${report.has_logs ? 'yes' : 'no'}`,
    `${report.screenshot_count} ${report.screenshot_count === 1 ? 'screenshot' : 'screenshots'}`,
    report.attachments_url ?? null,
  ].filter(Boolean);
  const meta = facts.join(' · ');
  return `${clip(submission.text, MESSAGE_TEXT_MAX_CHARS - meta.length - 2)}\n\n${meta}`;
}

/**
 * `POST /api/support/app-intake`. Checks, in order: the door is configured
 * (503), the signature (401), the body (400), the attachment host (400).
 * Nothing is written before all four pass. A repeated `message_id` answers
 * the same and adds nothing.
 */
export async function receiveAppIntake(env: Env, request: Request, rawBody: string): Promise<AppIntakeResponse> {
  const key = await intakeKey(env);
  if (!key || !replyURL(env)) throw new ControlError('The app channel is not configured here.', 503, 'not_configured');
  const timestamp = request.headers.get(APP_INTAKE_TIMESTAMP_HEADER) ?? '';
  const signature = request.headers.get(APP_INTAKE_SIGNATURE_HEADER) ?? '';
  if (!(await verifyTimedSignature(key, { timestamp, signature, message: appIntakeSignedString('intake', timestamp, rawBody) }))) {
    throw new ControlError('That app channel request is not signed.', 401, 'owner_auth_required');
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new ControlError('Request body must be valid JSON.', 400, 'invalid_request');
  }
  const submission = appIntakeSubmissionSchema.parse(json);
  const attachments = submission.report?.attachments_url;
  if (attachments && !allowedAttachmentHosts(env).has(new URL(attachments).hostname.toLowerCase())) {
    throw new ControlError('attachments_url names a host this workspace does not take.', 400, 'invalid_request');
  }

  const { reporter } = submission;
  const threadId = await appIntakeThreadId(reporter.ref);
  const name = reporter.name ?? reporter.handle ?? 'App user';
  await ensureIntakeThread(env, threadId, name, APP_LABEL);
  await env.USAGE.prepare(
    `INSERT INTO app_intake_threads (thread_id, reporter_ref, handle, name, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(thread_id) DO UPDATE SET handle = excluded.handle, name = excluded.name`,
  ).bind(threadId, reporter.ref, reporter.handle ?? null, reporter.name ?? null, Date.now()).run();
  await appendInboundMessage(env, {
    threadId,
    messageId: await inboundMessageId(threadId, `app:${submission.message_id}`),
    sender: { sub: `app:${reporter.ref}`, email: reporter.ref, name },
    origin: { kind: 'app', ref: reporter.ref },
    text: appIntakeLine(submission),
    type: 'text',
    refs: [],
  });
  return { ok: true, thread_id: threadId };
}

/**
 * After a member's line in a guest thread: when the thread is an app user's,
 * send the line back to the backend. The caller runs this in `waitUntil` and
 * only for a member's own new line, never a guest's, an agent's or an edit.
 */
export async function queueAppIntakeReply(
  env: Env,
  input: { threadId: string; messageId: string; text: string; authorName: string },
): Promise<void> {
  const url = replyURL(env);
  if (!url || !input.text.trim()) return;
  const row = await env.USAGE.prepare('SELECT reporter_ref FROM app_intake_threads WHERE thread_id = ?1')
    .bind(input.threadId).first<{ reporter_ref: string }>();
  if (!row) return;
  const key = await intakeKey(env);
  if (!key) {
    console.error(JSON.stringify({ level: 'error', message: 'app_intake.reply.not_configured' }));
    return;
  }
  const body = JSON.stringify(appIntakeReplySchema.parse({
    message_id: input.messageId,
    reporter_ref: row.reporter_ref,
    text: input.text,
    author: { name: input.authorName },
  }));
  let status = 0;
  for (let attempt = 0; attempt < REPLY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, REPLY_BACKOFF_MS[attempt - 1]));
    // A fresh timestamp per try: a retry late in the window must still verify.
    const timestamp = String(Date.now());
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [APP_INTAKE_TIMESTAMP_HEADER]: timestamp,
          [APP_INTAKE_SIGNATURE_HEADER]: await hmacSHA256Hex(key, appIntakeSignedString('reply', timestamp, body)),
        },
        body,
        signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
      });
      status = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
      // A 4xx is the backend refusing this reply; sending it again changes nothing.
      if (status < 500) break;
    } catch {
      status = 0;
    }
  }
  console.error(JSON.stringify({ level: 'error', message: 'app_intake.reply.failed', status }));
}
