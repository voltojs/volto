/**
 * Hook types and pipeline — M13 Phase 3.
 *
 * Pure types live here (in core) so runtime-node can import them without
 * depending on @agent-core/sdk. The async `runHookPipeline` function is
 * also pure (no I/O) — it only orchestrates hook handler calls.
 *
 * Key invariant: hook denial produces a normalized tool_result(isError)
 * via the same path as permission deny — the core reducer never sees "hook".
 */

import type { ToolResult } from "./tool.js";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** Named lifecycle points where hooks can be registered */
export type HookLifecycle =
  | "session:start"
  | "session:end"
  | "turn:start"
  | "turn:end"
  | "preToolUse"
  | "postToolUse";

/**
 * Context passed to hook handlers — what the hook can observe / act on.
 * Different lifecycle points receive different subsets.
 */
export interface HookContext {
  /** Current lifecycle point */
  lifecycle: HookLifecycle;
  /** Session ID (if available) */
  sessionId?: string;
  /** Tool call details (preToolUse / postToolUse only) */
  toolCall?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
  /** Tool result (postToolUse only) */
  toolResult?: ToolResult;
}

/** Patch to apply to tool input or result */
export interface HookPatch {
  /** Replacement input (for preToolUse modify) */
  input?: Record<string, unknown>;
  /** Replacement result (for postToolUse modify) */
  result?: Partial<ToolResult>;
}

/** Hook decision outcome */
export type HookOutcome =
  | { action: "continue" }
  | { action: "modify"; patch: HookPatch }
  | { action: "deny"; reason: string };

/** A hook handler function */
export type HookHandler = (ctx: HookContext) => HookOutcome | Promise<HookOutcome>;

/**
 * A registered hook: named + lifecycle-bound + handler.
 */
export interface Hook {
  /** Unique hook name (for dedup and logging) */
  name: string;
  /** Which lifecycle point this hook listens to */
  lifecycle: HookLifecycle;
  /** The handler function */
  handler: HookHandler;
}

// ──────────────────────────────────────────────
// Pipeline execution (pure — no I/O)
// ──────────────────────────────────────────────

/**
 * Execute a hook pipeline for a given lifecycle point.
 * Hooks run in registration order, serially. First `deny` short-circuits.
 *
 * Returns the aggregated outcome:
 * - If any hook denies → { action: "deny", reason }
 * - If any hook modifies → merges patches (last write wins per field)
 * - Otherwise → { action: "continue" }
 */
export async function runHookPipeline(
  hooks: Hook[],
  lifecycle: HookLifecycle,
  ctx: Omit<HookContext, "lifecycle">,
): Promise<HookOutcome> {
  const matchingHooks = hooks.filter((h) => h.lifecycle === lifecycle);
  if (matchingHooks.length === 0) {
    return { action: "continue" };
  }

  const fullCtx: HookContext = { ...ctx, lifecycle };
  let mergedPatch: HookPatch = {};

  for (const hook of matchingHooks) {
    const outcome = await hook.handler(fullCtx);

    if (outcome.action === "deny") {
      return outcome; // short-circuit
    }

    if (outcome.action === "modify") {
      // Merge patches — later hooks see the accumulated patch
      if (outcome.patch.input) {
        mergedPatch = { ...mergedPatch, input: outcome.patch.input };
        fullCtx.toolCall = fullCtx.toolCall
          ? { ...fullCtx.toolCall, input: outcome.patch.input }
          : undefined;
      }
      if (outcome.patch.result) {
        mergedPatch = { ...mergedPatch, result: { ...mergedPatch.result, ...outcome.patch.result } };
        fullCtx.toolResult = fullCtx.toolResult
          ? { ...fullCtx.toolResult, ...outcome.patch.result }
          : undefined;
      }
    }
  }

  if (mergedPatch.input || mergedPatch.result) {
    return { action: "modify", patch: mergedPatch };
  }

  return { action: "continue" };
}
