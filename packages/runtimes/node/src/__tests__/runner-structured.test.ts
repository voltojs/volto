/**
 * Runner structured-block text paths (T6 Task 2) — the three runner.ts
 * switch sites project a structured block's REQUIRED `text` field:
 *
 * 1. toolResultText feeds validators the structured projection.
 * 2. annotateUntrustedContent annotates the projection, leaving kind/data
 *    byte-identical (Review Focus 2).
 * 3. extractLastUserMessage (the default RAG query builder) reads the
 *    projection.
 *
 * All three functions are module-private and inline in the runner loop, so
 * the tests drive them through createRunner with a mock model — asserting
 * the real behavior at the real call sites.
 */

import { describe, it, expect } from "vitest";
import type {
  MemoryEntry,
  MemoryStore,
  PendingToolCall,
  StepContext,
  ToolDefinition,
  ToolResult,
  ToolResultBlock,
  ToolResultMessage,
  Validator,
  ValidationResult,
} from "@volto/core";
import { createMockModelPort, toolCallScript, textScript, UNTRUSTED_PREFIX } from "@volto/core";
import { createRunner, type ToolExecutor } from "../runner.js";

const STRUCT_DATA = { locations: [{ uri: "file:///a.ts", line: 3 }] };
const STRUCT_PROJECTION = "a.ts:3 definitions found";

function structured(text = STRUCT_PROJECTION): ToolResultBlock {
  return { type: "structured", kind: "lsp.locations", data: STRUCT_DATA, text };
}

const STRUCT_TOOL: ToolDefinition = {
  name: "lsp_probe",
  description: "Return structured locations",
  inputSchema: { type: "object", properties: {} },
  requires: [],
  riskTier: "READ_ONLY",
};

const ctx: StepContext = { tools: [STRUCT_TOOL], model: "test-model" };
const NO_CAPS = new Set<string>();

function executorReturning(content: ToolResultBlock[]): ToolExecutor {
  return async (_call: PendingToolCall): Promise<ToolResult> => ({ modelContent: content, isError: false });
}

function firstToolBlock(messages: unknown[]): ToolResultBlock | undefined {
  const msg = (messages as ToolResultMessage[]).find((m) => m.role === "tool");
  expect(msg).toBeDefined();
  return msg!.content[0]?.content[0];
}

describe("Runner structured-block text paths", () => {
  it("toolResultText: validator receives the structured text projection in the join", async () => {
    let seen: string | undefined;
    const validator: Validator = {
      name: "capture",
      validate(_toolName: string, resultContent: string): ValidationResult {
        seen = resultContent;
        return { passed: true, failures: [], validatorName: "capture" };
      },
    };
    const model = createMockModelPort([
      toolCallScript("c1", "lsp_probe", "{}"),
      textScript("done"),
    ]);
    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: NO_CAPS,
      toolExecutor: executorReturning([{ type: "text", text: "head" }, structured()]),
      validators: [validator],
      selfCorrectionMax: 0,
    });
    const final = await runner.run({ type: "user_message", content: "go" });
    expect(final.status).toBe("done");
    expect(seen).toBe(`head\n${STRUCT_PROJECTION}`);
  });

  it("annotateUntrustedContent: annotation wraps structured.text, kind/data byte-identical", async () => {
    const untrustedTool: ToolDefinition = { ...STRUCT_TOOL, trust: "untrusted" };
    const model = createMockModelPort([
      toolCallScript("c2", "lsp_probe", "{}"),
      textScript("done"),
    ]);
    const runner = createRunner({
      modelPort: model,
      stepContext: { ...ctx, tools: [untrustedTool] },
      availableCapabilities: NO_CAPS,
      toolExecutor: executorReturning([structured()]),
    });
    const final = await runner.run({ type: "user_message", content: "go" });
    expect(final.status).toBe("done");
    const block = firstToolBlock(final.messages);
    expect(block).toBeDefined();
    expect(block!.type).toBe("structured");
    const annotated = block as Extract<ToolResultBlock, { type: "structured" }>;
    expect(annotated.text).toBe(`${UNTRUSTED_PREFIX}${STRUCT_PROJECTION}`);
    expect(annotated.kind).toBe("lsp.locations");
    expect(annotated.data).toEqual(STRUCT_DATA);
    // Only `text` was rewritten — no other field rode along.
    expect(Object.keys(annotated).sort()).toEqual(["data", "kind", "text", "type"]);
  });

  it("extractLastUserMessage: default RAG query includes the structured projection", async () => {
    const queries: string[] = [];
    const store: MemoryStore = {
      async save(): Promise<string> { return "ok"; },
      async query(text: string, _k?: number): Promise<MemoryEntry[]> {
        queries.push(text);
        return [];
      },
      async delete(): Promise<boolean> { return true; },
    };
    const model = createMockModelPort([textScript("done")]);
    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: NO_CAPS,
      toolExecutor: executorReturning([]),
      rag: { memoryStore: store, topK: 2 },
    });
    const final = await runner.run({
      type: "user_message",
      content: [{ type: "text", text: "where is foo" }, structured()],
    });
    expect(final.status).toBe("done");
    expect(queries).toEqual([`where is foo ${STRUCT_PROJECTION}`]);
  });
});
