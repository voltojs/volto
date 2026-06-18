/**
 * Hook types re-exported from @volto/core.
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
} from "@volto/core";

export { runHookPipeline } from "@volto/core";
