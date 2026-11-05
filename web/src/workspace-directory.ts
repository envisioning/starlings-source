import { parseWorkspaceAddress, workspaceOrigin, workspaceOriginSignInURL, WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import { WORKSPACE_DESCRIPTOR_PATH } from '@starlings/contracts/workspace-descriptor';
import { workspaceBrand } from './workspace-brand';

/**
 * Add and switch workspaces on the web, the browser twin of
 * `StarlingsWorkspaceDirectory` and `StarlingsWorkspaceStore` in the apps.
 *
 * Each workspace is its own origin with its own host-only session, so the
 * browser cannot read another workspace's session or storage. What this
 * origin keeps is the list of workspaces a person reached from here, in
 * `localStorage`. Adding a workspace hands the origin it came from to the
 * new one in the sign-in's return path (`?added_from=`), and the new
 * origin lists it back after reading its descriptor, so each lists the
 * other. Only origins travel; no name, address or session does.
 */

/** A workspace this browser reached from here. Every field is public: the descriptor's. */
export interface KnownWorkspace {
  origin: string;
  name: string;
  /** The mark on the workspace's own origin, or null for its initial. */
  markUrl: string | null;
  /** The member domains, for who may sign in. */
  domains: string[];
}

export type LookupFailure = 'invalid' | 'not_found' | 'network';

export class WorkspaceLookupError extends Error {
  constructor(readonly reason: LookupFailure) {
    super(lookupFailureMessage(reason));
  }
}

export function lookupFailureMessage(reason: LookupFailure): string {
  switch (reason) {
    case 'invalid': return 'Enter a workspace address.';
    case 'not_found': return 'No workspace at that address.';
    case 'network': return 'Couldn’t reach that workspace. Check your connection.';
  }
}

/** The query the sign-in returns with, naming the origin the person came from. */
export const ADDED_FROM_PARAM = 'added_from';

/**
 * The origin an address names: `<slug>`, `<slug>.<suffix>`, a pasted
 * workspace URL or an invite link on it, or this page's own origin. The
 * page's CSP lets it read descriptors on `*.<suffix>` only, so a link
 * on a custom domain is not looked up here.
 */
export function addressOrigin(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  try {
    if (/^https?:\/\//i.test(value) && new URL(value).origin === window.location.origin) return window.location.origin;
  } catch { /* not a URL */ }
  const parsed = parseWorkspaceAddress(value);
  return parsed.ok ? workspaceOrigin(parsed.slug) : null;
}

/** The `.<suffix>` suffix shows while a bare name is typed. */
export function showsSuffix(input: string): boolean {
  return !/[.:/]/.test(input);
}

export const ADDRESS_SUFFIX = `.${WORKSPACE_HOST_SUFFIX}`;

/** `your-team.<suffix>`: the address a person reads. */
export function addressOf(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

function sameOrigin(value: unknown, origin: string): boolean {
  if (typeof value !== 'string') return false;
  try { return new URL(value).origin === origin; } catch { return false; }
}

/**
 * `GET <origin>/.well-known/meet`, read the way the apps read it: version 1,
 * a name, and a `web_origin` that is the origin asked. A host that names
 * another origin is not this workspace. A mark off the workspace's origin
 * is dropped.
 */
export async function lookUpWorkspace(input: string, signal?: AbortSignal): Promise<KnownWorkspace> {
  const origin = addressOrigin(input);
  if (!origin) throw new WorkspaceLookupError('invalid');
  let response: Response;
  try {
    response = await fetch(`${origin}${WORKSPACE_DESCRIPTOR_PATH}`, {
      signal,
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    // A host with no workspace answers without CORS, which reads as a
    // network failure: only an offline browser is one.
    throw new WorkspaceLookupError(navigator.onLine === false ? 'network' : 'not_found');
  }
  if (!response.ok) throw new WorkspaceLookupError('not_found');
  let body: unknown;
  try { body = await response.json(); } catch { throw new WorkspaceLookupError('not_found'); }
  const descriptor = body as {
    version?: unknown;
    name?: unknown;
    web_origin?: unknown;
    brand?: { mark_url?: unknown };
    identity?: { domains?: unknown };
  };
  const name = typeof descriptor.name === 'string' ? descriptor.name.trim().slice(0, 80) : '';
  if (descriptor.version !== 1 || !name || !sameOrigin(descriptor.web_origin, origin)) {
    throw new WorkspaceLookupError('not_found');
  }
  const mark = descriptor.brand?.mark_url;
  const domains = Array.isArray(descriptor.identity?.domains)
    ? descriptor.identity.domains.filter((domain): domain is string => typeof domain === 'string' && domain.length > 0)
    : [];
  return {
    origin,
    name,
    markUrl: typeof mark === 'string' && sameOrigin(mark, origin) ? mark : null,
    domains,
  };
}

/** This workspace, as the list draws it: from the page's own brand. */
export function currentWorkspace(): KnownWorkspace {
  const brand = workspaceBrand();
  return { origin: window.location.origin, name: brand.name, markUrl: brand.markUrl, domains: [] };
}

const STORAGE_KEY = 'meet.workspaces.known';

function readStored(): KnownWorkspace[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((entry): entry is KnownWorkspace =>
      typeof entry === 'object' && entry !== null
      && typeof (entry as KnownWorkspace).origin === 'string'
      && typeof (entry as KnownWorkspace).name === 'string');
  } catch {
    return [];
  }
}

function writeStored(list: KnownWorkspace[]): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 16))); } catch { /* private window: the list lives for the page */ }
}

/** Every workspace on the list, this one first. */
export function knownWorkspaces(): KnownWorkspace[] {
  const here = currentWorkspace();
  return [here, ...readStored().filter((entry) => entry.origin !== here.origin)];
}

/** Puts `workspace` on this origin's list, newest first. */
export function rememberWorkspace(workspace: KnownWorkspace): void {
  if (workspace.origin === window.location.origin) return;
  writeStored([workspace, ...readStored().filter((entry) => entry.origin !== workspace.origin)]);
}

/** Takes a workspace off this origin's list. */
export function forgetWorkspace(origin: string): void {
  writeStored(readStored().filter((entry) => entry.origin !== origin));
}

/**
 * Where "Continue to sign in" goes: the workspace's own sign-in, which
 * returns to its Home with this origin in `added_from`.
 */
export function addWorkspaceHref(workspace: KnownWorkspace, from: string = window.location.origin): string {
  const back = `/?${ADDED_FROM_PARAM}=${encodeURIComponent(from)}`;
  return workspaceOriginSignInURL(workspace.origin, back);
}

/**
 * On arrival from Add a workspace: the origin the person came from, taken
 * off the address. Listed back once its own descriptor confirms it.
 */
export function takeAddedFrom(): string | null {
  const url = new URL(window.location.href);
  const from = url.searchParams.get(ADDED_FROM_PARAM);
  if (from === null) return null;
  url.searchParams.delete(ADDED_FROM_PARAM);
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  try {
    const origin = new URL(from).origin;
    return origin === from && origin !== window.location.origin ? origin : null;
  } catch {
    return null;
  }
}

/** Lists the workspace a person came from, once its descriptor names that origin. */
export async function rememberOrigin(origin: string): Promise<void> {
  try {
    const found = await lookUpWorkspace(origin);
    if (found.origin === origin) rememberWorkspace(found);
  } catch { /* not a workspace we can read: not listed */ }
}
