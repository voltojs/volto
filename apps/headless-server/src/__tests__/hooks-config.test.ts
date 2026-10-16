/**
 * T10 Task 1 — hooks.json parse + compile (fail-closed, egress discipline).
 */

import { describe, it, expect } from "vitest";
import { HooksConfigError, parseHooksConfig, buildHooksFromConfig } from "../config/hooks.js";

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw HooksConfigError, but it returned");
}

describe("parseHooksConfig", () => {
  it("parses multiple lifecycles with multiple entries each", () => {
    const map = parseHooksConfig({
      preToolUse: [
        { type: "command", command: "~/bin/check-bash.sh" },
        { type: "command", command: "python3 ~/.volto/hooks/audit.py" },
      ],
      userPromptSubmit: [{ type: "command", command: "~/bin/audit-prompt.sh" }],
    });
    expect(map.size).toBe(2);
    expect(map.get("preToolUse")).toEqual([
      { type: "command", command: "~/bin/check-bash.sh" },
      { type: "command", command: "python3 ~/.volto/hooks/audit.py" },
    ]);
    expect(map.get("userPromptSubmit")).toEqual([
      { type: "command", command: "~/bin/audit-prompt.sh" },
    ]);
  });

  it("accepts all four new lifecycles as keys", () => {
    const map = parseHooksConfig({
      userPromptSubmit: [{ type: "command", command: "a" }],
      preCompact: [{ type: "command", command: "b" }],
      subagentStop: [{ type: "command", command: "c" }],
      notification: [{ type: "command", command: "d" }],
    });
    expect(map.size).toBe(4);
    expect(map.get("preCompact")).toEqual([{ type: "command", command: "b" }]);
    expect(map.get("subagentStop")).toEqual([{ type: "command", command: "c" }]);
    expect(map.get("notification")).toEqual([{ type: "command", command: "d" }]);
  });

  it("treats an empty object as an explicit no-hook config (empty Map)", () => {
    const map = parseHooksConfig({});
    expect(map.size).toBe(0);
  });

  it("rejects an unknown lifecycle key, naming the key", () => {
    const err = captureError(() =>
      parseHooksConfig({ preTolUse: [{ type: "command", command: "x" }] }),
    );
    expect(err).toBeInstanceOf(HooksConfigError);
    expect((err as Error).message).toContain("preTolUse");
  });

  it("rejects unknown fields on an entry, naming the field", () => {
    const err = captureError(() =>
      parseHooksConfig({ preToolUse: [{ type: "command", command: "x", matcher: "*" }] }),
    );
    expect(err).toBeInstanceOf(HooksConfigError);
    expect((err as Error).message).toContain("matcher");
  });

  it("rejects a non-object root", () => {
    expect(captureError(() => parseHooksConfig([]))).toBeInstanceOf(HooksConfigError);
    expect(captureError(() => parseHooksConfig(null))).toBeInstanceOf(HooksConfigError);
    expect(captureError(() => parseHooksConfig("preToolUse"))).toBeInstanceOf(HooksConfigError);
  });

  it("rejects a lifecycle value that is not an array", () => {
    expect(
      captureError(() => parseHooksConfig({ preToolUse: { type: "command", command: "x" } })),
    ).toBeInstanceOf(HooksConfigError);
  });

  it("rejects entries that are not exactly { type: \"command\", command: string }", () => {
    expect(
      captureError(() => parseHooksConfig({ preToolUse: [{ type: "script", command: "x" }] })),
    ).toBeInstanceOf(HooksConfigError);
    expect(
      captureError(() => parseHooksConfig({ preToolUse: [{ type: "command" }] })),
    ).toBeInstanceOf(HooksConfigError);
    expect(
      captureError(() => parseHooksConfig({ preToolUse: [{ type: "command", command: 42 }] })),
    ).toBeInstanceOf(HooksConfigError);
  });
});

describe("buildHooksFromConfig", () => {
  it("names hooks cfg:<lifecycle>:<index> and binds the lifecycle", () => {
    const specs = parseHooksConfig({
      preToolUse: [
        { type: "command", command: "a" },
        { type: "command", command: "b" },
      ],
      notification: [{ type: "command", command: "c" }],
    });
    const hooks = buildHooksFromConfig(specs);
    expect(hooks).toHaveLength(3);
    expect(hooks.map((h) => h.name)).toEqual([
      "cfg:preToolUse:0",
      "cfg:preToolUse:1",
      "cfg:notification:0",
    ]);
    expect(hooks.map((h) => h.lifecycle)).toEqual([
      "preToolUse",
      "preToolUse",
      "notification",
    ]);
    for (const hook of hooks) {
      expect(typeof hook.handler).toBe("function");
    }
  });

  it("returns an empty array for an empty config", () => {
    expect(buildHooksFromConfig(new Map())).toEqual([]);
  });
});
