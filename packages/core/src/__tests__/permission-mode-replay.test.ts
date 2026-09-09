import { describe, it, expect } from "vitest";
import {
  evaluatePermission,
} from "../permission-policy.js";
import type { PermissionConfig } from "../permission-policy.js";
import { step, createInitialState } from "../reducer.js";
import type { ToolDefinition } from "../index.js";

// ──────────────────────────────────────────────
// Replay: permission mode decisions are deterministic
// ──────────────────────────────────────────────

describe("permission knobs — replay / deep-equal determinism", () => {
  const tools: ToolDefinition[] = [
    {
      name: "read_file",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      requires: ["filesystem:read"],
      riskTier: "READ_ONLY",
    },
    {
      name: "bash",
      description: "run",
      inputSchema: { type: "object", properties: {} },
      requires: ["shell:exec"],
      riskTier: "WRITE_HIGH",
    },
  ];

  const ctx = {
    tools,
    model: "test",
    maxTokens: 100,
  };

  it("read-only + never denies write tools — two runs produce identical state", () => {
    const config: PermissionConfig = { sandbox: "read-only", approval: "never" };

    function runSequence() {
      let state = createInitialState();

      const r1 = step(state, { type: "user_message", content: "do something" }, ctx);
      state = r1.state;

      const r2 = step(state, {
        type: "model_done",
        stopReason: "tool_use",
      }, ctx);
      state = r2.state;

      // Simulate permission check for bash tool
      const perm = evaluatePermission(config, "bash", "WRITE_HIGH", new Set(["shell:exec"]));
      expect(perm).toBe("deny"); // read-only ceiling denies every write tier

      const r3 = step(state, {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "bash",
        result: { modelContent: 'Tool "bash" denied by permission policy', isError: true },
      }, ctx);
      state = r3.state;

      return { messages: state.messages, status: state.status };
    }

    const run1 = runSequence();
    const run2 = runSequence();

    expect(run1.status).toEqual(run2.status);
    expect(run1.messages.length).toEqual(run2.messages.length);
    // Messages must be deep-equal (deterministic)
    for (let i = 0; i < run1.messages.length; i++) {
      expect(run1.messages[i]).toEqual(run2.messages[i]);
    }
  });

  it("workspace-write + never allows WRITE_HIGH but denies IRREVERSIBLE — deterministic", () => {
    const config: PermissionConfig = { sandbox: "workspace-write", approval: "never" };

    function runSequence() {
      let state = createInitialState();

      const r1 = step(state, { type: "user_message", content: "test" }, ctx);
      state = r1.state;

      const permWriteHigh = evaluatePermission(config, "bash", "WRITE_HIGH", new Set(["shell:exec"]));
      expect(permWriteHigh).toBe("allow");

      const permIrrev = evaluatePermission(config, "rm_rf", "IRREVERSIBLE", new Set(["shell:exec"]));
      expect(permIrrev).toBe("deny");

      return { messages: state.messages, status: state.status };
    }

    const run1 = runSequence();
    const run2 = runSequence();

    expect(run1.status).toEqual(run2.status);
    expect(run1.messages.length).toEqual(run2.messages.length);
  });

  it("a rule appended mid-session stays part of the input, not hidden state", () => {
    // The gateway grants "always allow this tool" by appending to rules. That
    // must not make replay non-deterministic: rules are input, so replaying
    // the same config object yields the same decisions both times.
    const config: PermissionConfig = { sandbox: "workspace-write", approval: "ask" };
    expect(evaluatePermission(config, "bash", "WRITE_HIGH")).toBe("ask");

    config.rules = [{ toolName: "bash", decision: "allow" }];
    const first = evaluatePermission(config, "bash", "WRITE_HIGH");
    const second = evaluatePermission(config, "bash", "WRITE_HIGH");

    expect(first).toBe("allow");
    expect(second).toBe(first);
  });
});
