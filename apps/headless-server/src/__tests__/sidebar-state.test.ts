import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_SIDEBAR_STATE,
  InvalidSidebarStateError,
  createSidebarStateStore,
  normalizeSidebarState,
} from "../config/sidebar-state.js";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `s-${i}`);

describe("normalizeSidebarState", () => {
  it("fills defaults for an empty document, leaving expandedProjectIds absent", () => {
    expect(normalizeSidebarState({})).toEqual(DEFAULT_SIDEBAR_STATE);
    expect(normalizeSidebarState({}).expandedProjectIds).toBeUndefined();
  });

  it("keeps an explicit empty expandedProjectIds as []", () => {
    expect(normalizeSidebarState({ expandedProjectIds: [] }).expandedProjectIds).toEqual([]);
  });

  it("dedupes arrays preserving first occurrence", () => {
    expect(
      normalizeSidebarState({ pinnedSessionIds: ["a", "a", "b"], projectOrder: ["p", "p"] }),
    ).toMatchObject({ pinnedSessionIds: ["a", "b"], projectOrder: ["p"] });
  });

  it("rejects non-objects, bad modes, empty strings and over-limit arrays", () => {
    for (const bad of [null, "nope", 42, []]) {
      expect(() => normalizeSidebarState(bad)).toThrow(InvalidSidebarStateError);
    }
    expect(() => normalizeSidebarState({ sortModes: { pinned: "name" } })).toThrow(InvalidSidebarStateError);
    expect(() => normalizeSidebarState({ sortModes: { projects: "recent" } })).not.toThrow();
    expect(() => normalizeSidebarState({ pinnedSessionIds: [""] })).toThrow(InvalidSidebarStateError);
    expect(() => normalizeSidebarState({ pinnedSessionIds: ["x".repeat(201)] })).toThrow(InvalidSidebarStateError);
    expect(() => normalizeSidebarState({ pinnedSessionIds: ids(501) })).toThrow(InvalidSidebarStateError);
    expect(() => normalizeSidebarState({ pinnedSessionIds: ids(500) })).not.toThrow();
    expect(() => normalizeSidebarState({ pinnedCollapsed: "yes" })).toThrow(InvalidSidebarStateError);
  });
});

describe("createSidebarStateStore", () => {
  it("reads the default document without creating config.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-sidebar-"));
    const store = createSidebarStateStore(dir);
    await expect(store.read()).resolves.toEqual(DEFAULT_SIDEBAR_STATE);
    await expect(fs.access(path.join(dir, "config.json"))).rejects.toThrow();
  });

  it("round-trips a written document through config.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-sidebar-"));
    const store = createSidebarStateStore(dir);
    const written = await store.write({
      pinnedSessionIds: ["s-2", "s-1"],
      projectOrder: ["p-1"],
      sortModes: { pinned: "recent", projects: "name" },
      expandedProjectIds: ["p-1"],
      pinnedCollapsed: true,
      projectsCollapsed: false,
    });
    expect((await createSidebarStateStore(dir).read())).toEqual(written);
    const raw = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"));
    expect(raw.sidebar.pinnedSessionIds).toEqual(["s-2", "s-1"]);
  });

  it("falls back to defaults when config.json is corrupt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-sidebar-"));
    await fs.writeFile(path.join(dir, "config.json"), "{ not json", "utf8");
    await expect(createSidebarStateStore(dir).read()).resolves.toEqual(DEFAULT_SIDEBAR_STATE);
  });
});