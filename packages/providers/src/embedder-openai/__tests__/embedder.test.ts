import { describe, it, expect, vi } from "vitest";
import { createOpenAIEmbedder } from "../embedder.js";

describe("createOpenAIEmbedder", () => {
  it("should create an embedder with default model", () => {
    const embedder = createOpenAIEmbedder({ apiKey: "test-key" });
    expect(embedder).toBeDefined();
    expect(typeof embedder.embed).toBe("function");
  });

  it("should return empty array for empty input", async () => {
    const embedder = createOpenAIEmbedder({ apiKey: "test-key" });
    const result = await embedder.embed([]);
    expect(result).toEqual([]);
  });

  it("should throw on network failure (port contract: Runner catches)", async () => {
    // Mock fetch to simulate network failure
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    try {
      const embedder = createOpenAIEmbedder({ apiKey: "test-key" });
      await expect(embedder.embed(["hello"])).rejects.toThrow("Embedding failed: Network error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should throw on non-ok HTTP response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    try {
      const embedder = createOpenAIEmbedder({ apiKey: "bad-key" });
      await expect(embedder.embed(["hello"])).rejects.toThrow("Embedding API error 401");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should parse embeddings from valid response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
        }),
    });

    try {
      const embedder = createOpenAIEmbedder({ apiKey: "test-key" });
      const result = await embedder.embed(["hello", "world"]);
      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
