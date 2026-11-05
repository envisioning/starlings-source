// `GET /.well-known/meet`: what this workspace says about itself (,
// slice 2a). Public and cacheable; nothing here is a secret.
// `deployment.ts` holds Envisioning's defaults; each value a workspace sets
// comes from its Worker's configuration or its profile (workspace-profile.ts).

import { PUBLIC_WEB_ORIGIN } from '@starlings/contracts/deployment';
import { accentPalette } from '@starlings/contracts/workspace-accent';
import {
  WORKSPACE_DESCRIPTOR_VERSION,
  type WorkspaceDescriptor,
  type WorkspaceServices,
} from '@starlings/contracts/workspace-descriptor';
import { WORK_GROUPS } from '@starlings/contracts/work-groups';
import { crmSyncEnabled } from './crm';
import { usesCoreFor } from './work-store';
import { docsEnabled } from './docs';
import { keepEnabled } from './keep';
import { readWorkspaceBackgrounds } from './workspace-backgrounds';
import { identityDomains, signInDomain } from './workspace-identity';
import { workspaceDefaults } from './workspace-defaults';
import { workspaceClientDefaultsSchema } from '@starlings/contracts/workspace-defaults';
import { workspaceAliases } from './workspace-origins';
import { workspaceSuite } from './workspace-suite';
import { workspaceAccent, workspaceDisplayName, workspaceMarkPath } from './workspace-profile';

const VERSION = /^\d+(?:\.\d+){0,2}$/u;

function version(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && VERSION.test(trimmed) ? trimmed : null;
}

function origin(value: string | undefined): string | null {
  try {
    return value?.trim() ? new URL(value.trim()).origin : null;
  } catch {
    return null;
  }
}

/**
 * The services a native client may call directly. A service is named only
 * when this Worker can broker its token, the same test as its token route,
 * so a client never offers a service whose token route answers `not_configured`.
 */
export function workspaceServices(env: Env): WorkspaceServices {
  const core = crmSyncEnabled(env) ? origin(env.CORE_API_ORIGIN) : null;
  return {
    core,
    // A record whose group has moved to D1 is not linked to Core.
    core_groups: core ? WORK_GROUPS.filter((group) => usesCoreFor(env, group)) : [],
    docs: docsEnabled(env) ? origin(env.DOCS_ORIGIN) : null,
    keep: keepEnabled(env) ? origin(env.KEEP_ORIGIN) : null,
  };
}

/** The accent's shades for the native apps, in the descriptor's snake case. */
function wirePalette(accent: string | null): WorkspaceDescriptor['accent_palette'] {
  const palette = accentPalette(accent);
  if (!palette) return null;
  const { dark, light } = palette;
  return {
    dark: { accent: dark.accent, hover: dark.hover, down: dark.down, on_accent: dark.onAccent },
    light: { cta: light.cta, cta_hover: light.ctaHover, cta_down: light.ctaDown, mark: light.mark, focus: light.focus },
  };
}

export async function workspaceDescriptor(env: Env): Promise<WorkspaceDescriptor> {
  const webOrigin = origin(env.WEB_ORIGIN) ?? PUBLIC_WEB_ORIGIN;
  const [mark, name, accent, suite] = await Promise.all([workspaceMarkPath(env), workspaceDisplayName(env), workspaceAccent(env), workspaceSuite(env)]);
  const signIn = signInDomain(env);
  return {
    version: WORKSPACE_DESCRIPTOR_VERSION,
    name,
    web_origin: webOrigin,
    api_origin: origin(env.PUBLIC_API_ORIGIN) ?? webOrigin,
    // Unset: the workspace's own web origin, never Envisioning's.
    public_web_origin: origin(env.PUBLIC_WEB_ORIGIN) ?? webOrigin,
    aliases: workspaceAliases(env).slice(0, 8),
    identity: {
      provider: 'google',
      domains: [...identityDomains(env)],
      sign_in_hint: signIn || null,
    },
    suite,
    defaults: workspaceClientDefaultsSchema.strip().parse(await workspaceDefaults(env)),
    services: workspaceServices(env),
    brand: {
      backgrounds: (await readWorkspaceBackgrounds(env)).resolved,
      mark_url: mark ? `${webOrigin}${mark}` : null,
      accent,
    },
    min_client: {
      macos: version(env.MIN_RECOMMENDED_VERSION_MACOS),
      ios: version(env.MIN_RECOMMENDED_VERSION_IOS),
      android: version(env.MIN_RECOMMENDED_VERSION_ANDROID),
    },
    accent_palette: wirePalette(accent),
  };
}

/** The descriptor, cacheable for five minutes and readable from any origin. */
export async function serveWorkspaceDescriptor(env: Env): Promise<Response> {
  return Response.json(await workspaceDescriptor(env), {
    headers: {
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
}
