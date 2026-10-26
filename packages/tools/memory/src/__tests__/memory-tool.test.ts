import { describe, it, expect } from "vitest";
import type { MemoryEntry, MemoryQueryFilter, MemoryStore } from "@volto/core";
import { createMemoryTool, CAP_MEMORY_READ, CAP_MEMORY_WRITE } from "../index.js";

/** Spy store: records every call, returns whatever the test scripts. */
function createSpyStore(options?: {
  queryResults?: MemoryEntry[][];
  saveIds?: string[];
  saveError?: Error;
  queryError?: Error;
}): MemoryStore & {
  queries: Array<{ text: string; k?: number; filter?: MemoryQueryFilter }>;
  saves: MemoryEntry[];
} {
  const queries: Array<{ text: string; k?: number; filter?: MemoryQueryFilter }> = [];
  const saves: MemoryEntry[] = [];
  let queryIndex = 0;
  let saveIndex = 0;
  return {
    queries,
    saves,
    async save(entry: MemoryEntry): Promise<string> {
      if (options?.saveError) throw options.saveError;
      saves.push(entry);
      const id = options?.saveIds?.[saveIndex] ?? `mem-${saveIndex + 1}`;
      saveIndex += 1;
      return id;
    },
    async query(text: string, k?: number, filter?: MemoryQueryFilter): Promise<MemoryEntry[]> {
      if (options?.queryError) throw options.queryError;
      queries.push({ text, k, filter });
      const result = options?.queryResults?.[queryIndex] ?? [];
      queryIndex += 1;
      return result;
    },
    async delete(): Promise<boolean> {
      return true;
    },
  };
}

const NOW = 1_700_000_000_000;

function tool(deps?: Partial<Parameters<typeof createMemoryTool>[0]>) {
  return createMemoryTool({
    memoryStore: deps?.memoryStore ?? createSpyStore(),
    projectId: deps?.projectId === undefined ? "p1" : deps.projectId,
    sessionId: deps?.sessionId,
    now: deps?.now ?? (() => NOW),
  });
}

describe("memory tool schema", () => {
  it("rejects remember without text and recall without query", async () => {
    const t = tool();
    const noText = await t.handler({ action: "remember" });
    expect(noText.isError).toBe(true);
    expect(noText.modelContent).toContain("Invalid input");

    const noQuery = await t.handler({ action: "recall" });
    expect(noQuery.isError).toBe(true);
    expect(noQuery.modelContent).toContain("Invalid input");
  });

  it("rejects remember text over the 4000-char cap", async () => {
    const t = tool();
    const tooLong = await t.handler({ action: "remember", text: "x".repeat(4001) });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.modelContent).toContain("Invalid input");

    const atCap = await t.handler({ action: "remember", text: "x".repeat(4000) });
    expect(atCap.isError).toBeFalsy();
  });

  it("rejects an unknown action and out-of-range k", async () => {
    const t = tool();
    const unknown = await t.handler({ action: "delete", text: "x" });
    expect(unknown.isError).toBe(true);

    const kTooLarge = await t.handler({ action: "recall", query: "q", k: 11 });
    expect(kTooLarge.isError).toBe(true);

    const kZero = await t.handler({ action: "recall", query: "q", k: 0 });
    expect(kZero.isError).toBe(true);
  });

  it("rejects unknown extra properties (strict members)", async () => {
    const t = tool();
    const extra = await t.handler({ action: "remember", text: "hi", scope: "global" });
    expect(extra.isError).toBe(true);
    expect(extra.modelContent).toContain("Invalid input");
  });
});

describe("memory tool definition", () => {
  it("declares name, both capabilities, WRITE_LOW and untrusted", () => {
    const { definition } = tool();
    expect(definition.name).toBe("memory");
    expect(definition.requires).toContain(CAP_MEMORY_READ);
    expect(definition.requires).toContain(CAP_MEMORY_WRITE);
    expect(definition.requires).toHaveLength(2);
    expect(definition.riskTier).toBe("WRITE_LOW");
    expect(definition.trust).toBe("untrusted");
  });

  it("exports capability strings", () => {
    expect(CAP_MEMORY_READ).toBe("memory:read");
    expect(CAP_MEMORY_WRITE).toBe("memory:write");
  });
});

describe("remember", () => {
  it("rejects an unbound project with an error mentioning the project binding", async () => {
    const store = createSpyStore();
    const t = createMemoryTool({ memoryStore: store, now: () => NOW });
    const result = await t.handler({ action: "remember", text: "hello" });
    expect(result.isError).toBe(true);
    expect(String(result.modelContent)).toMatch(/project/i);
    expect(store.queries).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
  });

  it("saves a project-scoped semantic entry with id '' and createdAt from now()", async () => {
    const store = createSpyStore({ saveIds: ["mem-42"] });
    const t = createMemoryTool({
      memoryStore: store,
      projectId: "p1",
      sessionId: "s1",
      now: () => NOW,
    });
    const result = await t.handler({ action: "remember", text: "  the sky is blue  " });
    expect(result.isError).toBeFalsy();

    expect(store.queries).toHaveLength(1);
    expect(store.queries[0]).toEqual({
      text: "the sky is blue",
      k: 5,
      filter: { projectId: "p1", includeGlobal: false, tier: "semantic" },
    });

    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]).toEqual({
      id: "",
      text: "the sky is blue",
      scope: { kind: "project", projectId: "p1" },
      tier: "semantic",
      source: "tool",
      sessionId: "s1",
      createdAt: NOW,
    });

    expect(result.modelContent).toContain("mem-42");
    expect(result.displayMetadata).toMatchObject({
      memoryId: "mem-42",
      scope: { kind: "project", projectId: "p1" },
      deduped: false,
    });
  });

  it("skips the save when an exact trimmed duplicate already exists", async () => {
    const store = createSpyStore({
      queryResults: [[{ id: "mem-1", text: "the sky is blue" }]],
      saveIds: ["should-not-be-used"],
    });
    const t = createMemoryTool({ memoryStore: store, projectId: "p1", now: () => NOW });
    const result = await t.handler({ action: "remember", text: "the sky is blue" });

    expect(result.isError).toBeFalsy();
    expect(store.saves).toHaveLength(0);
    expect(String(result.modelContent)).toMatch(/already/i);
    expect(result.displayMetadata).toMatchObject({ memoryId: "mem-1", deduped: true });
  });

  it("normalizes a store failure to an error result", async () => {
    const store = createSpyStore({ saveError: new Error("disk full") });
    const t = createMemoryTool({ memoryStore: store, projectId: "p1", now: () => NOW });
    const result = await t.handler({ action: "remember", text: "hello" });
    expect(result.isError).toBe(true);
    expect(String(result.modelContent)).toContain("disk full");
  });

  it("rejects whitespace-only text instead of storing an unretrievable entry", async () => {
    const store = createSpyStore();
    const t = createMemoryTool({ memoryStore: store, projectId: "p1", now: () => NOW });
    const result = await t.handler({ action: "remember", text: "   " });

    expect(result.isError).toBe(true);
    expect(String(result.modelContent)).toMatch(/non-empty/i);
    expect(store.saves).toHaveLength(0);
  });
});

describe("recall", () => {
  it("queries with the scoped filter and formats entries as [1] text", async () => {
    const store = createSpyStore({
      queryResults: [
        [
          { id: "m1", text: "first fact" },
          { id: "m2", text: "second fact" },
        ],
      ],
    });
    const t = createMemoryTool({ memoryStore: store, projectId: "p1", now: () => NOW });
    const result = await t.handler({ action: "recall", query: "facts", k: 3 });

    expect(result.isError).toBeFalsy();
    expect(store.queries).toEqual([
      {
        text: "facts",
        k: 3,
        filter: { projectId: "p1", includeGlobal: true, tier: "semantic" },
      },
    ]);
    expect(result.modelContent).toBe("[1] first fact\n[2] second fact");
  });

  it("returns a non-error message when nothing matches", async () => {
    const store = createSpyStore({ queryResults: [[]] });
    const t = createMemoryTool({ memoryStore: store, projectId: "p1", now: () => NOW });
    const result = await t.handler({ action: "recall", query: "nothing" });

    expect(result.isError).toBeFalsy();
    expect(String(result.modelContent)).toMatch(/no relevant memories/i);
    expect(store.saves).toHaveLength(0);
  });

  it("caps each recalled line at 500 chars and declares the truncation", async () => {
    const longText = `long fact ${"x".repeat(600)}`;
    const store = createSpyStore({ queryResults: [[{ id: "m1", text: longText }]] });
    const t = createMemoryTool({ memoryStore: store, projectId: "p1", now: () => NOW });
    const result = await t.handler({ action: "recall", query: "long" });

    expect(result.isError).toBeFalsy();
    const content = String(result.modelContent);
    expect(content).toContain("(truncated)");
    expect(content.length).toBeLessThan(longText.length);
    expect(result.displayMetadata).toMatchObject({ truncated: true });
  });

  it("truncates by code point so surrogate pairs stay intact", async () => {
    // 600 emoji = 1200 UTF-16 code units; a naive slice(0, 500) would split a
    // pair and emit a lone surrogate.
    const emojiText = "😀".repeat(600);
    const store = createSpyStore({ queryResults: [[{ id: "m1", text: emojiText }]] });
    const t = createMemoryTool({ memoryStore: store, projectId: "p1", now: () => NOW });
    const result = await t.handler({ action: "recall", query: "emoji" });

    const content = String(result.modelContent);
    expect(content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result.displayMetadata).toMatchObject({ truncated: true });
  });

  it("does not mark short entries as truncated", async () => {
    const store = createSpyStore({ queryResults: [[{ id: "m1", text: "short fact" }]] });
    const t = createMemoryTool({ memoryStore: store, projectId: "p1", now: () => NOW });
    const result = await t.handler({ action: "recall", query: "short" });

    expect(result.modelContent).toBe("[1] short fact");
    expect(result.displayMetadata).toMatchObject({ count: 1 });
    expect(result.displayMetadata?.truncated).toBeUndefined();
  });

  it("rejects an unbound project with an error mentioning the project binding", async () => {
    const store = createSpyStore();
    const t = createMemoryTool({ memoryStore: store, now: () => NOW });
    const result = await t.handler({ action: "recall", query: "facts" });
    expect(result.isError).toBe(true);
    expect(String(result.modelContent)).toMatch(/project/i);
    expect(store.queries).toHaveLength(0);
  });

  it("normalizes a query failure to an error result", async () => {
    const store = createSpyStore({ queryError: new Error("index locked") });
    const t = createMemoryTool({ memoryStore: store, projectId: "p1", now: () => NOW });
    const result = await t.handler({ action: "recall", query: "facts" });
    expect(result.isError).toBe(true);
    expect(String(result.modelContent)).toContain("index locked");
  });
});
