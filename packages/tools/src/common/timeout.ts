/**
 * Shared timeout vocabulary for the tool and network layers (spec D3:
 * docs/superpowers/specs/2026-10-17-timeout-policy-design.md).
 */

/**
 * Single declaration point for the tool and network layers' default
 * timeouts. Consumers (bash, web tools, the runtime-node network adapter)
 * take their defaults from this table instead of local literals.
 *
 * The turn layer is intentionally NOT covered: it keeps its own
 * `maxWallclockMs` wallclock budget with `budget_exceeded` semantics
 * (spec D4 — documented here, behavior untouched).
 */
export const DEFAULT_TIMEOUTS = {
  /**
   * Default per-call timeout for tool executions (e.g. bash). Two minutes:
   * a single tool call is routinely a build, a test suite, or a scripted
   * sleep, and the 30s used to cut those off mid-run. Long-running commands
   * can still pass an explicit `timeout` per call.
   */
  tool: 120_000,
  /** Default per-request timeout for network calls (e.g. web_fetch). */
  network: 30_000,
} as const;

/**
 * Render the unified timeout signature (spec D3):
 * `[timeout] ${subject} timed out after ${timeoutMs}ms`
 *
 * `subject` identifies what timed out (tool name / URL / turn label).
 * `timeoutMs` is the effective configured timeout — a config value, never
 * a measured duration, so the output stays replay-deterministic.
 */
export function renderTimeoutSignature(subject: string, timeoutMs: number): string {
  return `[timeout] ${subject} timed out after ${timeoutMs}ms`;
}
