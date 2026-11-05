// Sign in with a password, for App Review only (Guideline 2.1(a)). Apple's
// reviewer must sign in with a user name and a password; Google and the
// email link give them neither. A workspace with both secrets set takes one
// address and one password, and nothing else:
//
//   REVIEW_SIGN_IN_EMAIL           the reviewer's address
//   REVIEW_SIGN_IN_PASSWORD_HASH   sha256(password), base64url (crypto.ts)
//
// Without both, every path here is 404 and native sign-in is unchanged. With
// both, the app's native sign-in (native-sign-in.ts) opens this page in
// place of the Google start, so set them only on a workspace kept for
// review. The address still passes the workspace's own admission rules (a
// domain or an invitation) and the revocation check, as an email link does;
// a correct password for an address the workspace does not admit is refused.
import { AuthError, OWNER_SESSION_COOKIE, admitWithInvitation, refuseBlockedPerson, signOwnerSession } from './auth';
import type { OwnerSession } from './contracts';
import { constantTimeEqual, sha256 } from './crypto';
import { assertUnderRateLimit } from './http';
import { cookie, redirectWithCookies, safeReturnPath } from './http-cookies';
import { mayJoin } from './invitations';
import { workspaceName } from './workspace-profile';
import { isDomainAdmitted } from './workspace-identity';

export const REVIEW_SIGN_IN_PATH = '/sign-in/password';
const FORM_LIMIT = 4_096;

interface ReviewAccount {
  email: string;
  passwordHash: string;
}

function reviewAccount(env: Env): ReviewAccount | null {
  const vars = env as { REVIEW_SIGN_IN_EMAIL?: string; REVIEW_SIGN_IN_PASSWORD_HASH?: string };
  const email = vars.REVIEW_SIGN_IN_EMAIL?.trim().toLowerCase();
  const passwordHash = vars.REVIEW_SIGN_IN_PASSWORD_HASH?.trim();
  return email && passwordHash ? { email, passwordHash } : null;
}

/** True when this workspace takes the review password. */
export function reviewSignInOffered(env: Env): boolean {
  return reviewAccount(env) !== null;
}

function requireAccount(env: Env): ReviewAccount {
  const account = reviewAccount(env);
  if (!account) throw new AuthError('Not found.', 404, 'not_configured');
  return account;
}

const escape = (value: string) => value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

async function page(env: Env, returnPath: string, refused: boolean, status = 200): Promise<Response> {
  const name = (await workspaceName(env).catch(() => null)) ?? 'this workspace';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta name="robots" content="noindex"><title>Sign in to ${escape(name)}</title><style>`
    + ':root{color-scheme:dark;--paper:#202128;--ink:#fafafa;--danger:#f87171}'
    + '@media(prefers-color-scheme:light){:root{color-scheme:light;--paper:#f6f6f3;--ink:#20231f;--danger:#b91c1c}}'
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--paper);color:var(--ink);font-family:Inter,system-ui,-apple-system,sans-serif}'
    + 'main{width:100%;max-width:320px;display:flex;flex-direction:column;gap:20px}h1{font-size:28px;font-weight:400;margin:0;text-align:center;overflow-wrap:anywhere}'
    + 'form{display:flex;flex-direction:column;gap:10px;margin:0}'
    + 'input{width:100%;min-height:44px;border-radius:9px;border:1px solid color-mix(in srgb,var(--ink) 25%,transparent);background:transparent;color:var(--ink);font:inherit;font-size:15px;padding:0 12px}'
    + 'button{width:100%;min-height:44px;border:0;border-radius:9px;background:var(--ink);color:var(--paper);font:inherit;font-size:15px;font-weight:500;cursor:pointer}'
    + 'button:focus-visible,input:focus-visible{outline:2px solid var(--ink);outline-offset:3px}'
    + '.error{margin:0;color:var(--danger);font-size:14px}'
    + `</style></head><body><main><h1>Sign in to ${escape(name)}</h1>`
    + (refused ? '<p class="error" role="alert">That email and password do not match.</p>' : '')
    + `<form method="post" action="${REVIEW_SIGN_IN_PATH}"><input type="hidden" name="return_to" value="${escape(returnPath)}">`
    + '<input type="email" name="email" required autocomplete="username" placeholder="Email" aria-label="Email">'
    + '<input type="password" name="password" required autocomplete="current-password" placeholder="Password" aria-label="Password">'
    + '<button type="submit">Sign in</button></form></main></body></html>';
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  });
}

/** `GET /sign-in/password`: the form. */
export async function reviewSignInPage(request: Request, env: Env): Promise<Response> {
  requireAccount(env);
  return page(env, safeReturnPath(new URL(request.url).searchParams.get('return_to')), false);
}

/**
 * `POST /sign-in/password`: check the address and the password, then sign
 * the person in as an email link does, and go to the return path.
 */
export async function reviewSignIn(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const account = requireAccount(env);
  if (request.headers.get('origin') !== env.WEB_ORIGIN) throw new AuthError('Not allowed.', 403, 'untrusted_origin');
  await assertUnderRateLimit(env.JOIN_LIMIT, request, 'review-sign-in');
  const type = request.headers.get('content-type') ?? '';
  const text = type.startsWith('application/x-www-form-urlencoded') ? await request.text() : '';
  const form = new URLSearchParams(text.length > FORM_LIMIT ? '' : text);
  const returnPath = safeReturnPath(form.get('return_to'));
  const email = (form.get('email') ?? '').trim().toLowerCase();
  const password = form.get('password') ?? '';
  // Both comparisons run whatever the first one said.
  const [emailMatches, passwordMatches] = await Promise.all([
    constantTimeEqual(email, account.email),
    sha256(password).then((hash) => constantTimeEqual(hash, account.passwordHash)),
  ]);
  if (!emailMatches || !passwordMatches || !(await mayJoin(env, email))) {
    console.log(JSON.stringify({ level: 'info', message: 'review_sign_in.refused' }));
    return page(env, returnPath, true, 401);
  }
  const row = await env.USAGE.prepare('SELECT sub, name FROM people WHERE lower(email) = ?1').bind(email).first<{ sub: string; name: string | null }>();
  const owner: OwnerSession = {
    sub: row?.sub ?? `email:${await sha256(email)}`,
    email,
    name: row?.name?.trim() || email.split('@')[0]!,
  };
  await refuseBlockedPerson(env, owner);
  await admitWithInvitation(env, owner, isDomainAdmitted(env, email));
  const session = await signOwnerSession(owner, env, { lastClient: 'web', ctx });
  const response = redirectWithCookies(`${env.WEB_ORIGIN}${returnPath}`, [cookie(OWNER_SESSION_COOKIE, session, 28_800)]);
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return new Response(null, { status: 303, headers: response.headers });
}
