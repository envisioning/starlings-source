// Outbound mail. Two modes, chosen by `EMAIL_MODE`:
//
//   log  — write the message to the Worker log and return. This is the default
//          in dev and in tests, so nothing ever reaches a real inbox by
//          accident while someone is iterating on a signing flow.
//   send — POST to Postmark, which is what Core already uses.
//
// Nothing on a user-facing path may fail because mail failed: a verification
// code that cannot be delivered surfaces as a failed *send*, not a 500 on the
// route that triggered it. Callers decide how loudly to complain.

import { DOCS_EMAIL_FROM } from '../../../../packages/contracts/src/deployment-values';
import { DocsError } from './errors';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export async function sendMail(env: Env, mail: Mail): Promise<void> {
  const mode = env.EMAIL_MODE ?? 'log';

  if (mode !== 'send') {
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'email.logged',
        to: mail.to,
        subject: mail.subject,
        // The body carries verification codes. In `log` mode that is the point
        // — it is how you test locally — but it is also why `log` must never
        // be the production setting.
        text: mail.text,
      }),
    );
    return;
  }

  const token = env.POSTMARK_TOKEN?.trim();
  if (!token) throw new DocsError('POSTMARK_TOKEN is not configured.', 503, 'not_configured');

  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-postmark-server-token': token,
    },
    body: JSON.stringify({
      From: env.EMAIL_FROM || DOCS_EMAIL_FROM,
      To: mail.to,
      Subject: mail.subject,
      TextBody: mail.text,
      ...(mail.html ? { HtmlBody: mail.html } : {}),
      ...(mail.replyTo ? { ReplyTo: mail.replyTo } : {}),
      MessageStream: 'outbound',
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new DocsError(`Mail delivery failed (${response.status}).`, 502, 'internal');
  }
}

/** Best-effort variant for paths where a mail outage must not break the flow. */
export async function sendMailQuietly(env: Env, mail: Mail): Promise<void> {
  try {
    await sendMail(env, mail);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'email.failed',
        to: mail.to,
        subject: mail.subject,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    );
  }
}
