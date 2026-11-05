import {
  type GuestHomeResponse,
  type GuestMessagesResponse,
  guestMessageCreateSchema,
  guestSessionRequestSchema,
} from '@starlings/contracts/subject-access';
import {
  endGuestSessionCookie,
  exchangeGuestLink,
  guestHome,
  postGuestMessage,
  readGuestThread,
  requireGuest,
} from '../guests';
import type { OkResponse } from '../contracts';
import { assertUnderRateLimit, json, readBoundedJSON } from '../http';
import { defineRoute, type Route } from '../route-types';

const THREAD_ID = { re: 'gst_[A-Za-z0-9_-]{32}', sample: 'gst_00000000000000000000000000000000' };

/**
 * Guests (docs/ACCESS.md slice 4): somebody outside the workspace, on the
 * subjects a `manage` holder granted them. A path of its own, never a flag on
 * a member route: the proof is the guest session cookie a link is exchanged
 * for, and every request re-reads the live grants (guests.ts).
 */
export const guestRoutes: readonly Route[] = [
  defineRoute({
    method: 'POST',
    path: '/api/guest/session',
    gate: { kind: 'guest', proof: 'the secret from a guest link, whose hash a live guest grant holds; rate limited', origin: 'web' },
    handler: async ({ request, env }) => {
      await assertUnderRateLimit(env.JOIN_LIMIT, request, 'guest-session');
      const body = guestSessionRequestSchema.parse(await readBoundedJSON(request));
      const { setCookie } = await exchangeGuestLink(env, body.token);
      // The home is read with the session just made, so the page draws at once.
      const guestRequest = new Request(request.url, { headers: { cookie: setCookie.split(';')[0]! } });
      const response = json(await guestHome(env, await requireGuest(guestRequest, env)) satisfies GuestHomeResponse);
      response.headers.append('set-cookie', setCookie);
      response.headers.set('cache-control', 'no-store');
      return response;
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/guest/session',
    gate: { kind: 'guest', proof: 'the guest session cookie, which this only clears', origin: 'web' },
    handler: async ({ request, env }) => {
      await requireGuest(request, env);
      const response = json({ ok: true } satisfies OkResponse);
      response.headers.append('set-cookie', endGuestSessionCookie());
      return response;
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/guest/home',
    gate: { kind: 'guest', proof: 'the guest session cookie; the live guest grants decide what it reaches' },
    handler: async ({ request, env }) => {
      const response = json(await guestHome(env, await requireGuest(request, env)) satisfies GuestHomeResponse);
      response.headers.set('cache-control', 'no-store');
      return response;
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/guest/threads/:threadId/messages',
    params: { threadId: THREAD_ID },
    gate: { kind: 'guest', proof: 'the guest session cookie, and a live grant on the subject this guest thread belongs to' },
    handler: async ({ request, env, url, params }) => {
      const guest = await requireGuest(request, env);
      const before = url.searchParams.get('before') ?? undefined;
      const response = json(await readGuestThread(env, guest, params.threadId!, before) satisfies GuestMessagesResponse);
      response.headers.set('cache-control', 'no-store');
      return response;
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/guest/threads/:threadId/messages',
    params: { threadId: THREAD_ID },
    gate: { kind: 'guest', proof: 'the guest session cookie, and a live write grant on the subject this guest thread belongs to', origin: 'web' },
    handler: async ({ request, env, params }) => {
      const guest = await requireGuest(request, env);
      const body = guestMessageCreateSchema.parse(await readBoundedJSON(request));
      await postGuestMessage(env, guest, params.threadId!, body.text);
      return json({ ok: true } satisfies OkResponse);
    },
  }),
];
