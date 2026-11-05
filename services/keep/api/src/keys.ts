// Staff keypairs and the org recovery key.
//
// Enrolment is the only write here that a person does for themselves. The
// server stores what it is handed and checks shape, not content — it has no
// way to verify that `wrapped_private_key` matches `public_key`, and does
// not try. A person who enrols garbage locks only themselves out.

import {
  addWrapSchema,
  enrolSchema,
  setRecoveryKeySchema,
  type DirectoryEntry,
  type KeyWrap,
  type RecoveryKey,
  type Sealed,
  type StaffKey,
  type StaffSession,
  type WrapParams,
} from '@keep/contracts';
import { auditStatement } from './audit';
import { ConflictError, KeepError, NotFoundError } from './errors';
import { assertAdmittedEmail } from './identity';

interface StaffKeyRow {
  email: string;
  name: string;
  suite: string;
  public_key: string;
  wrapped_private_key: string;
  wrap_params: string;
  extra_wraps: string;
  created_at: string;
  updated_at: string;
}

export async function getStaffKey(env: Env, email: string): Promise<StaffKey | null> {
  const row = await env.DB.prepare(`SELECT * FROM staff_keys WHERE email = ?`).bind(email).first<StaffKeyRow>();
  if (!row) return null;
  const primary: KeyWrap = {
    wrapped_private_key: JSON.parse(row.wrapped_private_key) as Sealed,
    wrap: JSON.parse(row.wrap_params) as WrapParams,
  };
  const extras = JSON.parse(row.extra_wraps || '[]') as KeyWrap[];
  return {
    email: row.email,
    name: row.name,
    suite: row.suite as StaffKey['suite'],
    public_key: row.public_key,
    wrapped_private_key: primary.wrapped_private_key,
    wrap: primary.wrap,
    wraps: [primary, ...extras],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Add a way to unwrap. The client has the private key open and seals it
 * under another method; the server cannot check the two wraps hold the same
 * key, and a client that lies locks only its own owner out of that method.
 * One wrap per method: a second passphrase replaces the first.
 */
export async function addWrap(env: Env, session: StaffSession, body: unknown, request: Request): Promise<StaffKey> {
  const input = addWrapSchema.parse(body);
  const existing = await getStaffKey(env, session.email);
  if (!existing) throw new KeepError('Enrol before adding a way to unlock.', 400, 'not_enrolled');
  const statements: D1PreparedStatement[] = [];
  if (existing.wrap.method === input.wrap.method) {
    statements.push(
      env.DB.prepare(
        `UPDATE staff_keys SET wrapped_private_key = ?, wrap_params = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE email = ?`,
      ).bind(JSON.stringify(input.wrapped_private_key), JSON.stringify(input.wrap), session.email),
    );
  } else {
    const extras = existing.wraps.slice(1).filter((wrap) => wrap.wrap.method !== input.wrap.method);
    extras.push({ wrapped_private_key: input.wrapped_private_key, wrap: input.wrap });
    statements.push(
      env.DB.prepare(`UPDATE staff_keys SET extra_wraps = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE email = ?`).bind(
        JSON.stringify(extras),
        session.email,
      ),
    );
  }
  statements.push(
    auditStatement(env, {
      vaultId: null,
      actor: session.email,
      kind: 'enrol',
      request,
      detail: { method: input.wrap.method, added: true },
    }),
  );
  await env.DB.batch(statements);
  const stored = await getStaffKey(env, session.email);
  if (!stored) throw new KeepError('Wrap did not persist.', 500, 'internal');
  return stored;
}

/**
 * Enrol, or re-enrol. Re-enrolling is destructive by construction: every
 * vault key wrapped to the old public key is now unopenable by this person,
 * so their memberships are dropped in the same batch and a colleague must
 * grant them again. The route requires `?replace=1` for that path so the
 * SPA can warn first.
 */
export async function enrol(
  env: Env,
  session: StaffSession,
  body: unknown,
  request: Request,
  options: { replace: boolean },
): Promise<StaffKey> {
  const input = enrolSchema.parse(body);
  // A person and an agent never share an address: an agent is never a
  // `staff_keys` row, so it can never be wrapped into a person's vault.
  const agent = await env.DB.prepare(`SELECT 1 AS present FROM agents WHERE address = ?`).bind(session.email).first();
  if (agent) throw new ConflictError('That address is an agent’s. An agent does not enrol.');
  const existing = await getStaffKey(env, session.email);
  if (existing && !options.replace) {
    throw new ConflictError('Already enrolled. Re-enrolling drops every vault membership.', 'conflict');
  }

  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(env.DB.prepare(`DELETE FROM vault_members WHERE email = ?`).bind(session.email));
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO staff_keys (email, name, suite, public_key, wrapped_private_key, wrap_params)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         name = excluded.name,
         suite = excluded.suite,
         public_key = excluded.public_key,
         wrapped_private_key = excluded.wrapped_private_key,
         wrap_params = excluded.wrap_params,
         extra_wraps = '[]',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).bind(
      session.email,
      session.name,
      input.suite,
      input.public_key,
      JSON.stringify(input.wrapped_private_key),
      JSON.stringify(input.wrap),
    ),
    auditStatement(env, {
      vaultId: null,
      actor: session.email,
      kind: 'enrol',
      request,
      detail: { method: input.wrap.method, replaced: Boolean(existing) },
    }),
  );
  await env.DB.batch(statements);

  const stored = await getStaffKey(env, session.email);
  if (!stored) throw new KeepError('Enrolment did not persist.', 500, 'internal');
  return stored;
}

export async function listDirectory(env: Env): Promise<DirectoryEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT email, name, public_key, created_at AS enrolled_at FROM staff_keys ORDER BY name, email`,
  ).all<DirectoryEntry>();
  return results;
}

/** Public keys for a set of emails, so vault routes can check a wrap targets an enrolled person. */
export async function publicKeysFor(env: Env, emails: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(emails)];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(`SELECT email, public_key FROM staff_keys WHERE email IN (${placeholders})`)
    .bind(...unique)
    .all<{ email: string; public_key: string }>();
  return new Map(results.map((row) => [row.email, row.public_key]));
}

export async function getRecoveryKey(env: Env): Promise<RecoveryKey | null> {
  const row = await env.DB.prepare(`SELECT public_key, holders, created_by, created_at FROM recovery_key WHERE id = 1`).first<{
    public_key: string;
    holders: string;
    created_by: string;
    created_at: string;
  }>();
  if (!row) return null;
  return { ...row, holders: JSON.parse(row.holders) as string[] };
}

/**
 * Set once. Replacing it would silently strand every vault's recovery copy,
 * so a second call is refused; replacing the key is a migration a person
 * runs on purpose, not a route.
 */
export async function setRecoveryKey(env: Env, session: StaffSession, body: unknown, request: Request): Promise<RecoveryKey> {
  const input = setRecoveryKeySchema.parse(body);
  for (const holder of input.holders) assertAdmittedEmail(env, holder, 'holders');
  if (await getRecoveryKey(env)) {
    throw new ConflictError('A recovery key already exists. Replacing it is a migration, not a request.');
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO recovery_key (id, suite, public_key, holders, created_by) VALUES (1, ?, ?, ?, ?)`).bind(
      input.suite,
      input.public_key,
      JSON.stringify(input.holders),
      session.email,
    ),
    auditStatement(env, {
      vaultId: null,
      actor: session.email,
      kind: 'recovery.set',
      request,
      detail: { holders: input.holders },
    }),
  ]);
  const stored = await getRecoveryKey(env);
  if (!stored) throw new NotFoundError('Recovery key did not persist.');
  return stored;
}
