import {
  type EventFollowUpResponse,
  type WorkEventOptions,
  type WorkEventResponse,
  workEventCreateSchema,
  workEventUpdateSchema,
  eventRegistrationInputSchema,
  sessionEventFromRecord,
  sessionSlugSchema,
  type EventRegistrationResponse,
  type SessionEvent,
} from '@starlings/contracts/event-signups';
import { AuthError, isOrgAdmin } from '../auth';
import { ControlError } from '../errors';
import { serveSessionHostPhoto, sessionHost } from '../event-page';
import { registerOnSignupPage, sendFollowUps } from '../event-signup-mail';
import { sessionEventById, sessionEventBySlug } from '../event-signups';
import { assertUnderRateLimit, json, readBoundedJSON } from '../http';
import { unsubscribe } from '../event-mail-opt-outs';
import { statusPage } from '../public-pages';
import { workspaceAccent } from '../workspace-profile';
import { personIdForEmail } from '../person-ids';
import { defineRoute, PARAMS, type Route } from '../route-types';
import { workModuleOn } from '../work-modules';
import { createWorkEvent, getWorkEvent, updateWorkEvent, workEventRooms, workEventsWritable } from '../work-events';
import { assertHuman } from '../turnstile';

/** Events are a work module (docs/WORK_MODEL.md): off means hidden, and the Worker refuses a write. */
async function assertEventsOn(env: Env, write: boolean): Promise<void> {
  if (await workModuleOn(env, 'events')) return;
  if (write) throw new ControlError('The Events work module is off on this workspace.', 409, 'invalid_request');
  throw new ControlError('No event here.', 404);
}

/** A page slug as the path carries it; anything else is not an event. */
function pageSlug(raw: string): string {
  const parsed = sessionSlugSchema.safeParse(raw);
  if (!parsed.success) throw new ControlError('No event here.', 404);
  return parsed.data;
}

/**
 * Event sign-up pages (docs/SESSIONS.md §0). Public: the page is on
 * the workspace host and nobody signs in. The store answers through the seam
 * (`event-signups.ts`), so a `d1` workspace and Envisioning's Core read alike.
 */
export const eventsRoutes: readonly Route[] = [
  // One click in a follow-up mail, no sign-in. GET is the link in
  // the body; POST is a mail client's own unsubscribe button (RFC 8058,
  // List-Unsubscribe-Post). The token is random and names no address.
  defineRoute({
    method: 'GET',
    path: '/api/event-mail/unsubscribe/:token',
    params: { token: { re: '[A-Za-z0-9_-]{43}', sample: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } },
    gate: { kind: 'public', reason: 'an unsubscribe link from an event follow-up mail; the random token stands for one address and only refuses mail' },
    handler: async ({ env, params }) => {
      const [done, accent] = await Promise.all([unsubscribe(env, params.token!), workspaceAccent(env)]);
      return done
        ? statusPage('You’re unsubscribed', 'You won’t get event follow-up mail from us again.', 200, accent)
        : statusPage('Link not found', 'This unsubscribe link doesn’t work.', 404, accent);
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/event-mail/unsubscribe/:token',
    params: { token: { re: '[A-Za-z0-9_-]{43}', sample: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } },
    gate: { kind: 'public', reason: 'a mail client\'s one-click unsubscribe (RFC 8058) for an event follow-up; the random token stands for one address and only refuses mail' },
    handler: async ({ env, params }) => (await unsubscribe(env, params.token!)
      ? new Response(null, { status: 204 })
      : new Response(null, { status: 404 })),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/events/:slug',
    gate: { kind: 'public', reason: 'an event sign-up page is public; it shows the title, the time and whether sign-up is open, never who signed up' },
    handler: async ({ env, params }) => {
      const record = await sessionEventBySlug(env, pageSlug(params.slug!));
      if (!record) throw new ControlError('No event here.', 404);
      return json({ event: sessionEventFromRecord(record, new Date(), await sessionHost(env, record)) } satisfies { event: SessionEvent });
    },
  }),

  // The host's photo on the event page: the room owner's avatar,
  // only for a session event. Any other slug, and a host without a photo,
  // answer the same 404.
  defineRoute({
    method: 'GET',
    path: '/api/events/:slug/host-photo',
    gate: { kind: 'public', reason: 'the event page names its host and shows the host photo; only the owner of a session event room, never another person' },
    handler: async ({ request, env, params, url }) => serveSessionHostPhoto(request, env, pageSlug(params.slug!), url.searchParams.get('v')),
  }),

  // The sign-up form. Rate limit, bot check, then the store. A new
  // registration gets its link in the answer; a repeat address gets
  // `join: null` and the link by mail only (SESSIONS.md S9).
  defineRoute({
    method: 'POST',
    path: '/api/events/:slug/register',
    gate: { kind: 'public', origin: 'web', reason: 'a public form: web origin, rate limit, Turnstile; a new sign-up gets its own link, a repeat address gets it by mail only' },
    handler: async ({ request, env, params }) => {
      const slug = pageSlug(params.slug!);
      const input = eventRegistrationInputSchema.parse(await readBoundedJSON(request, 4_096));
      await assertUnderRateLimit(env.FEEDBACK_LIMIT, request, 'event-signup');
      await assertHuman(request, env, input.turnstile_token, 'always');
      const record = await sessionEventBySlug(env, slug);
      if (!record) throw new ControlError('No event here.', 404);
      const join = await registerOnSignupPage(env, record, { name: input.name, email: input.email });
      return json({ ok: true, join } satisfies EventRegistrationResponse, 202);
    },
  }),

  // The follow-up mail, only when the host asks (docs/SESSIONS.md §0): it
  // carries the host's note. A workspace admin or the person who made the
  // event may send it. Idempotent: a second call sends only to those who did
  // not get it.
  defineRoute({
    method: 'POST',
    path: '/api/events/:id/follow-up',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      const event = await sessionEventById(env, params.id!);
      if (!event) throw new ControlError('No event here.', 404);
      const creator = event.created_by ? event.created_by === await personIdForEmail(env, owner.email) : false;
      if (!creator && !(await isOrgAdmin(env, owner))) {
        throw new AuthError('Only an admin or the person who made the event can send its follow-up.', 403, 'capability_denied');
      }
      return json({ sent: await sendFollowUps(env, event) } satisfies EventFollowUpResponse);
    },
  }),

  // Create and edit an event in Work (SESSIONS.md S8): one form
  // for both stores. Any member with the work graph may make one, as on any
  // subject; the Events work module must be on.
  defineRoute({
    method: 'GET',
    path: '/api/work/events/options',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner }) => {
      await assertEventsOn(env, false);
      return json({ rooms: await workEventRooms(env), can_create: await workEventsWritable(env, owner) } satisfies WorkEventOptions);
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/work/events',
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      await assertEventsOn(env, true);
      const input = workEventCreateSchema.parse(await readBoundedJSON(request, 16_384));
      return json({ event: await createWorkEvent(env, input, owner) } satisfies WorkEventResponse, 201);
    },
  }),
  defineRoute({
    method: 'GET',
    path: '/api/work/events/:id',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ env, owner, params }) => {
      await assertEventsOn(env, false);
      const event = await getWorkEvent(env, params.id!, owner);
      if (!event) throw new ControlError('No event here.', 404);
      return json({ event } satisfies WorkEventResponse);
    },
  }),
  defineRoute({
    method: 'PATCH',
    path: '/api/work/events/:id',
    params: { id: PARAMS.uuid },
    gate: { kind: 'capability', capability: 'crmWork', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      await assertEventsOn(env, true);
      const patch = workEventUpdateSchema.parse(await readBoundedJSON(request, 16_384));
      return json({ event: await updateWorkEvent(env, params.id!, patch, owner) } satisfies WorkEventResponse);
    },
  }),
];
