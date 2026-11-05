import type { Capability, RoleSession } from './capabilities';
import type { OwnerSession } from './contracts';

/**
 * The Worker's route table.
 *
 * One row per `(method, path)`: the gate it sits behind and the handler. The
 * router matches a request against the table and **applies the gate before it
 * calls the handler**, so a handler never has to remember to check who is
 * asking, and a row without a `gate` does not compile.
 *
 * Rows live one family to a file under `routes/`. This file owns the types a
 * row is written in; `routes.ts` owns the table, the matching and the gate. `index.ts` still holds the routes that have not
 * moved yet and answers whatever the table does not ( lands the
 * families one pull request at a time). `test/route-gates.test.ts` iterates
 * this table, and `scripts/check-client-routes.mjs` writes
 * `fixtures/routes.json` from it.
 *
 * **Row format** (the script reads the rows as text, so keep the first two
 * lines of a row in this shape): `method: 'GET',` or `method: ['GET', 'HEAD'],`,
 * then `path: '/api/…',`. A path segment `:name` is one dynamic segment; the
 * row's `params` says what it may be (default: anything but a slash).
 */

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * Who may call a route, said once, where the route is declared.
 *
 * - `public`: anyone, and `reason` says why that is safe (its own proof or a
 *   rate limit). Putting a route here is a review decision.
 * - `internal-hmac`: a service, with a signature over the body. The handler
 *   verifies it because it needs the raw body; the gate test proves an
 *   unsigned call is refused.
 * - `capability`: a signed-in, not revoked person whose role holds the
 *   capability (`requireCapability`). The handler gets `owner`.
 * - `admin`: an org admin (`requireOrgAdmin`). The handler gets `owner`.
 * - `room-owner`, `room-host`: a signed-in person who owns the room named by
 *   the row's `:slug` (`requireRoomOwner`), or, for `room-host`, hosts its open
 *   meeting on the owner's offer (`requireRoomHost`). The handler gets `owner`.
 * - `guest`: somebody with no account whose `proof` the handler checks: a
 *   lobby token, or the artifact token a meeting hands out. The text says what.
 *
 * `agents: 'refuse'` on a `capability` gate marks a store that is the person's
 * alone ("Only you"): an agent acting as them through `/mcp` is refused
 * (agent-boundary.ts).
 *
 * `origin` adds the browser-origin check: `trusted` is `assertTrustedMutation`
 * (the web origin, or a bearer token) and runs after the session, so a caller
 * with no session is told so (401) whatever origin it came from; `web` is
 * `assertWebOrigin` (the web origin only: a public form, or a write a bearer
 * token may not make).
 */
export type Gate =
  | { readonly kind: 'public'; readonly reason: string; readonly origin?: 'web' | 'trusted' }
  | { readonly kind: 'internal-hmac'; readonly reason: string }
  | { readonly kind: 'capability'; readonly capability: Capability; readonly origin?: 'trusted' | 'web'; readonly agents?: 'refuse' }
  | { readonly kind: 'admin'; readonly origin?: 'trusted' }
  | { readonly kind: 'room-owner'; readonly origin?: 'trusted' }
  | { readonly kind: 'room-host'; readonly origin?: 'trusted' }
  | { readonly kind: 'guest'; readonly proof: string; readonly origin?: 'web' };

/** What the gate resolved, handed to the handler. */
type Principal<G extends Gate> =
  G extends { readonly kind: 'capability' } ? { readonly owner: RoleSession }
    : G extends { readonly kind: 'admin' | 'room-owner' | 'room-host' } ? { readonly owner: OwnerSession }
      : unknown;

export type RouteContext = {
  readonly request: Request;
  readonly env: Env;
  readonly ctx: ExecutionContext;
  readonly url: URL;
  /** The `:name` segments of the path, as they appeared. */
  readonly params: Readonly<Record<string, string>>;
  /** Answer another request through the whole router, as the MCP door does for each tool call. */
  readonly dispatch: (request: Request) => Promise<Response>;
};

export type Handler<G extends Gate> = (context: RouteContext & Principal<G>) => Response | Promise<Response>;

/** What a `:name` segment may be, and a value that satisfies it (the gate test calls each row with it). */
export type Param = { readonly re: string; readonly sample: string };

export interface RouteDef<G extends Gate> {
  readonly method: Method | readonly Method[];
  readonly path: string;
  readonly params?: Readonly<Record<string, Param>>;
  readonly gate: G;
  readonly handler: Handler<G>;
}

export const PARAMS = {
  uuid: { re: '[0-9a-f-]{36}', sample: '00000000-0000-4000-8000-000000000001' },
  /** The rest of the path, slashes included, for a route that reads everything after its prefix. */
  rest: { re: '.+', sample: 'sample' },
} as const satisfies Record<string, Param>;

export const DEFAULT_PARAM: Param = { re: '[^/]+', sample: 'sample' };

/** A row, typed by its gate so the handler sees what the gate resolved. */
export function defineRoute<const G extends Gate>(def: RouteDef<G>): Route {
  return def as unknown as Route;
}

/** Any row, once its gate type no longer matters. */
export interface Route {
  readonly method: Method | readonly Method[];
  readonly path: string;
  readonly params?: Readonly<Record<string, Param>>;
  readonly gate: Gate;
  readonly handler: (context: RouteContext & { readonly owner?: RoleSession | OwnerSession }) => Response | Promise<Response>;
}

