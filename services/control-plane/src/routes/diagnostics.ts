import { log } from '../route-util';
import {
  DIAGNOSTIC_PAYLOAD_MAX_CHARS,
  type DiagnosticRecordedResponse,
  type OperationalErrorEvent,
  type OperationalErrorIngestResponse,
  diagnosticReportSchema,
  guestOperationalErrorBatchSchema,
  operationalErrorBatchSchema,
} from '../contracts';
import { recordDiagnostic } from '../diagnostics';
import { ControlError } from '../errors';
import { assertUnderRateLimit, json, readBoundedJSON } from '../http';
import { guestEventsAtServedRelease, recordOperationalErrors } from '../operational-errors';
import { defineRoute, type Route } from '../route-types';

/** Intake is best-effort: a broken telemetry store must not become an app error. */
async function saveOperationalEvents(env: Env, events: readonly OperationalErrorEvent[]): Promise<number> {
  try {
    return await recordOperationalErrors(env, events);
  } catch {
    log('error', 'operational_errors.intake.failed', { count: events.length });
    return 0;
  }
}

/**
 * What a device and the join page report about themselves.
 * Reading them is an admin act and lives in `admin.ts`.
 */
export const diagnosticsRoutes: readonly Route[] = [
  // Crash and hang reports: a device sends its own; an admin
  // reads them. The body is bounded by the payload cap plus the envelope.
  defineRoute({
    method: 'POST',
    path: '/api/diagnostics',
    gate: { kind: 'capability', capability: 'diagnostics', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      await assertUnderRateLimit(env.AGENT_LIMIT, request, 'diagnostics', owner.sub);
      const body = diagnosticReportSchema.parse(await readBoundedJSON(request, DIAGNOSTIC_PAYLOAD_MAX_CHARS + 1024));
      return json({ id: await recordDiagnostic(env, owner, body) } satisfies DiagnosticRecordedResponse, 201);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/operational-errors',
    gate: { kind: 'capability', capability: 'diagnostics', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      await assertUnderRateLimit(env.ERROR_EVENT_LIMIT, request, 'operational-errors', owner.sub);
      const body = operationalErrorBatchSchema.parse(await readBoundedJSON(request, 8192));
      if (body.events.some((event) => event.source === 'worker'
        || (event.source === 'mac' && event.platform !== 'macos')
        || (event.source === 'ios' && event.platform !== 'ios')
        || (event.source === 'web' && event.platform !== 'web'))) {
        throw new ControlError('The operational error event is not valid.', 400, 'invalid_request');
      }
      return json({ accepted: await saveOperationalEvents(env, body.events) } satisfies OperationalErrorIngestResponse, 202);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/guest/operational-errors',
    gate: { kind: 'public', origin: 'web', reason: 'the join flow, before anyone has an account: web origin, strict schema, rate limit' },
    handler: async ({ request, env }) => {
      await assertUnderRateLimit(env.FEEDBACK_LIMIT, request, 'guest-operational-errors');
      const body = guestOperationalErrorBatchSchema.parse(await readBoundedJSON(request, 4096));
      const events = guestEventsAtServedRelease(body.events);
      return json({ accepted: await saveOperationalEvents(env, events) } satisfies OperationalErrorIngestResponse, 202);
    },
  }),
];
