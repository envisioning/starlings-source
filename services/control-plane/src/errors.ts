import type { ControlErrorCode } from '@starlings/contracts';

/**
 * Base for every error the Worker turns into a client-visible response.
 *
 * `code` is the contract: clients branch on it. `message` is prose for people
 * and may be reworded freely — before codes existed, the Mac and the browser
 * matched on that prose, so a copy edit silently changed session-clearing and
 * lobby-credential behavior.
 */
export class ControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: ControlErrorCode,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A form body refused on one field: `formRefusal`'s sentence, and the body key
 * it is about, which the error response carries as `field`.
 */
export class FieldError extends ControlError {
  constructor(message: string, readonly field: string) {
    super(message, 400, 'invalid_request');
  }
}

export class AuthError extends ControlError {}

/**
 * Anything a thread refuses. Distinct from `RoomError` so a conversation's
 * failures never inherit room semantics — and so "not a member" and "no such
 * thread" can stay deliberately indistinguishable.
 */
export class ThreadError extends ControlError {}
