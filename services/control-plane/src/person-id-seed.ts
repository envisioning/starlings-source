// Meet person ids on a Core workspace, seeded from Core's `auth.users`
// (docs/CORE_FOLD_PLAN.md §Phase 1). Each person takes the id of the
// Core user with the same address. Core's rows already name people by that id
// (`owner`, `created_by`, `decided_by`, favorites), so a row copied into D1
// keeps its people without a remap.
//
// Two steps, both admin only. The dry run (`planPersonIdSeed`) writes nothing.
// The real run (`applyPersonIdSeed`) takes back the dry run's fingerprint and
// a settlement for every mismatch, and refuses anything else. It never changes
// a person id that is set.

import { z } from 'zod';
import {
  personIdSeedRequestSchema,
  type PersonIdMismatchReason,
  type PersonIdSeedPlan,
  type PersonIdSeedResponse,
} from '@starlings/contracts/person-ids';
import { recordAdminAction } from './admin-audit';
import type { OwnerSession } from './contracts';
import { fetchCrmTeam } from './crm';
import { ControlError } from './errors';
import { usesCore } from './work-store';

const coreUserId = z.string().uuid();

interface PersonRow {
  sub: string;
  email: string;
  name: string | null;
  kind: string;
  person_id: string | null;
}

interface Computed {
  report: PersonIdSeedPlan;
  /** Address, as `people` holds it, to `people.sub`, for every person without an id. */
  subs: Map<string, string>;
  /** Every Core user id that is a valid UUID. */
  coreIds: Set<string>;
  /** Every person id that is set on this workspace. */
  held: Set<string>;
}

function normal(email: string): string {
  return email.trim().toLowerCase();
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function computePlan(env: Env): Promise<Computed> {
  // Fail closed: a D1 workspace mints its ids at sign-in (`ensurePersonId`),
  // and only a Core workspace has Core users to take them from.
  if (!usesCore(env)) {
    throw new ControlError('This workspace keeps its records in D1. It mints person ids at sign-in and has no Core users to seed from.', 409, 'not_configured');
  }
  // Throws on a Core that does not answer, or on no shared secret. Nothing is planned then.
  const members = await fetchCrmTeam(env);
  if (members.length === 0) {
    throw new ControlError('Core sent an empty roster. Nothing was planned.', 502, 'upstream_shape');
  }

  const coreByEmail = new Map<string, string[]>();
  const coreIds = new Set<string>();
  for (const member of members) {
    if (coreUserId.safeParse(member.id).success) coreIds.add(member.id);
    if (!member.email?.trim()) continue;
    const key = normal(member.email);
    coreByEmail.set(key, [...(coreByEmail.get(key) ?? []), member.id]);
  }

  const { results } = await env.USAGE.prepare(
    'SELECT sub, email, name, kind, person_id FROM people ORDER BY lower(email), sub',
  ).all<PersonRow>();
  const peopleByEmail = new Map<string, number>();
  const held = new Set<string>();
  for (const row of results) {
    peopleByEmail.set(normal(row.email), (peopleByEmail.get(normal(row.email)) ?? 0) + 1);
    if (row.person_id) held.add(row.person_id);
  }

  const report: PersonIdSeedPlan = { plan: '', people: results.length, core_users: members.length, set: [], kept: [], mismatches: [] };
  const subs = new Map<string, string>();
  for (const row of results) {
    const key = normal(row.email);
    const matches = coreByEmail.get(key) ?? [];
    const person = { email: row.email, name: row.name, kind: row.kind };
    if (row.person_id) {
      report.kept.push({ ...person, person_id: row.person_id, core_user_id: matches.length === 1 ? matches[0]! : null });
      continue;
    }
    subs.set(row.email, row.sub);
    const reason = mismatchReason(matches, peopleByEmail.get(key) ?? 0, held);
    if (reason) {
      report.mismatches.push({ ...person, reason, core_user_ids: matches });
    } else {
      report.set.push({ ...person, person_id: matches[0]! });
    }
  }
  report.plan = await sha256Hex(JSON.stringify([
    report.set.map((row) => [row.email, row.person_id]),
    report.kept.map((row) => [row.email, row.person_id]),
    report.mismatches.map((row) => [row.email, row.reason, row.core_user_ids]),
  ]));
  return { report, subs, coreIds, held };
}

function mismatchReason(matches: string[], peopleWithAddress: number, held: Set<string>): PersonIdMismatchReason | null {
  if (matches.length === 0) return 'no_core_user';
  if (matches.length > 1) return 'several_core_users';
  if (!coreUserId.safeParse(matches[0]).success) return 'invalid_core_id';
  if (peopleWithAddress > 1) return 'several_people';
  if (held.has(matches[0]!)) return 'core_id_taken';
  return null;
}

/** The dry run: what the real run would write, and every person it cannot place. Writes nothing. */
export async function planPersonIdSeed(env: Env): Promise<PersonIdSeedPlan> {
  return (await computePlan(env)).report;
}

/**
 * The real run. Refuses unless `body.plan` is the current dry run's
 * fingerprint and every mismatch carries a settlement. Writes only people
 * whose `person_id` is null, in one batch: a unique-index conflict writes
 * nothing.
 */
export async function applyPersonIdSeed(env: Env, actor: OwnerSession, body: unknown): Promise<PersonIdSeedResponse> {
  const request = personIdSeedRequestSchema.parse(body);
  const { report, subs, coreIds, held } = await computePlan(env);
  if (request.plan !== report.plan) {
    throw new ControlError('People or Core users changed after the dry run. Run the dry run again and read it before the real run.', 409, 'invalid_request');
  }

  // A settlement names a person by address: exactly as `people` holds it, or
  // in any case when only one person has that address.
  const settlementFor = (email: string) => request.settle[email]
    ?? Object.entries(request.settle).find(([key]) => normal(key) === normal(email))?.[1];
  const strays = Object.keys(request.settle).filter((key) => !report.mismatches.some((row) => row.email === key || normal(row.email) === normal(key)));
  if (strays.length > 0) {
    throw new ControlError(`Only a mismatch takes a settlement. Not a mismatch: ${strays.join(', ')}.`, 400, 'invalid_request');
  }
  const unsettled = report.mismatches.filter((row) => !settlementFor(row.email)).map((row) => row.email);
  if (unsettled.length > 0) {
    throw new ControlError(`Settle every mismatch first. Unsettled: ${unsettled.join(', ')}.`, 409, 'invalid_request');
  }

  const written: PersonIdSeedResponse['written'] = report.set.map((row) => ({ email: row.email, person_id: row.person_id, source: 'core' as const }));
  const taken = new Set([...held, ...written.map((row) => row.person_id)]);
  for (const row of report.mismatches) {
    const settlement = settlementFor(row.email)!;
    if ('mint' in settlement) {
      written.push({ email: row.email, person_id: crypto.randomUUID(), source: 'minted' });
      continue;
    }
    const id = settlement.core_user_id.toLowerCase();
    if (!coreIds.has(id)) {
      throw new ControlError(`${row.email}: ${id} is not a Core user.`, 409, 'invalid_request');
    }
    if (taken.has(id)) {
      throw new ControlError(`${row.email}: ${id} is held by another person already.`, 409, 'invalid_request');
    }
    taken.add(id);
    written.push({ email: row.email, person_id: id, source: 'settled' });
  }

  if (written.length === 0) return { plan: report.plan, written };
  const update = env.USAGE.prepare('UPDATE people SET person_id = ?2 WHERE sub = ?1 AND person_id IS NULL');
  const results = await env.USAGE.batch(written.map((row) => update.bind(subs.get(row.email)!, row.person_id)));
  const landed = written.filter((_, index) => (results[index]?.meta.changes ?? 0) === 1);
  const counts = { core: 0, settled: 0, minted: 0 };
  for (const row of landed) counts[row.source] += 1;
  await recordAdminAction(env, actor, 'person_ids.seed', null, `core ${counts.core}, settled ${counts.settled}, minted ${counts.minted}`);
  return { plan: report.plan, written: landed };
}
