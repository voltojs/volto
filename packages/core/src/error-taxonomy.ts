/**
 * Error taxonomy — pure function for classifying errors into
 * transient / permanent / rate_limited / forbidden categories.
 *
 * Used by the Runner for retry/backoff decisions.
 * Zero I/O — pure classification only.
 */

export type ErrorKind = "transient" | "permanent" | "rate_limited" | "forbidden";

export interface ErrorClassification {
  kind: ErrorKind;
  /** Whether this error is retriable (transient and rate_limited are retriable) */
  retriable: boolean;
  /** Suggested backoff hint in ms (0 = no backoff, for rate_limited the actual value is from headers) */
  backoffHintMs: number;
}

/** Patterns that indicate transient errors */
const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /socket hang up/i,
  /network timeout/i,
  /connection reset/i,
  /EAI_AGAIN/i,
  /UND_ERR_CONNECT_TIMEOUT/i,
  /fetch failed/i,
  /EHOSTUNREACH/i,
];

/** Patterns that indicate rate limiting */
const RATE_LIMIT_PATTERNS = [
  /rate.limit/i,
  /too.many.requests/i,
  /429/,
  /quota.exceeded/i,
  /throttl/i,
];

/** Patterns that indicate forbidden / auth errors */
const FORBIDDEN_PATTERNS = [
  /401/,
  /403/,
  /unauthorized/i,
  /forbidden/i,
  /permission.denied/i,
  /access.denied/i,
  /invalid.api.key/i,
  /authentication/i,
];

/**
 * Classify an error into an ErrorKind category.
 * Pure function — same input always produces the same output.
 */
export function classifyError(err: unknown): ErrorClassification {
  const message = extractMessage(err);

  // Check rate limiting first (it can overlap with "transient")
  if (RATE_LIMIT_PATTERNS.some((p) => p.test(message))) {
    return { kind: "rate_limited", retriable: true, backoffHintMs: 1000 };
  }

  // Check forbidden / auth
  if (FORBIDDEN_PATTERNS.some((p) => p.test(message))) {
    return { kind: "forbidden", retriable: false, backoffHintMs: 0 };
  }

  // Check transient
  if (TRANSIENT_PATTERNS.some((p) => p.test(message))) {
    return { kind: "transient", retriable: true, backoffHintMs: 500 };
  }

  // Default: permanent (not retriable)
  return { kind: "permanent", retriable: false, backoffHintMs: 0 };
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
