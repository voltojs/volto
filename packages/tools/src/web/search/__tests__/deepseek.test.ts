import { describe, it, expect } from "vitest";
import type { NetworkResponse } from "@voltojs/core";
import { createDeepSeekAdapter } from "../deepseek.js";
import type { SearchAdapterError } from "../types.js";

function catchError(fn: () => unknown): SearchAdapterError {
  try {
    fn();
  } catch (error) {
    return error as SearchAdapterError;
  }
  throw new Error("expected the adapter to throw");
}

const ok = (body: string, status = 200): NetworkResponse => ({ status, headers: {}, body });

describe("deepseek search adapter", () => {
  it("builds a POST with bearer auth and need_content false", () => {
    const req = createDeepSeekAdapter().buildRequest("deepseek v4", { apiKey: "k", count: 5 });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(req.headers?.["Authorization"]).toBe("Bearer k");
    expect(JSON.parse(req.body!)).toEqual({ query: "deepseek v4", count: 5, need_content: false });
  });

  it("strips a trailing /v1 from baseUrl", () => {
    const req = createDeepSeekAdapter().buildRequest("q", {
      baseUrl: "https://proxy.example.com/v1/",
      count: 3,
    });
    expect(req.url).toBe("https://proxy.example.com/v1/tools/search");
  });

  it("clamps query to 128 characters", () => {
    const req = createDeepSeekAdapter().buildRequest("x".repeat(200), { count: 3 });
    expect((JSON.parse(req.body!) as { query: string }).query).toHaveLength(128);
  });

  it("parses results and maps site_name/date", () => {
    const hits = createDeepSeekAdapter().parseResponse(
      ok(
        JSON.stringify({
          results: [
            {
              title: "T",
              url: "https://e.com",
              snippet: "s",
              summary: "S",
              site_name: "E",
              date: "2026-06-01T00:00:00+00:00",
            },
          ],
        }),
      ),
      { count: 5 },
    );
    expect(hits).toEqual([
      {
        title: "T",
        url: "https://e.com",
        snippet: "s",
        summary: "S",
        siteName: "E",
        publishedAt: "2026-06-01T00:00:00+00:00",
      },
    ]);
  });

  it("throws auth on 401 and shape on a non-array results", () => {
    const auth = catchError(() => createDeepSeekAdapter().parseResponse(ok("{}", 401), { count: 5 }));
    expect(auth.kind).toBe("auth");
    expect(auth.status).toBe(401);

    const shape = catchError(() => createDeepSeekAdapter().parseResponse(ok("{}"), { count: 5 }));
    expect(shape.kind).toBe("shape");
  });
});
