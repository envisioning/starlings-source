// The workspace's name, mark and accent: one reader for every place that
// shows them. The web page's `<head>` (static-pages.ts) and the
// descriptor at `/.well-known/meet` (workspace-descriptor.ts) both read here.
//
// Where the values come from, first answer wins:
//   1. what an admin saved in Admin › People (`workspace_settings`, key `brand`);
//   2. the Worker's `WORKSPACE_NAME` and `WORKSPACE_ACCENT` vars, the seed
//      `scripts/provision-workspace.mjs` writes;
//   3. nothing: Envisioning's pinned profile (docs/TENANCY_READINESS.md §Brand rule).
// A saved row answers whole, so an admin can clear an accent the vars set. A
// cleared name falls back to `WORKSPACE_NAME`: a workspace with a deployed
// name never turns into Envisioning's profile.

import { workspaceSlug } from './workspace-origins';
import { accentPalette } from '@starlings/contracts/workspace-accent';
import { GATHERING_DOTS, GATHERING_VIEWBOX, STARLINGS_GLYPH_ICON_SPAN, STARLINGS_GLYPH_RADII } from '@starlings/contracts/gathering-dots';
import {
  WORKSPACE_MARK_MAX_BYTES,
  WORKSPACE_NAME_MAX,
  workspaceBrandUpdateSchema,
  type WorkspaceBrandAdminResponse,
  type WorkspaceBrandUpdate,
} from '@starlings/contracts/workspace-profile';
import { recordAdminAction } from './admin-audit';
import type { OwnerSession } from './contracts';
import { ControlError } from './errors';
import { readBoundedBytes } from './http';
import { publicNotFound } from './public-pages';

const KEY = 'brand';

type Stored = { brand: WorkspaceBrandUpdate; updatedAt: number } | null;

/** The saved row, read at most every 30 seconds per isolate; a write here refreshes it at once. */
let storedCache: { value: Stored; at: number } | null = null;
const STORED_TTL_MS = 30_000;

async function storedBrand(env: Pick<Env, 'USAGE'>): Promise<Stored> {
  if (storedCache && Date.now() - storedCache.at < STORED_TTL_MS) return storedCache.value;
  let value: Stored = null;
  try {
    const row = await env.USAGE.prepare('SELECT value, updated_at FROM workspace_settings WHERE key = ?1')
      .bind(KEY)
      .first<{ value: string; updated_at: number }>();
    const parsed = row ? workspaceBrandUpdateSchema.safeParse(JSON.parse(row.value)) : null;
    // A row nobody can read answers as if it were not there, not as a 500 on every page.
    value = row && parsed?.success ? { brand: parsed.data, updatedAt: row.updated_at } : null;
  } catch {
    value = null;
  }
  storedCache = { value, at: Date.now() };
  return value;
}

/** Forget the cached row; tests use it between cases. */
export function resetWorkspaceProfileCache(): void {
  storedCache = null;
  markCache = null;
}

function usableAccent(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && accentPalette(trimmed) ? trimmed.toLowerCase() : null;
}

/** The name and accent in force, and where they come from. */
async function brandInForce(env: Pick<Env, 'USAGE' | 'WORKSPACE_NAME' | 'WORKSPACE_ACCENT'>): Promise<{
  name: string | null;
  accent: string | null;
  source: WorkspaceBrandAdminResponse['source'];
  updatedAt: number | null;
}> {
  const stored = await storedBrand(env);
  // A name cleared in Admin falls back to the deployed one, never to
  // Envisioning's fixed profile.
  const name = env.WORKSPACE_NAME?.trim().slice(0, WORKSPACE_NAME_MAX) || null;
  if (stored) {
    return { name: stored.brand.name ?? name, accent: usableAccent(stored.brand.accent), source: 'settings', updatedAt: stored.updatedAt };
  }
  const accent = usableAccent(env.WORKSPACE_ACCENT);
  return { name, accent, source: name || accent ? 'deployment' : 'default', updatedAt: null };
}

/** The workspace's name; null on Envisioning, which draws its own. */
export async function workspaceName(env: Pick<Env, 'USAGE' | 'WORKSPACE_NAME' | 'WORKSPACE_ACCENT'>): Promise<string | null> {
  return (await brandInForce(env)).name;
}

/**
 * The workspace's name in text: its own, or Envisioning's on the fixed
 * profile, which sets none. Every other workspace must set `WORKSPACE_NAME`
 * (`scripts/check-production-config.mjs`), so only Envisioning reads the
 * fallback. The one place text names an unnamed workspace.
 */
export async function workspaceDisplayName(
  env: Pick<Env, 'USAGE' | 'WORKSPACE_NAME' | 'WORKSPACE_ACCENT'> & { WEB_ORIGIN: string; WORKSPACE_ORIGIN_ALIASES?: string | undefined },
): Promise<string> {
  // Every deployed workspace sets WORKSPACE_NAME (check-production-config);
  // an unnamed one names itself by its slug, never Envisioning.
  return (await workspaceName(env)) ?? workspaceSlug(env) ?? 'Starlings';
}

/** The name this workspace's MCP server gives a client, from the contracts. */
export { mcpServerName } from '@starlings/contracts/mcp';

/** The workspace's accent when it can carry readable text, else null: the product's own accent. */
export async function workspaceAccent(env: Pick<Env, 'USAGE' | 'WORKSPACE_NAME' | 'WORKSPACE_ACCENT'>): Promise<string | null> {
  return (await brandInForce(env)).accent;
}

/**
 * The workspace's mark: one file in the workspace's own R2, at
 * `WORKSPACE_MARK_KEY` in the downloads bucket, put there by an admin. Public,
 * because the sign-in page shows it. Only PNG or SVG, served with
 * `nosniff` and a sandbox policy: the web draws it as a CSS mask, and opened
 * on its own an SVG still cannot run a script.
 */
export const WORKSPACE_MARK_PATH = '/workspace-mark';
const WORKSPACE_MARK_KEY = 'workspace/mark';
const WORKSPACE_MARK_TYPES = new Set(['image/png', 'image/svg+xml']);

export async function serveWorkspaceMark(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return publicNotFound(request);
  const object = await env.DOWNLOADS?.get(WORKSPACE_MARK_KEY);
  const type = object?.httpMetadata?.contentType ?? '';
  if (!object || !WORKSPACE_MARK_TYPES.has(type)) return publicNotFound(request);
  return new Response(request.method === 'HEAD' ? null : object.body, {
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=300',
      etag: object.httpEtag,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

let markCache: { etag: string | null; type: string | null; at: number } | null = null;

/** The mark's etag and type, or nulls without one; read at most once a minute per isolate. */
async function workspaceMarkVersion(env: Env): Promise<{ etag: string | null; type: string | null }> {
  if (markCache && Date.now() - markCache.at < 60_000) return markCache;
  let etag: string | null = null;
  let type: string | null = null;
  try {
    const head = await env.DOWNLOADS?.head(WORKSPACE_MARK_KEY);
    type = head?.httpMetadata?.contentType ?? null;
    etag = head && WORKSPACE_MARK_TYPES.has(type ?? '') ? head.etag : null;
  } catch {
    etag = null;
  }
  markCache = { etag, type: etag ? type : null, at: Date.now() };
  return markCache;
}

/** The mark's path on this origin, versioned by its etag, or null without one. */
export async function workspaceMarkPath(env: Env): Promise<string | null> {
  const { etag } = await workspaceMarkVersion(env);
  return etag ? `${WORKSPACE_MARK_PATH}?v=${encodeURIComponent(etag)}` : null;
}

/**
 * The image a link preview shows for this workspace: its mark when the mark
 * is a PNG (link previews do not draw SVG), else the app icon. A path on this
 * origin.
 */
export async function workspaceShareImagePath(env: Env): Promise<string> {
  const { etag, type } = await workspaceMarkVersion(env);
  return etag && type === 'image/png' ? `${WORKSPACE_MARK_PATH}?v=${encodeURIComponent(etag)}` : '/icon-512.png';
}

/**
 * The workspace's favicon (docs/TENANCY_READINESS.md §Brand rule): its mark,
 * or the Starlings glyph without one, in the ink on its accent. Built per
 * request from the accent and the mark, so nothing is stored. A workspace
 * with no accent, Envisioning among them, has none and keeps the product's
 * favicon. The mark goes in as a data URI: a browser loads nothing outside an
 * SVG favicon. The PNG and ICO fallbacks and the home screen icon stay the
 * product's.
 */
export const WORKSPACE_ICON_PATH = '/workspace-icon';

/** The favicon's path on this origin, versioned by the accent and the mark, or null without an accent. */
export async function workspaceIconPath(env: Env): Promise<string | null> {
  const accent = await workspaceAccent(env);
  if (!accent || !accentPalette(accent)) return null;
  const { etag } = await workspaceMarkVersion(env);
  return `${WORKSPACE_ICON_PATH}?v=${encodeURIComponent(`${accent}.${etag ?? 'glyph'}`)}`;
}

export async function serveWorkspaceIcon(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return publicNotFound(request);
  const palette = accentPalette(await workspaceAccent(env));
  if (!palette) return publicNotFound(request);
  const { etag, type } = await workspaceMarkVersion(env);
  const object = etag && type ? await env.DOWNLOADS?.get(WORKSPACE_MARK_KEY) : null;
  const mark = object && type ? { type, bytes: new Uint8Array(await object.arrayBuffer()) } : null;
  return new Response(request.method === 'HEAD' ? null : workspaceIconSvg(palette.dark.accent, palette.dark.onAccent, mark), {
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    },
  });
}

/** The tile the product favicon draws (web/scripts/generate-favicons.mjs): 64 square, corners at 0.22, the glyph's square at `STARLINGS_GLYPH_ICON_SPAN`. */
function workspaceIconSvg(fill: string, ink: string, mark: { type: string; bytes: Uint8Array } | null): string {
  const size = 64;
  const span = size * STARLINGS_GLYPH_ICON_SPAN;
  const inset = (size - span) / 2;
  const tile = `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${fill}"/>`;
  let body: string;
  if (mark) {
    // The mark is a silhouette, as on the sign-in page: its alpha cuts the ink.
    const image = `<image href="data:${mark.type};base64,${base64(mark.bytes)}" x="${inset}" y="${inset}" width="${span}" height="${span}" preserveAspectRatio="xMidYMid meet"/>`;
    body = `<mask id="mark" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="${size}" height="${size}">${image}</mask><rect width="${size}" height="${size}" fill="${ink}" mask="url(#mark)"/>`;
  } else {
    const radii = STARLINGS_GLYPH_RADII.flat();
    const circles = GATHERING_DOTS.map((dot, index) => `<circle cx="${dot.x}" cy="${dot.y}" r="${radii[index]}"/>`).join('');
    body = `<g fill="${ink}" transform="translate(${inset} ${inset}) scale(${span / GATHERING_VIEWBOX})">${circles}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${tile}${body}</svg>`;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

// MARK: Admin

/** `GET /api/admin/workspace`: the values in force and where they come from. */
export async function readWorkspaceBrand(env: Env): Promise<WorkspaceBrandAdminResponse> {
  const brand = await brandInForce(env);
  return { name: brand.name, accent: brand.accent, mark_url: await workspaceMarkPath(env), source: brand.source, updated_at: brand.updatedAt };
}

/** `PUT /api/admin/workspace`. Refuses an accent that cannot carry readable text rather than save it and draw nothing. */
export async function writeWorkspaceBrand(env: Env, actor: OwnerSession, update: WorkspaceBrandUpdate): Promise<WorkspaceBrandAdminResponse> {
  const accent = update.accent?.toLowerCase() ?? null;
  if (accent && !accentPalette(accent)) {
    throw new ControlError('Text can’t be read on that accent. Pick a lighter or a darker one.', 400, 'invalid_request');
  }
  const brand: WorkspaceBrandUpdate = { name: update.name, accent };
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(KEY, JSON.stringify(brand), actor.sub, now).run();
  storedCache = { value: { brand, updatedAt: now }, at: Date.now() };
  await recordAdminAction(env, actor, 'workspace.brand', null, `name ${brand.name ?? '(none)'}, accent ${brand.accent ?? '(none)'}`);
  return readWorkspaceBrand(env);
}

/** What an uploaded mark is, from its bytes: a PNG, an SVG without script, or nothing. */
export function markType(bytes: Uint8Array): 'image/png' | 'image/svg+xml' | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength > png.length && png.every((byte, index) => bytes[index] === byte)) return 'image/png';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const head = text.replace(/^\uFEFF/u, '').trimStart();
  if (!/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/iu.test(head)) return null;
  // Served sandboxed and drawn as a mask, so a script could not run anyway;
  // a mark has no use for one, so it is refused rather than stored.
  if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:/iu.test(text)) return null;
  return 'image/svg+xml';
}

/** `PUT /api/admin/workspace/mark`: the request body is the file. */
export async function uploadWorkspaceMark(request: Request, env: Env, actor: OwnerSession): Promise<WorkspaceBrandAdminResponse> {
  if (!env.DOWNLOADS) throw new ControlError('This workspace has no file storage.', 503, 'not_configured');
  const bytes = await readBoundedBytes(request, WORKSPACE_MARK_MAX_BYTES);
  const type = markType(bytes);
  if (!type) throw new ControlError('The mark must be a PNG or an SVG without scripts.', 400, 'invalid_request');
  await env.DOWNLOADS.put(WORKSPACE_MARK_KEY, bytes, { httpMetadata: { contentType: type } });
  markCache = null;
  await recordAdminAction(env, actor, 'workspace.mark', null, `${type}, ${bytes.byteLength} bytes`);
  return readWorkspaceBrand(env);
}

/** `DELETE /api/admin/workspace/mark`: back to the workspace's initial. */
export async function removeWorkspaceMark(env: Env, actor: OwnerSession): Promise<WorkspaceBrandAdminResponse> {
  await env.DOWNLOADS?.delete(WORKSPACE_MARK_KEY);
  markCache = null;
  await recordAdminAction(env, actor, 'workspace.mark', null, 'removed');
  return readWorkspaceBrand(env);
}
