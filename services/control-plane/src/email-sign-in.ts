// Sign in by email link (docs/ONBOARDING.md §The email link sign-in). The
// central sign-in screen on the auth host posts an address here; this
// workspace decides whether the address may sign in, and mails a single-use
// link only when it may. The answer is the same page either way, so the form
// cannot test who is a member.
//
// Within a workspace a person is their verified address, whichever way they
// proved it (MZ, 2026-10-04): a link resolves to the `people` row that
// already holds the address, and a first sign-in by link gets a sub of its
// own, `email:<hash>`.
//
// Opening the link spends nothing. Webmail, Proton's included, and
// mail scanners fetch links before a person clicks. The GET shows a page with
// one button; its POST spends the link, and only in the browser that asked:
// the request set a random cookie whose hash the link row keeps.
import { authOrigin } from './central-auth';
import { randomToken, sha256 } from './crypto';
import { assertUnderRateLimit } from './http';
import { cookie, expiredCookie, readCookie, redirectWithCookies, safeReturnPath } from './http-cookies';
import { sendMail, withSenderName } from './mail';
import { AuthError, OWNER_SESSION_COOKIE, admitWithInvitation, refuseBlockedPerson, signOwnerSession } from './auth';
import { mayJoin } from './invitations';
import type { OwnerSession } from './contracts';
import { workspaceName } from './workspace-profile';
import { isDomainAdmitted } from './workspace-identity';

export const EMAIL_LINK_MS = 15 * 60_000;
/** Links per address in one window; more is somebody else's doing. */
const PER_ADDRESS_LIMIT = 3;
const FORM_LIMIT = 4_096;
const ADDRESS = /^[^\s@<>"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
/** The browser that asked. Host-only, so it never leaves this workspace. */
export const EMAIL_LINK_BROWSER_COOKIE = 'starlings_email_link';

export { EMAIL_LINK_REQUEST_PATH } from '@starlings/contracts/browser-auth';
export const EMAIL_LINK_REDEEM_PATH = '/api/auth/email-link/redeem';
export const EMAIL_LINK_SENT_PATH = '/sign-in/email-sent';

/** Only a workspace that signs in through starlings-auth offers the link. */
function offered(env: Env): boolean {
  return authOrigin(env) !== null;
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded')) return null;
  const text = await request.text();
  return text.length > FORM_LIMIT ? null : new URLSearchParams(text);
}

/**
 * May this address sign in here: one of the workspace's domains, an accepted
 * invitation, or an open one. Revocation and agents are refused
 * after the link is spent (`refuseBlockedPerson`).
 */
async function mayUseLink(env: Env, email: string): Promise<boolean> {
  return mayJoin(env, email);
}

/**
 * The browser's own value. A second request from the same browser keeps it,
 * so every link that browser asked for still works there.
 */
function browserValue(request: Request): string {
  const held = readCookie(request, EMAIL_LINK_BROWSER_COOKIE);
  return held && TOKEN.test(held) ? held : randomToken(32);
}

/**
 * POST from the central sign-in screen (or this workspace). The browser
 * lands on the sent page whatever happened, with the same cookie; only a log
 * line differs.
 */
export async function requestEmailSignInLink(request: Request, env: Env): Promise<Response> {
  if (!offered(env)) throw new AuthError('Sign-in by email is not offered here.', 404, 'not_configured');
  const origin = request.headers.get('origin');
  if (origin !== env.WEB_ORIGIN && origin !== authOrigin(env)) throw new AuthError('Not allowed.', 403, 'untrusted_origin');
  await assertUnderRateLimit(env.JOIN_LIMIT, request, 'email-sign-in');
  const browser = browserValue(request);
  const sent = new Response(null, {
    status: 303,
    headers: [
      ['location', new URL(EMAIL_LINK_SENT_PATH, env.WEB_ORIGIN).toString()],
      ['set-cookie', cookie(EMAIL_LINK_BROWSER_COOKIE, browser, EMAIL_LINK_MS / 1000)],
    ],
  });
  const form = await readForm(request);
  const email = (form?.get('email') ?? '').trim().toLowerCase();
  if (!ADDRESS.test(email)) return sent;
  const returnPath = safeReturnPath(form?.get('return_to') ?? '/');
  try {
    if (!(await mayUseLink(env, email))) {
      console.log(JSON.stringify({ level: 'info', message: 'email_sign_in.not_offered' }));
      return sent;
    }
    const now = Date.now();
    const recent = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM email_sign_in_links WHERE email = ?1 AND created_at > ?2')
      .bind(email, now - EMAIL_LINK_MS).first<{ n: number }>();
    if ((recent?.n ?? 0) >= PER_ADDRESS_LIMIT) return sent;
    const token = randomToken(32);
    await env.USAGE.batch([
      env.USAGE.prepare('DELETE FROM email_sign_in_links WHERE expires_at < ?1').bind(now - 24 * 60 * 60_000),
      env.USAGE.prepare(`INSERT INTO email_sign_in_links (token_hash, email, return_path, created_at, expires_at, browser_hash)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(await sha256(token), email, returnPath, now, now + EMAIL_LINK_MS, await sha256(browser)),
    ]);
    const name = await nameOf(env);
    const link = new URL(EMAIL_LINK_REDEEM_PATH, env.WEB_ORIGIN);
    link.searchParams.set('t', token);
    await sendMail(env, {
      to: email,
      from: withSenderName(env.MAIL_FROM, name),
      subject: `Sign in to ${name}`,
      text: [
        `Here is your link to sign in to ${name} on Starlings:`,
        '',
        link.toString(),
        '',
        'Open it in the browser where you asked for it. It works once, for 15 minutes. If you did not ask for it, ignore this mail.',
      ].join('\n'),
    });
  } catch (error) {
    // The kind only; never the address or the token.
    console.error(JSON.stringify({ level: 'error', message: 'email_sign_in.request_failed', error: error instanceof Error ? error.name : 'unknown' }));
  }
  return sent;
}

/**
 * GET from the mailed link: a page with one button, and nothing spent. A
 * scanner that fetches the link sees the page and changes nothing.
 */
export async function confirmEmailSignInLink(request: Request, env: Env): Promise<Response> {
  if (!offered(env)) throw new AuthError('Sign-in by email is not offered here.', 404, 'not_configured');
  const token = new URL(request.url).searchParams.get('t') ?? '';
  if (!TOKEN.test(token)) throw new AuthError('This sign-in link is not valid. Ask for a new one.', 400, 'oauth_failed');
  const row = await env.USAGE.prepare('SELECT email FROM email_sign_in_links WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2')
    .bind(await sha256(token), Date.now()).first<{ email: string }>();
  if (!row) throw new AuthError('This sign-in link has expired or was used. Ask for a new one.', 400, 'oauth_failed');
  const name = await nameOf(env);
  return page(`Sign in to ${name}`, `<h1>Sign in to ${escape(name)}</h1><p>Signing in as ${escape(row.email)}.</p>`
    + `<form method="post" action="${EMAIL_LINK_REDEEM_PATH}"><input type="hidden" name="t" value="${escape(token)}"><button type="submit">Sign in</button></form>`);
}

/** POST from that page: spend the link once, in the browser that asked, then sign the person in. */
export async function redeemEmailSignInLink(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!offered(env)) throw new AuthError('Sign-in by email is not offered here.', 404, 'not_configured');
  if (request.headers.get('origin') !== env.WEB_ORIGIN) throw new AuthError('Not allowed.', 403, 'untrusted_origin');
  const token = (await readForm(request))?.get('t') ?? '';
  if (!TOKEN.test(token)) throw new AuthError('This sign-in link is not valid. Ask for a new one.', 400, 'oauth_failed');
  const tokenHash = await sha256(token);
  const browser = readCookie(request, EMAIL_LINK_BROWSER_COOKIE) ?? '';
  const now = Date.now();
  const spent = TOKEN.test(browser)
    ? await env.USAGE.prepare(`UPDATE email_sign_in_links SET used_at = ?2
      WHERE token_hash = ?1 AND browser_hash = ?3 AND used_at IS NULL AND expires_at > ?2 RETURNING email, return_path`)
      .bind(tokenHash, now, await sha256(browser)).first<{ email: string; return_path: string }>()
    : null;
  if (!spent) {
    // Say which, so a person on the wrong device knows what to do; the link stays unspent.
    const open = await env.USAGE.prepare('SELECT 1 AS open FROM email_sign_in_links WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2')
      .bind(tokenHash, now).first<{ open: number }>();
    if (open) throw new AuthError('Open this link in the browser where you asked for it.', 403, 'oauth_failed');
    throw new AuthError('This sign-in link has expired or was used. Ask for a new one.', 400, 'oauth_failed');
  }
  const email = spent.email.toLowerCase();
  if (!(await mayUseLink(env, email))) throw new AuthError('This address cannot sign in to this workspace.', 403, 'oauth_failed');
  const row = await env.USAGE.prepare('SELECT sub, name FROM people WHERE lower(email) = ?1').bind(email).first<{ sub: string; name: string | null }>();
  const owner: OwnerSession = {
    sub: row?.sub ?? `email:${await sha256(email)}`,
    email,
    name: row?.name?.trim() || email.split('@')[0]!,
  };
  await refuseBlockedPerson(env, owner);
  await admitWithInvitation(env, owner, isDomainAdmitted(env, email));
  const session = await signOwnerSession(owner, env, { lastClient: 'web', ctx });
  return redirectWithCookies(`${env.WEB_ORIGIN}${safeReturnPath(spent.return_path)}`, [
    cookie(OWNER_SESSION_COOKIE, session, 28_800),
    expiredCookie(EMAIL_LINK_BROWSER_COOKIE),
  ]);
}

/** The page the request lands on. The same words whatever the address was. */
export async function emailLinkSentPage(env: Env): Promise<Response> {
  const name = (await workspaceName(env).catch(() => null)) ?? 'this workspace';
  return page('Check your email', `<h1>Check your email</h1><p>If that address can sign in to ${escape(name)}, a link is on its way. It works for 15 minutes.</p>`);
}

async function nameOf(env: Env): Promise<string> {
  return (await workspaceName(env).catch(() => null)) ?? new URL(env.WEB_ORIGIN).hostname;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string): Response {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta name="robots" content="noindex"><title>${escape(title)}</title><style>`
    + ':root{color-scheme:dark;--paper:#202128;--ink:#fafafa;--muted:#a1a1aa;--accent:#d6f249;--on-accent:#20231f}'
    + '@media(prefers-color-scheme:light){:root{color-scheme:light;--paper:#f6f6f3;--ink:#20231f;--muted:#6b6f68}}'
    + 'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--paper);color:var(--ink);font-family:Inter,system-ui,-apple-system,sans-serif}'
    + 'main{max-width:340px;text-align:center}h1{font-size:24px;font-weight:400;margin:0 0 12px}p{margin:0;color:var(--muted);line-height:1.5}'
    + 'form{margin-top:24px}button{font:inherit;border:0;border-radius:999px;padding:10px 24px;background:var(--accent);color:var(--on-accent);cursor:pointer}button:hover{filter:brightness(1.05)}'
    + `</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}
