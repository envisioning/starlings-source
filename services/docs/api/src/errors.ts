import type { DocsErrorCode } from '@docs/contracts';

/**
 * Base for every error the Worker turns into a client-visible response.
 *
 * `code` is the contract: clients branch on it. `message` is prose for people
 * and may be reworded freely.
 */
export class DocsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: DocsErrorCode = 'internal',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthError extends DocsError {}
export class NotFoundError extends DocsError {
  constructor(message = 'Not found.') {
    super(message, 404, 'not_found');
  }
}
export class ConflictError extends DocsError {
  constructor(message: string, code: DocsErrorCode = 'conflict') {
    super(message, 409, code);
  }
}
