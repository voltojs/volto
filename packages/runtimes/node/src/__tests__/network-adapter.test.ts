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
      headers: new Map([["content-type", "text/html"]]),
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
