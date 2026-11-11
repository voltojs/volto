import { describe, it, expect } from "vitest";
import { createTaskTool, createTaskOutputTool } from "../index.js";

describe("task acceptance contract", () => {
  it("accepts and forwards acceptance criteria", async () => {
    const seen: Array<{ acceptance?: string }> = [];
    const tool = createTaskTool(async (req) => {
      seen.push({ ...(req.acceptance !== undefined ? { acceptance: req.acceptance } : {}) });
      return { taskId: "t1", text: "done" };
    });
    const res = await tool.handler({ message: "do it", acceptance: "tests pass" });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ acceptance: "tests pass" }]);
  });

  it("renders a rejected dispatch as an error with the failure list", async () => {
    const tool = createTaskTool(async () => ({
      taskId: "t1", text: "out", rejected: true,
      verification: { status: "failed", attempts: 2, failures: ["no tests"], retryHint: "run pnpm test" },
    }));
    const res = await tool.handler({ message: "do it", acceptance: "tests pass" });
    expect(res.isError).toBe(true);
    const blocks = res.modelContent as Array<{ type: "text"; text: string }>;
    expect(blocks[0]!.text).toContain("no tests");
    expect(JSON.parse(blocks[1]!.text).verification).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("omits verification entirely when no criteria were given", async () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "out" }));
    const res = await tool.handler({ message: "do it" });
    const blocks = res.modelContent as Array<{ type: "text"; text: string }>;
    expect(JSON.parse(blocks[1]!.text)).not.toHaveProperty("verification");
  });

  it("carries verification in displayMetadata when present", async () => {
    const verification = { status: "passed" as const, attempts: 1, failures: [] };
    const tool = createTaskTool(async () => ({
      taskId: "t1", text: "out", verification,
    }));
    const res = await tool.handler({ message: "do it", acceptance: "tests pass" });
    expect(res.isError).toBeFalsy();
    expect(res.displayMetadata).toMatchObject({ verification });
  });

  it("returns verification and fails a rejected background result", async () => {
    const tool = createTaskOutputTool(async () => ({
      text: "out", childSessionId: "s-sub-1", rejected: true,
      verification: { status: "failed", attempts: 1, failures: ["no tests"] },
    }));
    const res = await tool.handler({ task_id: "t1" });
    expect(res.isError).toBe(true);
    const blocks = res.modelContent as Array<{ type: "text"; text: string }>;
    expect(JSON.parse(blocks[1]!.text).verification.status).toBe("failed");
  });

  it("keeps the legacy envelope untouched for a clean accepted dispatch", async () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "out" }));
    const res = await tool.handler({ message: "do it", acceptance: "tests pass" });
    const blocks = res.modelContent as Array<{ type: "text"; text: string }>;
    expect(blocks[0]!.text).toBe("out");
    expect(JSON.parse(blocks[1]!.text)).toEqual({ status: "completed" });
    expect(res.isError).toBeUndefined();
  });
});
