// Refusing event follow-up mail (migration 0118). A follow-up is
// the host's note and call to action, so it can be marketing: each one has a
// one-click unsubscribe link and the List-Unsubscribe headers. The link names
// no address: it carries a random token, and D1 keeps only the token's hash.

import { randomToken, sha256 } from './crypto';
import { workspaceSiteOrigin } from './workspace-origins';

const normal = (email: string) => email.trim().toLowerCase();

/** A new unsubscribe link for one follow-up to `email`. */
export async function unsubscribeLink(env: Env, email: string, now = Date.now()): Promise<string> {
  const token = randomToken();
  await env.USAGE.prepare('INSERT INTO event_mail_unsubscribe_links (token_hash, email, created_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256(token), normal(email), now).run();
  return `${workspaceSiteOrigin(env)}/api/event-mail/unsubscribe/${token}`;
}

/** True when `email` refused follow-ups from this workspace. */
export async function refusedFollowUps(env: Env, email: string): Promise<boolean> {
  const row = await env.USAGE.prepare('SELECT 1 AS found FROM event_mail_opt_outs WHERE email = ?1')
    .bind(normal(email)).first<{ found: number }>();
  return row !== null;
}

/** Record the refusal a link stands for. False when the link is unknown. Repeating it is harmless. */
export async function unsubscribe(env: Env, token: string, now = Date.now()): Promise<boolean> {
  const row = await env.USAGE.prepare('SELECT email FROM event_mail_unsubscribe_links WHERE token_hash = ?1')
    .bind(await sha256(token)).first<{ email: string }>();
  if (!row) return false;
  await env.USAGE.prepare('INSERT OR IGNORE INTO event_mail_opt_outs (email, opted_out_at) VALUES (?1, ?2)')
    .bind(row.email, now).run();
  return true;
}
