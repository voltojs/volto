// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useSessionStore } from "../session-store";
import { loadStoredSessionId, persistSessionId } from "@/lib/session-persistence";
import { applyServerSummaries, restoreStoredSession } from "@/hooks/use-server-sessions";
import type { ServerSessionSummary } from "@/lib/sessions-api";

const summary = (id: string): ServerSessionSummary => ({
  id,
  projectId: null,
  providerId: null,
  modelId: null,
  permissionMode: null,
  messageCount: 0,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  running: false,
});

beforeEach(() => {
  window.localStorage.clear();
  useSessionStore.setState({ sessions: [], currentSessionId: null });
});

describe("active session persistence", () => {
  it("persists an explicit selection and clears it for the welcome screen", () => {
    useSessionStore.getState().setCurrentSession("s-1");
    expect(loadStoredSessionId()).toBe("s-1");
    useSessionStore.getState().setCurrentSession(null);
    expect(loadStoredSessionId()).toBeNull();
  });

  it("restores a stored session that the server still lists", () => {
    persistSessionId("s-1");
    expect(restoreStoredSession([summary("s-1"), summary("s-2")])).toBe("s-1");
    expect(useSessionStore.getState().currentSessionId).toBe("s-1");
  });

  it("drops a stored session that no longer exists", () => {
    persistSessionId("gone");
    expect(restoreStoredSession([summary("s-1")])).toBeNull();
    expect(loadStoredSessionId()).toBeNull();
  });

  it("keeps loaded detail when a background status refresh replaces summaries", () => {
    const loaded = {
      ...summary("s-1"),
      title: "old",
      detailLoaded: true,
      messages: [{ id: "m1", role: "user", content: "hello", blocks: [] }],
      running: false,
    };
    useSessionStore.setState({ sessions: [loaded as never], currentSessionId: "s-1" });

    applyServerSummaries([{ ...summary("s-1"), title: "new", running: false }]);

    const refreshed = useSessionStore.getState().sessions[0];
    expect(refreshed?.title).toBe("new");
    expect(refreshed?.detailLoaded).toBe(true);
    expect(refreshed?.messages).toEqual(loaded.messages);
  });

  it("tracks the running flag per session", () => {
    useSessionStore.setState({ sessions: [{ ...summary("s-1") } as never] });
    useSessionStore.getState().setSessionRunning("s-1", true);
    expect(useSessionStore.getState().sessions[0]?.running).toBe(true);
    useSessionStore.getState().setSessionRunning("s-1", false);
    expect(useSessionStore.getState().sessions[0]?.running).toBe(false);
  });
});
