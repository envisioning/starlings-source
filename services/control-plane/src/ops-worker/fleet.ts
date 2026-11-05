// Which workspaces exist, for the operator console. One interface,
// `WorkspaceRegistry`, so the provisioning registry can replace
// the source without a change to the page.
//
// Today the source is this Worker's own service bindings: one
// `WORKSPACE_<SLUG>` binding per workspace in wrangler.ops.jsonc.
// `scripts/check-production-config.mjs` refuses a config whose bindings do
// not match the workspaces in wrangler.jsonc (the top level and each
// `env.<slug>`), so the two lists cannot drift.
import { opsBindingSlug, opsServiceBinding, type OpsServiceKind, type OpsServiceMetadata, type OpsWorkspaceMetadata } from '@starlings/contracts/ops';
import { workspaceOrigin } from '@starlings/contracts/workspace-slug';
import type { OpsEnv } from './env';

/** The RPC surface of a workspace's `OpsService`, as this Worker calls it. */
export interface OpsServiceStub {
  metadata(): Promise<OpsWorkspaceMetadata>;
}

export interface FleetWorkspace {
  slug: string;
  /** `<slug>.<suffix>`. */
  host: string;
  /** The way to reach the workspace's `OpsService`. */
  service: OpsServiceStub;
}

export interface WorkspaceRegistry {
  workspaces(): Promise<FleetWorkspace[]>;
}

/** The registry read from the service bindings, sorted by slug. */
export function bindingRegistry(env: OpsEnv): WorkspaceRegistry {
  return {
    async workspaces() {
      const found: FleetWorkspace[] = [];
      for (const [binding, value] of Object.entries(env)) {
        const slug = opsBindingSlug(binding);
        if (!slug || !value || (typeof value !== 'object' && typeof value !== 'function')) continue;
        found.push({ slug, host: new URL(workspaceOrigin(slug)).host, service: value as OpsServiceStub });
      }
      return found.sort((a, b) => a.slug.localeCompare(b.slug));
    },
  };
}

/** The RPC surface of a workspace's Docs or Keep `OpsService`. */
export interface OpsSharedServiceStub {
  metadata(): Promise<OpsServiceMetadata>;
}

export interface FleetService {
  /** The workspace the service belongs to. */
  slug: string;
  kind: OpsServiceKind;
  service: OpsSharedServiceStub;
}

/** Each workspace's Docs and Keep, from the `DOCS_<SLUG>` and `KEEP_<SLUG>` bindings, by slug then kind. */
export function boundServices(env: OpsEnv): FleetService[] {
  const found: FleetService[] = [];
  for (const [binding, value] of Object.entries(env)) {
    const parsed = opsServiceBinding(binding);
    if (!parsed || !value || (typeof value !== 'object' && typeof value !== 'function')) continue;
    found.push({ ...parsed, service: value as OpsSharedServiceStub });
  }
  return found.sort((a, b) => a.slug.localeCompare(b.slug) || a.kind.localeCompare(b.kind));
}
