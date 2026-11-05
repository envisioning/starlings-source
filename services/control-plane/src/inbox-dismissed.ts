// INBOX items resolved by hand (docs/WORK.md §INBOX, migration 0039).
//
// Reader state: "I have seen this" for an item whose life is owned
// elsewhere: a booking (Core owns the row, the guest owns its window), an
// interest or form submission (the row keeps it), an unanswered guest line (the
// thread keeps it; a newer line has a new key) and an offer or license coming
// due (Core keeps it; a moved date has a new key). The key grammar is checked
// here and nothing else is stored.

import { ControlError } from './errors';

const DISMISSABLE = /^(booking|interest|submission|guest|commercial):[A-Za-z0-9_./#:-]{1,160}$/u;

export function assertDismissableInboxKey(key: string): void {
  if (!DISMISSABLE.test(key)) {
    throw new ControlError('That inbox item cannot be dismissed.', 400, 'invalid_request');
  }
}

export async function readDismissedInboxKeys(env: Env, sub: string): Promise<Set<string>> {
  const { results } = await env.USAGE.prepare('SELECT key FROM inbox_dismissed WHERE sub = ?1')
    .bind(sub)
    .all<{ key: string }>();
  return new Set(results.map((row) => row.key));
}

export async function setInboxDismissed(env: Env, sub: string, key: string, dismissed: boolean): Promise<void> {
  assertDismissableInboxKey(key);
  if (dismissed) {
    await env.USAGE.prepare(
      'INSERT INTO inbox_dismissed (sub, key, dismissed_at) VALUES (?1, ?2, ?3) ON CONFLICT (sub, key) DO UPDATE SET dismissed_at = excluded.dismissed_at',
    ).bind(sub, key, Date.now()).run();
  } else {
    await env.USAGE.prepare('DELETE FROM inbox_dismissed WHERE sub = ?1 AND key = ?2').bind(sub, key).run();
  }
}
