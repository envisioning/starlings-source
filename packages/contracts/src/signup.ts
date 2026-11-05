// Signing up for a workspace (docs/ONBOARDING.md). The operator mails a
// single-use link bound to one address; the applicant fills one form on
// the product site/start; the request waits in starlings-auth's D1 for the
// operator. These shapes cross three Workers: the product site, starlings-auth
// and starlings-ops.
import { z } from 'zod';
import { CONTACT_EMAIL } from './deployment';
import { INTEREST_AGENTS, INTEREST_ROLES, INTEREST_SIZES, type InterestOption } from './interest';
import { accentPalette } from './workspace-accent';
import { DEFAULT_WORKSPACE_REGION, WORKSPACE_REGIONS } from './workspace-region';
import { DEFAULT_WORKSPACE_SUITE, workspaceSuiteSchema } from './workspace-profile';
import { checkWorkspaceSlug, PLATFORM_WORKSPACE_SLUGS } from './workspace-slug';

/** A signup link lives 14 days unless the operator says otherwise. */
export const SIGNUP_LINK_DAYS = 14;
/** A request nobody decided expires after 30 days, and its slug is released. */
export const SIGNUP_REQUEST_DAYS = 30;
/**
 * The longest slug provisioning accepts. `starlings-<slug>-artifact-jobs-dead`
 * is the longest resource name, and Cloudflare stops at 63 characters
 * (docs/PROVISIONING.md §Names).
 */
export const SIGNUP_SLUG_MAX = 34;
export const SIGNUP_TEXT_MAX = 200;
export const SIGNUP_NOTE_MAX = 2_000;

/** Mail providers whose domain can never be a workspace's sign-in domain. */
export const PERSONAL_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de', 'yandex.com',
  'mail.com', 'zoho.com', 'fastmail.com', 'hey.com', 'uol.com.br', 'bol.com.br', 'terra.com.br',
]);

/**
 * Why this address cannot start a workspace, or null. "Only
 * people I invite" takes the owner's domain as the sign-in domain, and a mail
 * provider can never be one; a workspace with no sign-in domain does not run
 * yet (check-production-config.mjs refuses it). The /start page, the submit,
 * the operator's link and provision-workspace.mjs all ask this one function.
 */
export function signupAddressProblem(email: string): string | null {
  return PERSONAL_MAIL_DOMAINS.has(emailDomain(email))
    ? `A workspace can’t start from a personal address yet. Write to ${CONTACT_EMAIL} for a link to your work address.`
    : null;
}

export type SignupSlugCheck =
  | { ok: true; slug: string }
  | { ok: false; reason: 'empty' | 'shape' | 'reserved' | 'long' | 'taken' };

/** The rules a slug obeys before anyone asks whether it is free. */
export function checkSignupSlug(value: string): SignupSlugCheck {
  const checked = checkWorkspaceSlug(value);
  if (!checked.ok) return checked;
  if (PLATFORM_WORKSPACE_SLUGS.has(checked.slug)) return { ok: false, reason: 'reserved' };
  if (checked.slug.length > SIGNUP_SLUG_MAX) return { ok: false, reason: 'long' };
  return checked;
}

/** The sentence a refused slug shows under the field. */
export function signupSlugMessage(reason: Exclude<SignupSlugCheck, { ok: true }>['reason']): string {
  switch (reason) {
    case 'empty': return 'Choose an address.';
    case 'shape': return 'Use lowercase letters, numbers and hyphens, 3 characters or more.';
    case 'reserved': return 'That address is reserved.';
    case 'long': return `Use ${SIGNUP_SLUG_MAX} characters or fewer.`;
    case 'taken': return 'That address is taken.';
  }
}

/**
 * The address the form offers for a workspace name, until the person types
 * their own: lowercase ASCII, hyphens between words, at most SIGNUP_SLUG_MAX.
 * It may still fail `checkSignupSlug` (too short, reserved); the field says so.
 */
export function suggestSignupSlug(workspaceName: string): string {
  return workspaceName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, SIGNUP_SLUG_MAX)
    .replace(/-+$/u, '');
}

/** A lowercase domain, or null. */
export function normalizeDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/^@/u, '');
  return /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain) ? domain : null;
}

/** The domain of an address, lowercase. */
export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split('@').pop() ?? '';
}

function ids<T extends readonly InterestOption[]>(options: T): [T[number]['id'], ...T[number]['id'][]] {
  return options.map((option) => option.id) as [T[number]['id'], ...T[number]['id'][]];
}

const text = z.string().trim().max(SIGNUP_TEXT_MAX);

/** Where the workspace keeps its data (workspace-region.ts). Final: Cloudflare sets it when each store is made. */
export const signupRegionSchema = z.enum(WORKSPACE_REGIONS, { error: 'Choose a region.' });

/**
 * Who may join. `invite` is the default (docs/ONBOARDING.md decision 12):
 * only invited addresses. `domains`: any verified address on these domains.
 */
export const signupMembershipSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('invite') }),
  z.object({
    mode: z.literal('domains'),
    domains: z.array(z.string()).min(1).max(5).transform((values, ctx) => {
      const domains = [...new Set(values.map(normalizeDomain))];
      if (domains.some((domain) => domain === null)) {
        ctx.addIssue({ code: 'custom', message: 'Each entry must be a domain, like acme.com.' });
        return z.NEVER;
      }
      if (domains.some((domain) => PERSONAL_MAIL_DOMAINS.has(domain!))) {
        ctx.addIssue({ code: 'custom', message: 'A personal mail domain cannot be a sign-in domain.' });
        return z.NEVER;
      }
      return domains as string[];
    }),
  }),
]);
export type SignupMembership = z.infer<typeof signupMembershipSchema>;

/**
 * What a link carries from the interest request it answers: the
 * /start form opens with these filled in. Every field is optional, and one a
 * newer interest form no longer asks is left out, never guessed.
 */
export const signupPrefillSchema = z.object({
  name: text.optional(),
  role: z.enum(ids(INTEREST_ROLES)).optional(),
  workspace_name: z.string().trim().max(60).optional(),
  team_size: z.enum(ids(INTEREST_SIZES)).optional(),
  agents: z.enum(ids(INTEREST_AGENTS)).optional(),
});
export type SignupPrefill = z.infer<typeof signupPrefillSchema>;

/**
 * One interest request as the operator's console lists it, read from the
 * workspace the product site forwards the form to (hq). `body` is not sent:
 * the console needs who asked and what to fill in, nothing else.
 */
export const signupInterestSchema = z.object({
  id: z.string(),
  created_at: z.number(),
  email: z.string(),
  name: z.string(),
  company: z.string(),
  team_size: z.string().nullable(),
  prefill: signupPrefillSchema,
});
export type SignupInterest = z.infer<typeof signupInterestSchema>;

/**
 * The prefill from an interest submission's stored answers. A field that does
 * not parse as today's option is dropped, so an old submission still links.
 */
export function signupPrefillOf(answers: Record<string, unknown>): SignupPrefill {
  const prefill: Record<string, unknown> = {};
  for (const [field, from] of [['name', 'name'], ['role', 'role'], ['workspace_name', 'company'], ['team_size', 'team_size'], ['agents', 'agents']] as const) {
    const one = signupPrefillSchema.shape[field].safeParse(answers[from]);
    if (one.success && one.data !== undefined && one.data !== '') prefill[field] = one.data;
  }
  return prefill as SignupPrefill;
}

/** The token from the link, as the page reads it from the address fragment. */
export const signupTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u);

/** The one form on the product site/start. The address is the link's, never the form's. */
export const signupFormSchema = z.object({
  token: signupTokenSchema,
  name: text.min(1),
  role: z.enum(ids(INTEREST_ROLES)),
  workspace_name: z.string().trim().min(1).max(60),
  slug: z.string().transform((value, ctx) => {
    const checked = checkSignupSlug(value);
    if (!checked.ok) {
      ctx.addIssue({ code: 'custom', message: signupSlugMessage(checked.reason) });
      return z.NEVER;
    }
    return checked.slug;
  }),
  /** Empty: the product accent. Otherwise #rrggbb that carries readable text. */
  accent: z.string().trim().refine((value) => value === '' || accentPalette(value) !== null, {
    message: 'Pick a darker or lighter colour. Text on it must stay readable.',
  }).transform((value) => value.toLowerCase()),
  membership: signupMembershipSchema,
  /** Where the team's mail and calendar live. A page loaded before the field existed sends none. */
  suite: workspaceSuiteSchema.default(DEFAULT_WORKSPACE_SUITE),
  /** Required: a page that sends no region is refused, never read as eu. */
  region: signupRegionSchema,
  team_size: z.enum(ids(INTEREST_SIZES)),
  agents: z.enum(ids(INTEREST_AGENTS)),
  note: z.string().trim().max(SIGNUP_NOTE_MAX).optional(),
  /** The applicant read the pilot terms. */
  terms: z.literal(true),
});
export type SignupForm = z.infer<typeof signupFormSchema>;
export type SignupFormInput = z.input<typeof signupFormSchema>;

export const SIGNUP_REQUEST_STATES = ['submitted', 'approved', 'provisioning', 'ready', 'declined', 'failed', 'expired'] as const;
export type SignupRequestState = (typeof SIGNUP_REQUEST_STATES)[number];
export const SIGNUP_PAYMENT_STATES = ['waived', 'pending', 'paid'] as const;
export type SignupPaymentState = (typeof SIGNUP_PAYMENT_STATES)[number];

/** What the status page shows: the state and the address, nothing else. */
export const signupRequestStatusSchema = z.object({
  state: z.enum(SIGNUP_REQUEST_STATES),
  workspace_name: z.string(),
  slug: z.string(),
  /** `https://<slug>.<suffix>` once the workspace is ready. */
  host: z.string().url().nullable(),
});
export type SignupRequestStatus = z.infer<typeof signupRequestStatusSchema>;

/** What the page learns from its token. A closed link says nothing about whom it was for. */
export const signupLinkViewSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('open'),
    email: z.string(),
    expires_at: z.number(),
    /** From the interest request the link answers; empty for a link minted by address alone. */
    prefill: signupPrefillSchema.default({}),
  }),
  z.object({ state: z.literal('request'), request: signupRequestStatusSchema }),
  z.object({ state: z.literal('closed') }),
]);
export type SignupLinkView = z.infer<typeof signupLinkViewSchema>;

export const signupSlugAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), slug: z.string() }),
  z.object({ ok: z.literal(false), reason: z.enum(['empty', 'shape', 'reserved', 'long', 'taken']), message: z.string() }),
]);
export type SignupSlugAnswer = z.infer<typeof signupSlugAnswerSchema>;

export const signupSubmitAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), request: signupRequestStatusSchema }),
  z.object({ ok: z.literal(false), field: z.string().nullable(), message: z.string() }),
]);
export type SignupSubmitAnswer = z.infer<typeof signupSubmitAnswerSchema>;

/** One request as the operator sees it in starlings-ops. */
export const signupRequestSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  workspace_name: z.string(),
  slug: z.string(),
  accent: z.string(),
  membership: signupMembershipSchema,
  suite: workspaceSuiteSchema,
  /** A request sent before the field existed (auth migration 0008) reads as eu, where it was made. */
  region: signupRegionSchema.default(DEFAULT_WORKSPACE_REGION),
  answers: z.object({
    team_size: z.string(),
    agents: z.string(),
    /** Asked until 2026-10-04; every feature is on, so the form no longer asks. */
    first_parts: z.array(z.string()).default([]),
    note: z.string().optional(),
  }),
  interest_id: z.string().nullable(),
  state: z.enum(SIGNUP_REQUEST_STATES),
  payment: z.enum(SIGNUP_PAYMENT_STATES),
  created_at: z.number(),
  decided_by: z.string().nullable(),
  decided_at: z.number().nullable(),
  host: z.string().nullable(),
  failure: z.string().nullable(),
  /** When the provisioning run ended. Null while it runs, and before the column existed. */
  provisioned_at: z.number().nullable().default(null),
  /** The workspace's Docs and Keep origins, which Send ready mail checks too. */
  service_hosts: z.array(z.string()).default([]),
  /** Mails about this request that did not go out: `receipt` (applicant), `operator` (O1). */
  mail_failed: z.array(z.enum(['receipt', 'operator'])).default([]),
  /** The managed meeting agent's stage at the end of the run. Shown, never required. */
  agent_state: z.string().nullable().default(null),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

/** A link the operator minted, for the console's list. Never the token. */
export const signupLinkSummarySchema = z.object({
  email: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  used_at: z.number().nullable(),
  /** Revoked, by hand or by a resend to the same address. */
  revoked_at: z.number().nullable().default(null),
  created_by: z.string(),
  /** The interest request the link answers, or null. */
  interest_id: z.string().nullable().default(null),
});
export type SignupLinkSummary = z.infer<typeof signupLinkSummarySchema>;

export const signupMintInputSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  interest_id: z.string().max(64).nullable().default(null),
  /** Read by the console from the interest request, never from the form. */
  prefill: signupPrefillSchema.default({}),
  operator: z.string().email(),
});
export type SignupMintInput = z.input<typeof signupMintInputSchema>;

/** Revoke every open link for an address. */
export const signupRevokeInputSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  operator: z.string().email(),
});
export type SignupRevokeInput = z.input<typeof signupRevokeInputSchema>;

export const signupDecisionInputSchema = z.object({
  id: z.string().regex(/^req_[A-Za-z0-9_-]{8,64}$/u),
  /** `ready`: the workspace answers /api/health; the applicant gets the ready mail (E3). */
  action: z.enum(['accept', 'decline', 'ask', 'ready']),
  message: z.string().trim().max(SIGNUP_NOTE_MAX).default(''),
  operator: z.string().email(),
}).refine((input) => input.action !== 'ask' || input.message.length > 0, { message: 'Ask needs a question.', path: ['message'] });
export type SignupDecisionInput = z.input<typeof signupDecisionInputSchema>;
