// Where a workspace keeps its data: one value per workspace, `WORKSPACE_REGION`
// in its env block and `region` in its provisioning record (MZ, 2026-10-15).
// Every store's jurisdiction comes from it: the R2 buckets, the Durable
// Objects (`DO_JURISDICTION`) and the D1 databases. Cloudflare sets a
// jurisdiction only when a store is made, so a workspace never changes region.
//
// The applicant chooses the region at signup (docs/ONBOARDING.md).
// Cloudflare's jurisdictions are `eu` and `fedramp` only, for D1, R2 and
// Durable Objects alike: there is no `us` jurisdiction. So an EU workspace is
// pinned to the EU jurisdiction, and a US workspace takes no jurisdiction and
// the location hint `enam`: its stores are placed in the US, without a
// residency guarantee (MZ, 2026-10-19; found when Craft, the first US
// workspace, was provisioned). No imports, so the Node scripts
// (provision-workspace, check-production-config) load it as is.

export const WORKSPACE_REGIONS = ['eu', 'us'] as const;
export type WorkspaceRegion = (typeof WORKSPACE_REGIONS)[number];

export const DEFAULT_WORKSPACE_REGION: WorkspaceRegion = 'eu';

/** The region's name in signup, the signup mail and the operator console. */
export const WORKSPACE_REGION_LABELS: Record<WorkspaceRegion, string> = {
  eu: 'European Union',
  us: 'United States',
};

export function isWorkspaceRegion(value: unknown): value is WorkspaceRegion {
  return typeof value === 'string' && (WORKSPACE_REGIONS as readonly string[]).includes(value);
}

/** The region named by a stored or typed value, or null for anything else. */
export function parseWorkspaceRegion(value: unknown): WorkspaceRegion | null {
  if (typeof value !== 'string') return null;
  const region = value.trim().toLowerCase();
  return isWorkspaceRegion(region) ? region : null;
}

/** Cloudflare's jurisdiction for a region, or null where Cloudflare has none. */
export type RegionJurisdiction = 'eu' | null;

/** A Cloudflare location hint (D1 `--location`, R2 `--location`, a Durable Object's `locationHint`). */
export type RegionLocationHint = 'enam';

/**
 * Where a region's stores go. A jurisdiction pins a store; with one, a
 * location hint is ignored, so a region has one or the other. This is the one
 * place that says which.
 */
export interface RegionPlacement {
  jurisdiction: RegionJurisdiction;
  location: RegionLocationHint | null;
}

export const REGION_PLACEMENT: Record<WorkspaceRegion, RegionPlacement> = {
  eu: { jurisdiction: 'eu', location: null },
  us: { jurisdiction: null, location: 'enam' },
};

export function regionPlacement(region: WorkspaceRegion): RegionPlacement {
  return REGION_PLACEMENT[region];
}
