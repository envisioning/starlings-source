import { PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import { ZodError } from 'zod';
import { addCORS, addUpgradeHeaders } from './cors';
import { CONTROL_ERROR_CODES, type ControlErrorBody, type ControlErrorCode } from './contracts';
import { ControlError, FieldError } from './errors';
import { isObjectMovingError } from './object-snapshot';
import { assertUnderRateLimit, json } from './http';
import { recordOperationalErrors, shouldCaptureWorkerFailure, workerErrorEvent } from './operational-errors';
import { log } from './route-util';
import { pageRedirect } from './page-redirect';
import { closedResponse } from './workspace-lifecycle';

/**
 * Answer one request: the router's response with CORS and upgrade headers, or,
 * for anything it throws, the error body every client reads (`error`, `code`,
 * and a `request_id` to quote when the failure is the Worker's).
 */
export async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  route: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  // Pages on a host the workspace left go to its new one (page-redirect.ts).
  const moved = pageRedirect(request, env as { PAGE_REDIRECT_FROM?: string; PAGE_REDIRECT_TO?: string });
  if (moved) return moved;
  if ((request.method === 'GET' || request.method === 'HEAD') && /^\/(?:why|features(?:\/status)?|pricing|interest|terms|changelog(?:\.md)?|help(?:\/.*)?)\/?$/.test(url.pathname)) {
    return Response.redirect(`${PRODUCT_SITE_ORIGIN}${url.pathname}${url.search}${url.hash}`, 302);
  }
  const requestId = crypto.randomUUID();
  try {
    // A shut-down workspace answers nothing but health.
    const closed = await closedResponse(request, env);
    if (closed) return closed;
    const response = await route(request, env, ctx);
    return addUpgradeHeaders(addCORS(response, request, env), request, env);
  } catch (error) {
    const status = errorStatus(error);
    const code = errorCode(error, status);
    log('error', 'request.failed', {
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      status,
      code,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    if (shouldCaptureWorkerFailure(status, code)) {
      // D1 aggregation is deliberately detached from the product response.
      const event = workerErrorEvent({
        requestId, pathname: new URL(request.url).pathname, status, code, method: request.method,
      });
      const capture = assertUnderRateLimit(env.ERROR_EVENT_LIMIT, request, 'worker-operational-errors')
        .then(() => recordOperationalErrors(env, [event]));
      ctx.waitUntil(capture.catch((captureError) => {
        if (!(captureError instanceof ControlError && captureError.code === 'rate_limited')) {
          log('error', 'operational_errors.record.failed', { requestId });
        }
      }));
    }
    const body: ControlErrorBody = { error: publicError(error, status), code };
    if (error instanceof FieldError) body.field = error.field;
    // 5xx prose is deliberately opaque, so give the user something to quote.
    // A provider failure (Google said no) gets one too, whatever its status,
    // so Copy diagnostics can be matched to `request.failed`.
    if (status >= 500 || code === 'calendar_failed') body.request_id = requestId;
    return addUpgradeHeaders(addCORS(json(body, status), request, env), request, env);
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof ControlError) return error.status;
  // A write to a room frozen for its move to the EU. It lasts
  // seconds, or up to a minute for an isolate that has not seen the switch.
  if (isObjectMovingError(error)) return 503;
  if (error instanceof ZodError) return 400;
  if (isRecord(error) && typeof error.status === 'number') return error.status;
  return 500;
}

function publicError(error: unknown, status: number): string {
  // Auth/Room/Calendar errors are already written for operators and clients.
  if (error instanceof ControlError) return error.message;
  if (error instanceof ZodError) return error.issues[0]?.message ?? 'Invalid request.';
  if (isObjectMovingError(error)) return 'This room is moving. Try again in a minute.';
  if (status >= 500) return 'The meeting service could not complete the request.';
  return error instanceof Error ? error.message : 'Invalid request.';
}

/**
 * The machine-readable half of the response. Clients branch on this so nothing
 * downstream has to pattern-match the prose in `publicError`.
 */
function errorCode(error: unknown, status: number): ControlErrorCode {
  if (error instanceof ControlError && error.code) return error.code;
  if (error instanceof ZodError) return 'invalid_request';
  // A Durable Object's error arrives as a plain object: the class is gone by
  // the time it crosses RPC, and its own properties are all that survive.
  // `errorStatus` has always read `status` back that way, and without the same
  // read here every refusal decided inside a coordinator answered
  // `invalid_request` — the status was right and the reason was lost.
  if (isRecord(error) && typeof error.code === 'string'
    && (CONTROL_ERROR_CODES as readonly string[]).includes(error.code)) {
    return error.code as ControlErrorCode;
  }
  if (status >= 500) return 'internal_error';
  return 'invalid_request';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
