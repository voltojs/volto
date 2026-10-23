/**
 * Compaction budget derivation — pure, model-window aware.
 *
 * The host used to hand every session a fixed 60k-token compaction threshold.
 * On a 1M-token model that fires at ~6% occupancy, rewriting history (and
 * destroying the provider's prefix cache) long before the context is under
 * real pressure. The threshold must scale with the model's actual window.
 *
 * The formula mirrors the DSH compaction backend:
 *
 *   messageBudget  = window − maxOutputTokens
 *   pressureBudget = messageBudget − headroomTokens
 *   threshold      = floor(min(window × ratio, pressureBudget))
 *
 * The 0.8 ratio is safe because the Runner compares it against a
 * provider-anchored measurement (last usage + heuristic delta), not the old
 * absolute char/4 estimate. Headroom absorbs provider tokenizer variance and
 * the output cap. Its default scales with the window
 * (`min(65,536, 10% of the window)`): large windows keep the DSH-compatible
 * 65,536 reserve, while small local models still get a usable threshold
 * instead of failing construction. An explicitly configured headroom that
 * exhausts the budget remains a configuration error.
 *
 * @module compaction-budget
 */

/** Fallback used only when the model's context window is unknown. */
export const DEFAULT_COMPACTION_MAX_TOKENS = 60_000;

/** Fraction of the window used as the compaction trigger (DSH: 0.8). */
export const DEFAULT_COMPACTION_WINDOW_RATIO = 0.8;

/** Space kept between the trigger and the window's completion reserve. */
export const DEFAULT_COMPACTION_HEADROOM_TOKENS = 65_536;

/** Share of the window used as headroom when it is smaller than the default. */
const HEADROOM_WINDOW_RATIO = 0.1;

export interface CompactionBudgetInput {
  /** The routed model's context window in tokens. Unknown/absent → fallback. */
  contextWindow?: number;
  /** Per-call output cap; reserved out of the window before headroom. */
  maxOutputTokens?: number;
  /** Override the default ratio; values outside (0, 1) fall back to 0.8. */
  ratio?: number;
  /** Override the default headroom reserve (65,536 or 10% of the window). */
  headroomTokens?: number;
  /** Override the 60k fallback used when the window is unknown. */
  fallback?: number;
}

/**
 * Derive the per-session compaction threshold (`CompactionConfig.maxTokens`)
 * from the model's context window.
 *
 * - window unknown / non-positive → `fallback` (default 60k), preserving the
 *   pre-window-aware behaviour for adapters that cannot describe their model;
 * - otherwise → `floor(min(window × ratio, window − maxOutput − headroom))`;
 * - an exhausted pressure budget throws: with the scaled default this needs
 *   an explicit headroom or an output cap above 90% of the window; silently
 *   clamping would either compact on every call or never compact at all.
 */
export function deriveCompactionMaxTokens(input: CompactionBudgetInput = {}): number {
  const fallback = input.fallback ?? DEFAULT_COMPACTION_MAX_TOKENS;
  const window = input.contextWindow;
  if (window === undefined || !Number.isFinite(window) || window <= 0) {
    return fallback;
  }
  const output = Math.max(0, input.maxOutputTokens ?? 0);
  // Scale the default reserve down for small windows; an explicit headroom is
  // honored verbatim and may still exhaust the budget (then we throw).
  const headroom = Math.max(
    0,
    input.headroomTokens
      ?? Math.min(DEFAULT_COMPACTION_HEADROOM_TOKENS, Math.floor(window * HEADROOM_WINDOW_RATIO)),
  );
  const pressureBudget = Math.floor(window) - output - headroom;
  if (pressureBudget <= 0) {
    throw new Error(
      `compaction budget exhausted: contextWindow ${Math.floor(window)} - maxOutput ${output} `
        + `- headroom ${headroom} <= 0`,
    );
  }
  const ratio =
    input.ratio !== undefined && input.ratio > 0 && input.ratio < 1
      ? input.ratio
      : DEFAULT_COMPACTION_WINDOW_RATIO;
  return Math.max(1, Math.floor(Math.min(window * ratio, pressureBudget)));
}
