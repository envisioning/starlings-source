import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getOwnerSession, signOwnerSession } from '../src/auth';
import { optionalSession, requireCapability } from '../src/capabilities';
import { googleAuthorizationURL } from '../src/google-oauth';
import {
  deviceScopedOwnerIdentity,
  ownerAccountEmail,
  ownerRoomSlugFor,
} from '../src/contracts';
import { identityDomains, isMemberEmail, isMemberHostedDomain, isSameMember, signInDomain } from '../src/workspace-identity';

const workspace = env as Env;

// A workspace can span two domains (Envisioning has .com and .io). A first-domain-only check made a
// second-domain sign-in fail at the exchange, and — because the iOS alert
// could not present over the Settings sheet — fail silently.
describe('the workspace identity spans both domains', () => {
  it('accepts either domain and nothing else', () => {
    expect(isMemberEmail(workspace, 'accounts@example.org')).toBe(true);
    expect(isMemberEmail(workspace, 'rosa@example.com')).toBe(true);
    expect(isMemberEmail(workspace, 'ROSA@EXAMPLE.ORG')).toBe(true);
    expect(isMemberEmail(workspace, 'someone@example.net')).toBe(false);
    // Suffix matching, not substring: a lookalike domain must not pass.
    expect(isMemberEmail(workspace, 'someone@notexample.com')).toBe(false);
    expect(isMemberEmail(workspace, 'example.org')).toBe(false);
    expect(isMemberEmail(workspace, undefined)).toBe(false);
  });

  it('treats the same local part on either domain as one person', () => {
    expect(isSameMember(workspace, 'tarik@example.org', 'Tarik@example.com')).toBe(true);
    expect(isSameMember(workspace, 'tarik@example.com', 'tarik@example.com')).toBe(true);
    expect(isSameMember(workspace, 'tarik@example.org', 'dina@example.org')).toBe(false);
    // The pairing is only between identity domains — never across to outside.
    expect(isSameMember(workspace, 'tarik@example.org', 'tarik@example.net')).toBe(false);
    expect(isSameMember(workspace, 'tarik@example.net', 'tarik@example.net')).toBe(true);
  });

  it('finds a room whichever identity domain the map keys it on', () => {
    const map = JSON.stringify({ 'tarik@example.org': 'tarik', 'rosa@example.com': 'rosa' });
    expect(ownerRoomSlugFor(map, 'tarik@example.com', identityDomains(workspace))).toBe('tarik');
    expect(ownerRoomSlugFor(map, 'TARIK@example.org', identityDomains(workspace))).toBe('tarik');
    expect(ownerRoomSlugFor(map, 'rosa@example.org', identityDomains(workspace))).toBe('rosa');
    expect(ownerRoomSlugFor(map, 'dina@example.org', identityDomains(workspace))).toBeNull();
    expect(ownerRoomSlugFor(map, 'tarik@example.net', identityDomains(workspace))).toBeNull();
  });

  it('scopes an owner identity to a device without leaving the domain', () => {
    expect(deviceScopedOwnerIdentity('rosa@example.com', 'mac')).toBe('rosa+mac@example.com');
    expect(deviceScopedOwnerIdentity('rosa@example.org', 'ipad')).toBe('rosa+ipad@example.org');
    expect(deviceScopedOwnerIdentity('rosa@example.com', 'android', 'a1b2')).toBe('rosa+android-a1b2@example.com');
    // No device named is what every client sent before per-device identity.
    expect(deviceScopedOwnerIdentity('rosa@example.com')).toBe('rosa@example.com');
    expect(isMemberEmail(workspace, deviceScopedOwnerIdentity('rosa@example.com', 'iphone'))).toBe(true);

    expect(ownerAccountEmail('rosa+iphone@example.com')).toBe('rosa@example.com');
    expect(ownerAccountEmail('rosa@example.com')).toBe('rosa@example.com');
    // A guest identity is not an address and must survive unchanged.
    expect(ownerAccountEmail('guest:9f2c')).toBe('guest:9f2c');
  });

  it('accepts either hosted domain claim', () => {
    expect(isMemberHostedDomain(workspace, 'example.org')).toBe(true);
    expect(isMemberHostedDomain(workspace, 'example.com')).toBe(true);
    expect(isMemberHostedDomain(workspace, 'example.net')).toBe(false);
    // `hd` absent means a personal Google account, never an owner.
    expect(isMemberHostedDomain(workspace, undefined)).toBe(false);
    expect(isMemberHostedDomain(workspace, '*')).toBe(false);
  });

  it('narrows the account chooser to one domain without narrowing the gate', () => {
    const authorization = (hostedDomain?: string | null) => new URL(googleAuthorizationURL({
      clientID: 'client', redirectURI: 'https://api.example/callback', scope: 'openid email profile',
      state: 's', nonce: 'n', challenge: 'c', hostedDomain: hostedDomain === undefined ? signInDomain(workspace) : hostedDomain,
    }));
    // `hd` takes one domain: the picker offers Envisioning accounts only …
    expect(authorization().searchParams.get('hd')).toBe(signInDomain(workspace));
    expect(signInDomain(workspace)).toBe('example.com');
    // … while the gate below still admits an `.io` colleague's token.
    expect(isMemberHostedDomain(workspace, signInDomain(workspace))).toBe(true);
    expect(isMemberHostedDomain(workspace, 'example.org')).toBe(true);
    // Attaching a personal calendar is the one flow with no `hd` at all.
    expect(authorization(null).searchParams.get('hd')).toBeNull();
  });

  it('narrows no chooser on an invite workspace, so an invited personal account can pick itself', () => {
    expect(signInDomain({ ...workspace, WORKSPACE_MEMBERSHIP: 'invite' })).toBeNull();
    expect(signInDomain({ ...workspace, WORKSPACE_MEMBERSHIP: 'domains' })).toBe('example.com');
  });

  it('verifies a session minted for an @example.org owner', async () => {
    const owner = { sub: 'google-io', email: 'accounts@example.org', name: 'Accounts' };
    const token = await signOwnerSession(owner, env as Env, { lastClient: 'ios' });
    const session = await getOwnerSession(
      new Request('http://local/api/auth/me', { headers: { authorization: `Bearer ${token}` } }),
      env as Env,
    );
    expect(session?.email).toBe('accounts@example.org');
  });

  it('rejects a session minted for an outside address with no accepted invitation (meet#873)', async () => {
    const outsider = { sub: 'google-x', email: 'someone@example.net', name: 'Outsider' };
    const token = await signOwnerSession(outsider, env as Env, { lastClient: 'ios' });
    const request = new Request('http://local/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    await expect(requireCapability(request, env as Env, 'ownProfile')).rejects.toMatchObject({ status: 401, code: 'owner_auth_required' });
    expect(await optionalSession(request, env as Env, 'ownProfile')).toBeNull();
  });
});
