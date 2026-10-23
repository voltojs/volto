/**
 * Compaction budget derivation — pure, model-window aware.
 *
 * The host used to hand every session a fixed 60k-token compaction threshold.
 * On a 1M-token model that fires at ~6% occupancy, rewriting history (and
 * destroying the provider's prefix cache) long before the context is under
 * real pressure. The threshold must scale with the model's actual window.
 *
 * Two corrections keep the derived number conservative:
 *
 * 1. `decideCompaction` prices messages with `createHeuristicTokenizer`
 *    (chars / 4), which undercounts provider tokens by ~15% on code/JSON/
 *    mixed-CJK content.
 * 2. The estimate covers only `state.messages`; the static layers
 *    (AGENTS.md, skill catalogue) and tool schemas — several thousand tokens
 *    — are added by the ContextAssembler afterwards and are not counted.
 *
 * The default ratio is therefore 0.6, not the 0.75–0.8 an exact tokenizer
 * would allow: `0.6 × (window − maxOutput)` leaves room for both effects
 * while still scaling away the fixed 60k cap.
 *
 * @module compaction-budget
 */

/** Fallback used only when the model's context window is unknown. */
export const DEFAULT_COMPACTION_MAX_TOKENS = 60_000;

/** Fraction of (window − max output) used as the compaction trigger. */
export const DEFAULT_COMPACTION_WINDOW_RATIO = 0.6;

export interface CompactionBudgetInput {
  /** The routed model's context window in tokens. Unknown/absent → fallback. */
  contextWindow?: number;
  /** Per-call output cap; reserved out of the window before applying the ratio. */
  maxOutputTokens?: number;
  /** Override the default ratio (must be in (0, 1)). */
  ratio?: number;
  /** Override the 60k fallback used when the window is unknown. */
  fallback?: number;
}

/**
 * Derive the per-session compaction threshold (`CompactionConfig.maxTokens`)
 * from the model's context window.
 *
 * - window unknown / non-positive → `fallback` (default 60k), preserving the
 *   pre-window-aware behaviour for adapters that cannot describe their model;
 * - otherwise → `floor((window − maxOutput) × ratio)`, at least 1.
 */
export function deriveCompactionMaxTokens(input: CompactionBudgetInput = {}): number {
  const fallback = input.fallback ?? DEFAULT_COMPACTION_MAX_TOKENS;
  const window = input.contextWindow;
  if (window === undefined || !Number.isFinite(window) || window <= 0) {
    return fallback;
  }
  const output = Math.max(0, input.maxOutputTokens ?? 0);
  const usable = Math.max(1, Math.floor(window) - output);
  const ratio =
    input.ratio !== undefined && input.ratio > 0 && input.ratio < 1
      ? input.ratio
      : DEFAULT_COMPACTION_WINDOW_RATIO;
  return Math.max(1, Math.floor(usable * ratio));
}
