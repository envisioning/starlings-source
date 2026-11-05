import type { ControlPlaneJob } from './contracts';
import { json } from './http';
import { handleInboundEmail } from './inbound-email';
import { isWorkspaceClosed } from './workspace-lifecycle';
import { routeFromTable } from './routes';
import { isAllowedPublicDocument, serveStatic } from './static-pages';
import { handleFetch } from './worker-fetch';
import { processQueue } from './worker-queue';
import { runScheduled } from './worker-scheduled';

export { RoomCoordinator } from './room-coordinator';
export { ThreadCoordinator } from './thread-coordinator';
export { QuickNotesCoordinator } from './quick-notes';
// The operator console's door, RPC over a service binding only (docs/OPS_CONSOLE.md).
export { OpsService } from './ops-service';
export { InterestService } from './interest-service';
// The door for this workspace's Docs and Keep: may a proven identity sign in (docs/CENTRAL_AUTH.md "Services").
export { MemberService } from './member-service';
export { isAllowedPublicDocument };

const worker = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => handleFetch(request, env, ctx, route),

  /**
   * The agent watchdog and the rest of the hourly pass. Every tick is a no-op
   * unless something is owed; see `worker-scheduled.ts` and
   * docs/AGENTS_SURFACE.md for the runtime contract it enforces.
   */
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> => runScheduled(controller, env, ctx),

  /**
   * A member forwarding an email into a subject channel. Email
   * Routing delivers everything on the workspace domain here; the handler
   * decides silently, so nothing here rejects or bounces.
   */
  email: async (message: ForwardableEmailMessage, env: Env): Promise<void> => {
    // A shut-down workspace drops its mail, silently like every refusal.
    if (await isWorkspaceClosed(env)) return;
    await handleInboundEmail(message, env);
  },

  queue: (batch: MessageBatch<ControlPlaneJob>, env: Env): Promise<void> => processQueue(batch, env),
} satisfies ExportedHandler<Env, ControlPlaneJob>;

export default worker;

/**
 * The route table (`routes.ts`) answers first, gate before handler. A path
 * that is not under `/api/` is a page or a file of the web app; anything else
 * has no route.
 */
async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  const tabled = await routeFromTable(request, env, ctx, url, (inner) => route(inner, env, ctx));
  if (tabled) return tabled;

  if (!path.startsWith('/api/') && path !== '/api') return serveStatic(request, env, path);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  return json({ error: 'Not found.' }, 404);
}
