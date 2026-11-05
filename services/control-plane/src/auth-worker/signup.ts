// Signing up for a workspace, in starlings-auth's own D1 (docs/ONBOARDING.md,
// auth-migrations/0002_signup.sql).
//
// An operator mints a single-use link for one address; it goes out by mail
// and only by mail, so holding it proves the address. The product site's
// /start page reads the link, checks slugs, and submits one request. The
// request holds its slug until the operator declines it or it expires.
//
// Two callers, two entrypoints (index.ts): the product site reaches
// `SignupService` (view, checkSlug, submit); the operator console reaches
// `SignupAdminService` (mint, list, decide). Neither has a URL.
import {
  checkSignupSlug,
  signupDecisionInputSchema,
  signupAddressProblem,
  signupFormSchema,
  signupLinkSummarySchema,
  signupMintInputSchema,
  signupPrefillSchema,
  signupRequestSchema,
  signupRevokeInputSchema,
  signupSlugMessage,
  signupTokenSchema,
  SIGNUP_LINK_DAYS,
  SIGNUP_REQUEST_DAYS,
  type SignupLinkSummary,
  type SignupLinkView,
  type SignupPrefill,
  type SignupRequest,
  type SignupRequestStatus,
  type SignupSlugAnswer,
  type SignupSubmitAnswer,
} from '@starlings/contracts/signup';
import { randomToken, sha256 } from '../crypto';
import { sendMail, withSenderName } from '../mail';
import { sharedSecret } from '../shared-secrets';
import { declinedMail, linkMail, operatorRequestMail, operatorQuestionMail, readyMail, receiptMail } from './signup-mail';

/** The bindings signup reads. A subset of the auth Worker's env. */
export interface SignupEnv {
  AUTH_DB: D1Database;
  /** Secret. Absent: nothing is mailed, and minting a link fails. */
  POSTMARK_API_KEY?: string;
  MAIL_FROM: string;
  /** Who hears about a new request. */
  OPS_ALERT_EMAIL: string;
  /** The product site, `the product site`. Links point at its /start. */
  SIGNUP_ORIGIN: string;
  /** The operator console, `the ops host`. */
  OPS_ORIGIN: string;
}

const DAY_MS = 86_400_000;

interface RequestRow {
  id: string;
  token_hash: string;
  email: string;
  name: string;
  role: string;
  workspace_name: string;
  slug: string;
  accent: string;
  membership: string;
  suite: string;
  /** Absent before auth migration 0008; the contract reads it as eu. */
  region?: string;
  answers: string;
  interest_id: string | null;
  state: SignupRequest['state'];
  payment: SignupRequest['payment'];
  created_at: number;
  decided_by: string | null;
  decided_at: number | null;
  host: string | null;
  failure: string | null;
  provisioned_at?: number | null;
  service_hosts?: string | null;
  agent_state?: string | null;
  mail_failed?: string | null;
}

interface LinkRow {
  token_hash: string;
  email: string;
  interest_id: string | null;
  /** JSON, signupPrefillSchema; null for a link minted by address alone (auth migration 0010). */
  prefill: string | null;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at?: number | null;
}

/** A link's stored prefill; anything that does not parse fills in nothing. */
function prefillOf(raw: string | null): SignupPrefill {
  if (!raw) return {};
  try {
    const parsed = signupPrefillSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function from(env: SignupEnv): string {
  return withSenderName(env.MAIL_FROM, 'Starlings');
}

function statusOf(row: Pick<RequestRow, 'state' | 'workspace_name' | 'slug' | 'host'>): SignupRequestStatus {
  return { state: row.state, workspace_name: row.workspace_name, slug: row.slug, host: row.state === 'ready' ? row.host : null };
}

function requestOf(row: RequestRow): SignupRequest {
  return signupRequestSchema.parse({
    ...row,
    membership: JSON.parse(row.membership),
    answers: JSON.parse(row.answers),
    provisioned_at: row.provisioned_at ?? null,
    service_hosts: row.service_hosts ? JSON.parse(row.service_hosts) : [],
    mail_failed: row.mail_failed ? row.mail_failed.split(',') : [],
    agent_state: row.agent_state ?? null,
  });
}

/**
 * Whether one host answers `/api/health` with a 2xx. The refusal names the
 * host and what it answered, so the operator knows which Worker to look at.
 */
async function healthProblem(host: string): Promise<string | null> {
  const health = await fetch(`${host}/api/health`, { headers: { accept: 'application/json' } }).catch(() => null);
  return health?.ok ? null : `${host}/api/health does not answer yet (${health?.status ?? 'no answer'}).`;
}

async function recordAction(env: SignupEnv, operator: string, action: string, requestId: string | null, detail: string | null): Promise<void> {
  await env.AUTH_DB.prepare('INSERT INTO operator_actions (id, at, operator, action, request_id, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(`act_${randomToken(12)}`, Date.now(), operator.toLowerCase(), action, requestId, detail)
    .run();
}

/** A request nobody decided in 30 days expires, and its slug is free again. */
async function expireStale(env: SignupEnv, now: number): Promise<void> {
  const cutoff = now - SIGNUP_REQUEST_DAYS * DAY_MS;
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare(`DELETE FROM workspace_slugs WHERE state = 'held' AND request_id IN
      (SELECT id FROM workspace_requests WHERE state = 'submitted' AND created_at < ?1)`).bind(cutoff),
    env.AUTH_DB.prepare(`UPDATE workspace_requests SET state = 'expired', updated_at = ?2 WHERE state = 'submitted' AND created_at < ?1`).bind(cutoff, now),
  ]);
}

async function tokenHash(raw: unknown): Promise<string | null> {
  const token = signupTokenSchema.safeParse(raw);
  return token.success ? sha256(token.data) : null;
}

async function openLink(env: SignupEnv, hash: string, now: number): Promise<LinkRow | null> {
  return env.AUTH_DB.prepare('SELECT * FROM signup_links WHERE token_hash = ?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?2')
    .bind(hash, now).first<LinkRow>();
}

// ---------------------------------------------------------------------------
// The product site's side.

/** What the /start page shows for its token. A closed link names nobody. */
export async function viewSignupLink(env: SignupEnv, rawToken: unknown, now = Date.now()): Promise<SignupLinkView> {
  const hash = await tokenHash(rawToken);
  if (!hash) return { state: 'closed' };
  const request = await env.AUTH_DB.prepare('SELECT state, workspace_name, slug, host FROM workspace_requests WHERE token_hash = ?1')
    .bind(hash).first<Pick<RequestRow, 'state' | 'workspace_name' | 'slug' | 'host'>>();
  if (request) return { state: 'request', request: statusOf(request) };
  const link = await openLink(env, hash, now);
  return link ? { state: 'open', email: link.email, expires_at: link.expires_at, prefill: prefillOf(link.prefill) } : { state: 'closed' };
}

/** Whether a slug is free. Only an open link may ask, so the page cannot be used to list workspaces. */
export async function checkSignupSlugFree(env: SignupEnv, rawToken: unknown, rawSlug: unknown, now = Date.now()): Promise<SignupSlugAnswer> {
  const hash = await tokenHash(rawToken);
  if (!hash || !(await openLink(env, hash, now))) return { ok: false, reason: 'taken', message: 'This link is no longer valid.' };
  const checked = checkSignupSlug(typeof rawSlug === 'string' ? rawSlug : '');
  if (!checked.ok) return { ok: false, reason: checked.reason, message: signupSlugMessage(checked.reason) };
  await expireStale(env, now);
  const taken = await env.AUTH_DB.prepare('SELECT 1 FROM workspace_slugs WHERE slug = ?1').bind(checked.slug).first();
  return taken ? { ok: false, reason: 'taken', message: signupSlugMessage('taken') } : { ok: true, slug: checked.slug };
}

/**
 * The one submit. Three writes in one D1 transaction: the request (only while
 * the link is open), the slug hold (the primary key refuses a second holder),
 * and the link spent. A refusal of any one leaves nothing.
 */
export async function submitSignup(env: SignupEnv, raw: unknown, now = Date.now()): Promise<SignupSubmitAnswer> {
  const parsed = signupFormSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, field: typeof issue?.path[0] === 'string' ? issue.path[0] : null, message: issue?.message ?? 'Check the form.' };
  }
  const form = parsed.data;
  const hash = await sha256(form.token);
  const link = await openLink(env, hash, now);
  if (!link) return { ok: false, field: null, message: 'This link is no longer valid.' };
  // Refused before anything is held: no request reaches the operator that
  // provisioning would refuse.
  const addressProblem = signupAddressProblem(link.email);
  if (addressProblem) return { ok: false, field: null, message: addressProblem };
  await expireStale(env, now);

  const id = `req_${randomToken(12)}`;
  const answers = { team_size: form.team_size, agents: form.agents, ...(form.note ? { note: form.note } : {}) };
  try {
    const results = await env.AUTH_DB.batch([
      env.AUTH_DB.prepare(`INSERT INTO workspace_requests
        (id, token_hash, email, name, role, workspace_name, slug, accent, membership, suite, region, answers, interest_id, state, payment, created_at, updated_at)
        SELECT ?1, token_hash, email, ?2, ?3, ?4, ?5, ?6, ?7, ?11, ?12, ?8, interest_id, 'submitted', 'waived', ?9, ?9
        FROM signup_links WHERE token_hash = ?10 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?9`)
        .bind(id, form.name, form.role, form.workspace_name, form.slug, form.accent, JSON.stringify(form.membership), JSON.stringify(answers), now, hash, form.suite, form.region),
      env.AUTH_DB.prepare(`INSERT INTO workspace_slugs (slug, state, request_id, updated_at)
        SELECT slug, 'held', id, ?2 FROM workspace_requests WHERE id = ?1`).bind(id, now),
      env.AUTH_DB.prepare('UPDATE signup_links SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL').bind(hash, now),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return { ok: false, field: null, message: 'This link is no longer valid.' };
  } catch (error) {
    if (/UNIQUE|PRIMARY KEY|constraint/iu.test(String(error))) {
      return { ok: false, field: 'slug', message: signupSlugMessage('taken') };
    }
    throw error;
  }

  const row = { state: 'submitted' as const, workspace_name: form.workspace_name, slug: form.slug, host: null };
  // The request is recorded; a mail that does not go out is written on the
  // request, so its card says so, and logs its kind only.
  const failed: string[] = [];
  await Promise.all([
    sendMail(env, { to: link.email, from: from(env), ...receiptMail(form, link.email) })
      .catch(() => { failed.push('receipt'); console.error(JSON.stringify({ level: 'error', message: 'signup.receipt.failed' })); }),
    sendMail(env, { to: env.OPS_ALERT_EMAIL, from: from(env), ...operatorRequestMail(form, link.email, `${env.OPS_ORIGIN}/requests#${id}`) })
      .catch(() => { failed.push('operator'); console.error(JSON.stringify({ level: 'error', message: 'signup.operator_mail.failed' })); }),
  ]);
  if (failed.length > 0) {
    await env.AUTH_DB.prepare('UPDATE workspace_requests SET mail_failed = ?2 WHERE id = ?1').bind(id, failed.sort().join(',')).run();
  }
  return { ok: true, request: statusOf(row) };
}

// ---------------------------------------------------------------------------
// The operator console's side. Every call names the operator, whom
// starlings-ops proved with Cloudflare Access.

/** Mint and mail a link. The token is never returned: holding it must prove the address. */
export async function mintSignupLink(env: SignupEnv, raw: unknown, now = Date.now()): Promise<{ email: string; expires_at: number; replaced: number }> {
  const input = signupMintInputSchema.parse(raw);
  // A link to a personal address could never become a workspace.
  if (signupAddressProblem(input.email)) throw new Error(`${input.email} is a personal address. Send the link to a work address.`);
  if (!(await sharedSecret(env, 'POSTMARK_API_KEY'))) throw new Error('Mail is not configured, so no link can be sent.');
  const token = randomToken(32);
  const expiresAt = now + SIGNUP_LINK_DAYS * DAY_MS;
  // Minting again for an address is a resend: its open link stops working, so
  // only the newest mail opens /start.
  const replaced = (await env.AUTH_DB.prepare('UPDATE signup_links SET revoked_at = ?2 WHERE email = ?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?2')
    .bind(input.email, now).run()).meta.changes ?? 0;
  const prefill = Object.keys(input.prefill).length > 0 ? JSON.stringify(input.prefill) : null;
  await env.AUTH_DB.prepare('INSERT INTO signup_links (token_hash, email, interest_id, prefill, created_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(await sha256(token), input.email, input.interest_id, prefill, input.operator.toLowerCase(), now, expiresAt)
    .run();
  await sendMail(env, { to: input.email, from: from(env), ...linkMail(`${env.SIGNUP_ORIGIN}/start#t=${token}`, expiresAt) });
  await recordAction(env, input.operator, 'mint', null, input.email);
  return { email: input.email, expires_at: expiresAt, replaced };
}

/** Revoke every open link for an address. The row stays, marked revoked. */
export async function revokeSignupLinks(env: SignupEnv, raw: unknown, now = Date.now()): Promise<{ email: string; revoked: number }> {
  const input = signupRevokeInputSchema.parse(raw);
  const result = await env.AUTH_DB.prepare('UPDATE signup_links SET revoked_at = ?2 WHERE email = ?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?2')
    .bind(input.email, now).run();
  await recordAction(env, input.operator, 'revoke', null, input.email);
  return { email: input.email, revoked: result.meta.changes ?? 0 };
}

/** Open requests first, then the last 50 of any state, and the last 20 links. */
export async function listSignups(env: SignupEnv, now = Date.now()): Promise<{ requests: SignupRequest[]; links: SignupLinkSummary[]; interest_links: SignupLinkSummary[] }> {
  await expireStale(env, now);
  const requests = await env.AUTH_DB.prepare(`SELECT * FROM workspace_requests
    ORDER BY CASE state WHEN 'submitted' THEN 0 WHEN 'approved' THEN 1 WHEN 'provisioning' THEN 2 ELSE 3 END, created_at DESC LIMIT 50`)
    .all<RequestRow>();
  const links = await env.AUTH_DB.prepare('SELECT email, created_at, expires_at, used_at, revoked_at, created_by, interest_id FROM signup_links ORDER BY created_at DESC LIMIT 20')
    .all<Omit<LinkRow, 'token_hash' | 'prefill'>>();
  // Every link that answers an interest request, newest first, so the console
  // can mark the requests already answered whatever their age.
  const answered = await env.AUTH_DB.prepare(`SELECT email, created_at, expires_at, used_at, created_by, interest_id FROM signup_links
    WHERE interest_id IS NOT NULL ORDER BY created_at DESC LIMIT 500`)
    .all<Omit<LinkRow, 'token_hash' | 'prefill'>>();
  return {
    requests: requests.results.map(requestOf),
    links: links.results.map((link) => signupLinkSummarySchema.parse(link)),
    interest_links: answered.results.map((link) => signupLinkSummarySchema.parse(link)),
  };
}

export type SignupDecisionResult =
  | { ok: true; request: SignupRequest; command: string | null }
  | { ok: false; message: string };

/**
 * Accept, decline or ask. Accept moves `submitted` to `approved` and hands
 * back the command that provisions it (decision 3). Decline releases the
 * slug and mails a fixed line, with no reason. Ask mails the question with the operator as Reply-To (decision 7).
 */
export async function decideSignup(env: SignupEnv, raw: unknown, now = Date.now()): Promise<SignupDecisionResult> {
  const parsed = signupDecisionInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the action.' };
  const input = parsed.data;
  const row = await env.AUTH_DB.prepare('SELECT * FROM workspace_requests WHERE id = ?1').bind(input.id).first<RequestRow>();
  if (!row) return { ok: false, message: 'No such request.' };
  const operator = input.operator.toLowerCase();

  if (input.action === 'ask') {
    if (row.state !== 'submitted') return { ok: false, message: `The request is ${row.state}.` };
    await sendMail(env, { to: row.email, from: from(env), replyTo: operator, ...operatorQuestionMail(row.workspace_name, input.message) });
    await recordAction(env, operator, 'ask', row.id, input.message);
    return { ok: true, request: requestOf(row), command: null };
  }

  if (input.action === 'ready') {
    if (row.state !== 'provisioning' || !row.host) return { ok: false, message: `The request is ${row.state}; run the provisioning command first.` };
    // Ready means the whole workspace answers: its Worker, and its own Docs
    // and Keep when the run made them. The agent is shown, not checked.
    const { service_hosts: services } = requestOf(row);
    for (const host of [row.host, ...services]) {
      const problem = await healthProblem(host);
      if (problem) return { ok: false, message: problem };
    }
    const results = await env.AUTH_DB.batch([
      env.AUTH_DB.prepare(`UPDATE workspace_requests SET state = 'ready', updated_at = ?2 WHERE id = ?1 AND state = 'provisioning'`).bind(row.id, now),
      env.AUTH_DB.prepare(`UPDATE workspace_slugs SET state = 'live', updated_at = ?2 WHERE slug = ?1`).bind(row.slug, now),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return { ok: false, message: `The request is ${row.state}.` };
    await recordAction(env, operator, 'ready', row.id, row.host);
    await sendMail(env, { to: row.email, from: from(env), replyTo: operator, ...readyMail(row.workspace_name, row.host, row.email) });
    return { ok: true, request: requestOf({ ...row, state: 'ready' }), command: null };
  }

  if (input.action === 'accept') {
    // Provisioning would refuse it: Ask or Decline instead.
    if (signupAddressProblem(row.email)) return { ok: false, message: `${row.email} is a personal address, so this request cannot be provisioned yet. Ask for a work address, or Decline.` };
    const changed = await env.AUTH_DB.prepare(`UPDATE workspace_requests SET state = 'approved', decided_by = ?2, decided_at = ?3, updated_at = ?3
      WHERE id = ?1 AND state = 'submitted'`).bind(row.id, operator, now).run();
    if (changed.meta.changes !== 1) return { ok: false, message: `The request is ${row.state}.` };
    await recordAction(env, operator, 'accept', row.id, null);
    return {
      ok: true,
      request: requestOf({ ...row, state: 'approved', decided_by: operator, decided_at: now }),
      command: `node scripts/provision-workspace.mjs --from-request ${row.id} --apply`,
    };
  }

  const results = await env.AUTH_DB.batch([
    env.AUTH_DB.prepare(`UPDATE workspace_requests SET state = 'declined', decided_by = ?2, decided_at = ?3, updated_at = ?3
      WHERE id = ?1 AND state IN ('submitted', 'approved', 'failed')`).bind(row.id, operator, now),
    env.AUTH_DB.prepare(`DELETE FROM workspace_slugs WHERE slug = ?1 AND state = 'held' AND request_id = ?2
      AND EXISTS (SELECT 1 FROM workspace_requests WHERE id = ?2 AND state = 'declined')`).bind(row.slug, row.id),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) return { ok: false, message: `The request is ${row.state}.` };
  await recordAction(env, operator, 'decline', row.id, null);
  await sendMail(env, { to: row.email, from: from(env), replyTo: operator, ...declinedMail(row.workspace_name) })
    .catch(() => console.error(JSON.stringify({ level: 'error', message: 'signup.declined_mail.failed' })));
  return { ok: true, request: requestOf({ ...row, state: 'declined', decided_by: operator, decided_at: now }), command: null };
}
