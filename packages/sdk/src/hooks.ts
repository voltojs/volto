/**
 * Hook types re-exported from @voltojs/core.
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
} from "@voltojs/core";

export { runHookPipeline } from "@voltojs/core";
