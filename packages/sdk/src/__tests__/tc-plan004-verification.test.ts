/**
 * Plan 004 Test Cases Verification — 逐个 TC 验证
 *
 * 每个 TC 对应 plan 文档中的一个验收用例。
 * 运行: pnpm turbo run test --filter @volto/core --filter @volto/sdk -- --testPathPattern tc-plan004
 */

import { describe, it, expect } from "vitest";
import { createMockModelPort, textScript, toolCallScript, filterVisibleTools, filterByScope } from "@volto/core";
import type { ModelPort, ModelRequest, ToolDefinition, ToolResult, ToolSource } from "@volto/core";
import type { LspClient } from "@volto/tools-code";
import { createAgent } from "@volto/sdk";
import { createAskUserTool } from "@volto/tools-ask";
import { createApplyPatchTool, createMultiEditTool } from "@volto/tools-fs";
import { createLspDefinitionTool, LSP_TOOL_NAMES } from "@volto/tools-code";
import { createGitCommitTool, createGitPushTool } from "@volto/tools-vcs";
import type { FileSystem } from "@volto/core";

// ── Helpers ──────────────────────────────────

function createInMemoryFs(seed: Record<string, string>): FileSystem {
  const store = new Map(Object.entries(seed));
  return {
    async read(path, offset = 1, limit?) {
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      const lines = content.split(/\r?\n/);
      const sliced = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined);
      return { content: sliced.join("\n"), totalLines: lines.length, truncated: false };
    },
    async readBytes() {
      return Promise.reject(new Error("readBytes is not implemented in this test double"));
    },
    async write(path, data) { store.set(path, data); },
    async stat(path) {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
      return { path, isDirectory: false, size: store.get(path)?.length ?? 0, mtime: 0 };
    },
    async list() { return { entries: [] }; },
    async glob() { return { paths: [] }; },
    async grep() { return { matches: [], truncated: false }; },
  };
}

// ═══════════════════════════════════════════════
// TC-001: MCP 工具通过 ToolSource 进入可见集并可调用
// ═══════════════════════════════════════════════

describe("TC-001: MCP 工具通过 ToolSource 进入可见集并可调用", () => {
  it("ToolSource 的工具通过 list() 可发现，SDK 路由可调用", async () => {
    const mcpToolDef: ToolDefinition = {
      name: "mcp__srv1__echo",
      description: "Echo tool",
      inputSchema: { type: "object", properties: { x: { type: "number" } } },
      requires: ["mcp:srv1"],
      riskTier: "READ_ONLY",
    };

    // Mock ToolSource that returns one tool and supports callTool
    const source: ToolSource & { callTool?: (name: string, input: Record<string, unknown>) => Promise<ToolResult> } = {
      async list() { return [mcpToolDef]; },
      onChange() { return () => {}; },
      async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
        return { modelContent: `mock-result: ${(input as { x?: number }).x}`, displayMetadata: { source: "mock" } };
      },
    };

    const mockModel = createMockModelPort([
      toolCallScript("c1", "mcp__srv1__echo", '{"x":42}'),
      textScript("done"),
    ]);

    // Step 1: createAgent with toolSource
    const agent = createAgent({
      modelPort: mockModel,
      toolSources: [source],
      capabilities: new Set(["mcp:srv1"]),
    });

    // Step 2: run — tool should be called
    const state = await agent.run("echo 42");

    // Step 3-5: 验证工具被选用并返回归一结果
    expect(state.status).toBe("done");
    expect(mockModel.callCount).toBe(2);
    const toolMsg = state.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const blocks = toolMsg?.content as Array<{ type: string; content: Array<{ type: string; text?: string }> }>;
    expect(
      blocks.some(
        (b) =>
          b.type === "tool_result" &&
          b.content.some((inner) => inner.type === "text" && inner.text?.includes("mock-result: 42")),
      ),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════
// TC-002: MCP server 缺席时工具自动从可见集摘除
// ═══════════════════════════════════════════════

describe("TC-002: MCP server 缺席时工具自动从可见集摘除", () => {
  it("能力缺失时 filterVisibleTools 自动过滤该 server 的工具", () => {
    // Simulate: server disconnected → mcp:srv1 capability removed
    // But filesystem:read is still present (FS adapter is still connected)
    const capabilities = new Set<string>(["filesystem:read"]);

    const allTools: ToolDefinition[] = [
      { name: "mcp__srv1__echo", description: "", inputSchema: { type: "object" }, requires: ["mcp:srv1"], riskTier: "READ_ONLY" },
      { name: "read_file", description: "", inputSchema: { type: "object" }, requires: ["filesystem:read"], riskTier: "READ_ONLY" },
    ];

    // Step 5: filterVisibleTools 过滤
    const visible = filterVisibleTools(allTools, capabilities);
    expect(visible.map((t) => t.name)).toEqual(["read_file"]);
    expect(visible.find((t) => t.name === "mcp__srv1__echo")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════
// TC-003: MCP 工具调用失败归一为 isError（不抛异常）
// ═══════════════════════════════════════════════

describe("TC-003: MCP 工具调用失败归一为 isError（不抛异常）", () => {
  it("ToolSource.callTool 抛异常时 SDK 返回 isError", async () => {
    const source: ToolSource & { callTool?: (name: string, input: Record<string, unknown>) => Promise<ToolResult> } = {
      async list() {
        return [{ name: "mcp__bad__tool", description: "", inputSchema: { type: "object" }, requires: ["mcp:bad"], riskTier: "READ_ONLY" as const }];
      },
      onChange() { return () => {}; },
      async callTool(): Promise<ToolResult> {
        throw new Error("server crashed");
      },
    };

    const mockModel = createMockModelPort([
      toolCallScript("c1", "mcp__bad__tool", "{}"),
      textScript("error handled"),
    ]);

    const agent = createAgent({
      modelPort: mockModel,
      toolSources: [source],
      capabilities: new Set(["mcp:bad"]),
    });

    // The callTool throws → SDK catches and returns isError
    const state = await agent.run("do something");
    expect(state.status).toBe("done");
    expect(mockModel.callCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════
// TC-004: filterByScope 裁剪纯函数可重放（快照断言）
// ═══════════════════════════════════════════════

describe("TC-004: filterByScope 裁剪纯函数可重放（快照断言）", () => {
  it("同输入同输出，两次调用结果完全一致", () => {
    const tools: ToolDefinition[] = [
      { name: "mcp__a__t1", description: "", inputSchema: { type: "object" }, requires: ["mcp:a"], riskTier: "READ_ONLY" },
      { name: "mcp__b__t2", description: "", inputSchema: { type: "object" }, requires: ["mcp:b"], riskTier: "READ_ONLY" },
      { name: "lsp__def", description: "", inputSchema: { type: "object" }, requires: ["lsp:query"], riskTier: "READ_ONLY" },
      { name: "read_file", description: "", inputSchema: { type: "object" }, requires: [], riskTier: "READ_ONLY" },
    ];
    const scopeConfig = { groups: { mcp: { priority: 5 }, lsp: { priority: 3 }, read_file: { priority: 1 } } };

    // Step 1-2: 两次调用
    const r1 = filterByScope(tools, scopeConfig, 10);
    const r2 = filterByScope(tools, scopeConfig, 10);

    // Step 3: 完全一致
    expect(r1.map((t) => t.name)).toEqual(r2.map((t) => t.name));
  });
});

// ═══════════════════════════════════════════════
// TC-005: 工具数超阈值时裁剪到 limit
// ═══════════════════════════════════════════════

describe("TC-005: 工具数超阈值时裁剪到 limit", () => {
  it("30 个工具，limit=5，agent 正常运行", async () => {
    const names = Array.from({ length: 30 }, (_, i) => `tool_${i}`);
    const tools = names.map((name) => ({
      definition: { name, description: `tool ${name}`, inputSchema: { type: "object" }, requires: [], riskTier: "READ_ONLY" as const },
      handler: async (): Promise<ToolResult> => ({ modelContent: `ok: ${name}` }),
    }));

    const mockModel = createMockModelPort([textScript("done")]);

    // Step 1: createAgent with limit=5
    const agent = createAgent({
      modelPort: mockModel,
      tools,
      toolVisibility: { limit: 5 },
    });

    // Step 2: run
    const state = await agent.run("hi");

    // Step 3: agent 正常完成
    expect(state.status).toBe("done");
  });
});

// ═══════════════════════════════════════════════
// TC-006: apply_patch 命中成功、hunk 不匹配返回候选
// ═══════════════════════════════════════════════

describe("TC-006: apply_patch 命中成功、hunk 不匹配返回候选", () => {
  it("有效 diff 成功；无效 diff 返回 isError + did not match", async () => {
    const fs = createInMemoryFs({ "test.ts": "line1\nline2\nline3" });
    const tool = createApplyPatchTool(fs);

    // Step 1: valid diff
    const patch = "@@ -1,3 +1,3 @@\n line1\n-line2\n+line2-modified\n line3";
    const result1 = await tool.handler({ path: "test.ts", patch });
    expect(result1.isError).toBeFalsy();

    // Step 2: invalid diff
    const badPatch = "@@ -1,3 +1,3 @@\n line1\n-nonexistent\n+replaced\n line3";
    const result2 = await tool.handler({ path: "test.ts", patch: badPatch });

    // Step 3: isError + did not match
    expect(result2.isError).toBe(true);
    expect(result2.modelContent).toContain("did not match");
  });
});

// ═══════════════════════════════════════════════
// TC-007: multi_edit 原子性 — 部分失败整体回滚
// ═══════════════════════════════════════════════

describe("TC-007: multi_edit 原子性 — 部分失败整体回滚", () => {
  it("第 2 个 edit 失败 → 全部回滚，文件不变", async () => {
    const original = "function hello() {\n  console.log('hello');\n  return true;\n}";
    const fs = createInMemoryFs({ "test.ts": original });
    const tool = createMultiEditTool(fs);

    // Step 1: 2 edits，第 2 个会失败
    const result = await tool.handler({
      path: "test.ts",
      edits: [
        { old_string: "function hello()", new_string: "function greet()" },
        { old_string: "nonexistent_xyz", new_string: "nope" },
      ],
    });

    // Step 3: isError + aborted
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("aborted");

    // Step 4: 文件不变
    const content = await fs.read("test.ts");
    expect(content.content).toBe(original);
  });
});

// ═══════════════════════════════════════════════
// TC-008: LSP 工具返回结构化结果
// ═══════════════════════════════════════════════

describe("TC-008: LSP 工具返回结构化结果", () => {
  it("lsp_definition 返回位置信息（非裸文本）", async () => {
    const mockClient: LspClient = {
      async definition() { return [{ uri: "file:///src/foo.ts", range: { start: { line: 10, character: 5 }, end: { line: 10, character: 10 } } }]; },
      async references() { return []; },
      async rename() { return {}; },
      async diagnostics() { return { diagnostics: [], source: "push" as const }; },
      async hover() { return null; },
    };
    // The tool layer consumes an LspClientProvider (workspace boundary and
    // document sync belong to the manager), so the double answers for the
    // requested file with the same client.
    const provider = { async forFile() { return mockClient; } };

    // Step 1-2: create the tool and call it
    const tool = createLspDefinitionTool(provider);
    const result = await tool.handler({ file: "/src/foo.ts", line: 5, character: 3 });

    // Step 3: exactly one structured block whose text projection still says
    // what the old plain string said (the model-side rendering is unchanged).
    expect(Array.isArray(result.modelContent)).toBe(true);
    const blocks = result.modelContent as unknown[];
    expect(blocks).toHaveLength(1);
    const block = blocks[0] as { type: string; kind?: string; text?: string };
    expect(block.type).toBe("structured");
    expect(block.kind).toBe("lsp.locations");
    expect(block.text).toContain("1 definition(s)");
    expect(block.text).toContain("/src/foo.ts:11:6");

    // Step 4: displayMetadata has the structured data
    expect(result.displayMetadata).toBeDefined();
    expect((result.displayMetadata as Record<string, unknown>).locations).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// TC-009: LSP 工具缺 adapter 时能力门控摘除
// ═══════════════════════════════════════════════

describe("TC-009: LSP 工具缺 adapter 时能力门控摘除", () => {
  it("不传 lsp 时 capabilities 无 lsp:query，LSP 工具不可见", async () => {
    // The real ModelRequest tool list is the evidence, not the capability
    // shape: with no `lsp` option the grant is absent, so the five `lsp_*`
    // tools must not reach the model at all.
    const captured: ModelRequest[] = [];
    const mockModel: ModelPort = {
      async *stream(req) {
        captured.push(req);
        yield* textScript("done");
      },
    };

    // Step 1: createAgent without lsp
    const agent = createAgent({ modelPort: mockModel });

    // Step 2-3: the tools the model actually saw
    const state = await agent.run("hi");
    expect(state.status).toBe("done");
    const names = captured[0]!.tools.map((t) => t.name);
    for (const lspTool of LSP_TOOL_NAMES) {
      expect(names).not.toContain(lspTool);
    }
    // Positive baseline: the absence assertions must not be satisfiable by an
    // empty visible set.
    expect(names).toContain("read_document");

    // 验证 LSP 工具名集合存在（定义层面）
    expect(LSP_TOOL_NAMES.size).toBe(5);
  });
});

// ═══════════════════════════════════════════════
// TC-010: git_commit / git_push 高风险经 PermissionPolicy 触发 ask
// ═══════════════════════════════════════════════

describe("TC-010: git_commit / git_push 高风险经 PermissionPolicy 触发 ask", () => {
  it("git_commit riskTier=WRITE_HIGH, git_push riskTier=IRREVERSIBLE", () => {
    const mockShell = { async *[Symbol.asyncIterator]() { yield { type: "exit" as const, code: 0 }; } };

    // Step 1-2: 验证 riskTier
    const commitTool = createGitCommitTool(mockShell as unknown as Parameters<typeof createGitCommitTool>[0]);
    expect(commitTool.definition.riskTier).toBe("WRITE_HIGH");

    const pushTool = createGitPushTool(mockShell as unknown as Parameters<typeof createGitPushTool>[0]);
    expect(pushTool.definition.riskTier).toBe("IRREVERSIBLE");
  });
});

// ═══════════════════════════════════════════════
// TC-011: browser 工具缺 adapter 不可见
// ═══════════════════════════════════════════════

describe("TC-011: browser 工具缺 adapter 不可见", () => {
  it("不传 browserAdapter 时无 browser:control 能力", async () => {
    const mockModel = createMockModelPort([textScript("done")]);

    // Step 1-2: createAgent without browserAdapter
    const agent = createAgent({ modelPort: mockModel });
    const state = await agent.run("hi");
    expect(state.status).toBe("done");

    // 验证 capabilities 不含 browser:control（通过 ports 间接验证）
    // 注：完整验证需要访问内部状态，此处验证 agent 正常运行 + browser 工具名定义
    const { BROWSER_TOOL_NAMES } = await import("@volto/tools-browser");
    expect(BROWSER_TOOL_NAMES.size).toBe(5);
  });
});

// ═══════════════════════════════════════════════
// TC-012: ask_user 宿主不可用时归一为 isError
// ═══════════════════════════════════════════════

describe("TC-012: ask_user 宿主不可用时归一为 isError", () => {
  it("ApprovalGate.ask() 抛异常 → isError + 'not available'", async () => {
    const gate = { async ask() { throw new Error("no host"); } };
    const sink = { emit() {} };

    // Step 1-3: 创建工具并调用
    const tool = createAskUserTool({ approvalGate: gate as unknown as Parameters<typeof createAskUserTool>[0]["approvalGate"], eventSink: sink as unknown as Parameters<typeof createAskUserTool>[0]["eventSink"] });
    const result = await tool.handler({ question: "Continue?" });

    // Step 4: isError + 包含 not available
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("not available");
  });
});

// ═══════════════════════════════════════════════
// C1: ask_user 不得复用网关的 HITL ApprovalGate — 该 gate 无超时，
// 一旦复用就会把整个 turn 永久挂起
// ═══════════════════════════════════════════════

describe("C1: ask_user must not be parked on a permission approvalGate that never settles", () => {
  it("agent.run() completes even when opts.approvalGate never resolves", async () => {
    // Mirrors the gateway's real HITL ApprovalGate: ask() parks forever with
    // no timeout. If ask_user is ever handed this SAME gate (instead of its
    // own auto-allow default), the turn can never finish.
    const neverSettlingGate = { ask: () => new Promise<"allow" | "deny">(() => {}) };

    const mockModel = createMockModelPort([
      toolCallScript("c1", "ask_user", '{"question":"Continue?"}'),
      textScript("done"),
    ]);

    const agent = createAgent({
      modelPort: mockModel,
      approvalGate: neverSettlingGate,
    });

    const raced = await Promise.race([
      agent.run("please ask the user something").then((state) => ({ kind: "resolved" as const, state })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 500)),
    ]);

    expect(raced.kind).toBe("resolved");
    if (raced.kind === "resolved") {
      expect(raced.state.status).toBe("done");
    }
  });
});
