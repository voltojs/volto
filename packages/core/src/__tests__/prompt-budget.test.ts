import { describe, it, expect } from "vitest";
import {
  estimateContextLayerTokens,
  estimateFromAnchor,
  estimateToolDefinitionTokens,
} from "../prompt-budget.js";
import { estimateTokens } from "../compactor.js";
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

describe("estimateFromAnchor", () => {
  const tokenizer = createFixedTokenizer(10);
  const messages = [
    { id: "u1", role: "user" as const, content: "a" },
    { id: "a1", role: "assistant" as const, content: [{ type: "text" as const, text: "b" }] },
    { id: "t1", role: "tool" as const, content: [{ type: "tool_result" as const, toolUseId: "c1", content: [{ type: "text" as const, text: "c" }] }] },
  ];

  it("adds only messages after the anchor", () => {
    const anchor = { totalTokens: 100, messageIndex: 2, headerHash: "h", trusted: true };
    expect(estimateFromAnchor(anchor, messages, tokenizer)).toBe(
      100 + estimateTokens(messages.slice(2), tokenizer),
    );
  });

  it("returns undefined for untrusted or stale anchors", () => {
    expect(
      estimateFromAnchor(
        { totalTokens: 1, messageIndex: 0, headerHash: "h", trusted: false },
        messages,
        tokenizer,
      ),
    ).toBeUndefined();
    expect(
      estimateFromAnchor(
        { totalTokens: 1, messageIndex: 9, headerHash: "h", trusted: true },
        messages,
        tokenizer,
      ),
    ).toBeUndefined();
  });
});
