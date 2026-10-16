/**
 * T10 Task 1 — extended hook lifecycle contract.
 *
 * The assignability checks are compile-level (enforced by `tsc --noEmit`
 * over `src/__tests__`); the runtime assertions pin that hooks bound to
 * the new lifecycles flow through the existing pipeline unchanged.
 */

import { describe, it, expect } from "vitest";
import type { Hook, HookContext, HookLifecycle } from "../hooks.js";
import { runHookPipeline } from "../hooks.js";

// Compile-level: these four literals must be assignable to HookLifecycle.
const NEW_LIFECYCLES: HookLifecycle[] = [
  "userPromptSubmit",
  "preCompact",
  "subagentStop",
  "notification",
];

describe("HookLifecycle extended contract (T10)", () => {
  it("accepts the four new lifecycle literals", () => {
    expect(NEW_LIFECYCLES).toEqual([
      "userPromptSubmit",
      "preCompact",
      "subagentStop",
      "notification",
    ]);
  });

  it("HookContext carries the four new optional fields", () => {
    const ctx: HookContext = {
      lifecycle: "userPromptSubmit",
      prompt: "hello",
      compactInfo: { compressibleCount: 3, currentTokens: 1200 },
      subagentInfo: { childSessionId: "child-1", status: "completed" },
      notification: { kind: "budget_warning" },
    };
    expect(ctx.prompt).toBe("hello");
    expect(ctx.compactInfo?.compressibleCount).toBe(3);
    expect(ctx.subagentInfo?.status).toBe("completed");
    expect(ctx.notification?.kind).toBe("budget_warning");
  });

  it("old call sites still typecheck with the original fields only", () => {
    const ctx: HookContext = { lifecycle: "preToolUse" };
    expect(ctx.prompt).toBeUndefined();
    expect(ctx.compactInfo).toBeUndefined();
    expect(ctx.subagentInfo).toBeUndefined();
    expect(ctx.notification).toBeUndefined();
  });

  it("hooks bound to the new lifecycles run through the pipeline", async () => {
    const seen: HookLifecycle[] = [];
    const hooks: Hook[] = NEW_LIFECYCLES.map((lifecycle) => ({
      name: `probe:${lifecycle}`,
      lifecycle,
      handler: (ctx) => {
        seen.push(ctx.lifecycle);
        return { action: "continue" as const };
      },
    }));
    for (const lifecycle of NEW_LIFECYCLES) {
      const outcome = await runHookPipeline(hooks, lifecycle, {});
      expect(outcome).toEqual({ action: "continue" });
    }
    expect(seen).toEqual(NEW_LIFECYCLES);
  });
});
