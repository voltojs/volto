import { describe, it, expect, vi, afterEach } from "vitest";
import { createNodeNetwork } from "../network.js";

describe("Node Network adapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches a URL and returns status, headers, body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers([["content-type", "text/html"]]),
      text: async () => "<html>hello</html>",
    });

    const network = createNodeNetwork();
    const response = await network.fetch({ url: "https://example.com" });
    expect(response.status).toBe(200);
    expect(response.body).toBe("<html>hello</html>");
    expect(response.headers["content-type"]).toBe("text/html");
  });

  it("throws on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS resolution failed"));
    const network = createNodeNetwork();
    await expect(
      network.fetch({ url: "https://unreachable.com" }),
    ).rejects.toThrow("Network fetch failed");
  });

  it("adapter-level timeout surfaces the unified timeout signature verbatim", async () => {
    // Hanging fetch that rejects only when the adapter's timer aborts.
    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal | null }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abortError = new Error("The operation was aborted.");
          abortError.name = "AbortError";
          reject(abortError);
        });
      })) as typeof globalThis.fetch;

    const network = createNodeNetwork({ timeout: 20 });
    expect.assertions(1);
    try {
      await network.fetch({ url: "https://example.com/slow" });
    } catch (error) {
      expect((error as Error).message).toBe(
        "[timeout] https://example.com/slow timed out after 20ms",
      );
    }
  });

  it("external abort keeps AbortError identity and carries no timeout signature", async () => {
    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal | null }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abortError = new Error("The operation was aborted.");
          abortError.name = "AbortError";
          reject(abortError);
        });
      })) as typeof globalThis.fetch;

    const network = createNodeNetwork({ timeout: 30_000 });
    const controller = new AbortController();
    const pending = network.fetch({
      url: "https://example.com/slow",
      abortSignal: controller.signal,
    });
    controller.abort();

    expect.assertions(2);
    try {
      await pending;
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      expect((error as Error).message).not.toContain("[timeout]");
    }
  });

  it("sends custom headers and body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 201,
      headers: new Map(),
      text: async () => "created",
    });

    const network = createNodeNetwork();
    await network.fetch({
      url: "https://api.example.com/data",
      method: "POST",
      headers: { Authorization: "Bearer token" },
      body: '{"key":"value"}',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.example.com/data",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer token" },
        body: '{"key":"value"}',
      }),
    );
  });
});
