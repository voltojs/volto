import { describe, it, expect } from "vitest";
import { createGlmAdapter } from "../glm.js";
import type { SearchAdapterError } from "../types.js";

function catchError(fn: () => unknown): SearchAdapterError {
  try {
    fn();
  } catch (error) {
    return error as SearchAdapterError;
  }
  throw new Error("expected the adapter to throw");
}

describe("glm search adapter", () => {
  it("posts to /paas/v4/web_search with search_std and a 70-char query", () => {
    const req = createGlmAdapter().buildRequest("x".repeat(120), { apiKey: "k", count: 8 });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://open.bigmodel.cn/api/paas/v4/web_search");
    expect(req.headers?.["Authorization"]).toBe("Bearer k");
    expect(JSON.parse(req.body!)).toEqual({
      search_query: "x".repeat(70),
      search_engine: "search_std",
      count: 8,
    });
  });

  it("keeps a custom baseUrl's /api suffix", () => {
    const req = createGlmAdapter().buildRequest("q", {
      baseUrl: "https://proxy.example.com/api/",
      count: 5,
    });
    expect(req.url).toBe("https://proxy.example.com/api/paas/v4/web_search");
  });

  it("maps search_result fields", () => {
    const hits = createGlmAdapter().parseResponse(
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          search_result: [
            { title: "T", content: "C", link: "https://g.com", media: "站点", publish_date: "2026-01-01" },
          ],
        }),
      },
      { count: 8 },
    );
    expect(hits).toEqual([
      {
        title: "T",
        url: "https://g.com",
        snippet: "C",
        summary: "C",
        siteName: "站点",
        publishedAt: "2026-01-01",
      },
    ]);
  });

  it("throws auth on 401 and shape when search_result is missing", () => {
    const auth = catchError(() => createGlmAdapter().parseResponse({ status: 401, headers: {}, body: "" }, { count: 5 }));
    expect(auth.kind).toBe("auth");

    const shape = catchError(() => createGlmAdapter().parseResponse({ status: 200, headers: {}, body: "{}" }, { count: 5 }));
    expect(shape.kind).toBe("shape");
  });
});
