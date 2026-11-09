import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchSidebarState = vi.fn();
const putSidebarState = vi.fn();

vi.mock("@/lib/sidebar-state-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sidebar-state-api")>(
    "@/lib/sidebar-state-api",
  );
  return {
    ...actual,
    fetchSidebarState: () => fetchSidebarState(),
    putSidebarState: (s: unknown) => putSidebarState(s),
  };
});

type StoreModule = typeof import("../sidebar-state-store");

async function freshStore(): Promise<StoreModule["useSidebarStateStore"]> {
  vi.resetModules();
  return (await import("../sidebar-state-store")).useSidebarStateStore;
}

const { DEFAULT_SIDEBAR_STATE } = await import("@/lib/sidebar-state-api");

beforeEach(() => {
  fetchSidebarState.mockReset();
  putSidebarState.mockReset();
  putSidebarState.mockResolvedValue(true);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("sidebar-state-store", () => {
  it("loads the server document exactly once", async () => {
    const store = await freshStore();
    fetchSidebarState.mockResolvedValue({ ...DEFAULT_SIDEBAR_STATE, pinnedSessionIds: ["s-1"] });
    await store.getState().load();
    await store.getState().load();
    expect(fetchSidebarState).toHaveBeenCalledTimes(1);
    expect(store.getState().state.pinnedSessionIds).toEqual(["s-1"]);
    expect(store.getState().loaded).toBe(true);
  });

  it("applies an update optimistically and PUTs the resulting document", async () => {
    const store = await freshStore();
    fetchSidebarState.mockResolvedValue(DEFAULT_SIDEBAR_STATE);
    await store.getState().load();
    store.getState().update((s) => ({ ...s, pinnedSessionIds: ["s-9"] }));
    expect(store.getState().state.pinnedSessionIds).toEqual(["s-9"]);
    await flush();
    expect(putSidebarState).toHaveBeenCalledTimes(1);
    expect(putSidebarState.mock.calls[0]?.[0]).toMatchObject({ pinnedSessionIds: ["s-9"] });
  });

  it("rebases a pre-load update onto the server document instead of sending defaults", async () => {
    const store = await freshStore();
    let resolveFetch: (value: unknown) => void = () => {};
    fetchSidebarState.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    const loading = store.getState().load();
    // The user pins something before the layout document has arrived.
    store.getState().update((s) => ({ ...s, pinnedSessionIds: [...s.pinnedSessionIds, "local-1"] }));
    resolveFetch({ ...DEFAULT_SIDEBAR_STATE, pinnedSessionIds: ["server-1"] });
    await loading;
    await flush();

    // The optimistic change survives on top of the server document...
    expect(store.getState().state.pinnedSessionIds).toEqual(["server-1", "local-1"]);
    // ...and the write is not "default + one change", which would drop the
    // server's own pins and order.
    expect(putSidebarState).toHaveBeenCalledTimes(1);
    expect(putSidebarState.mock.calls[0]?.[0]).toMatchObject({
      pinnedSessionIds: ["server-1", "local-1"],
    });
  });

  it("defers writes until load settles, so defaults never overwrite the server", async () => {
    const store = await freshStore();
    fetchSidebarState.mockReturnValue(new Promise(() => {})); // never resolves
    void store.getState().load();
    store.getState().update((s) => ({ ...s, pinnedCollapsed: true }));
    await flush();
    expect(putSidebarState).not.toHaveBeenCalled();
  });

  it("ignores the PUT response body", async () => {
    const store = await freshStore();
    fetchSidebarState.mockResolvedValue(DEFAULT_SIDEBAR_STATE);
    await store.getState().load();
    putSidebarState.mockResolvedValue(false);
    store.getState().update((s) => ({ ...s, pinnedCollapsed: true }));
    await flush();
    expect(store.getState().state.pinnedCollapsed).toBe(true);
  });

  it("serialises writes and only sends the newest state", async () => {
    const store = await freshStore();
    fetchSidebarState.mockResolvedValue(DEFAULT_SIDEBAR_STATE);
    await store.getState().load();
    const resolvers: Array<(v: boolean) => void> = [];
    putSidebarState.mockImplementation(
      () => new Promise<boolean>((resolve) => resolvers.push(resolve)),
    );
    store.getState().update((s) => ({ ...s, pinnedSessionIds: ["a"] }));
    store.getState().update((s) => ({ ...s, pinnedSessionIds: ["a", "b"] }));
    await flush();
    expect(putSidebarState).toHaveBeenCalledTimes(1);
    expect(putSidebarState.mock.calls[0]?.[0]).toMatchObject({ pinnedSessionIds: ["a"] });
    resolvers[0]?.(true);
    await flush();
    expect(putSidebarState).toHaveBeenCalledTimes(2);
    expect(putSidebarState.mock.calls[1]?.[0]).toMatchObject({ pinnedSessionIds: ["a", "b"] });
  });
});