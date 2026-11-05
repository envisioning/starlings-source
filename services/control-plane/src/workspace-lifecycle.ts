// A workspace that leaves is shut down first and deleted 30 days later
// (docs/WORKSPACE_EXIT.md). Shutdown is one row in
// `workspace_settings`, written by `scripts/retire-workspace.mjs --shutdown`:
// while it is there, the Worker answers every request with "closed" and drops
// every mail, and the data stays. Removing the row (`--undo`) opens it again.
//
// Health stays open, so the fleet deploy and the operator console still see
// the Worker; crons keep running, so backups cover the undo window.
import { ControlError } from './errors';

export const WORKSPACE_SHUTDOWN_KEY = 'workspace_shutdown';

/** How long one isolate trusts its last read. A shutdown reaches every isolate within this. */
const CACHE_MS = 30_000;
let cached: { closed: boolean; at: number } | null = null;

/** True while the workspace is shut down. Read once per 30 seconds per isolate. */
export async function isWorkspaceClosed(env: Pick<Env, 'USAGE'>, now = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < CACHE_MS) return cached.closed;
  const row = await env.USAGE.prepare('SELECT 1 AS closed FROM workspace_settings WHERE key = ?1')
    .bind(WORKSPACE_SHUTDOWN_KEY).first<{ closed: number }>();
  cached = { closed: row !== null, at: now };
  return cached.closed;
}

/** Tests only: forget the last read. */
export function resetWorkspaceLifecycleCache(): void {
  cached = null;
}

/** Paths a closed workspace still answers: the deploy's and the operators' health checks. */
const OPEN_WHEN_CLOSED = /^\/api\/health\/?$/u;

/**
 * The answer for a request to a closed workspace, or null when it may go on.
 * An API call gets the error body every client reads; a page gets one line.
 */
export async function closedResponse(request: Request, env: Pick<Env, 'USAGE'>): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (OPEN_WHEN_CLOSED.test(path)) return null;
  if (!(await isWorkspaceClosed(env))) return null;
  if (path.startsWith('/api/') || path === '/mcp' || path.startsWith('/.well-known/')) {
    throw new ControlError('This workspace is closed.', 503, 'workspace_closed');
  }
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><title>Closed</title><style>'
    + ':root{color-scheme:dark;--paper:#202128;--ink:#fafafa}'
    + '@media(prefers-color-scheme:light){:root{color-scheme:light;--paper:#f6f6f3;--ink:#20231f}}'
    + 'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--paper);color:var(--ink);font-family:Inter,system-ui,-apple-system,sans-serif}'
    + 'h1{font-size:24px;font-weight:400;margin:0}</style></head><body><h1>This workspace is closed.</h1></body></html>';
  return new Response(html, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
