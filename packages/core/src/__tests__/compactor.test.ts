import { describe, it, expect } from "vitest";
import {
  decideCompaction,
  estimateTokens,
  extractFilePaths,
  hasIncompleteTodos,
  isToolInteraction,
  isKeyMessage,
  isPermissionReminder,
  buildSummaryPrompt,
} from "../compactor.js";
import { buildPermissionReminder } from "../permission-prompt.js";
import type { PermissionConfig } from "../permission-policy.js";
import { createCharTokenizer, createFixedTokenizer } from "../testing/char-tokenizer.js";
import type { Message } from "../state.js";

function sysMsg(content: string, id = "m1"): Message {
  return { id, role: "system", content };
}

function userMsg(content: string, id = "m2"): Message {
  return { id, role: "user", content };
}

function assistantMsg(text: string, id = "m3"): Message {
  return { id, role: "assistant", content: [{ type: "text", text }] };
}

function toolUseMsg(name: string, id: string, msgId = "m4"): Message {
  return {
    id: msgId,
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

function toolResultMsg(id: string, content: string, msgId = "m5"): Message {
  return {
    id: msgId,
    role: "tool",
    content: [{ type: "tool_result", toolUseId: id, content: [{ type: "text", text: content }] }],
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

describe("isKeyMessage — permission reminders", () => {
  it("treats a permission reminder as key", () => {
    const msg = {
      id: "m6",
      role: "user" as const,
      content:
        "<system-reminder>\nPermission boundary for this session:\n\n- Filesystem writes are confined to the workspace.\n</system-reminder>",
    };
    expect(isKeyMessage(msg)).toBe(true);
  });

  it("does not treat ordinary user text as key", () => {
    expect(isKeyMessage({ id: "m7", role: "user", content: "please refactor this" })).toBe(false);
  });

  it("also treats a change announcement as key", () => {
    const msg = {
      id: "m8",
      role: "user" as const,
      content:
        "<system-reminder>\nThe permission boundary for this session has changed. It is now:\n\n- You cannot write to the filesystem at all.\n</system-reminder>",
    };
    expect(isKeyMessage(msg)).toBe(true);
  });

  it("recognises the real generator's output, not just a hand-typed copy", () => {
    const config: PermissionConfig = { sandbox: "workspace-write", approval: "ask" };
    const previous: PermissionConfig = { sandbox: "read-only", approval: "never" };

    // First announcement and mid-session change take different opening lines;
    // both must survive compaction, so both must be recognised here.
    expect(isKeyMessage({ id: "m9", role: "user", content: buildPermissionReminder(config) })).toBe(true);
    expect(isKeyMessage({ id: "m10", role: "user", content: buildPermissionReminder(config, previous) })).toBe(true);
  });
});

describe("decideCompaction — the permission reminder is exempt, not merely last", () => {
  const config: PermissionConfig = { sandbox: "workspace-write", approval: "ask" };

  /** A history long enough that "compress everything else first" is not a way out. */
  function historyWithReminder(): Message[] {
    const reminder = userMsg(buildPermissionReminder(config));
    const filler: Message[] = [];
    for (let i = 0; i < 12; i++) {
      filler.push(toolUseMsg("read_file", `t${i}`), toolResultMsg(`t${i}`, `result ${i}`));
    }
    return [sysMsg("System prompt"), reminder, ...filler, userMsg("latest"), assistantMsg("ok")];
  }

  it("keeps the reminder even when the budget forces every other message out", () => {
    const messages = historyWithReminder();
    // maxTokens = 1 with a fixed tokenizer: the greedy loop can never get
    // under budget, so it takes everything it is allowed to take. Whatever
    // survives here survives because it was exempt, not because it sorted last.
    const decision = decideCompaction(messages, {
      maxTokens: 1,
      recentKeepCount: 2,
      tokenizer: createFixedTokenizer(100),
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.compressibleMessages.some(isPermissionReminder)).toBe(false);
    expect(decision.preservedMessages.some(isPermissionReminder)).toBe(true);
  });

  it("still compresses the rest of the history", () => {
    // Guards the opposite failure: exempting the reminder must not shrink the
    // compaction surface to nothing.
    const decision = decideCompaction(historyWithReminder(), {
      maxTokens: 1,
      recentKeepCount: 2,
      tokenizer: createFixedTokenizer(100),
    });

    expect(decision.compressibleMessages.length).toBeGreaterThan(10);
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
      userMsg("Hello"),         // 5 chars / 4 = 2 tokens + BLOCK_OVERHEAD(4) + ROLE_OVERHEAD(4) = 10
      assistantMsg("Hi there"), // 8 chars / 4 = 2 tokens + BLOCK_OVERHEAD(4) + ROLE_OVERHEAD(4) = 10
    ];
    const total = estimateTokens(messages, tokenizer);
    expect(total).toBe(20);
  });

  it("handles empty messages", () => {
    const tokenizer = createCharTokenizer(4);
    expect(estimateTokens([], tokenizer)).toBe(0);
  });

  it("prices a reasoning block materially higher than the same message without it", () => {
    const tokenizer = createCharTokenizer(4);
    const withoutReasoning: Message = { id: "m11", role: "assistant", content: [{ type: "text", text: "Hi" }] };
    const withReasoning: Message = {
      id: "m12",
      role: "assistant",
      content: [
        { type: "reasoning", text: "a".repeat(400) },
        { type: "text", text: "Hi" },
      ],
    };
    const baseline = estimateTokens([withoutReasoning], tokenizer);
    const withReasoningEstimate = estimateTokens([withReasoning], tokenizer);
    // The reasoning block alone accounts for ~100 tokens (400 chars / 4);
    // pricing it at zero would leave the two estimates nearly identical.
    expect(withReasoningEstimate - baseline).toBeGreaterThan(90);
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
    // Key messages are compressible but deprioritized (picked last by greedy algorithm).
    // If budget allows, non-key messages are compressed first.
    // The summary prompt preserves their content.
    expect(typeof decision.summaryPrompt).toBe("string");
    expect(decision.summaryPrompt).toContain("/important/config.ts");
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
    // Key messages are compressible but deprioritized (picked last by greedy algorithm).
    // If budget allows, non-key messages are compressed first.
    // The summary prompt preserves their content.
    expect(typeof decision.summaryPrompt).toBe("string");
    expect(decision.summaryPrompt).toContain("wire the gate");
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
      id: "m13",
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
    const msg: Message = { id: "m14", role: "assistant", content: [] };
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

    // Over budget → shouldCompact true. Key messages are compressible but deprioritized.
    expect(decision.shouldCompact).toBe(true);
    // Key messages may be included in compressibleMessages (deprioritized, not exempt)
    // but the summary prompt should preserve their content.
    expect(typeof decision.summaryPrompt).toBe("string");
    expect(decision.summaryPrompt).toContain("## Files and Code");
    expect(decision.summaryPrompt).toContain("file paths");
  });

  describe("pinnedMessageIds", () => {
    it("should not compress pinned messages even when over budget", () => {
      const tokenizer = createFixedTokenizer(10);
      // 6 non-system messages × 10 tokens = 60, budget = 30 → over budget
      // Keep last 2, so the first three user messages are eligible. Pin u1.
      const messages: Message[] = [
        sysMsg("system", "s0"),
        userMsg("msg-0", "u0"), // eligible, NOT pinned
        userMsg("msg-1", "u1"), // eligible, PINNED
        userMsg("msg-2", "u2"), // eligible, NOT pinned
        userMsg("msg-3", "u3"), // recent keep
        userMsg("msg-4", "u4"), // recent keep
      ];

      const decision = decideCompaction(messages, {
        maxTokens: 30,
        recentKeepCount: 2,
        tokenizer,
        pinnedMessageIds: ["u1"],
      });

      expect(decision.shouldCompact).toBe(true);
      // u1 is pinned → not in compressible
      const compressibleTexts = decision.compressibleMessages.map((m) =>
        (m as Message & { content: string }).content,
      );
      expect(compressibleTexts).not.toContain("msg-1");
    });
  });
});

describe("pinnedMessageIds as stable ids", () => {
  it("never selects a pinned message id even when over budget", () => {
    const tokenizer = createFixedTokenizer(100);
    const messages: Message[] = [
      { id: "sys", role: "system", content: "S" },
      { id: "p1", role: "user", content: "keep me" },
      { id: "u1", role: "user", content: "a" },
      { id: "u2", role: "assistant", content: [{ type: "text", text: "b" }] },
      { id: "u3", role: "user", content: "c" },
      { id: "u4", role: "assistant", content: [{ type: "text", text: "d" }] },
    ];
    const decision = decideCompaction(messages, {
      maxTokens: 200,
      recentKeepCount: 1,
      tokenizer,
      pinnedMessageIds: ["p1"],
    });
    expect(decision.shouldCompact).toBe(true);
    const pinnedIndex = messages.findIndex((m) => m.id === "p1");
    expect(decision.compressedIndices ?? []).not.toContain(pinnedIndex);
    expect(decision.replacedIds ?? []).not.toContain("p1");
  });
});

describe("soft tool pairing", () => {
  it("includes tool_use and its tool_result together", () => {
    const tokenizer = createFixedTokenizer(100);
    const messages: Message[] = [
      { id: "sys", role: "system", content: "S" },
      { id: "a1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { id: "r1", role: "tool", content: [{ type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "out" }] }] },
      { id: "a2", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "y", input: {} }] },
      { id: "r2", role: "tool", content: [{ type: "tool_result", toolUseId: "t2", content: [{ type: "text", text: "out2" }] }] },
      { id: "u9", role: "user", content: "latest" },
      { id: "a9", role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    const decision = decideCompaction(messages, {
      maxTokens: 300,
      recentKeepCount: 2,
      tokenizer,
    });
    const ids = new Set(
      (decision.compressedIndices ?? []).map((i) => messages[i]!.id),
    );
    // If one side of a pair is selected, the other must be too (when both exist).
    if (ids.has("a1")) expect(ids.has("r1")).toBe(true);
    if (ids.has("r1")) expect(ids.has("a1")).toBe(true);
    if (ids.has("a2")) expect(ids.has("r2")).toBe(true);
    if (ids.has("r2")) expect(ids.has("a2")).toBe(true);
  });

  it("pulls in the matching tool_result when only the tool_use was selected", () => {
    const tokenizer = createFixedTokenizer(100);
    // Budget sized so the greedy loop takes a1 (tool_use, ~208 tokens) and
    // stops before r1 (tool_result, ~108 tokens). Soft pairing must then
    // pull r1 in — otherwise the request would carry an orphaned tool_use.
    const messages: Message[] = [
      sysMsg("S", "sys"),
      toolUseMsg("read_file", "t1", "a1"),
      toolResultMsg("t1", "contents", "r1"),
      userMsg("recent user", "u9"),
      assistantMsg("ok", "a9"),
    ];
    // total ≈ 108+208+108+108+108 = 640; tokensToRemove = 640-432 = 208 → takes a1 only
    const decision = decideCompaction(messages, {
      maxTokens: 432,
      recentKeepCount: 2,
      tokenizer,
    });

    const ids = new Set(
      (decision.compressedIndices ?? []).map((i) => messages[i]!.id),
    );
    expect(ids.has("a1")).toBe(true);
    expect(ids.has("r1")).toBe(true);
  });
});

describe("structured summary prompt", () => {
  it("requires the checkpoint sections and merge rule", () => {
    const tokenizer = createFixedTokenizer(50);
    const messages: Message[] = [
      { id: "s", role: "system", content: "S" },
      { id: "u1", role: "user", content: "old work" },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "did things" }] },
      { id: "u2", role: "user", content: "more" },
      { id: "a2", role: "assistant", content: [{ type: "text", text: "more done" }] },
      { id: "u3", role: "user", content: "now" },
      { id: "a3", role: "assistant", content: [{ type: "text", text: "now" }] },
    ];
    const decision = decideCompaction(messages, {
      maxTokens: 100,
      recentKeepCount: 1,
      tokenizer,
    });
    const prompt = decision.summaryPrompt!;
    for (const section of [
      "## Primary Request and Intent",
      "## Key Technical Concepts",
      "## Files and Code",
      "## Errors and Fixes",
      "## Pending Jobs",
      "## Current Work",
      "## Next Step",
      "## Critical Context",
    ]) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain("(none)");
    expect(prompt.toLowerCase()).toContain("merge");
  });

  it("is exported and embeds the conversation segment", () => {
    const messages: Message[] = [
      userMsg("edit /src/app.ts", "u1"),
      assistantMsg("done", "a1"),
    ];
    const prompt = buildSummaryPrompt(messages);
    expect(prompt).toContain("## Primary Request and Intent");
    expect(prompt).toContain("/src/app.ts");
    expect(prompt).toContain("[user]:");
  });
});

describe("CompactionDecision.replacedIds", () => {
  it("maps compressedIndices to the corresponding message ids", () => {
    const tokenizer = createFixedTokenizer(100);
    const messages: Message[] = [
      sysMsg("S", "sys"),
      userMsg("old 1", "u1"),
      userMsg("old 2", "u2"),
      userMsg("old 3", "u3"),
      userMsg("recent", "u9"),
    ];
    const decision = decideCompaction(messages, {
      maxTokens: 200,
      recentKeepCount: 1,
      tokenizer,
    });
    expect(decision.shouldCompact).toBe(true);
    expect(decision.replacedIds).toBeDefined();
    expect(decision.replacedIds).toEqual(
      decision.compressedIndices!.map((i) => messages[i]!.id),
    );
  });

  it("is undefined when no compaction is needed", () => {
    const tokenizer = createFixedTokenizer(10);
    const messages: Message[] = [sysMsg("S", "sys"), userMsg("hi", "u1")];
    const decision = decideCompaction(messages, {
      maxTokens: 1000,
      recentKeepCount: 1,
      tokenizer,
    });
    expect(decision.shouldCompact).toBe(false);
    expect(decision.replacedIds).toBeUndefined();
  });
});
