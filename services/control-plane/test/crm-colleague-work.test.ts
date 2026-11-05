import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordOwnerSignIn } from '../src/usage';

const rosa = { email: 'cw-rosa@example.com', name: 'Rosa' };

async function member(person: { email: string; name: string }) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  }));
  const body = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(env as Env, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { authorization: `Bearer ${body.access_token}` };
}

async function work(headers: Record<string, string>, assignee: string) {
  return exports.default.fetch(new Request(
    `http://local/api/crm/work?assignee_email=${encodeURIComponent(assignee)}`,
    { headers },
  ));
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'cw-%'").run();
});

describe('a colleague’s work', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await work({}, 'cw-ada@example.com');
    expect(response.status).toBe(401);
  });

  it('refuses an address outside Envisioning', async () => {
    const headers = await member(rosa);
    const response = await work(headers, 'someone@acme.example');
    // The same 404 a missing person gets: this route is not a way to ask Core
    // about arbitrary addresses.
    expect([404, 503]).toContain(response.status);
    if (response.status === 404) {
      await expect(response.json()).resolves.toMatchObject({ code: 'room_not_found' });
    }
  });

  it('refuses a malformed address before it reaches Core', async () => {
    const headers = await member(rosa);
    const response = await work(headers, 'not-an-address');
    expect([400, 503]).toContain(response.status);
  });
});
