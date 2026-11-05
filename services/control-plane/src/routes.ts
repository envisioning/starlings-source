import { refuseAgent } from './agent-boundary';
import { requireCapability } from './capabilities';
import { readKindAlias, roomSlugSchema } from './contracts';
import type { RoleSession } from './capabilities';
import { requireOrgAdmin } from './auth';
import type { OwnerSession } from './contracts';
import { assertTrustedMutation, assertWebOrigin } from './http';
import { admitRoomHost, ensureOwnerRoom } from './room-access';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { connectorsRoutes } from './routes/connectors';
import { ownerRoutes } from './routes/owner';
import { mcpRoutes } from './routes/mcp';
import { meetingsRoutes } from './routes/meetings';
import { notesRoutes } from './routes/notes';
import { peersRoutes } from './routes/peers';
import { profileRoutes } from './routes/profile';
import { roomsRoutes } from './routes/rooms';
import { attentionRoutes } from './routes/attention';
import { threadsRoutes } from './routes/threads';
import { tokensRoutes } from './routes/tokens';
import { bookingRoutes } from './routes/booking';
import { calendarRoutes } from './routes/calendar';
import { crmRoutes } from './routes/crm';
import { offersRoutes } from './routes/offers';
import { diagnosticsRoutes } from './routes/diagnostics';
import { docsRoutes } from './routes/docs';
import { docsServiceRoutes } from './routes/docs-service';
import { guestRoutes } from './routes/guest';
import { internalRoutes } from './routes/internal';
import { publicRoutes } from './routes/public';
import { eventsRoutes } from './routes/events';
import { type Gate, type Method, type Route, DEFAULT_PARAM } from './route-types';

export { defineRoute, PARAMS, type Gate, type Method, type Route, type RouteContext } from './route-types';

/** Every family, in the order the router tries them. */
export const ROUTES: readonly Route[] = [
  ...publicRoutes,
  ...eventsRoutes,
  ...internalRoutes,
  ...diagnosticsRoutes,
  ...adminRoutes,
  ...calendarRoutes,
  ...crmRoutes,
  ...offersRoutes,
  ...authRoutes,
  ...peersRoutes,
  ...threadsRoutes,
  ...attentionRoutes,
  ...connectorsRoutes,
  ...ownerRoutes,
  ...tokensRoutes,
  ...profileRoutes,
  ...notesRoutes,
  ...mcpRoutes,
  ...docsRoutes,
  ...docsServiceRoutes,
  ...bookingRoutes,
  ...guestRoutes,
  ...roomsRoutes,
  ...meetingsRoutes,
];

export function methodsOf(route: Route): readonly Method[] {
  return typeof route.method === 'string' ? [route.method] : route.method;
}

/**
 * The paths `fixtures/routes.json` records for a row: `{}` for a dynamic
 * segment, and one path per word where the row says the segment is one of a
 * fixed set (`re: 'lead|project'`), as the inventory lists a regex alternation.
 */
export function inventoryPaths(route: Route): string[] {
  let paths = [route.path];
  for (const [name, param] of Object.entries(route.params ?? {})) {
    if (!/^[a-z_-]+(?:\|[a-z_-]+)+$/u.test(param.re)) continue;
    paths = paths.flatMap((path) => param.re.split('|').map((word) => path.replace(`:${name}`, word)));
  }
  return paths.map((path) => path.replace(/:\w+/gu, '{}'));
}

/** The route's path with each `:name` replaced by a value its `params` accepts. */
export function samplePath(route: Route): string {
  return route.path.replace(/:(\w+)/gu, (_, name: string) => (route.params?.[name] ?? DEFAULT_PARAM).sample);
}

interface Compiled {
  readonly route: Route;
  readonly methods: ReadonlySet<string>;
  readonly pattern: RegExp;
}

function compile(route: Route): Compiled {
  const source = route.path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const name = segment.slice(1);
      return `(?<${name}>${(route.params?.[name] ?? DEFAULT_PARAM).re})`;
    })
    .join('/');
  return { route, methods: new Set(methodsOf(route)), pattern: new RegExp(`^${source}$`, 'u') };
}

const COMPILED: readonly Compiled[] = ROUTES.map(compile);

/**
 * A `:kind` an app built before ADR 0006 sends as `partner` reads as
 * `organization`, the same way the contracts' kind schemas read a body.
 */
function readKindAliases(params: Record<string, string>): Record<string, string> {
  if (params.kind !== undefined) params.kind = String(readKindAlias(params.kind));
  return params;
}

/** The first row that takes this method at this path, with its `:name` values. */
export function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  for (const entry of COMPILED) {
    if (!entry.methods.has(method)) continue;
    const found = entry.pattern.exec(path);
    if (found) return { route: entry.route, params: readKindAliases({ ...found.groups }) };
  }
  return null;
}

/** What the route's gate lets through: nothing, or a refusal thrown before the handler runs. */
async function applyGate(
  gate: Gate,
  request: Request,
  env: Env,
  params: Readonly<Record<string, string>>,
): Promise<{ owner?: RoleSession | OwnerSession }> {
  switch (gate.kind) {
    case 'public':
      if (gate.origin === 'web') assertWebOrigin(request, env);
      if (gate.origin === 'trusted') assertTrustedMutation(request, env);
      return {};
    case 'internal-hmac':
      return {};
    case 'capability': {
      // The session first: `owner_auth_required` is 401 from every gate, and a
      // caller with no session is told that whatever origin it came from.
      const owner = await requireCapability(request, env, gate.capability);
      if (gate.origin === 'trusted') assertTrustedMutation(request, env);
      if (gate.origin === 'web') assertWebOrigin(request, env);
      if (gate.agents === 'refuse') refuseAgent(owner);
      return { owner };
    }
    case 'admin': {
      const owner = await requireOrgAdmin(request, env);
      if (gate.origin === 'trusted') assertTrustedMutation(request, env);
      return { owner };
    }
    case 'room-owner':
    case 'room-host': {
      // The session first, then the origin, then the room: a caller with no
      // session is told so whatever it sent, and the slug is checked against
      // the contract before anyone is asked about the room, as the room router
      // did when it read it.
      const slug = roomSlugSchema.parse(params.slug);
      const owner = await requireCapability(request, env, 'hosting');
      if (gate.origin === 'trusted') assertTrustedMutation(request, env);
      if (gate.kind === 'room-owner') await ensureOwnerRoom(env, slug, owner);
      else await admitRoomHost(env, slug, owner);
      return { owner };
    }
    case 'guest':
      if (gate.origin === 'web') assertWebOrigin(request, env);
      return {};
    default: {
      const unreachable: never = gate;
      throw new Error(`Unknown gate: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Answer from the table, or `null` when no row takes this request and the legacy chain in `index.ts` should. */
export async function routeFromTable(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  dispatch: (request: Request) => Promise<Response>,
): Promise<Response | null> {
  const matched = matchRoute(request.method, url.pathname);
  if (!matched) return null;
  const principal = await applyGate(matched.route.gate, request, env, matched.params);
  return matched.route.handler({ request, env, ctx, url, params: matched.params, dispatch, ...principal });
}
