import { robotsTxt } from '@starlings/contracts/agent-discovery';
import { ANALYTICS_BODY_MAX_BYTES, parseAnalyticsEvent, plausibleRequest } from '@starlings/contracts/analytics';
import {
  INTEREST_BODY_MAX_BYTES,
  interestAgentSubmissionSchema,
  interestConfirmInputSchema,
  interestSchema,
  type InterestAgentResponse,
  type InterestConfirmResponse,
  type InterestResponse,
} from '@starlings/contracts/interest';
import {
  ANDROID_APP_PACKAGE,
  ANDROID_DEBUG_CERT_SHA256,
  ANDROID_RELEASE_CERT_SHA256,
  FEEDBACK_BODY_MAX_BYTES,
  nativeAppId,
  feedbackSchema,
  linkPreviewQuerySchema,
  type FeedbackResponse,
  type HealthResponse,
  type LinkPreviewResponse,
  type SupportLineConnectResponse,
} from '../contracts';
import { FORM_BODY_MAX_BYTES, type FormSubmitResponse } from '@starlings/contracts/forms';
import { ControlError } from '../errors';
import { formAllowsOrigin, offeredForm, recordFormSubmission } from '../forms';
import { handlePublicLead } from '../public-leads';
import { isWorkspaceOrigin } from '../workspace-origins';
import { fileFeedbackIssue } from '../feedback';
import { releaseInfo } from '../release-info';
import { assertUnderRateLimit, json, readBoundedJSON, readBoundedText } from '../http';
import { connectSupportLine } from '../support-line';
import { confirmAgentInterest, holdAgentInterest, recordInterest } from '../interest';
import { linkPreview } from '../link-preview';
import { serveLinkPreviewImage } from '../link-preview-image';
import { defineRoute, type Route } from '../route-types';
import { parseQuery } from '../route-util';
import { assertHuman } from '../turnstile';
import { readVisitorHome } from '../visitor-home';
import { serveWorkspaceBackground } from '../workspace-backgrounds';
import { serveWorkspaceDescriptor } from '../workspace-descriptor';
import type { VisitorHomeResponse } from '@starlings/contracts/visitor-home';
import { SUPPORT_INTAKE_BODY_MAX_BYTES, supportIntakeSubmissionSchema, type SupportIntakeResponse } from '@starlings/contracts/support-intake';
import { submitPublicSupport } from '../support-intake';
import { APP_INTAKE_BODY_MAX_BYTES, type AppIntakeResponse } from '@starlings/contracts/app-intake';
import { receiveAppIntake } from '../app-intake';
import { workspacePrivacy } from '../workspace-privacy';

/**
 * Routes anyone may call. Each is on purpose, and its gate says why.
 */
export const publicRoutes: readonly Route[] = [
  defineRoute({
    method: ['GET', 'HEAD'],
    path: '/privacy',
    gate: { kind: 'public', reason: 'the workspace publishes its contact addresses and the product privacy policy' },
    handler: ({ request, env }) => workspacePrivacy(request, env),
  }),
  // Anonymous website messages (docs/SUPPORT.md): rate limited and bot-checked,
  // then written to a sender-private guest thread before its link is mailed.
  defineRoute({
    method: 'POST',
    path: '/api/support/intake',
    gate: { kind: 'public', origin: 'web', reason: 'a public support form: web origin, rate limit, Turnstile, and a private guest thread' },
    handler: async ({ request, env }) => {
      const body = supportIntakeSubmissionSchema.parse(await readBoundedJSON(request, SUPPORT_INTAKE_BODY_MAX_BYTES));
      await assertUnderRateLimit(env.FEEDBACK_LIMIT, request, 'support-intake');
      await assertHuman(request, env, body.turnstile_token, 'always');
      return json(await submitPublicSupport(env, body) satisfies SupportIntakeResponse, 202);
    },
  }),

  // The app channel door (#1176, docs/SUPPORT.md): the workspace's own
  // backend sends its app users' support lines. Server to server, no browser
  // origin; receiveAppIntake checks the APP_INTAKE_KEY signature before it
  // writes anything, and answers 503 where the key is not bound.
  defineRoute({
    method: 'POST',
    path: '/api/support/app-intake',
    gate: { kind: 'public', reason: 'receiveAppIntake verifies the APP_INTAKE_KEY signature before it writes anything' },
    handler: async ({ request, env }) => {
      await assertUnderRateLimit(env.AGENT_LIMIT, request, 'app-intake');
      return json(await receiveAppIntake(env, request, await readBoundedText(request, APP_INTAKE_BODY_MAX_BYTES)) satisfies AppIntakeResponse);
    },
  }),

  // The support line: a workspace's Worker asks hq to connect it.
  // Signed with the shared SUPPORT_LINK_KEY; connectSupportLine checks it.
  defineRoute({
    method: 'POST',
    path: '/api/support-line/connect',
    gate: { kind: 'public', reason: 'connectSupportLine verifies the shared-key signature before it writes anything' },
    handler: async ({ request, env }) => {
      await assertUnderRateLimit(env.FEEDBACK_LIMIT, request, 'support-line');
      return json(await connectSupportLine(env, request, await readBoundedText(request)) satisfies SupportLineConnectResponse);
    },
  }),

  defineRoute({
    method: ['GET', 'HEAD'],
    path: '/workspace-background',
    gate: { kind: 'public', reason: 'the workspace picture is public branding, available to guests before admission' },
    handler: ({ request, env }) => serveWorkspaceBackground(request, env),
  }),
  // What the root draws for a signed-out visitor (packages/contracts/src/visitor-home.ts).
  // It names the booker an admin chose, whose booking page is public already.
  defineRoute({
    method: 'GET',
    path: '/api/visitor-home',
    gate: { kind: 'public', reason: 'the visitor root is drawn before anyone signs in' },
    handler: async ({ env }) => json(await readVisitorHome(env) satisfies VisitorHomeResponse),
  }),

  // What this workspace says about itself: how a client learns
  // the workspace at runtime instead of compiling Envisioning's in.
  defineRoute({
    method: ['GET', 'HEAD'],
    path: '/.well-known/meet',
    gate: { kind: 'public', reason: 'workspace discovery: a client reads it before anyone signs in, and it holds no secret' },
    handler: ({ env }) => serveWorkspaceDescriptor(env),
  }),

  // The app's association with this host: Apple reads it before
  // the app may claim the https sign-in callback. `webcredentials` is what
  // ASWebAuthenticationSession's https callback checks.
  defineRoute({
    method: ['GET', 'HEAD'],
    path: '/.well-known/apple-app-site-association',
    gate: { kind: 'public', reason: 'Apple reads the app association before anyone signs in, and it holds no secret' },
    handler: ({ request, env }) => new Response(request.method === 'HEAD' ? null : JSON.stringify(appleAppSiteAssociation(env)), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
    }),
  }),

  // The Android app's association with this host (#1238): Android reads it
  // before it verifies the app's room-link filters (`autoVerify`), so a room
  // link opens the app with no chooser.
  defineRoute({
    method: ['GET', 'HEAD'],
    path: '/.well-known/assetlinks.json',
    gate: { kind: 'public', reason: 'Android reads the app association before anyone signs in, and it holds no secret' },
    handler: ({ request, env }) => new Response(request.method === 'HEAD' ? null : JSON.stringify(androidAssetLinks(env)), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
    }),
  }),

  // The https sign-in callback. The app claims it and this page
  // never draws; a browser that opens it anyway says where to go.
  defineRoute({
    method: 'GET',
    path: '/auth/native/callback', // NATIVE_SIGN_IN_HTTPS_PATH; the route fixture reads a literal
    gate: { kind: 'public', reason: 'the app claims this address; a browser that opens it gets a page with no data' },
    handler: () => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Starlings</title><p>Return to the Starlings app.</p>', {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    }),
  }),

  defineRoute({
    method: ['GET', 'HEAD'],
    path: '/robots.txt',
    gate: { kind: 'public', reason: 'a static text file for crawlers' },
    handler: ({ request, env }) => new Response(request.method === 'HEAD' ? null : robotsTxt(new URL(env.WEB_ORIGIN).origin), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    }),
  }),

  // A page view or a count from the web app (docs/ANALYTICS.md), forwarded
  // to Plausible after the response. Only a Worker that names
  // PLAUSIBLE_DOMAIN (Envisioning) has it; every other workspace answers 404.
  // No rate limit: an event costs one outbound fetch, and abuse can only
  // spoil Envisioning's own counts.
  defineRoute({
    method: 'POST',
    path: '/api/event',
    gate: { kind: 'public', origin: 'web', reason: 'usage counts from this origin\'s own pages: no session, nothing stored, and the event names are a fixed list' },
    handler: async ({ request, env, ctx }) => {
      const domain = env.PLAUSIBLE_DOMAIN?.trim();
      if (!domain) throw new ControlError('This workspace counts no usage.', 404, 'not_configured');
      const event = parseAnalyticsEvent(await readBoundedJSON(request, ANALYTICS_BODY_MAX_BYTES));
      if (!event) throw new ControlError('Not an event this workspace counts.', 400, 'invalid_request');
      ctx.waitUntil(fetch(plausibleRequest(event, request, domain)).then(() => undefined, () => undefined));
      return new Response(null, { status: 202 });
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/health',
    gate: { kind: 'public', reason: 'uptime probe' },
    // `build` and `migration` say which release answers ( step 1).
    handler: async ({ env }) => json({ ok: true, environment: env.ENVIRONMENT, ...(await releaseInfo(env)) } satisfies HealthResponse),
  }),

  // Public and unauthenticated on purpose: the people best placed to report a
  // bug are guests mid-call, and making them sign in first is how you never
  // hear about it. Rate limit, then bot check, then spend the GitHub token.
  defineRoute({
    method: 'POST',
    path: '/api/feedback',
    gate: { kind: 'public', origin: 'web', reason: 'a public form: web origin, rate limit, Turnstile' },
    handler: async ({ request, env }) => {
      const body = feedbackSchema.parse(await readBoundedJSON(request, FEEDBACK_BODY_MAX_BYTES));
      await assertUnderRateLimit(env.FEEDBACK_LIMIT, request, 'feedback');
      await assertHuman(request, env, body.turnstile_token, 'always');
      await fileFeedbackIssue(env, body);
      return json({ ok: true } satisfies FeedbackResponse, 202);
    },
  }),

  // The interest form (/interest): same door as a bug report — public, rate
  // limited on the same limiter, bot-checked — then a row, a lead, a mail.
  defineRoute({
    method: 'POST',
    path: '/api/interest',
    gate: { kind: 'public', origin: 'web', reason: 'a public form: web origin, rate limit, Turnstile' },
    handler: async ({ request, env }) => {
      const body = interestSchema.parse(await readBoundedJSON(request, INTEREST_BODY_MAX_BYTES));
      await assertUnderRateLimit(env.FEEDBACK_LIMIT, request, 'interest');
      await assertHuman(request, env, body.turnstile_token, 'always');
      await recordInterest(env, { ...body, filled_by: 'form', agent_name: undefined });
      return json({ ok: true } satisfies InterestResponse, 202);
    },
  }),

  // A workspace's public form (docs/FORMS.md §Step 2).
  // The workspace's own origin, or one the form lists, posting from its own
  // page; `addCORS` lets only those read the answer. No Turnstile yet for an
  // outside page ( §Bot check): a per-IP limit, the form's hourly
  // total and a honeypot stand in for it.
  defineRoute({
    method: 'POST',
    path: '/api/forms/:form',
    params: { form: { re: '[a-z][a-z0-9-]{1,40}', sample: 'organisations' } },
    gate: { kind: 'public', reason: 'a public form: the workspace origin or one the form lists, a per-IP limit, an hourly total and a honeypot' },
    handler: async ({ request, env, params }) => {
      const form = offeredForm(env, params.form!);
      const origin = request.headers.get('origin');
      const outside = !isWorkspaceOrigin(origin, env);
      if (outside && !formAllowsOrigin(form, origin)) throw new ControlError('Untrusted request origin.', 403, 'untrusted_origin');
      // An outside page posts without credentials; one that sends them is refused.
      if (outside && request.headers.has('cookie')) throw new ControlError('Send the form without credentials.', 400, 'invalid_request');
      await assertUnderRateLimit(env.FEEDBACK_LIMIT, request, `form:${form.id}`);
      const body = form.schema.parse(await readBoundedJSON(request, FORM_BODY_MAX_BYTES));
      await recordFormSubmission(env, form, body);
      return json({ ok: true } satisfies FormSubmitResponse, 202);
    },
  }),

  // The public lead form the sites post to (docs/SECURITY.md, "The public lead
  // route"). A 404 until the workspace sets its key: no other firm has this door.
  defineRoute({
    method: 'POST',
    path: '/api/public/leads',
    gate: { kind: 'public', reason: 'a public lead form: 404 until the workspace sets PUBLIC_LEAD_SECRET, then an HMAC from the site or a Turnstile token that fails closed, rate limits and an hourly total' },
    handler: ({ request, env }) => handlePublicLead(request, env),
  }),

  // The same form, sent by a person's own agent (docs/FORMS.md §Agents). No
  // Turnstile: the answers wait until the person confirms from the mail, so
  // nothing is filed on an agent's word alone. A 400 lists every issue, so
  // the agent can fix them all in one more try.
  defineRoute({
    method: 'POST',
    path: '/api/interest/agent',
    gate: { kind: 'public', reason: 'an agent applies for its person: rate limited, and nothing is filed until the person confirms by mail' },
    handler: async ({ request, env }) => {
      await assertUnderRateLimit(env.FEEDBACK_LIMIT, request, 'interest-agent');
      const parsed = interestAgentSubmissionSchema.safeParse(await readBoundedJSON(request, INTEREST_BODY_MAX_BYTES));
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
        return json({ error: issues[0]?.message ?? 'Invalid request.', code: 'invalid_request', issues }, 400);
      }
      const held = await holdAgentInterest(env, parsed.data);
      return json({
        ok: true,
        state: 'confirm_sent',
        email: held.email,
        expires_at: held.expires_at,
        next: `Starlings mailed ${held.email} a link. Ask the person to open it and press Send. Nothing reaches Envisioning before that.`,
      } satisfies InterestAgentResponse, 202);
    },
  }),

  // The person opens the confirm mail's link on the product site and presses Send.
  defineRoute({
    method: 'POST',
    path: '/api/interest/confirm',
    gate: { kind: 'public', origin: 'web', reason: 'the mailed single-use token is the proof; web origin and rate limit' },
    handler: async ({ request, env }) => {
      await assertUnderRateLimit(env.FEEDBACK_LIMIT, request, 'interest-confirm');
      const { token } = interestConfirmInputSchema.parse(await readBoundedJSON(request, 1024));
      const confirmed = await confirmAgentInterest(env, token);
      return json(confirmed satisfies InterestConfirmResponse);
    },
  }),

  // What a link in a thread points at, read here rather than by the device —
  // see `fetchLinkPreview`. Rate limited because it is the one route that
  // fetches an address a message chose: without a bound, a paste is a way to
  // spend our egress on somebody else's server.
  defineRoute({
    method: 'GET',
    path: '/api/link-preview',
    gate: { kind: 'capability', capability: 'conversations' },
    handler: async ({ request, env, url }) => {
      await assertUnderRateLimit(env.LINK_PREVIEW_LIMITER, request, 'link-preview');
      return json({
        preview: await linkPreview(parseQuery(linkPreviewQuerySchema, url).url, { env, origin: url.origin }),
      } satisfies LinkPreviewResponse);
    },
  }),

  // The picture on a preview card. No session: it is drawn by the same clients
  // that just read the card, guests included, and the signature on the address
  // is what says this Worker found the picture rather than a caller naming it.
  // Rate limited on the same bucket as the unfurl — it is the same egress
  // pointed at the same stranger's server. See `link-preview-image.ts`.
  defineRoute({
    method: 'GET',
    path: '/api/link-preview/image',
    gate: { kind: 'public', reason: 'the signature on the address; rate limited on the unfurl bucket' },
    handler: async ({ request, env }) => {
      await assertUnderRateLimit(env.LINK_PREVIEW_LIMITER, request, 'link-preview-image');
      return serveLinkPreviewImage(env, request);
    },
  }),
];

/** The apple-app-site-association body: the app may use this host's web credentials. A deployment with no team names no app. */
export function appleAppSiteAssociation(env: Pick<Env, 'NATIVE_APPLE_TEAM_ID'>): { webcredentials: { apps: string[] } } {
  return { webcredentials: { apps: env.NATIVE_APPLE_TEAM_ID ? [nativeAppId(env.NATIVE_APPLE_TEAM_ID)] : [] } };
}

/** One Digital Asset Links statement: this host's links may open the Android app. */
export interface AndroidAssetLink {
  relation: ['delegate_permission/common.handle_all_urls'];
  target: { namespace: 'android_app'; package_name: string; sha256_cert_fingerprints: string[] };
}

/**
 * The assetlinks.json body (#1238): the release certificate always, and the
 * build host's debug certificate only on a development Worker
 * (`ENVIRONMENT=development`).
 */
export function androidAssetLinks(env: Pick<Env, 'ENVIRONMENT'>): AndroidAssetLink[] {
  const fingerprints = String(env.ENVIRONMENT) === 'development'
    ? [ANDROID_RELEASE_CERT_SHA256, ANDROID_DEBUG_CERT_SHA256]
    : [ANDROID_RELEASE_CERT_SHA256];
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: ANDROID_APP_PACKAGE, sha256_cert_fingerprints: fingerprints },
  }];
}
