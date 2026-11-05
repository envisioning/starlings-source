import { z } from 'zod';

/*
 * The activity trail of the work model on D1: one row per write
 * the Worker sends to D1. Admin › Activity reads it, for admins only, with
 * the filters Core's activity feed has.
 */

export const WORK_ACTIVITY_ACTIONS = ['insert', 'update', 'delete'] as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

/** `GET /api/admin/activity` query. */
export const workActivityQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  table: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u).optional(),
  action: z.enum(WORK_ACTIVITY_ACTIONS).optional(),
  actor: z.string().trim().max(320).optional(),
  /** First day, UTC, inclusive. */
  from: day.optional(),
  /** Last day, UTC, inclusive. */
  to: day.optional(),
  /** The last row's id of the page before. */
  cursor: z.coerce.number().int().positive().optional(),
});
export type WorkActivityQuery = z.infer<typeof workActivityQuerySchema>;

export const workActivityItemSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  /** A member's or an agent's address, or the door that wrote for no member. */
  actor: z.string().nullable(),
  table: z.string(),
  row_id: z.string(),
  action: z.enum(WORK_ACTIVITY_ACTIONS),
  label: z.string().nullable(),
  changed_fields: z.array(z.string()),
});
export type WorkActivityItem = z.infer<typeof workActivityItemSchema>;

export const workActivityResponseSchema = z.object({
  items: z.array(workActivityItemSchema),
  next_cursor: z.number().int().nullable(),
  /** Every table and actor in the trail, for the filters. */
  tables: z.array(z.string()),
  actors: z.array(z.string()),
});
export type WorkActivityResponse = z.infer<typeof workActivityResponseSchema>;
