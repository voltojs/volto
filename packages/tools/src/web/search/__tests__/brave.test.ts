import { describe, it, expect } from "vitest";
import { createBraveAdapter } from "../brave.js";

describe("brave search adapter", () => {
  it("builds the legacy GET shape", () => {
    const req = createBraveAdapter().buildRequest("a b", { apiKey: "k", count: 4 });
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://api.search.brave.com/res/v1/web/search?q=a%20b&count=4");
    expect(req.headers?.["X-Subscription-Token"]).toBe("k");
    expect(req.headers?.["Accept"]).toBe("application/json");
  });

  it("omits the token header when no key is configured", () => {
    const req = createBraveAdapter().buildRequest("q", { count: 3 });
    expect(req.headers?.["X-Subscription-Token"]).toBeUndefined();
  });

  it("parses web.results", () => {
    const hits = createBraveAdapter().parseResponse(
      {
        status: 200,
        headers: {},
        body: JSON.stringify({ web: { results: [{ title: "T", url: "https://b.com", description: "D" }] } }),
      },
      { count: 4 },
    );
    expect(hits).toEqual([{ title: "T", url: "https://b.com", snippet: "D" }]);
  });
});
