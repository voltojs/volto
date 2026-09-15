import { describe, it, expect } from "vitest";
import {
  assembleContext,
  buildToolPrompt,
  computeStaticPrefixTokens,
} from "../context-assembler.js";
import { createCharTokenizer } from "../testing/char-tokenizer.js";
import type { Message } from "../state.js";
import type { ToolDefinition } from "../tool.js";

const sampleTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file's contents",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
  {
    name: "edit_file",
    description: "Edit a file using str_replace",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:write"],
    riskTier: "WRITE_LOW",
  },
];

const sampleMessages: Message[] = [
  { id: "m1", role: "system", content: "You are a helpful assistant." },
  { id: "m2", role: "user", content: "Read the file" },
  { id: "m3", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "/a.ts" } }] },
  { id: "m4", role: "tool", content: [{ type: "tool_result", toolUseId: "t1", content: "file contents" }] },
  { id: "m5", role: "assistant", content: [{ type: "text", text: "Here is the file." }] },
  { id: "m6", role: "user", content: "Now edit it" },
];

describe("assembleContext", () => {
  it("puts system messages first, preserves chronological order of others", () => {
    const result = assembleContext({ messages: sampleMessages, tools: [] });

    expect(result.messages[0]!.role).toBe("system");
    expect(result.staticPrefixLength).toBe(1);

    // Non-system messages should be in original order
    const nonSystem = result.messages.slice(result.staticPrefixLength);
    expect(nonSystem.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
  });

  it("handles messages with no system message", () => {
    const messages: Message[] = [
      { id: "m7", role: "user", content: "Hello" },
      { id: "m8", role: "assistant", content: [{ type: "text", text: "Hi!" }] },
    ];
    const result = assembleContext({ messages, tools: [] });

    expect(result.staticPrefixLength).toBe(0);
    expect(result.messages).toHaveLength(2);
  });

  it("handles multiple system messages", () => {
    const messages: Message[] = [
      { id: "m9", role: "system", content: "Base instructions" },
      { id: "m10", role: "system", content: "Additional instructions" },
      { id: "m11", role: "user", content: "Hello" },
    ];
    const result = assembleContext({ messages, tools: [] });

    expect(result.staticPrefixLength).toBe(2);
    expect(result.messages[0]!.role).toBe("system");
    expect(result.messages[1]!.role).toBe("system");
    expect(result.messages[2]!.role).toBe("user");
  });

  it("moves system messages after non-system to the front", () => {
    const messages: Message[] = [
      { id: "m12", role: "user", content: "Hello" },
      { id: "m13", role: "system", content: "Late system" },
      { id: "m14", role: "assistant", content: [{ type: "text", text: "Hi!" }] },
    ];
    const result = assembleContext({ messages, tools: [] });

    expect(result.staticPrefixLength).toBe(1);
    expect(result.messages[0]!.role).toBe("system");
    expect(result.messages[1]!.role).toBe("user");
    expect(result.messages[2]!.role).toBe("assistant");
  });

  it("returns identical output for identical input (deterministic)", () => {
    const r1 = assembleContext({ messages: sampleMessages, tools: sampleTools });
    const r2 = assembleContext({ messages: sampleMessages, tools: sampleTools });

    expect(r1.messages).toEqual(r2.messages);
    expect(r1.staticPrefixLength).toBe(r2.staticPrefixLength);
  });
});

describe("buildToolPrompt", () => {
  it("sorts tools by name for stable output", () => {
    const prompt = buildToolPrompt(sampleTools);

    const editIdx = prompt.indexOf("## edit_file");
    const readIdx = prompt.indexOf("## read_file");
    expect(editIdx).toBeLessThan(readIdx);
  });

  it("includes tool descriptions and schemas", () => {
    const prompt = buildToolPrompt(sampleTools);

    expect(prompt).toContain("Read a file's contents");
    expect(prompt).toContain("Edit a file using str_replace");
    expect(prompt).toContain('"path"');
  });

  it("includes requires when non-empty", () => {
    const prompt = buildToolPrompt(sampleTools);
    expect(prompt).toContain("Requires: filesystem:read");
    expect(prompt).toContain("Requires: filesystem:write");
  });

  it("prepends additional prompt when provided", () => {
    const prompt = buildToolPrompt(sampleTools, "Custom system prompt");

    expect(prompt.startsWith("Custom system prompt")).toBe(true);
    expect(prompt).toContain("# Available Tools");
  });

  it("returns empty string for empty tools and no additional prompt", () => {
    expect(buildToolPrompt([], undefined)).toBe("");
  });

  it("returns stable output across calls (cache-friendly)", () => {
    const p1 = buildToolPrompt(sampleTools);
    const p2 = buildToolPrompt(sampleTools);
    expect(p1).toBe(p2);
  });

  it("AC2: identical tool set → identical bytes; changed tool set → different bytes", () => {
    // Same set in a different declaration order must still be byte-identical
    // (sort-by-name makes the prefix order-insensitive → cacheable).
    const reordered = [...sampleTools].reverse();
    expect(buildToolPrompt(reordered)).toBe(buildToolPrompt(sampleTools));

    // Dropping a tool MUST change the prefix bytes (cache correctly invalidates).
    const subset = [sampleTools[0]!];
    expect(buildToolPrompt(subset)).not.toBe(buildToolPrompt(sampleTools));
  });
});

describe("computeStaticPrefixTokens", () => {
  it("counts tokens only in system messages", () => {
    const tokenizer = createCharTokenizer(4);
    const tokens = computeStaticPrefixTokens(sampleMessages, tokenizer);

    // System message: "You are a helpful assistant." = 28 chars / 4 = 7 tokens
    expect(tokens).toBe(7);
  });

  it("returns 0 when no system messages", () => {
    const tokenizer = createCharTokenizer(4);
    const messages: Message[] = [
      { id: "m15", role: "user", content: "Hello" },
      { id: "m16", role: "assistant", content: [{ type: "text", text: "Hi!" }] },
    ];
    expect(computeStaticPrefixTokens(messages, tokenizer)).toBe(0);
  });
});

describe("pinned messages in assembleContext", () => {
  it("should place pinned messages in the prefix slot after system messages", () => {
    const messages: Message[] = [
      { id: "m17", role: "system", content: "System prompt" },
      { id: "m18", role: "user", content: "msg-0" },      // index 1 — not pinned
      { id: "m19", role: "user", content: "pinned-msg" },  // index 2 — pinned
      { id: "m20", role: "user", content: "msg-3" },       // index 3 — not pinned
    ];

    const result = assembleContext({
      messages,
      tools: [],
      pinnedMessageIds: ["2"],
    });

    // Order: system, pinned, then remaining non-system in original order
    const roles = result.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "user", "user"]);

    // The pinned message is second (after system)
    const contents = result.messages.map((m) => (m as { content: string }).content);
    expect(contents[1]).toBe("pinned-msg");

    // staticPrefixLength includes system + pinned
    expect(result.staticPrefixLength).toBe(2);
  });

  it("should not affect prefix when no pinned messages", () => {
    const messages: Message[] = [
      { id: "m21", role: "system", content: "System" },
      { id: "m22", role: "user", content: "Hello" },
    ];

    const result = assembleContext({ messages, tools: [] });
    expect(result.staticPrefixLength).toBe(1);
  });
});

describe("contextLayers in assembleContext", () => {
  it("places each layer as its own system message after existing system messages", () => {
    const messages: Message[] = [
      { id: "m23", role: "system", content: "Base prompt" },
      { id: "m24", role: "user", content: "Hello" },
    ];
    const result = assembleContext({
      messages,
      tools: [],
      contextLayers: [
        { id: "user-memory", text: "User instructions" },
        { id: "project-memory", text: "Project instructions" },
      ],
    });

    expect(result.messages.map((m) => m.role)).toEqual(["system", "system", "system", "user"]);
    expect(result.messages[1]).toEqual({ id: "layer-user-memory", role: "system", content: "User instructions" });
    expect(result.messages[2]).toEqual({ id: "layer-project-memory", role: "system", content: "Project instructions" });
    expect(result.staticPrefixLength).toBe(3);
  });

  it("does not merge two layers into one message", () => {
    const messages: Message[] = [{ id: "m27", role: "user", content: "Hi" }];
    const result = assembleContext({
      messages,
      tools: [],
      contextLayers: [
        { id: "user-memory", text: "A" },
        { id: "project-memory", text: "B" },
      ],
    });

    const systemMessages = result.messages.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(2);
    expect(systemMessages.map((m) => (m as { content: string }).content)).toEqual(["A", "B"]);
  });

  it("reports layerOrigins mapping each layer id to its message index", () => {
    const messages: Message[] = [
      { id: "m28", role: "system", content: "Base" },
      { id: "m29", role: "user", content: "Hi" },
    ];
    const result = assembleContext({
      messages,
      tools: [],
      contextLayers: [
        { id: "user-memory", text: "A" },
        { id: "skill:debugging", text: "B" },
      ],
    });

    expect(result.layerOrigins).toEqual([
      { id: "user-memory", messageIndex: 1 },
      { id: "skill:debugging", messageIndex: 2 },
    ]);
  });

  it("places contextLayers before pinned messages", () => {
    const messages: Message[] = [
      { id: "m30", role: "system", content: "Base" },
      { id: "m31", role: "user", content: "msg-0" },
      { id: "m32", role: "user", content: "pinned-msg" },
    ];
    const result = assembleContext({
      messages,
      tools: [],
      pinnedMessageIds: ["2"],
      contextLayers: [{ id: "user-memory", text: "A" }],
    });

    const contents = result.messages.map((m) => (m as { content: string }).content);
    expect(contents).toEqual(["Base", "A", "pinned-msg", "msg-0"]);
    expect(result.staticPrefixLength).toBe(3);
  });

  it("defaults to an empty layerOrigins array and unchanged output when contextLayers is omitted", () => {
    const messages: Message[] = [{ id: "m33", role: "user", content: "Hi" }];
    const result = assembleContext({ messages, tools: [] });

    expect(result.layerOrigins).toEqual([]);
    expect(result.messages).toEqual(messages);
  });
});
