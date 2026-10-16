import { describe, it, expect, afterEach } from "vitest";
import { createNodeNetwork } from "../network.js";

describe("TC-E7: Network AbortError 透传端到端", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  it("AbortError preserves identity (name === AbortError, not wrapped)", async () => {
    const network = createNodeNetwork({ timeout: 30_000 });
    const ac = new AbortController();

    // Abort immediately so the fetch sees an already-aborted signal.
    ac.abort();

    try {
      await network.fetch({
        url: "https://httpbin.org/get",
        abortSignal: ac.signal,
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
      // Must NOT be wrapped with "Network fetch failed" prefix.
      expect((error as Error).message).not.toContain("Network fetch failed");
    }
  });

  it("timeout-triggered abort surfaces the unified timeout signature (not AbortError identity)", async () => {
    // T9 Task 3 / spec §6: the adapter's own timeout-abort is a timeout, not a
    // cancellation — it must carry the unified signature. External aborts keep
    // the AbortError identity (asserted by the test above).
    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal | null }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abortError = new Error("The operation was aborted.");
          abortError.name = "AbortError";
          reject(abortError);
        });
      })) as typeof globalThis.fetch;

    const network = createNodeNetwork({ timeout: 20 });
    try {
      await network.fetch({ url: "https://example.com/slow" });
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toBe(
        "[timeout] https://example.com/slow timed out after 20ms",
      );
    }
  });
});
