// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadStoredSessionId, persistSessionId } from "../session-persistence";

beforeEach(() => window.localStorage.clear());

describe("session persistence", () => {
  it("stores and reads the active session id", () => {
    persistSessionId("s-1");
    expect(window.localStorage.getItem("volto.currentSessionId")).toBe("s-1");
    expect(loadStoredSessionId()).toBe("s-1");
  });

  it("clears the stored id when there is no active session", () => {
    persistSessionId("s-1");
    persistSessionId(null);
    expect(loadStoredSessionId()).toBeNull();
  });
});
