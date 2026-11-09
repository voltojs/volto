import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIDEBAR_STATE,
  fetchSidebarState,
  normalizeSidebarState,
  putSidebarState,
} from "../sidebar-state-api";

afterEach(() => vi.unstubAllGlobals());

describe("sidebar-state-api", () => {
  it("unwraps the { sidebar } envelope and normalizes it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ sidebar: { pinnedSessionIds: ["s-1", "s-1"], sortModes: { pinned: "recent" } } }),
      { status: 200 },
    )));
    expect(await fetchSidebarState()).toMatchObject({
      pinnedSessionIds: ["s-1"],
      sortModes: { pinned: "recent", projects: "manual" },
    });
  });

  it("falls back to defaults on HTTP failure or a thrown fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await fetchSidebarState()).toEqual(DEFAULT_SIDEBAR_STATE);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchSidebarState()).toEqual(DEFAULT_SIDEBAR_STATE);
  });

  it("sends the full document under the { sidebar } envelope", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sidebar: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const doc = { ...DEFAULT_SIDEBAR_STATE, pinnedSessionIds: ["s-1"] };
    expect(await putSidebarState(doc)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/sidebar-state");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ sidebar: doc });
  });

  it("reports failure instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 400 })));
    expect(await putSidebarState(DEFAULT_SIDEBAR_STATE)).toBe(false);
  });

  it("keeps undefined vs [] apart in the client normalizer", () => {
    expect(normalizeSidebarState({}).expandedProjectIds).toBeUndefined();
    expect(normalizeSidebarState({ expandedProjectIds: [] }).expandedProjectIds).toEqual([]);
  });
});