// packages/sdk/src/__tests__/save-plan.test.ts
import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, toolCallScript } from "@voltojs/core";
import type { PlanStore } from "@voltojs/core";

function fakeStore() {
  const saved: Array<{ sessionId: string; projectPath: string; content: string }> = [];
  return {
    saved,
    store: {
      async save(sessionId: string, projectPath: string, content: string) {
        saved.push({ sessionId, projectPath, content });
      },
      async read() { return null; },
      async deleteBySession() {},
    } as PlanStore,
  };
}

describe("createAgent — save_plan", () => {
  it("routes save_plan through the PlanStore with session and project", async () => {
    const { store, saved } = fakeStore();
    const mock = createMockModelPort([
      toolCallScript("c1", "save_plan", JSON.stringify({ content: "# 计划\n1. 做 X" })),
    ]);
    const agent = createAgent({
      modelPort: mock,
      planStore: store,
      chatSessionId: "sess-1",
      cwd: "/tmp/the-project",
      permissionConfig: { sandbox: "read-only", approval: "never" },
    });
    const state = await agent.run("go");
    expect(saved).toEqual([
      { sessionId: "sess-1", projectPath: "/tmp/the-project", content: "# 计划\n1. 做 X" },
    ]);
    const toolMsg = (state.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === "tool").at(-1);
    expect(JSON.stringify(toolMsg)).toContain("PLAN_SAVED");
  });

  it("does not register save_plan without a planStore", async () => {
    const mock = createMockModelPort([toolCallScript("c1", "save_plan", "{}")]);
    const agent = createAgent({
      modelPort: mock,
      chatSessionId: "sess-1",
      permissionConfig: { sandbox: "read-only", approval: "never" },
    });
    const state = await agent.run("go");
    const toolMsg = (state.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === "tool").at(-1);
    // 工具不在可见集 → 路由报 unknown tool（isError 结果）。
    expect(JSON.stringify(toolMsg)).not.toContain("PLAN_SAVED");
  });
});
