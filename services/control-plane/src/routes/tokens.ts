import {
  type ControlErrorBody,
  type KeepTokenResponse,
  keepTokenRequestSchema,
} from '../contracts';
import { json, readBoundedJSON } from '../http';
import { exchangeKeepToken, keepEnabled } from '../keep';
import { defineRoute, type Route } from '../route-types';

export const tokensRoutes: readonly Route[] = [
  // No Docs device token: the Mac and iPhone reach Docs through
  // `/api/docs-service` (routes/docs-service.ts) on the owner session, so
  // the Worker applies subject access to every read. `POST /api/docs/token`
  // is gone. Apps before 6.9.2 still call it, and they show the server's
  // message, so it answers 410 with the fix, not the router's "Not found."
  //. `client_update_required` makes 6.9.3 and later show their
  // update action. Remove it once no accepted app calls it.
  defineRoute({
    method: 'POST',
    path: '/api/docs/token',
    gate: { kind: 'public', reason: 'A retired route: it tells an old app to update and reads nothing.' },
    handler: async () => json({ error: 'Update Starlings to open Docs.', code: 'client_update_required' } satisfies ControlErrorBody, 410),
  }),

  // A Keep device token for the signed-in owner. Brokered here, held on the
  // device, used against Keep directly; the device does its own crypto.
  defineRoute({
    method: 'POST',
    path: '/api/keep/token',
    gate: { kind: 'capability', capability: 'docs', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      if (!keepEnabled(env)) {
        return json({ error: 'Keep is not configured.', code: 'not_configured' } satisfies ControlErrorBody, 503);
      }
      const body = keepTokenRequestSchema.parse(await readBoundedJSON(request));
      return json(await exchangeKeepToken(env, owner, body.device_name) satisfies KeepTokenResponse);
    },
  }),
];
