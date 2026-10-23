import { describe, it, expect } from "vitest";
import {
  estimateContextLayerTokens,
  estimateToolDefinitionTokens,
} from "../prompt-budget.js";
import { createFixedTokenizer } from "../testing/char-tokenizer.js";
import type { ToolDefinition } from "../tool.js";

describe("prompt-budget estimators", () => {
  it("prices every context layer once", () => {
    const tokenizer = createFixedTokenizer(1);
    const layers = [
      { id: "agents", text: "xx" },
      { id: "skills", text: "yyy" },
    ];
    expect(estimateContextLayerTokens(layers, tokenizer)).toBe(2);
  });

  it("prices only the model-visible tool fields", () => {
    const tokenizer = createFixedTokenizer(1);
    const tools: ToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object" },
        requires: [],
        riskTier: "READ_ONLY",
        pathInputs: ["path"],
      },
    ];
    expect(estimateToolDefinitionTokens(tools, tokenizer)).toBe(1);
    expect(estimateToolDefinitionTokens([], tokenizer)).toBe(0);
  });
});
