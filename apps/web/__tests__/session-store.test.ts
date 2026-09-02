/**
 * Session store tests.
 *
 * The store uses zustand's persist middleware. Under vitest's node
 * environment there is no localStorage; zustand warns and skips persistence,
 * which is fine — these tests cover in-memory behaviour only.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../stores/session-store.js";

beforeEach(() => {
  useSessionStore.setState({ sessions: [], currentSessionId: null });
});

describe("useSessionStore", () => {
  it("binds a project at creation time", () => {
    const id = useSessionStore.getState().createSession({ projectId: "p1" });
    const session = useSessionStore.getState().sessions.find((s) => s.id === id);
    expect(session?.projectId).toBe("p1");
  });

  it("defaults permissionMode to plan", () => {
    const id = useSessionStore.getState().createSession({ projectId: "p1" });
    const session = useSessionStore.getState().sessions.find((s) => s.id === id);
    expect(session?.permissionMode).toBe("plan");
  });

  it("carries the initial model binding", () => {
    const id = useSessionStore
      .getState()
      .createSession({ projectId: "p1", providerId: "v1", modelId: "m1" });
    const session = useSessionStore.getState().sessions.find((s) => s.id === id);
    expect(session?.providerId).toBe("v1");
    expect(session?.modelId).toBe("m1");
  });

  it("changes the model of an existing session", () => {
    const id = useSessionStore.getState().createSession({ projectId: "p1" });
    useSessionStore.getState().setSessionModel(id, "v2", "m2");
    const session = useSessionStore.getState().sessions.find((s) => s.id === id);
    expect(session?.providerId).toBe("v2");
    expect(session?.modelId).toBe("m2");
  });

  it("changes the permission mode of an existing session", () => {
    const id = useSessionStore.getState().createSession({ projectId: "p1" });
    useSessionStore.getState().setSessionPermissionMode(id, "auto-accept");
    const session = useSessionStore.getState().sessions.find((s) => s.id === id);
    expect(session?.permissionMode).toBe("auto-accept");
  });

  it("groups sessions by project", () => {
    const a = useSessionStore.getState().createSession({ projectId: "p1" });
    useSessionStore.getState().createSession({ projectId: "p2" });
    const forP1 = useSessionStore.getState().getProjectSessions("p1");
    expect(forP1.map((s) => s.id)).toEqual([a]);
  });
});
