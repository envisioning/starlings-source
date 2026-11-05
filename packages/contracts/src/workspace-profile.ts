import { z } from 'zod';
import { WORKSPACE_ACCENT_PATTERN } from './workspace-accent';
import { WORKSPACE_SUITES } from './workspace-suite';

/**
 * A workspace's name, accent and mark, set by an admin in Admin › People
 *. Stored in D1 (`workspace_settings`, key `brand`). Before an
 * admin saves, the Worker's `WORKSPACE_NAME` and `WORKSPACE_ACCENT` vars
 * answer, and without those, Envisioning's pinned profile. The descriptor
 * (`/.well-known/meet`) and every page's `<head>` read the result.
 */

/** The longest name product chrome draws. */
export const WORKSPACE_NAME_MAX = 60;

/** The largest mark an admin can upload: a PNG or an SVG. */
export const WORKSPACE_MARK_MAX_BYTES = 256 * 1024;

/** `PUT /api/admin/workspace`. Null clears a value: no name is the deployed `WORKSPACE_NAME`, no accent is the product's. */
export const workspaceBrandUpdateSchema = z.object({
  name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX).nullable(),
  /** `#rrggbb`. The Worker also refuses one that cannot carry readable text. */
  accent: z.string().trim().regex(WORKSPACE_ACCENT_PATTERN).nullable(),
});
export type WorkspaceBrandUpdate = z.infer<typeof workspaceBrandUpdateSchema>;

/** Where the values in force come from. */
export const WORKSPACE_BRAND_SOURCES = ['settings', 'deployment', 'default'] as const;

/**
 * `GET` and `PUT /api/admin/workspace`, and the mark routes: the values in
 * force and where they come from. `mark_url` is on this origin, versioned.
 */
export const workspaceBrandAdminResponseSchema = z.object({
  name: z.string().nullable(),
  accent: z.string().nullable(),
  mark_url: z.string().nullable(),
  source: z.enum(WORKSPACE_BRAND_SOURCES),
  /** Null until an admin has saved once. */
  updated_at: z.number().int().nullable(),
});
export type WorkspaceBrandAdminResponse = z.infer<typeof workspaceBrandAdminResponseSchema>;

/** A workspace's suite on the wire (workspace-suite.ts). */
export const workspaceSuiteSchema = z.enum(WORKSPACE_SUITES);

/** `PUT /api/admin/workspace/suite`. */
export const workspaceSuiteUpdateSchema = z.object({
  suite: workspaceSuiteSchema,
}).strict();
export type WorkspaceSuiteUpdate = z.infer<typeof workspaceSuiteUpdateSchema>;

/** `GET` and `PUT /api/admin/workspace/suite`: the suite in force and where it comes from. */
export const workspaceSuiteAdminResponseSchema = z.object({
  suite: workspaceSuiteSchema,
  source: z.enum(WORKSPACE_BRAND_SOURCES),
  /** Null until an admin has saved once. */
  updated_at: z.number().int().nullable(),
});
export type WorkspaceSuiteAdminResponse = z.infer<typeof workspaceSuiteAdminResponseSchema>;

export * from './workspace-suite';
export * from './workspace-backgrounds';
