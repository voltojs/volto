import { describe, it, expect } from "vitest";
import {
  decideCompaction,
  estimateTokens,
  extractFilePaths,
  hasIncompleteTodos,
  isToolInteraction,
  isKeyMessage,
} from "../compactor.js";
import { createCharTokenizer, createFixedTokenizer } from "../testing/char-tokenizer.js";
import type { Message } from "../state.js";

function sysMsg(content: string): Message {
  return { role: "system", content };
}

function userMsg(content: string): Message {
  return { role: "user", content };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolUseMsg(name: string, id: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

function toolResultMsg(id: string, content: string): Message {
  return {
    role: "tool",
    content: [{ type: "tool_result", toolUseId: id, content }],
  };
}

describe("extractFilePaths", () => {
  it("extracts absolute paths", () => {
    const msg = userMsg("Read /Users/foo/bar.ts and /tmp/test.txt");
    const paths = extractFilePaths(msg);
    expect(paths).toContain("/Users/foo/bar.ts");
    expect(paths).toContain("/tmp/test.txt");
  });

  it("extracts relative paths", () => {
    const msg = userMsg("Edit ./src/index.ts");
    const paths = extractFilePaths(msg);
    expect(paths).toContain("./src/index.ts");
  });

  it("returns empty array when no paths", () => {
    const msg = userMsg("Hello world");
    expect(extractFilePaths(msg)).toEqual([]);
  });

  it("extracts paths wrapped in punctuation like (/a/b.ts)", () => {
    const msg = userMsg("See the config (/important/config.ts) and [/tmp/x.log]");
    const paths = extractFilePaths(msg);
    expect(paths).toContain("/important/config.ts");
    expect(paths).toContain("/tmp/x.log");
  });
});

describe("isKeyMessage", () => {
  it("is true when the message carries a file path", () => {
    expect(isKeyMessage(userMsg("edit ./src/index.ts"))).toBe(true);
  });

  it("is true when the message carries an incomplete todo", () => {
    expect(isKeyMessage(assistantMsg("- [ ] not done"))).toBe(true);
  });

  it("is false for a plain message", () => {
    expect(isKeyMessage(userMsg("just chatting"))).toBe(false);
  });
});

describe("hasIncompleteTodos", () => {
  it("detects checkbox style todos", () => {
    const msg = userMsg("Tasks:\n- [ ] Fix the bug\n- [x] Write tests");
    expect(hasIncompleteTodos(msg)).toBe(true);
  });

  it("detects TODO: markers", () => {
    const msg = assistantMsg("TODO: implement auth");
    expect(hasIncompleteTodos(msg)).toBe(true);
  });

  it("detects FIXME: markers", () => {
    const msg = assistantMsg("FIXME: memory leak in handler");
    expect(hasIncompleteTodos(msg)).toBe(true);
  });

  it("returns false when all tasks complete", () => {
    const msg = userMsg("- [x] Done\n- [x] Also done");
    expect(hasIncompleteTodos(msg)).toBe(false);
  });

  it("returns false for regular messages", () => {
    const msg = userMsg("Hello, how are you?");
    expect(hasIncompleteTodos(msg)).toBe(false);
  });
});

describe("isToolInteraction", () => {
  it("identifies assistant messages with tool_use", () => {
    const msg = toolUseMsg("read_file", "t1");
    expect(isToolInteraction(msg)).toBe(true);
  });

  it("identifies tool result messages", () => {
    const msg = toolResultMsg("t1", "content");
    expect(isToolInteraction(msg)).toBe(true);
  });

  it("returns false for text-only assistant messages", () => {
    const msg = assistantMsg("Here is the result");
    expect(isToolInteraction(msg)).toBe(false);
  });

  it("returns false for user messages", () => {
    const msg = userMsg("Hello");
    expect(isToolInteraction(msg)).toBe(false);
  });
});

describe("estimateTokens", () => {
  it("estimates tokens across multiple messages", () => {
    const tokenizer = createCharTokenizer(4);
    const messages: Message[] = [
      userMsg("Hello"),         // 5 chars / 4 = 2 tokens + 4 overhead = 6
      assistantMsg("Hi there"), // 8 chars / 4 = 2 tokens + 4 overhead = 6
    ];
    const total = estimateTokens(messages, tokenizer);
    expect(total).toBe(12);
  });

  it("handles empty messages", () => {
    const tokenizer = createCharTokenizer(4);
    expect(estimateTokens([], tokenizer)).toBe(0);
  });
});

describe("decideCompaction", () => {
  it("does not compact when under threshold", () => {
    const tokenizer = createCharTokenizer(4);
    const messages: Message[] = [
      sysMsg("System"),
      userMsg("Hello"),
      assistantMsg("Hi!"),
    ];

    const decision = decideCompaction(messages, {
      maxTokens: 1000,
      recentKeepCount: 2,
      tokenizer,
    });

    expect(decision.shouldCompact).toBe(false);
    expect(decision.preservedMessages).toHaveLength(3);
    expect(decision.compressibleMessages).toHaveLength(0);
  });

  it("compacts when over threshold", () => {
    // Create enough messages to exceed a low threshold
    const tokenizer = createFixedTokenizer(100); // each message = 100 + 4 = 104 tokens
    const messages: Message[] = [
      sysMsg("System prompt"),
      userMsg("Message 1"),
      assistantMsg("Response 1"),
      toolUseMsg("read_file", "t1"),
      toolResultMsg("t1", "result 1"),
      userMsg("Message 2"),
      assistantMsg("Response 2"),
      userMsg("Message 3"),
      assistantMsg("Response 3"),
    ];

    // 9 messages * 104 tokens = 936 tokens; threshold = 500
    const decision = decideCompaction(messages, {
      maxTokens: 500,
      recentKeepCount: 2,
      tokenizer,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.compressedIndices).toBeDefined();
    expect(decision.compressedIndices!.length).toBeGreaterThan(0);
    expect(Math.max(...decision.compressedIndices!)).toBeLessThan(messages.length);
    expect(decision.compressibleMessages.length).toBeGreaterThan(0);
    expect(decision.preservedMessages.length).toBeGreaterThan(0);
    expect(decision.summaryPrompt).toBeDefined();
  });

  it("always preserves system message and recent messages", () => {
    const tokenizer = createFixedTokenizer(100);
    const messages: Message[] = [
      sysMsg("System"),
      userMsg("Msg 1"),
      assistantMsg("Resp 1"),
      userMsg("Msg 2"),
      assistantMsg("Resp 2"),
      userMsg("Msg 3"),
      assistantMsg("Resp 3"),
    ];

    const decision = decideCompaction(messages, {
      maxTokens: 500,
      recentKeepCount: 2,
      tokenizer,
    });

    if (decision.shouldCompact) {
      // System message should always be preserved
      expect(decision.preservedMessages.some((m) => m.role === "system")).toBe(true);

      // Last 2 messages should be preserved
      const lastPreserved = decision.preservedMessages.slice(-2);
      expect(lastPreserved).toHaveLength(2);
    }
  });

  it("AC1: keeps a non-recent message carrying a file path OUT of compression", () => {
    const tokenizer = createFixedTokenizer(100);
    // The path-bearing message sits early (non-recent) so recency alone would
    // not save it; only the key-message guard can.
    const keyMsg = userMsg("Remember to update /important/config.ts later");
    const messages: Message[] = [
      sysMsg("System"),
      keyMsg,                          // index 1 — non-recent, carries a path
      assistantMsg("ok"),
      toolUseMsg("read_file", "t1"),
      toolResultMsg("t1", "stuff"),
      userMsg("recent 1"),
      assistantMsg("recent 2"),
    ];

    const decision = decideCompaction(messages, {
      maxTokens: 300,
      recentKeepCount: 2,
      tokenizer,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.preservedMessages).toContainEqual(keyMsg);
    expect(decision.compressibleMessages).not.toContainEqual(keyMsg);
  });

  it("AC1: keeps a non-recent message carrying an incomplete todo OUT of compression", () => {
    const tokenizer = createFixedTokenizer(100);
    const todoMsg = assistantMsg("Plan:\n- [ ] wire the gate\n- [x] done part");
    const messages: Message[] = [
      sysMsg("System"),
      todoMsg,                         // index 1 — non-recent, has incomplete todo
      assistantMsg("filler"),
      toolUseMsg("read_file", "t1"),
      toolResultMsg("t1", "stuff"),
      userMsg("recent 1"),
      assistantMsg("recent 2"),
    ];

    const decision = decideCompaction(messages, {
      maxTokens: 300,
      recentKeepCount: 2,
      tokenizer,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.preservedMessages).toContainEqual(todoMsg);
    expect(decision.compressibleMessages).not.toContainEqual(todoMsg);
  });

  it("preserves file paths in summary prompt", () => {
    const tokenizer = createFixedTokenizer(100);
    const messages: Message[] = [
      sysMsg("System"),
      userMsg("Read /important/config.ts"),
      assistantMsg("I'll read the file"),
      toolUseMsg("read_file", "t1"),
      toolResultMsg("t1", "config contents"),
      userMsg("Now edit /important/config.ts"),
      assistantMsg("Done"),
    ];

    const decision = decideCompaction(messages, {
      maxTokens: 500,
      recentKeepCount: 2,
      tokenizer,
    });

    if (decision.shouldCompact && decision.summaryPrompt) {
      // Summary prompt should mention preserving file paths
      expect(decision.summaryPrompt).toContain("file paths");
    }
  });

  it("is deterministic for same input", () => {
    const tokenizer = createFixedTokenizer(100);
    const messages: Message[] = [
      sysMsg("System"),
      userMsg("Msg 1"),
      assistantMsg("Resp 1"),
      userMsg("Msg 2"),
      assistantMsg("Resp 2"),
    ];

    const d1 = decideCompaction(messages, { maxTokens: 500, recentKeepCount: 2, tokenizer });
    const d2 = decideCompaction(messages, { maxTokens: 500, recentKeepCount: 2, tokenizer });

    expect(d1.shouldCompact).toBe(d2.shouldCompact);
    expect(d1.preservedMessages).toEqual(d2.preservedMessages);
    expect(d1.compressibleMessages).toEqual(d2.compressibleMessages);
  });

  it("does not compact when recentKeepCount >= otherMessages.length", () => {
    const tokenizer = createFixedTokenizer(100);
    const messages: Message[] = [
      sysMsg("System"),
      userMsg("Msg 1"),
      assistantMsg("Resp 1"),
    ];

    // keepCount (5) >= otherMessages.length (2) → compressible is empty
    const decision = decideCompaction(messages, {
      maxTokens: 500,
      recentKeepCount: 5,
      tokenizer,
    });

    expect(decision.shouldCompact).toBe(false);
    expect(decision.compressibleMessages).toHaveLength(0);
  });

  it("handles empty content array in message", () => {
    const tokenizer = createFixedTokenizer(100);
    const emptyContentMsg: Message = {
      role: "assistant",
      content: [],
    };
    const messages: Message[] = [emptyContentMsg];

    // Should not throw — empty content extracts as ""
    const tokens = estimateTokens(messages, tokenizer);
    expect(tokens).toBeGreaterThan(0); // overhead still counts
  });
});

describe("extractFilePaths edge cases", () => {
  it("handles message with no paths", () => {
    const msg = userMsg("Just a regular message");
    expect(extractFilePaths(msg)).toEqual([]);
  });

  it("deduplicates paths", () => {
    const msg = userMsg("Edit /foo/bar.ts then read /foo/bar.ts again");
    const paths = extractFilePaths(msg);
    const unique = [...new Set(paths)];
    expect(paths).toEqual(unique);
  });
});

describe("hasIncompleteTodos edge cases", () => {
  it("returns false for empty content", () => {
    const msg: Message = { role: "assistant", content: [] };
    expect(hasIncompleteTodos(msg)).toBe(false);
  });
});

describe("decideCompaction — empty compressible boundary (T-10)", () => {
  it("does not crash when all non-recent messages are key messages", () => {
    const tokenizer = createFixedTokenizer(100);
    // Every non-recent message carries a file path → all are key messages →
    // compressible set is empty even though we are over the token budget.
    const messages: Message[] = [
      sysMsg("system"),
      userMsg("Read /a/one.ts"),
      userMsg("Read /a/two.ts"),
      userMsg("Read /a/three.ts"),
      userMsg("recent tail 1"),
      userMsg("recent tail 2"),
    ];

    let decision!: ReturnType<typeof decideCompaction>;
    expect(() => {
      decision = decideCompaction(messages, {
        maxTokens: 10,
        recentKeepCount: 2,
        tokenizer,
      });
    }).not.toThrow();

    // Over budget → shouldCompact true, but nothing is compressible.
    expect(decision.shouldCompact).toBe(true);
    expect(decision.compressibleMessages).toHaveLength(0);
    // Key messages are retained in preservedMessages.
    expect(decision.preservedMessages.some((m) => isKeyMessage(m))).toBe(true);
    // summaryPrompt is still well-formed (built over an empty segment).
    expect(typeof decision.summaryPrompt).toBe("string");
    expect(decision.summaryPrompt).toContain("Summarize");
  });

  describe("pinnedMessageIds", () => {
    it("should not compress pinned messages even when over budget", () => {
      const tokenizer = createFixedTokenizer(10);
      // 6 non-system messages × 10 tokens = 60, budget = 30 → over budget
      // Keep last 2, so indices 0-3 are eligible. Pin index 1.
      const messages: Message[] = [
        sysMsg("system"),
        userMsg("msg-0"),  // index 1 — eligible, NOT pinned
        userMsg("msg-1"),  // index 2 — eligible, PINNED
        userMsg("msg-2"),  // index 3 — eligible, NOT pinned
        userMsg("msg-3"),  // index 4 — recent keep
        userMsg("msg-4"),  // index 5 — recent keep
      ];

      const decision = decideCompaction(messages, {
        maxTokens: 30,
        recentKeepCount: 2,
        tokenizer,
        pinnedMessageIds: ["2"],
      });

      expect(decision.shouldCompact).toBe(true);
      // msg-1 (index 2) is pinned → not in compressible
      const compressibleTexts = decision.compressibleMessages.map((m) =>
        (m as Message & { content: string }).content,
      );
      expect(compressibleTexts).not.toContain("msg-1");
    });
  });
});
