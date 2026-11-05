// Outbound mail, through Postmark's HTTP API. One function: plain text, and
// optionally an HTML body and attachments (an event sign-up's calendar invite).
// Postmark because it is what the rest of Envisioning sends with. The
// Envisioning workspace sends on core-web's server, from the organisation's site;
// starlings-auth and every other workspace send on the Starlings server, from
// the workspace domain.
//
// `POSTMARK_API_KEY` is a secret; absent, nothing is sent and the caller hears
// `false`, which is what keeps dev and tests quiet. The key is a write
// credential, so a failure logs Postmark's status and nothing about the mail.
import { CONTACT_EMAIL } from '@starlings/contracts/deployment';
import { sharedSecret } from './shared-secrets';
import { workspaceMailContact } from './workspace-defaults';

const POSTMARK_API_ORIGIN = 'https://api.postmarkapp.com';
/** Postmark's transactional stream, as core-web uses it. Never the broadcast one. */
const MESSAGE_STREAM = 'outbound';

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  /** Defaults to the contact address, so a reply lands with a person. */
  replyTo?: string;
  /** Defaults to MAIL_FROM. Postmark sends only from a verified address; see `withSenderName`. */
  from?: string;
  /** An HTML twin of `text`. The text body is always sent. */
  html?: string;
  /** Base64 content; `contentType` as the client should read it (an invite is `text/calendar; method=REQUEST`). */
  attachments?: Array<{ name: string; content: string; contentType: string }>;
  /** Extra headers, such as List-Unsubscribe on an event follow-up. */
  headers?: Record<string, string>;
}

/** MAIL_FROM's address under another display name, so the sender stays the verified one. */
export function withSenderName(mailFrom: string, name: string): string {
  const address = /<([^>]+)>/.exec(mailFrom)?.[1] ?? mailFrom.trim();
  return `${name} <${address}>`;
}

/** What sending needs: the workspace Worker's `Env`, and starlings-auth's, both fit. */
export interface MailEnv {
  POSTMARK_API_KEY?: string;
  MAIL_FROM: string;
  USAGE?: D1Database;
}


/** True when Postmark accepted it; false when the key is unset. Throws on a refusal. */
export async function sendMail(env: MailEnv, mail: OutboundMail): Promise<boolean> {
  const key = await sharedSecret(env, 'POSTMARK_API_KEY');
  if (!key) return false;
  const response = await fetch(`${POSTMARK_API_ORIGIN}/email`, {
    method: 'POST',
    headers: { 'X-Postmark-Server-Token': key, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      From: mail.from ?? env.MAIL_FROM,
      To: mail.to,
      ReplyTo: mail.replyTo ?? (env.USAGE ? await workspaceMailContact({ USAGE: env.USAGE }) : CONTACT_EMAIL),
      Subject: mail.subject,
      TextBody: mail.text,
      ...(mail.html ? { HtmlBody: mail.html } : {}),
      ...(mail.attachments?.length
        ? { Attachments: mail.attachments.map((file) => ({ Name: file.name, Content: file.content, ContentType: file.contentType })) }
        : {}),
      ...(mail.headers ? { Headers: Object.entries(mail.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
      MessageStream: MESSAGE_STREAM,
    }),
  });
  if (!response.ok) throw new Error(`Postmark answered ${response.status}`);
  return true;
}
