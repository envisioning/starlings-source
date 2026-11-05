import { backgroundTonesFromAccent, ENVISIONING_BACKGROUND_TONES } from '@starlings/contracts/background-gallery';
import { CUSTOM_BACKGROUND_MAX_BYTES, CUSTOM_BACKGROUND_MAX_HEIGHT, CUSTOM_BACKGROUND_MAX_WIDTH } from '@starlings/contracts/limits';
import { workspaceBackgroundSettingsSchema, workspaceBackgroundTonesSchema, type WorkspaceBackgroundSettings, type WorkspaceBackgroundAdminResponse, type WorkspaceBackgroundUpdate } from '@starlings/contracts/workspace-backgrounds';
import { workspaceAccent } from './workspace-profile';
import { recordAdminAction } from './admin-audit';
import { backgroundImageSize } from './background-image';
import { ControlError } from './errors';
import { readBoundedBytes } from './http';
import type { OwnerSession } from './contracts';
import { publicNotFound } from './public-pages';

const KEY = 'backgrounds';
const IMAGE_KEY = 'workspace/background';
export const WORKSPACE_BACKGROUND_PATH = '/workspace-background';
const EMPTY: WorkspaceBackgroundSettings = { tones: null, image: null, default: null };

export async function readWorkspaceBackgrounds(env: Env): Promise<WorkspaceBackgroundAdminResponse> {
  const row = await env.USAGE.prepare('SELECT value, updated_at FROM workspace_settings WHERE key = ?1').bind(KEY).first<{ value: string; updated_at: number }>();
  let settings = EMPTY;
  try {
    const parsed = row && workspaceBackgroundSettingsSchema.safeParse(JSON.parse(row.value));
    if (parsed && parsed.success) settings = parsed.data;
  } catch { /* A malformed saved row falls back to the workspace's derived tones. */ }
  const accent = await workspaceAccent(env);
  const tones = workspaceBackgroundTonesSchema.parse(settings.tones ?? backgroundTonesFromAccent(accent) ?? ENVISIONING_BACKGROUND_TONES);
  const imageUrl = settings.image ? `${new URL(env.WEB_ORIGIN).origin}${WORKSPACE_BACKGROUND_PATH}?v=${encodeURIComponent(settings.image.version)}` : null;
  return { settings, resolved: { tones, image_url: imageUrl, default: settings.default }, updated_at: row?.updated_at ?? null };
}

async function save(env: Env, actor: OwnerSession, settings: WorkspaceBackgroundSettings): Promise<WorkspaceBackgroundAdminResponse> {
  await env.USAGE.prepare(`INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(KEY, JSON.stringify(settings), actor.sub, Date.now()).run();
  await recordAdminAction(env, actor, 'workspace.backgrounds', null, `tones ${settings.tones ? 'explicit' : 'derived'}, image ${settings.image ? 'set' : 'none'}, default ${settings.default?.mode ?? 'none'}`);
  return readWorkspaceBackgrounds(env);
}

export async function writeWorkspaceBackgrounds(env: Env, actor: OwnerSession, update: WorkspaceBackgroundUpdate): Promise<WorkspaceBackgroundAdminResponse> {
  const { settings } = await readWorkspaceBackgrounds(env);
  if (update.default?.mode === 'image' && !settings.image) throw new ControlError('Upload a workspace picture before making it the default.', 400, 'invalid_request');
  return save(env, actor, { ...settings, ...update });
}

export async function uploadWorkspaceBackground(request: Request, env: Env, actor: OwnerSession): Promise<WorkspaceBackgroundAdminResponse> {
  if (!env.DOWNLOADS) throw new ControlError('This workspace has no file storage.', 503, 'not_configured');
  const bytes = await readBoundedBytes(request, CUSTOM_BACKGROUND_MAX_BYTES);
  const size = backgroundImageSize(bytes);
  if (!size || size.width < 1 || size.height < 1 || size.width > CUSTOM_BACKGROUND_MAX_WIDTH || size.height > CUSTOM_BACKGROUND_MAX_HEIGHT) {
    throw new ControlError('Use a PNG, JPEG or WebP picture no larger than 1280 × 720.', 400, 'invalid_request');
  }
  const { settings } = await readWorkspaceBackgrounds(env);
  const object = await env.DOWNLOADS.put(IMAGE_KEY, bytes, { httpMetadata: { contentType: size.type } });
  return save(env, actor, { ...settings, image: { key: IMAGE_KEY, version: object.etag } });
}

export async function removeWorkspaceBackground(env: Env, actor: OwnerSession): Promise<WorkspaceBackgroundAdminResponse> {
  const { settings } = await readWorkspaceBackgrounds(env);
  const result = await save(env, actor, { ...settings, image: null, default: settings.default?.mode === 'image' ? null : settings.default });
  await env.DOWNLOADS?.delete(IMAGE_KEY);
  return result;
}

export async function serveWorkspaceBackground(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return publicNotFound(request);
  const object = await env.DOWNLOADS?.get(IMAGE_KEY);
  const version = new URL(request.url).searchParams.get('v');
  if (!object || (version && version !== object.etag)) return publicNotFound(request);
  return new Response(request.method === 'HEAD' ? null : object.body, { headers: {
    'content-type': object.httpMetadata?.contentType ?? 'image/png',
    'cache-control': version ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', etag: object.httpEtag,
    'content-security-policy': "default-src 'none'; sandbox",
  } });
}
