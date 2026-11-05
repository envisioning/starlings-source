import { ORG_NAME } from '@starlings/contracts/deployment';
import { DEFAULT_WORKSPACE_SUITE, parseWorkspaceSuite, type WorkspaceSuite } from '@starlings/contracts/workspace-suite';

/**
 * Whose workspace this is: its name and its mark (;
 * docs/TENANCY_READINESS.md §Brand rule). The Worker writes both into every
 * page it serves, as `<meta name="workspace-name">` and
 * `<meta name="workspace-mark">`, beside the accent, so nothing waits on a
 * request. Every workspace sets its name, Envisioning included; a page
 * without one (the Vite dev server) is named Starlings, never an
 * organization. The mark is the workspace's upload.
 *
 * The favicon is the Worker's (`/workspace-icon`, docs/TENANCY_READINESS.md
 * §Brand rule); the app icons and the manifest are the product's.
 */
export interface WorkspaceBrand {
  name: string;
  /** Same-origin URL of an uploaded mark, or null to draw the default. */
  markUrl: string | null;
}

/** A page without the name meta (the Vite dev server): the product's name, never an organization's. */
const UNNAMED = 'Starlings';

let brand: WorkspaceBrand | null = null;

function meta(name: string): string | null {
  // Read without the DOM types: the Worker's typecheck reads this file too.
  const page = (globalThis as { document?: { querySelector(selector: string): { content: string } | null } }).document;
  const value = page?.querySelector(`meta[name="${name}"]`)?.content.trim();
  return value ? value : null;
}

export function workspaceBrand(): WorkspaceBrand {
  if (brand) return brand;
  const name = meta('workspace-name');
  const mark = meta('workspace-mark');
  // Only a path on this origin: the mark is the workspace's own file.
  const markUrl = mark && mark.startsWith('/') && !mark.startsWith('//') ? mark : null;
  brand = { name: name ?? UNNAMED, markUrl };
  return brand;
}

/**
 * True on Envisioning's own workspace: the one whose name is the
 * organization's. What only Envisioning has keys on it: its newsletter
 * and the www share reader on the organisation's site, which reads
 * Envisioning's Docs only.
 */
export function isEnvisioningWorkspace(): boolean {
  return workspaceBrand().name === ORG_NAME;
}

/**
 * Where the workspace's mail and calendar live, from
 * `<meta name="workspace-suite">`. A page without it is `google`.
 */
export function workspaceSuite(): WorkspaceSuite {
  return parseWorkspaceSuite(meta('workspace-suite')) ?? DEFAULT_WORKSPACE_SUITE;
}

/**
 * True when this workspace has the Docs service, from
 * `<meta name="workspace-docs">`. The Worker always writes it; a page without
 * it is the Vite dev server, which shows Docs.
 */
export function workspaceHasDocs(): boolean {
  return meta('workspace-docs') !== 'off';
}

/** True when a member can connect a calendar: Meet speaks Google Calendar only. */
export function calendarConnectable(): boolean {
  return workspaceSuite() === 'google';
}
