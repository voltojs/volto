import { describe, expect, it } from "vitest";
import { createMockModelPort, textScript } from "@volto/core";
import type { MemoryEntry, MemoryQueryFilter, MemoryStore, ModelPort, ModelRequest } from "@volto/core";
import { createAgent } from "../create-agent.js";

function memoryStore(entries: MemoryEntry[], queries: Array<{ text: string; k?: number; filter?: MemoryQueryFilter }> = []): MemoryStore {
  return {
    async save(entry) {
      entries.push(entry);
      return entry.id || "mem-test";
    },
    async query(text, k, filter) {
      queries.push({ text, k, filter });
      return entries.slice(0, k ?? 10);
    },
    async delete() {
      return true;
    },
  };
}

function capture(script: Parameters<typeof createMockModelPort>[0]): {
  modelPort: ModelPort;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(script);
  return {
    requests,
    modelPort: {
      async *stream(req) {
        // Keep the live request rather than a structuredClone: a future
        // abortSignal on ModelRequest would make cloning throw DataCloneError.
        requests.push(req);
        yield* inner.stream(req);
      },
    },
  };
}

const ENTRY: MemoryEntry = {
  id: "mem-1",
  text: "The project uses pnpm.",
  scope: { kind: "global" },
  tier: "semantic",
};

describe("SDK memory wiring", () => {
  it("does not register the tool or inject RAG without an explicit memoryStore", async () => {
    const { modelPort, requests } = capture([textScript("ok")]);
    const agent = createAgent({ modelPort });
    await agent.run("hello");
    const tools = requests[0]!.tools.map((t) => t.name);
    expect(tools).not.toContain("memory");
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("Retrieved Memory");
  });

  it("registers the memory tool and injects RAG when memory and rag are enabled", async () => {
    const queries: Array<{ text: string; k?: number; filter?: MemoryQueryFilter }> = [];
    const { modelPort, requests } = capture([textScript("ok")]);
    const agent = createAgent({
      modelPort,
      memoryStore: memoryStore([ENTRY], queries),
      memory: { rag: { topK: 2 } },
    });
    await agent.run("which package manager?");
    const tool = requests[0]!.tools.find((t) => t.name === "memory");
    expect(tool).toBeDefined();
    expect(tool!.requires).toEqual(["memory:read", "memory:write"]);
    expect(tool!.riskTier).toBe("WRITE_LOW");
    expect(JSON.stringify(requests[0]!.messages)).toContain("# Retrieved Memory");
    expect(JSON.stringify(requests[0]!.messages)).toContain("The project uses pnpm.");
    expect(queries[0]?.filter).toEqual({ projectId: undefined, includeGlobal: true, tier: "semantic" });
  });

  it("memory.tools:false hides the tool but keeps RAG", async () => {
    const { modelPort, requests } = capture([textScript("ok")]);
    const agent = createAgent({
      modelPort,
      memoryStore: memoryStore([ENTRY]),
      memory: { rag: { topK: 1 }, tools: false },
    });
    await agent.run("which package manager?");
    const tools = requests[0]!.tools.map((t) => t.name);
    expect(tools).not.toContain("memory");
    expect(JSON.stringify(requests[0]!.messages)).toContain("The project uses pnpm.");
  });

  it("injects exactly one RAG message per turn and never accumulates in history", async () => {
    const { modelPort, requests } = capture([textScript("first"), textScript("second")]);
    const agent = createAgent({
      modelPort,
      memoryStore: memoryStore([ENTRY]),
      memory: { rag: { topK: 2 } },
    });
    await agent.run("first question");
    await agent.run("second question");

    // The injection lives only on the request surface: each turn sees
    // exactly one RAG message, and the durable history never accumulates
    // copies of it across turns.
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      const ragMessages = (req.messages as Array<{ role: string; content: unknown }>).filter(
        (m) => typeof m.content === "string" && m.content.includes("# Retrieved Memory"),
      );
      expect(ragMessages).toHaveLength(1);
    }
    expect(JSON.stringify(requests[1]!.messages).match(/# Retrieved Memory/g)).toHaveLength(1);
  });

  it("passes memory.rag.includeGlobal through to the runner filter", async () => {
    const queries: Array<{ text: string; k?: number; filter?: MemoryQueryFilter }> = [];
    const { modelPort } = capture([textScript("ok")]);
    const agent = createAgent({
      modelPort,
      memoryStore: memoryStore([ENTRY], queries),
      memory: { rag: { includeGlobal: false } },
    });
    await agent.run("hello");
    expect(queries[0]?.filter).toEqual({
      projectId: undefined,
      includeGlobal: false,
      tier: "semantic",
    });
  });

  it("passes memory.rag.queryBuilder through to the runner", async () => {
    const queries: Array<{ text: string; k?: number; filter?: MemoryQueryFilter }> = [];
    const { modelPort, requests } = capture([textScript("ok")]);
    const agent = createAgent({
      modelPort,
      memoryStore: memoryStore([ENTRY], queries),
      memory: {
        rag: {
          queryBuilder: (messages) =>
            `custom:${String((messages.at(-1) as { content?: unknown } | undefined)?.content ?? "")}`,
        },
      },
    });
    await agent.run("hello");
    expect(queries[0]?.text).toBe("custom:hello");
    expect(JSON.stringify(requests[0]!.messages)).toContain("# Retrieved Memory");
  });

  it("memory rag default is off even with a store", async () => {
    const { modelPort, requests } = capture([textScript("ok")]);
    const agent = createAgent({ modelPort, memoryStore: memoryStore([ENTRY]) });
    await agent.run("which package manager?");
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("Retrieved Memory");
  });
});
