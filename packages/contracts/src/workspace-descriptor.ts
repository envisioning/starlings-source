import { z } from 'zod';
import { workspaceClientDefaultsSchema } from './workspace-defaults';
import { workspaceBackgroundProfileSchema } from './workspace-backgrounds';
import { WORKSPACE_ACCENT_PATTERN } from './workspace-accent';
import { workspaceSuiteSchema } from './workspace-profile';
import { WORK_GROUPS } from './work-groups';

/**
 * What a workspace says about itself ( slice 2a). Each
 * workspace's Worker serves it at `WORKSPACE_DESCRIPTOR_PATH`, public and
 * cacheable, so a client learns the workspace at runtime instead of compiling
 * Envisioning's in. No secrets: everything here is already visible to a
 * visitor of the sign-in page.
 *
 * Built from the Worker's configuration, with `deployment.ts` as Envisioning's
 * defaults. Brand values come from the workspace profile ( moves them
 * to D1; the shape does not change).
 */

export const WORKSPACE_DESCRIPTOR_PATH = '/.well-known/meet';

/**
 * Bumped only by a change an older client cannot read. Fields may be added within a version.
 * `version` and `min_client` are the version handshake: every
 * version keeps both with this shape, so an app that cannot read the rest
 * still reads them and asks to be updated instead of failing.
 */
export const WORKSPACE_DESCRIPTOR_VERSION = 1;

const originSchema = z.string().url();
const versionSchema = z.string().regex(/^\d+(?:\.\d+){0,2}$/u);
const accentHexSchema = z.string().regex(WORKSPACE_ACCENT_PATTERN);

export const workspaceServicesSchema = z.object({
  /** Core, the records store, for a workspace with `WORK_STORE=core`. */
  core: originSchema.nullable(),
  /**
   * The table groups Core still holds (`WORK_GROUPS`). A client
   * links a record to Core only when its group is here
   * (`coreCollectionGroup`). Empty when `core` is null. Absent from an
   * older Worker: read every group as on Core while `core` is set.
   */
  core_groups: z.array(z.enum(WORK_GROUPS)).optional(),
  /** The workspace's own Docs. */
  docs: originSchema.nullable(),
  /** The workspace's own Keep. */
  keep: originSchema.nullable(),
});
export type WorkspaceServices = z.infer<typeof workspaceServicesSchema>;

export const workspaceDescriptorSchema = z.object({
  version: z.literal(WORKSPACE_DESCRIPTOR_VERSION),
  /** The workspace's name in product chrome. */
  name: z.string().min(1).max(80),
  /** The origin that serves the web app and its pages. */
  web_origin: originSchema,
  /** The origin the API answers on; routes are `<api_origin>/api/…`. */
  api_origin: originSchema,
  /** The host invite and room links name. */
  public_web_origin: originSchema,
  /**
   * Other origins that serve this same workspace (`WORKSPACE_ORIGIN_ALIASES`),
   * so a link on one of them opens here. A client trusts an alias
   * only once that host's own descriptor names the same `web_origin`.
   * Absent from an older Worker.
   */
  aliases: z.array(originSchema).max(8).optional(),
  identity: z.object({
    provider: z.literal('google'),
    /** Who is a member by address. Empty admits nobody by domain. */
    domains: z.array(z.string().min(1)),
    /** The one domain the account chooser is narrowed to, or null to show every account. */
    sign_in_hint: z.string().min(1).nullable(),
  }),
  /** Where the workspace's mail and calendar live. Absent from an older Worker: read it as `google`. */
  suite: workspaceSuiteSchema.optional(),
  defaults: workspaceClientDefaultsSchema.optional(),
  /**
   * The services a native client talks to directly, each the origin it calls,
   * or null when this workspace does not have it (,
   * docs/CENTRAL_AUTH.md slice C). A client sends no request to a service
   * that is null here and offers no screen for it.
   *
   * Absent from an older Worker. A client then keeps its build's defaults for
   * the build's own workspace and reads every service as null for any other.
   */
  services: workspaceServicesSchema.optional(),
  brand: z.object({
    backgrounds: workspaceBackgroundProfileSchema.optional(),
    /** The workspace's mark, a PNG or SVG on `web_origin`; null draws the workspace's initial. */
    mark_url: originSchema.nullable(),
    /** `#rrggbb`; null keeps the product's own accent. Only an accent that carries readable text is sent. */
    accent: z.string().regex(WORKSPACE_ACCENT_PATTERN).nullable(),
  }),
  /**
   * The lowest app version this workspace recommends, per platform
   * (`MIN_RECOMMENDED_VERSION_MACOS`, `_IOS`, `_ANDROID`). An older app shows
   * the update banner; an app that cannot decode this descriptor and is below
   * the floor says to update instead of "no workspace". Null sets no floor.
   * `android` is absent from an older Worker: read it as null.
   */
  min_client: z.object({
    macos: versionSchema.nullable(),
    ios: versionSchema.nullable(),
    android: versionSchema.nullable().optional(),
  }),
  /**
   * Every shade drawn from `brand.accent`, derived once by `accentPalette`
   * (workspace-accent.ts), so the native apps read the shades and never
   * copy the rule. Null keeps the product's own accent. Absent from an older
   * Worker: read it as null.
   */
  accent_palette: z.object({
    dark: z.object({
      accent: accentHexSchema,
      hover: accentHexSchema,
      down: accentHexSchema,
      on_accent: accentHexSchema,
    }),
    light: z.object({
      cta: accentHexSchema,
      cta_hover: accentHexSchema,
      cta_down: accentHexSchema,
      mark: accentHexSchema,
      focus: accentHexSchema,
    }),
  }).nullable().optional(),
});
export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>;
