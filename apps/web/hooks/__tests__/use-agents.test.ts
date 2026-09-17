// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAgents } from "@/hooks/use-agents";

function stubFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  });
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("useAgents", () => {
  it("loads agents and tools together", async () => {
    vi.stubGlobal("fetch", stubFetch({
      "/agents": { agents: [{ id: "user:a", name: "a", scope: "user", readOnly: false, shadowed: false, spec: { name: "a" } }] },
      "/tools": { tools: [{ name: "read_file", description: "read" }] },
    }));

    const { result } = renderHook(() => useAgents(null));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.agents).toHaveLength(1);
    expect(result.current.tools.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("surfaces a failed load instead of rendering an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const { result } = renderHook(() => useAgents(null));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.agents).toEqual([]);
  });

  it("refreshes after a mutation so shadowed flags stay accurate", async () => {
    const fetchSpy = stubFetch({
      "/agents": { agents: [] },
      "/tools": { tools: [] },
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { result } = renderHook(() => useAgents(null));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const callsBefore = fetchSpy.mock.calls.length;
    await act(async () => { await result.current.refresh(); });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("refetches the whole list after a successful mutate", async () => {
    const fetchSpy = stubFetch({
      "/agents": { agents: [] },
      "/tools": { tools: [] },
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { result } = renderHook(() => useAgents(null));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const callsBefore = fetchSpy.mock.calls.length;
    const value = await act(async () => result.current.mutate(async () => "ok"));
    expect(value).toBe("ok");
    // mutate must refetch (F-034): shadowed flags are server-computed, so
    // skipping the load would leave stale list data without failing here.
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
