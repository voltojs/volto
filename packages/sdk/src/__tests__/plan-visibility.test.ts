import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { textScript, toolCallScript } from "@voltojs/core";
import type { ModelRequest, ModelPort } from "@voltojs/core";
import { createNodeFileSystem, createNodeShell } from "@voltojs/runtime-node";

const requests: ModelRequest[] = [];
const modelPort: ModelPort = {
  async *stream(req) {
    requests.push(req);
    yield* textScript("ok");
  },
};

describe("createAgent — plan/read-only ceiling removes write tools from the visible set", () => {
  it("read-only sandbox hides WRITE_HIGH tools from the model request", async () => {
    requests.length = 0;
    const agent = createAgent({
      modelPort,
      fs: createNodeFileSystem({ root: process.cwd() }),
      shell: createNodeShell({ defaultCwd: process.cwd() }),
      permissionConfig: { sandbox: "read-only", approval: "never" },
    });
    await agent.run("go");
    const names = requests[0]!.tools.map((t) => t.name);
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
    expect(names).toContain("read_file");
    expect(names).toContain("glob");
  });

  it("danger-full-access keeps write tools (unchanged behavior)", async () => {
    requests.length = 0;
    const agent = createAgent({
      modelPort,
      fs: createNodeFileSystem({ root: process.cwd() }),
      shell: createNodeShell({ defaultCwd: process.cwd() }),
      permissionConfig: { sandbox: "danger-full-access", approval: "never" },
    });
    await agent.run("go");
    expect(requests[0]!.tools.map((t) => t.name)).toContain("write_file");
  });
});

describe("createAgent — pruned visible set inherits into dispatched sub-agents", () => {
  it("sub-agent request tools stay pruned: spec-declared write tools stay hidden, read tools visible", async () => {
    // 子代理可见集继承断言（spec §四 sdk 行「子代理继承收紧后的可见集」，
    // final-review I-2）：子代理 spec 声明 `policy.sandbox: "read-only"` 后，
    // assembleSubAgent 收窄子代 config，runner 以 `ceilingOf(子代 sandbox)`
    // 作为子代 ceiling——其模型请求的 tools 因此不含写类工具，即使 spec 的
    // tools 白名单显式点名 write_file/bash。
    //
    // 派发父级用 workspace-write 而非 read-only：task 工具本身是 WRITE_LOW，
    // read-only 父级的可见集里 task 会被 ceiling 剪除（路由层 Unknown tool），
    // 根本无法派发——这正是 ceiling 语义 fail-closed 的一部分。子代自身的
    // read-only ceiling 才是被测对象。fs/shell 注入使 write_file/bash 的
    // capability 对子代同样在，剪除只能来自 ceiling 继承而非能力门控。
    requests.length = 0;
    let parentTurn = 0;
    // 父/子请求按最后一条 user 消息路由区分（content-routed，同
    // subagent-e2e 的模式）：子代理的第一条 user 消息就是 task 派发的
    // message 字段。脚本顺序：父 task 调用 → 子收尾 → 父收尾。
    const routedPort: ModelPort = {
      async *stream(req) {
        requests.push(req);
        const users = req.messages.filter((m) => m.role === "user");
        const lastUser = users[users.length - 1];
        const lastUserText =
          typeof lastUser?.content === "string" ? lastUser.content : "";
        if (lastUserText === "child-dispatch") {
          yield* textScript("child done");
          return;
        }
        if (parentTurn++ === 0) {
          yield* toolCallScript(
            "c1",
            "task",
            JSON.stringify({
              message: "child-dispatch",
              subagent_type: "builder",
            }),
          );
          return;
        }
        yield* textScript("parent done");
      },
    };
    const agent = createAgent({
      modelPort: routedPort,
      fs: createNodeFileSystem({ root: process.cwd() }),
      shell: createNodeShell({ defaultCwd: process.cwd() }),
      permissionConfig: { sandbox: "workspace-write", approval: "never" },
      enableTaskTool: true,
      agentSpecs: [
        {
          id: "project:builder",
          scope: "project",
          spec: {
            name: "builder",
            policy: { sandbox: "read-only", approval: "never" },
            tools: ["read_file", "write_file", "bash"],
          },
          shadowed: false,
        },
      ],
    });
    await agent.run("go");

    const childRequests = requests.filter((r) => {
      const users = r.messages.filter((m) => m.role === "user");
      const lastUser = users[users.length - 1];
      return (
        typeof lastUser?.content === "string" &&
        lastUser.content === "child-dispatch"
      );
    });
    expect(childRequests).toHaveLength(1);
    const names = childRequests[0]!.tools.map((t) => t.name);
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
    expect(names).toContain("read_file");
  });
});

describe("createAgent — ask keeps an IRREVERSIBLE tool visible, auto does not", () => {
  // The ceiling is what decides whether the approval gate ever gets a chance
  // to ask: pruned tools reach the "Unknown tool" path instead. Only `ask`
  // escalates the above-ceiling IRREVERSIBLE tier to a human.
  const runWith = async (approval: "ask" | "never"): Promise<string[]> => {
    requests.length = 0;
    const agent = createAgent({
      modelPort,
      fs: createNodeFileSystem({ root: process.cwd() }),
      shell: createNodeShell({ defaultCwd: process.cwd() }),
      permissionConfig: { sandbox: "workspace-write", approval },
    });
    await agent.run("go");
    return requests[0]!.tools.map((t) => t.name);
  };

  it("workspace-write + ask surfaces git_push so the gate can ask", async () => {
    expect(await runWith("ask")).toContain("git_push");
  });

  it("workspace-write + never (auto) still prunes it", async () => {
    const names = await runWith("never");
    expect(names).not.toContain("git_push");
    // The cap must not be what hid it: the write-tier tools in the same batch
    // are still visible.
    expect(names).toContain("git_commit");
  });
});
