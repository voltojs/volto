import { describe, expect, it } from "vitest";
import {
  applyDragEnd, moveItem, orderProjects, pinSession, sortPinned, sortProjects,
  toggleProjectExpanded, unpinSession,
} from "../sidebar-layout";
import { DEFAULT_SIDEBAR_STATE } from "../sidebar-state-api";

const projects = [
  { id: "p-b", name: "beta", createdAt: 20 },
  { id: "p-a", name: "alpha", createdAt: 10 },
  { id: "p-c", name: "gamma", createdAt: 30 },
];
const sessions = [
  { id: "s-1", projectId: "p-a", updatedAt: 100 },
  { id: "s-2", projectId: "p-b", updatedAt: 300 },
  { id: "s-3", projectId: "p-a", updatedAt: 200 },
];

describe("orderProjects", () => {
  it("honours the stored order, appends unlisted by createdAt and ignores unknown ids", () => {
    expect(orderProjects(projects, ["p-a", "ghost"]).map((p) => p.id)).toEqual(["p-a", "p-b", "p-c"]);
    expect(orderProjects(projects, []).map((p) => p.id)).toEqual(["p-a", "p-b", "p-c"]);
  });
});

describe("sortProjects", () => {
  const ctx = { order: ["p-c", "p-a"], sessions, locale: "zh" };
  it("manual follows projectOrder", () => {
    expect(sortProjects(projects, "manual", ctx).map((p) => p.id)).toEqual(["p-c", "p-a", "p-b"]);
  });
  it("name sorts by localeCompare", () => {
    expect(sortProjects(projects, "name", ctx).map((p) => p.name)).toEqual(["alpha", "beta", "gamma"]);
  });
  it("recent sorts by the newest session, falling back to createdAt, breaking ties by name then id", () => {
    expect(sortProjects(projects, "recent", ctx).map((p) => p.id)).toEqual(["p-b", "p-a", "p-c"]);
    const tied = [
      { id: "p-2", name: "same", createdAt: 5 },
      { id: "p-1", name: "same", createdAt: 5 },
    ];
    expect(sortProjects(tied, "recent", { order: [], sessions: [], locale: "zh" }).map((p) => p.id)).toEqual(["p-1", "p-2"]);
  });
});

describe("sortPinned", () => {
  it("manual follows pinnedSessionIds and drops unknown ids", () => {
    expect(sortPinned(sessions, "manual", ["s-3", "ghost", "s-1"]).map((s) => s.id)).toEqual(["s-3", "s-1"]);
  });
  it("recent sorts by updatedAt descending", () => {
    expect(sortPinned(sessions, "recent", ["s-1", "s-3"]).map((s) => s.id)).toEqual(["s-3", "s-1"]);
  });
});

describe("moveItem", () => {
  it("moves items and ignores out-of-range or identical indices", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 0, 9)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], -1, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("pin / unpin / toggle", () => {
  it("pins idempotently at the end and unpins by id", () => {
    const once = pinSession(DEFAULT_SIDEBAR_STATE, "s-1");
    const twice = pinSession(once, "s-1");
    expect(twice.pinnedSessionIds).toEqual(["s-1"]);
    expect(pinSession(twice, "s-2").pinnedSessionIds).toEqual(["s-1", "s-2"]);
    expect(unpinSession(twice, "s-1").pinnedSessionIds).toEqual([]);
  });
  it("toggles against the set the caller is actually rendering, not the stored one", () => {
    // A fresh document renders the first project expanded while the field is
    // still absent; expanding a second one must add to that visible set.
    const both = toggleProjectExpanded(DEFAULT_SIDEBAR_STATE, "p-2", ["p-1"]);
    expect(both.expandedProjectIds).toEqual(["p-1", "p-2"]);
    // Collapsing a project that is only visible through the fallback works too.
    expect(toggleProjectExpanded(both, "p-1", ["p-1", "p-2"]).expandedProjectIds).toEqual(["p-2"]);
  });

  it("toggles membership, materialising an explicit array from the absent default", () => {
    const on = toggleProjectExpanded(DEFAULT_SIDEBAR_STATE, "p-a");
    expect(on.expandedProjectIds).toEqual(["p-a"]);
    expect(toggleProjectExpanded(on, "p-a").expandedProjectIds).toEqual([]);
  });
});

describe("applyDragEnd", () => {
  it("writes the moved order and switches that section back to manual", () => {
    const start = { ...DEFAULT_SIDEBAR_STATE, sortModes: { pinned: "recent" as const, projects: "name" as const } };
    const afterPinned = applyDragEnd(start, "pinned", ["s-1", "s-2", "s-3"], 2, 0);
    expect(afterPinned.pinnedSessionIds).toEqual(["s-3", "s-1", "s-2"]);
    expect(afterPinned.sortModes.pinned).toBe("manual");
    const afterProjects = applyDragEnd(afterPinned, "projects", ["p-b", "p-a"], 1, 0);
    expect(afterProjects.projectOrder).toEqual(["p-a", "p-b"]);
    expect(afterProjects.sortModes.projects).toBe("manual");
  });
});