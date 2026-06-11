/**
 * Hook types re-exported from @agent-core/core.
 * The canonical definitions live in core (pure types + runHookPipeline).
 * This module exists for SDK consumers' convenience.
 */

export type {
  Hook,
  HookOutcome,
  HookPatch,
  HookContext,
  HookLifecycle,
  HookHandler,
} from "@agent-core/core";

export { runHookPipeline } from "@agent-core/core";
