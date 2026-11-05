import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { startGoogleWebAuth } from '../src/auth';
import { startWebCalendarConnect } from '../src/calendar';
import { assertWebOrigin } from '../src/http';
import { addCORS } from '../src/cors';
import { isWorkspaceOrigin, restoreWorkspaceOAuthOrigins, workspaceOAuthOrigins } from '../src/workspace-origins';

const origin = 'https://envisioning.starlings.example';
const configured = { ...env, WORKSPACE_ORIGIN_ALIASES: origin, GOOGLE_WEB_CLIENT_ID: 'test-web-client' } as unknown as Env;
const request = (path: string) => new Request(`${origin}${path}`, { headers: { origin } });

describe('workspace aliases preserve the existing workspace', () => {
  it('permits only explicitly configured browser origins', () => {
    expect(() => assertWebOrigin(request('/api/home/preferences'), configured)).not.toThrow();
    expect(isWorkspaceOrigin('https://other.starlings.example', configured)).toBe(false);
    expect(isWorkspaceOrigin('https://envisioning.starlings.example.evil.example', configured)).toBe(false);
    expect(isWorkspaceOrigin('https://site.example', configured)).toBe(false);
    expect(isWorkspaceOrigin(env.WEB_ORIGIN, configured)).toBe(true);
    expect(addCORS(new Response('ok'), request('/'), configured).headers.get('access-control-allow-origin')).toBe(origin);
  });
  it('binds sign-in and Calendar consent to the initiating alias', async () => {
    const responses = [await startGoogleWebAuth(request('/api/auth/google/start?return_to=/work'), configured),
      await startWebCalendarConnect(request('/api/calendar/connect/start?return_to=/calendar'), configured, { sub: 'person', email: 'person@example.com', name: 'Person' })];
    for (const response of responses) {
      const google = new URL(response.headers.get('location')!);
      expect(google.searchParams.get('redirect_uri')).toMatch(/^https:\/\/envisioning\.starlings\.example\/api\//);
      const seal = response.headers.getSetCookie()[0]!.split(';')[0]!.split('=')[1]!;
      const state = decodeJwt(decodeURIComponent(seal)) as { webOrigin?: string; callbackOrigin?: string };
      expect(state.webOrigin).toBe(origin);
      expect(state.callbackOrigin).toBe(origin);
      expect(() => restoreWorkspaceOAuthOrigins(new Request(`${env.PUBLIC_API_ORIGIN}/api/auth/google/callback`), configured, state)).toThrow();
      expect(restoreWorkspaceOAuthOrigins(request('/api/auth/google/callback'), configured, state).webOrigin).toBe(origin);
    }
  });
  it('keeps legacy callbacks and in-flight OAuth state compatible', () => {
    const legacy = new Request(`${env.PUBLIC_API_ORIGIN}/api/auth/google/callback`);
    expect(workspaceOAuthOrigins(legacy, configured)).toEqual({ webOrigin: env.WEB_ORIGIN, callbackOrigin: env.PUBLIC_API_ORIGIN });
    expect(restoreWorkspaceOAuthOrigins(legacy, configured, {})).toEqual({ webOrigin: env.WEB_ORIGIN, callbackOrigin: env.PUBLIC_API_ORIGIN });
  });
});
