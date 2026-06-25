// Shared utilities for protocol handlers (§4).

/**
 * Returns `true` when the HTTP status indicates a transient failure
 * worth retrying: 429 (rate-limit) or any 5xx server error.
 */
export function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}
