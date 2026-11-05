import type { KeepErrorCode } from '@keep/contracts';

/**
 * Base for every error the Worker turns into a client-visible response.
 *
 * `code` is the contract: clients branch on it. `message` is prose for people
 * and may be reworded freely.
 */
export class KeepError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: KeepErrorCode = 'internal',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthError extends KeepError {}
export class NotFoundError extends KeepError {
  constructor(message = 'Not found.') {
    super(message, 404, 'not_found');
  }
}
export class ConflictError extends KeepError {
  constructor(message: string, code: KeepErrorCode = 'conflict') {
    super(message, 409, code);
  }
}
