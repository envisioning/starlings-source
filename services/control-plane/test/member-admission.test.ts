import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { JoinRequestReceipt } from '@starlings/contracts';

/**
 * A verified Envisioning member knocking on a colleague's room is not a visitor
 * asking to be let in — both sides are the same org, proved by the same Google
 * identity, so Call is a call rather than a request.
 *
 * Deliberately narrow: only into a room that is actually running. The idle case
 * stays queued, because a colleague materialising in a room the host never
 * started is the one behaviour nobody asked for.
 */
async function ownerHeaders(email = 'rosa@example.com') {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rosa', email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}` };
}

async function knock(headers: Record<string, string>) {
  const response = await exports.default.fetch(new Request('http://local/api/rooms/rosa/join-requests', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
    body: JSON.stringify({
      name: 'Ada',
      email: 'ada@example.com',
    }),
  }));
  return { status: response.status, receipt: await response.json<JoinRequestReceipt>() };
}

afterEach(async () => {
  const headers = await ownerHeaders();
  await exports.default.fetch(new Request('http://local/api/rooms/rosa/end', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }));
  await env.USAGE.prepare('DELETE FROM people WHERE sub = ?1').bind('dev:rosa@example.com').run();
});

describe('member admission', () => {
  it('walks a signed-in member straight into a running room', async () => {
    const headers = await ownerHeaders();
    const start = await exports.default.fetch(new Request('http://local/api/rooms/rosa/start', {
      method: 'POST',
      headers,
    }));
    expect(start.status).toBe(200);

    const member = await knock(headers);
    expect(member.status).toBe(201);
    expect(member.receipt.status).toBe('admitted');
  });

  it('still queues a visitor with no session', async () => {
    const headers = await ownerHeaders();
    const start = await exports.default.fetch(new Request('http://local/api/rooms/rosa/start', {
      method: 'POST',
      headers,
    }));
    expect(start.status).toBe(200);

    const visitor = await knock({});
    expect(visitor.status).toBe(201);
    expect(visitor.receipt.status).toBe('waiting');
  });
});
