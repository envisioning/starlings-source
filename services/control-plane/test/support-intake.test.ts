import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { guestThreadAccess, guestSub, liveOutsideGrants } from '../src/guests';
import { recordInboundSupportEmail, supportThreadId } from '../src/support-intake';

const addresses: string[] = [];

afterEach(async () => {
  for (const address of addresses.splice(0)) {
    await env.USAGE.prepare("DELETE FROM subject_grants WHERE subject_id = 'intake' AND principal_id = ?1")
      .bind(address).run();
    const threadId = await supportThreadId(address);
    await env.USAGE.prepare('DELETE FROM threads WHERE id = ?1').bind(threadId).run();
  }
});

describe('public support intake', () => {
  it('normalizes sender identity and limits each guest to their own intake thread', async () => {
    const firstEmail = `support-intake-${crypto.randomUUID()}@example.net`;
    const secondEmail = `support-intake-${crypto.randomUUID()}@example.net`;
    addresses.push(firstEmail, secondEmail);

    expect(await supportThreadId(` ${firstEmail.toUpperCase()} `)).toBe(await supportThreadId(firstEmail));
    const first = await recordInboundSupportEmail(env as Env, {
      email: firstEmail,
      name: 'First contact',
      message: 'Hello from the first contact.',
      messageId: `mail-${crypto.randomUUID()}`,
    });
    const second = await recordInboundSupportEmail(env as Env, {
      email: secondEmail,
      name: 'Second contact',
      message: 'Hello from the second contact.',
      messageId: `mail-${crypto.randomUUID()}`,
    });
    expect(first.threadId).not.toBe(second.threadId);

    for (const [email, threadId] of [[firstEmail, first.threadId], [secondEmail, second.threadId]] as const) {
      await env.USAGE.prepare(
        `INSERT INTO subject_grants
          (id, kind, subject_id, principal_kind, principal_id, role, granted_by, granted_at, thread_id)
         VALUES (?1, 'organization', 'intake', 'guest', ?2, 'write', 'public-support', ?3, ?4)`,
      ).bind(`sgr_${crypto.randomUUID()}`, email, Date.now(), threadId).run();
    }

    const grants = await liveOutsideGrants(env as Env, 'guest', firstEmail);
    const guest = { sub: guestSub(firstEmail), email: firstEmail, name: 'First contact', grants };
    await expect(guestThreadAccess(env as Env, guest, first.threadId)).resolves.toBe('write');
    await expect(guestThreadAccess(env as Env, guest, second.threadId)).rejects.toThrow('Conversation not found.');
  });
});
