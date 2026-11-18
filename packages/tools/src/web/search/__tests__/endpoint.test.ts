import { describe, it, expect } from "vitest";
import type { NetworkResponse } from "@voltojs/core";
import { createEndpointAdapter } from "../endpoint.js";
import type { EndpointSourceSpec, SearchAdapterError } from "../types.js";

function catchError(fn: () => unknown): SearchAdapterError {
  try {
    fn();
  } catch (error) {
    return error as SearchAdapterError;
  }
  throw new Error("expected the adapter to throw");
}

const spec: EndpointSourceSpec = {
  method: "POST",
  url: "https://search.example.com/v1/search",
  auth: { header: "Authorization", prefix: "Bearer " },
  bodyTemplate: '{"q": "{{query}}", "n": {{count}}}',
  paths: {
    list: "data.items",
    title: "name",
    url: "link",
    snippet: "digest",
    summary: "digest",
    date: "published",
  },
};

const ok = (payload: unknown): NetworkResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(payload),
});

describe("custom endpoint search adapter", () => {
  it("escapes the query into valid JSON", () => {
    const req = createEndpointAdapter({ id: "x", label: "X", spec }).buildRequest('he said "hi"\n', {
      apiKey: "k",
      count: 7,
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://search.example.com/v1/search");
    expect(JSON.parse(req.body!)).toEqual({ q: 'he said "hi"\n', n: 7 });
    expect(req.headers?.["Authorization"]).toBe("Bearer k");
  });

  it("supports GET with encoded placeholders", () => {
    const getSpec: EndpointSourceSpec = {
      ...spec,
      method: "GET",
      url: "https://s.example.com/s?q={{query}}&n={{count}}",
      bodyTemplate: undefined,
    };
    const req = createEndpointAdapter({ id: "x", label: "X", spec: getSpec }).buildRequest("a b", {
      count: 3,
    });
    expect(req.url).toBe("https://s.example.com/s?q=a%20b&n=3");
    expect(req.body).toBeUndefined();
  });

  it("reads dotted paths and indexes arrays", () => {
    const hits = createEndpointAdapter({ id: "x", label: "X", spec }).parseResponse(
      ok({ data: { items: [{ name: "T", link: "https://i.com", digest: "D", published: "2026-02-02" }] } }),
      { count: 3 },
    );
    expect(hits).toEqual([
      {
        title: "T",
        url: "https://i.com",
        snippet: "D",
        summary: "D",
        publishedAt: "2026-02-02",
      },
    ]);
  });

  it("indexes numeric path segments", () => {
    const indexed: EndpointSourceSpec = { ...spec, paths: { ...spec.paths, list: "data.0.items" } };
    const hits = createEndpointAdapter({ id: "x", label: "X", spec: indexed }).parseResponse(
      ok({ data: [{ items: [{ name: "T", link: "https://i.com" }] }] }),
      { count: 3 },
    );
    expect(hits).toEqual([{ title: "T", url: "https://i.com" }]);
  });

  it("fails shape on a broken template", () => {
    const broken: EndpointSourceSpec = { ...spec, bodyTemplate: '{"q": "{{query}}"' };
    const error = catchError(() =>
      createEndpointAdapter({ id: "x", label: "X", spec: broken }).buildRequest("q", { count: 3 }),
    );
    expect(error.kind).toBe("shape");
  });

  it("fails shape when the list path misses or an entry lacks title/url", () => {
    const noList: EndpointSourceSpec = { ...spec, paths: { ...spec.paths, list: "nope" } };
    expect(
      catchError(() =>
        createEndpointAdapter({ id: "x", label: "X", spec: noList }).parseResponse(ok({}), { count: 3 }),
      ).kind,
    ).toBe("shape");

    const noTitle = catchError(() =>
      createEndpointAdapter({ id: "x", label: "X", spec }).parseResponse(
        ok({ data: { items: [{ link: "https://i.com" }] } }),
        { count: 3 },
      ),
    );
    expect(noTitle.kind).toBe("shape");
    expect(noTitle.message).toContain("title");
  });
});
