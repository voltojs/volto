import { describe, it, expect, vi } from "vitest";
import { createMockModelPort, textScript } from "@voltojs/core";
import type { PermissionConfig, StepContext } from "@voltojs/core";
import type { RunnerOptions } from "@voltojs/runtime-node";

// `createAgent`'s return value (AgentInstance) does not expose the internal
// `stepContext` it builds — only `ports`, `run`, `stream`, `resume`,
// `getState`, and `sessionStore` are public. So instead of reading
// `agent.stepContext` (which does not exist), we intercept `createRunner`
// from @voltojs/runtime-node — the one place `stepContext` actually crosses
// into the Runner — and capture the `stepContext` it was called with while
// driving one real turn through a stubbed ModelPort.
const capturedRunnerOptions: RunnerOptions[] = [];

vi.mock("@voltojs/runtime-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@voltojs/runtime-node")>();
  return {
    ...actual,
    createRunner: (opts: RunnerOptions) => {
      capturedRunnerOptions.push(opts);
      return actual.createRunner(opts);
    },
  };
});

// Imported after the mock is registered so `createAgent` picks up the
// wrapped `createRunner`.
const { createAgent } = await import("../create-agent.js");

function lastStepContext(): StepContext {
  const opts = capturedRunnerOptions.at(-1);
  if (!opts) throw new Error("createRunner was never called");
  return opts.stepContext;
}

describe("createAgent permission wiring", () => {
  it("passes an explicit permissionConfig into the step context handed to the Runner", async () => {
    const permissionConfig: PermissionConfig = {
      sandbox: "read-only",
      approval: "never",
    };
    const mockModel = createMockModelPort([textScript("ok")]);
    const agent = createAgent({ modelPort: mockModel, permissionConfig });

    await agent.run("hello");

    expect(lastStepContext().permissionConfig).toEqual(permissionConfig);
  });

  it("falls back to the default config rather than leaving it unset", async () => {
    // createAgent defaults to createDefaultPermissionConfig(); an agent with
    // no config would silently skip the boundary announcement.
    const mockModel = createMockModelPort([textScript("ok")]);
    const agent = createAgent({ modelPort: mockModel });

    await agent.run("hello");

    expect(lastStepContext().permissionConfig).toEqual({
      sandbox: "workspace-write",
      approval: "ask",
    });
  });
});
