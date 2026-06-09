import { describe, it, expect } from "vitest";
import { createNodeNetwork } from "../network.js";

describe("TC-E7: Network AbortError 透传端到端", () => {
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

  it("timeout-triggered AbortError also preserves identity", async () => {
    // Use a very short timeout so the adapter-level timer aborts.
    const network = createNodeNetwork({ timeout: 1 });

    try {
      await network.fetch({ url: "https://httpbin.org/delay/10" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
    }
  });
});
