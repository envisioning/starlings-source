import { isMemberEmail } from '../workspace-identity';
import {
  AuthError,
  completeCentralWebAuth,
  completeGoogleWebAuth,
  devSessionCookie,
  dropOwnerDevice,
  exchangeNativeGoogleCode,
  isOrgAdmin,
  listOwnerDevices,
  logoutResponse,
  mintDevWebSession,
  recordOwnerDeviceVersion,
  redeemOwnerRefreshToken,
  requestDeviceID,
  signOwnerSession,
  startGoogleWebAuth,
} from '../auth';
import { parseMeetClientVersion } from '../client-version';
import { finishNativeSignIn, redeemNativeSignIn, startNativeSignIn } from '../native-sign-in';
import { centralSignOutResponse } from '../central-auth';
import { confirmEmailSignInLink, emailLinkSentPage, redeemEmailSignInLink, requestEmailSignInLink } from '../email-sign-in';
import { reviewSignIn, reviewSignInPage } from '../review-sign-in';
import {
  type OwnerAuthResponse,
  type OwnerDevicesResponse,
  type OwnerSessionResponse,
  devSessionSchema,
  deviceRevokeSchema,
  nativeExchangeSchema,
  sessionRefreshSchema,
} from '../contracts';
import { json, readBoundedJSON } from '../http';
import { defineRoute, type Route } from '../route-types';

export const authRoutes: readonly Route[] = [
  defineRoute({
    method: 'GET',
    path: '/api/auth/google/start',
    gate: { kind: 'public', reason: 'sign-in begins here' },
    handler: ({ request, env }) => startGoogleWebAuth(request, env),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/auth/google/callback',
    gate: { kind: 'public', reason: "Google's redirect; the state cookie is the proof" },
    handler: ({ request, env, ctx }) => completeGoogleWebAuth(request, env, ctx),
  }),

  // Central sign-in (docs/CENTRAL_AUTH.md): the auth Worker sends the
  // browser back here with a single-use code.
  defineRoute({
    method: 'GET',
    path: '/api/auth/central/complete',
    gate: { kind: 'public', reason: 'sign-in ends here; a single-use code bound to this origin and this browser is the proof' },
    handler: ({ request, env, ctx }) => completeCentralWebAuth(request, env, ctx),
  }),

  // After the member's sign-out, the auth host ends its session too.
  defineRoute({
    method: 'GET',
    path: '/api/auth/central/sign-out',
    gate: { kind: 'public', reason: 'only redirects to the auth host or the root; it reads and changes nothing here' },
    handler: ({ request, env }) => centralSignOutResponse(request, env),
  }),

  // Sign in by email link (email-sign-in.ts), offered on the central screen.
  defineRoute({
    method: 'POST',
    path: '/api/auth/email-link',
    gate: { kind: 'public', reason: 'sign-in: a mailed single-use link is the proof; the answer is the same for every address' },
    handler: ({ request, env }) => requestEmailSignInLink(request, env),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/auth/email-link/redeem',
    gate: { kind: 'public', reason: 'shows one button and spends nothing, so a mail scanner that fetches the link changes nothing' },
    handler: ({ request, env }) => confirmEmailSignInLink(request, env),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/auth/email-link/redeem',
    gate: { kind: 'public', reason: 'sign-in ends here; the single-use mailed token and the cookie of the browser that asked are the proof' },
    handler: ({ request, env, ctx }) => redeemEmailSignInLink(request, env, ctx),
  }),

  defineRoute({
    method: 'GET',
    path: '/sign-in/email-sent',
    gate: { kind: 'public', reason: 'the same page for every address' },
    handler: ({ env }) => emailLinkSentPage(env),
  }),

  // Sign in with a password, for App Review only (review-sign-in.ts): 404
  // unless the workspace has the reviewer's address and password hash.
  defineRoute({
    method: 'GET',
    path: '/sign-in/password',
    gate: { kind: 'public', reason: 'the sign-in form; 404 unless the review account is configured' },
    handler: ({ request, env }) => reviewSignInPage(request, env),
  }),

  defineRoute({
    method: 'POST',
    path: '/sign-in/password',
    gate: { kind: 'public', reason: 'sign-in: the review account\'s password is the proof; same-origin form post, rate limited' },
    handler: ({ request, env, ctx }) => reviewSignIn(request, env, ctx),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/auth/native/exchange',
    gate: { kind: 'public', reason: 'sign-in: the PKCE code is the proof' },
    handler: async ({ request, env, ctx }) => {
      const body = nativeExchangeSchema.parse(await readBoundedJSON(request));
      const result = await exchangeNativeGoogleCode(env, {
        code: body.code,
        codeVerifier: body.code_verifier,
        redirectURI: body.redirect_uri,
        nonce: body.nonce,
      }, { lastClient: body.client ?? 'mac', deviceID: body.device_id, deviceLabel: body.device_name, ctx });
      const version = parseMeetClientVersion(request.headers.get('x-meet-client'));
      if (version) {
        await recordOwnerDeviceVersion(env, result.deviceID, {
          platform: version.platform,
          appVersion: `${version.version} (${version.build})`,
        });
      }
      return json({
        access_token: result.token,
        refresh_token: result.refreshToken,
        owner: result.owner,
      } satisfies OwnerSessionResponse);
    },
  }),

  // Native sign-in through the workspace's own web sign-in, with no Google
  // client in the app (docs/CENTRAL_AUTH.md).
  defineRoute({
    method: 'GET',
    path: '/api/auth/native/start',
    gate: { kind: 'public', reason: 'native sign-in begins here; the web sign-in that follows is the proof' },
    handler: ({ request, env }) => startNativeSignIn(request, env),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/auth/native/finish',
    gate: { kind: 'public', reason: 'a web session minted after the start, and the start cookie, are the proof' },
    handler: ({ request, env }) => finishNativeSignIn(request, env),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/auth/native/redeem',
    gate: { kind: 'public', reason: 'a single-use code and its PKCE verifier are the proof' },
    handler: ({ request, env, ctx }) => redeemNativeSignIn(request, env, ctx),
  }),

  // Renewal, so a phone is not a sign-in prompt every morning. The access token
  // stays 8h; this is what survives a night, a weekend, or a holiday. It
  // re-proves the domain and the revocation column rather than trusting the
  // token's age, and rotates the refresh token on every use — per device, so
  // renewing on one never spends another's.
  defineRoute({
    method: 'POST',
    path: '/api/auth/refresh',
    gate: { kind: 'public', reason: 'the refresh token is the proof' },
    handler: async ({ request, env, ctx }) => {
      const body = sessionRefreshSchema.parse(await readBoundedJSON(request));
      const result = await redeemOwnerRefreshToken(body.refresh_token, env, {
        lastClient: body.client ?? 'mac',
        deviceID: body.device_id,
        deviceLabel: body.device_name,
        ctx,
      });
      const version = parseMeetClientVersion(request.headers.get('x-meet-client'));
      if (version) {
        await recordOwnerDeviceVersion(env, result.deviceID, {
          platform: version.platform,
          appVersion: `${version.version} (${version.build})`,
        });
      }
      return json({
        access_token: result.token,
        refresh_token: result.refreshToken,
        owner: result.owner,
      } satisfies OwnerSessionResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/dev/session',
    gate: { kind: 'public', reason: 'development only: mintDevWebSession refuses outside ENVIRONMENT=development' },
    handler: ({ request, env, ctx }) => mintDevWebSession(request, env, ctx),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/dev/session',
    gate: { kind: 'public', reason: 'development only: 404 unless ENVIRONMENT=development' },
    handler: async ({ request, env, ctx }) => {
      if (String(env.ENVIRONMENT) !== 'development') throw new AuthError('Not found.', 404, 'room_not_found');
      const body = devSessionSchema.parse(await readBoundedJSON(request));
      if (!isMemberEmail(env, body.email)) throw new AuthError('A member address is required.', 400, 'invalid_request');
      const owner = { sub: `dev:${body.email}`, email: body.email, name: body.name };
      const access_token = await signOwnerSession(owner, env, { lastClient: 'mac', ctx });
      return new Response(JSON.stringify({ access_token, owner }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'set-cookie': devSessionCookie(access_token),
        },
      });
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/auth/me',
    gate: { kind: 'capability', capability: 'ownProfile' },
    // `is_admin` only shows or hides the Admin door; every Admin route checks again.
    handler: async ({ env, owner }) => json({ owner, is_admin: await isOrgAdmin(env, owner) } satisfies OwnerAuthResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/auth/logout',
    gate: { kind: 'public', origin: 'trusted', reason: 'clears a cookie; nothing to protect' },
    handler: ({ env, request }) => logoutResponse(env, request),
  }),

  // The person's own Macs and phones (docs/ADMIN.md §5a). A browser session
  // has no row and is not listed: it signs out at /api/auth/logout. Signing
  // out the device the request came from is a sign-out, and the clients do
  // exactly that before they clear their Keychain.
  defineRoute({
    method: 'GET',
    path: '/api/auth/devices',
    gate: { kind: 'capability', capability: 'ownProfile' },
    handler: async ({ request, env, owner }) => json({ devices: await listOwnerDevices(env, owner.sub, await requestDeviceID(request, env)) } satisfies OwnerDevicesResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/auth/devices/revoke',
    gate: { kind: 'capability', capability: 'ownProfile', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = deviceRevokeSchema.parse(await readBoundedJSON(request));
      // Somebody else's id answers the same empty change a missing one does.
      await dropOwnerDevice(env, owner.sub, body.device_id);
      return json({ devices: await listOwnerDevices(env, owner.sub, await requestDeviceID(request, env)) } satisfies OwnerDevicesResponse);
    },
  }),
];