import { z } from 'zod';

/*
 * Seeding Meet person ids on a Core workspace (docs/CORE_FOLD_PLAN.md §Phase 1,
 *). Every person on the workspace gets the id of the Core user with
 * the same address, so the ids already on Core's rows (`owner`, `created_by`,
 * `decided_by`, favorites) are Meet person ids and nothing is remapped.
 *
 * `GET /api/admin/person-ids/seed` is the dry run: it writes nothing.
 * `POST /api/admin/person-ids/seed` is the real run. Both are admin only.
 */

/** Why a person cannot take a Core user id by address alone. MZ settles each one by hand. */
export const personIdMismatchReasonSchema = z.enum([
  /** No Core user has this address. */
  'no_core_user',
  /** More than one Core user has this address. */
  'several_core_users',
  /** Another person on this workspace has the same address in another case, so the Core user matches both. */
  'several_people',
  /** Another person on this workspace already holds the matched Core user id. */
  'core_id_taken',
  /** Core sent an id that is not a UUID. */
  'invalid_core_id',
]);
export type PersonIdMismatchReason = z.infer<typeof personIdMismatchReasonSchema>;

const personSchema = z.object({
  email: z.string(),
  name: z.string().nullable(),
  /** `human` or `agent`. An agent has no Core user. */
  kind: z.string(),
});

/** `GET /api/admin/person-ids/seed`: what the real run would write. */
export const personIdSeedPlanSchema = z.object({
  /**
   * The plan's fingerprint. The real run takes it back and refuses when the
   * workspace or Core changed after the dry run.
   */
  plan: z.string(),
  /** Rows in `people` on this workspace. */
  people: z.number().int(),
  /** Users in Core's roster (`auth.users`). */
  core_users: z.number().int(),
  /** People who get the Core user id of their address. */
  set: z.array(personSchema.extend({ person_id: z.string() })),
  /** People who hold a person id already. The seed never changes one. `core_user_id` is the Core user of their address, or null. */
  kept: z.array(personSchema.extend({ person_id: z.string(), core_user_id: z.string().nullable() })),
  /** People whose address does not match exactly one Core user. The real run refuses until each one is settled. */
  mismatches: z.array(personSchema.extend({
    reason: personIdMismatchReasonSchema,
    /** The Core user ids the address matched, if any. */
    core_user_ids: z.array(z.string()),
  })),
});
export type PersonIdSeedPlan = z.infer<typeof personIdSeedPlanSchema>;

/** How MZ settles one mismatch: a Core user id chosen by hand, or a fresh id for a person Core does not know. */
export const personIdSettlementSchema = z.union([
  z.object({ core_user_id: z.string().uuid() }).strict(),
  z.object({ mint: z.literal(true) }).strict(),
]);
export type PersonIdSettlement = z.infer<typeof personIdSettlementSchema>;

/** `POST /api/admin/person-ids/seed`: the real run. */
export const personIdSeedRequestSchema = z.object({
  /** The `plan` of the dry run this run carries out. */
  plan: z.string().min(1),
  /** One settlement per mismatch, keyed by the person's address. */
  settle: z.record(z.string(), personIdSettlementSchema).default({}),
}).strict();
export type PersonIdSeedRequest = z.infer<typeof personIdSeedRequestSchema>;

export const personIdSeedResponseSchema = z.object({
  plan: z.string(),
  written: z.array(z.object({
    email: z.string(),
    person_id: z.string(),
    /** `core`: matched by address. `settled`: a Core user id MZ chose. `minted`: a fresh id. */
    source: z.enum(['core', 'settled', 'minted']),
  })),
});
export type PersonIdSeedResponse = z.infer<typeof personIdSeedResponseSchema>;
