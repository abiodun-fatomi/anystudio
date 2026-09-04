/**
 * Application errors.
 *
 * One base class with a machine code, an HTTP status and a message safe to show
 * a customer. Services throw these; the exception filter turns them into a
 * response and a log line. Nothing else in the codebase decides HTTP status.
 */

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    /** Extra fields for the response body — never secrets. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) { super('not_found', 404, `${what} not found`); }
}

export class UnauthorizedError extends AppError {
  constructor() { super('unauthorized', 401, 'Sign in to continue.'); }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to that.') { super('forbidden', 403, message); }
}

/** 402 Payment Required is the honest status here, and it is what the UI keys on. */
export class ConflictError extends AppError {
  constructor(message: string) { super('conflict', 409, message); }
}

export class InsufficientCreditsError extends AppError {
  constructor() { super('insufficient_credits', 402, 'Not enough credits for that. Your work is saved.'); }
}

export class ValidationError extends AppError {
  constructor(details: Record<string, unknown>) { super('invalid_input', 400, 'Some of that did not look right.', details); }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSec: number) {
    super('rate_limited', 429, 'Too many requests. Try again shortly.', { retryAfterSec });
  }
}

/** HTTP status for each policy refusal. Step-up is 403 with a code the UI keys on. */
export const PolicyToHttp = {
  WRONG_SURFACE: 401,
  NOT_STAFF: 403,
  INSUFFICIENT_STAFF_ROLE: 403,
  NOT_A_MEMBER: 403,
  INSUFFICIENT_WORKSPACE_ROLE: 403,
  STEP_UP_REQUIRED: 403,
  SELF_DEALING: 403,
  READ_ONLY_IMPERSONATION: 403,
} as const;
