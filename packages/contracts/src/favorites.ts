import { z } from 'zod';

/** The openable, member-owned target kinds pinned by fixtures/favorites.json. */
export const FAVORITE_KINDS = [
  'crm.lead',
  'crm.project',
  'crm.partner',
  'cms.event',
  'core.record',
  'crm.task',
  'github.issue',
  'docs.document',
  'docs.folder',
  'meet.person',
  'meet.agent',
  'meet.thread',
] as const;

export const LEGACY_SUBJECT_FAVORITE_KINDS = [
  'crm.lead',
  'crm.project',
  'crm.partner',
  'cms.event',
] as const;

export const favoriteKindSchema = z.enum(FAVORITE_KINDS);
export const legacySubjectFavoriteKindSchema = z.enum(LEGACY_SUBJECT_FAVORITE_KINDS);
const UUID_FAVORITE_KINDS = new Set<string>([
  'crm.lead', 'crm.project', 'crm.partner', 'cms.event', 'crm.task',
  'docs.document', 'docs.folder', 'meet.thread',
]);

/** POST /api/crm/favorites. Core applies the kind-specific reference grammar. */
export const favoriteTargetSchema = z.object({
  kind: favoriteKindSchema,
  target_ref: z.string().min(1).max(512),
}).strict().transform((target) => {
  if (UUID_FAVORITE_KINDS.has(target.kind)) return { ...target, target_ref: target.target_ref.toLowerCase() };
  if (target.kind === 'core.record') {
    const separator = target.target_ref.indexOf(':');
    const recordId = target.target_ref.slice(separator + 1);
    if (separator > 0 && z.string().uuid().safeParse(recordId).success) {
      return { ...target, target_ref: `${target.target_ref.slice(0, separator)}:${recordId.toLowerCase()}` };
    }
  }
  return target;
});
export type FavoriteTarget = z.infer<typeof favoriteTargetSchema>;

/** DELETE /api/crm/favorites query fields, before canonicalizing the target. */
export const favoriteTargetQuerySchema = z.object({
  kind: favoriteKindSchema,
  target_ref: z.string().min(1).max(512),
}).strict();
export type FavoriteTargetQuery = z.infer<typeof favoriteTargetQuerySchema>;

/** Stored Core favorite row; response kinds stay open for forward compatibility. */
export const favoriteRowSchema = z.object({
  kind: z.string().min(1).max(80),
  target_ref: z.string().min(1).max(512),
  created_at: z.string().datetime({ offset: true }),
}).strict();
export type FavoriteRow = z.infer<typeof favoriteRowSchema>;

/** GET /api/crm/favorites. */
export const favoritesResponseSchema = z.object({
  favorites: z.array(favoriteRowSchema),
  synced: z.boolean(),
}).strict();
export type FavoritesResponse = z.infer<typeof favoritesResponseSchema>;

/** POST /api/crm/favorites. `synced` is false while the durable outbox retries Core. */
export const favoriteMutationResponseSchema = z.object({
  favorite: favoriteRowSchema,
  synced: z.boolean(),
}).strict();
export type FavoriteMutationResponse = z.infer<typeof favoriteMutationResponseSchema>;

/** DELETE /api/crm/favorites. */
export const favoriteRemoveResponseSchema = z.object({ removed: z.literal(true), synced: z.boolean() }).strict();
export type FavoriteRemoveResponse = z.infer<typeof favoriteRemoveResponseSchema>;

/** Per-member migration comparison for the old subject stars and Core copy. */
export const favoriteMigrationStatusResponseSchema = z.object({
  shared_available: z.boolean(),
  by_kind: z.array(z.object({
    kind: legacySubjectFavoriteKindSchema,
    legacy_count: z.number().int().nonnegative(),
    shared_count: z.number().int().nonnegative(),
    pending_count: z.number().int().nonnegative(),
  }).strict()),
  unresolved: z.array(z.object({
    kind: z.string().min(1).max(80),
    target_ref: z.string().min(1).max(512),
    code: z.string().min(1).max(80),
    attempts: z.number().int().positive(),
  }).strict()),
}).strict();
export type FavoriteMigrationStatusResponse = z.infer<typeof favoriteMigrationStatusResponseSchema>;
