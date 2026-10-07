/**
 * packages/vhi-connector/src/errors.ts
 *
 * Usage: typed errors thrown by every connector method. Callers branch on the
 * class (or `retryable`) instead of parsing HTTP codes:
 *
 *   try { await vhi.getServer(id) }
 *   catch (e) { if (e instanceof VhiNotFoundError) ...; if (isRetryable(e)) ... }
 */

export class VhiError extends Error {
  constructor(
    message: string,
    /** HTTP status from the cloud API, 0 for network failures. */
    readonly status: number,
    /** true when repeating the same call later may succeed (5xx, 429, network). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "VhiError";
  }
}

export class VhiAuthError extends VhiError {
  constructor(message: string, status = 401) {
    super(message, status, false);
    this.name = "VhiAuthError";
  }
}

export class VhiNotFoundError extends VhiError {
  constructor(message: string) {
    super(message, 404, false);
    this.name = "VhiNotFoundError";
  }
}

export class VhiConflictError extends VhiError {
  constructor(message: string) {
    super(message, 409, false);
    this.name = "VhiConflictError";
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof VhiError && error.retryable;
}
