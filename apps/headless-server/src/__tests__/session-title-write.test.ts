/**
 * `writeSessionTitle` itself: what it appends, how it serializes, and what it
 * promises about failures. Driven through the registry's exposed `writeTitle`
 * against a fake transcript store, so the interleavings a real clock cannot be
 * made to produce are exact.
 */

import { describe, expect, it } from "vitest";
import type { ChatSessionMeta, TranscriptEventInput } from "@volto/core";
import { createSessionRegistry } from "../sessions.js";

interface FakeStore {
  meta: ChatSessionMeta | undefined;
  appendCalls: Array<{ sessionId: string; events: TranscriptEventInput[] }>;
  /** Runs before the append is applied; lets a test hold one write in flight. */
  onAppend?: (call: number) => Promise<void> | void;
  readSession: (id: string) => Promise<{ meta: ChatSessionMeta; events: [] } | undefined>;
  appendEvents: (
    workspace: string | null,
    id: string,
    events: readonly TranscriptEventInput[],
  ) => Promise<void>;
}

/**
 * A transcript store that folds `session_meta` field-by-field exactly like
 * `@volto/store-jsonl` does — the property every title write relies on.
 */
function fakeStore(initial?: ChatSessionMeta): FakeStore {
  const store: FakeStore = {
    meta: initial,
    appendCalls: [],
    async readSession() {
      return store.meta === undefined ? undefined : { meta: { ...store.meta }, events: [] };
    },
    async appendEvents(_workspace, sessionId, events) {
      const call = store.appendCalls.length;
      store.appendCalls.push({ sessionId, events: [...events] });
      await store.onAppend?.(call);
      for (const event of events) {
        if (event.type !== "session_meta") continue;
        store.meta = { ...(store.meta ?? ({} as ChatSessionMeta)), ...event.data };
      }
    },
  };
  return store;
}

/**
 * A registry whose session pool has `s1`. `write` is only consulted for
 * frames carrying a transcript event — attach()'s own `: connected` comment
 * and CONNECTED token frame must get through for the channel to exist.
 */
function registryFor(store: FakeStore, write?: (chunk: string) => void) {
  const registry = createSessionRegistry({ chatStore: store as never });
  registry.attach("s1", {
    write: (chunk: string) => {
      if (chunk.includes("session_meta")) write?.(chunk);
    },
    on: () => {},
  } as never);
  return registry;
}

describe("writeSessionTitle", () => {
  it("appends only the title fields, never a snapshot of the rest", async () => {
    // The stored meta is folded field-by-field, so a full snapshot would
    // re-write whatever it read — blanking a field that changed after the
    // read, and (with no record yet) stamping `projectId: null` onto a
    // session whose header lands later.
    const store = fakeStore({
      projectId: "p1",
      providerId: "v1",
      modelId: "m1",
      permissionMode: "ask",
    } as ChatSessionMeta);
    const registry = registryFor(store);

    await expect(registry.writeTitle("s1", "重构会话标题", "heuristic")).resolves.toBe("written");

    expect(store.appendCalls[0]!.events).toHaveLength(1);
    expect(store.appendCalls[0]!.events[0]!.data).toEqual({
      title: "重构会话标题",
      titleSource: "heuristic",
    });
    // And the fold still yields the full meta.
    expect(store.meta).toEqual({
      projectId: "p1",
      providerId: "v1",
      modelId: "m1",
      permissionMode: "ask",
      title: "重构会话标题",
      titleSource: "heuristic",
    });
  });

  it("keeps a user rename that lands while a model title is in flight", async () => {
    const store = fakeStore({ title: "首条消息", titleSource: "heuristic", projectId: null, providerId: null, modelId: null, permissionMode: null } as ChatSessionMeta);
    const registry = registryFor(store);

    // Hold the model write inside its append; the user's rename starts while
    // it is parked there. Serialized behind it, the rename re-reads the
    // model's result and wins on rank instead of racing it.
    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.onAppend = (call) => (call === 0 ? parked : undefined);

    const modelWrite = registry.writeTitle("s1", "模型标题", "model");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const userWrite = registry.writeTitle("s1", "我起的名字", "user");
    release();
    await Promise.all([modelWrite, userWrite]);

    expect(store.meta?.title).toBe("我起的名字");
    expect(store.meta?.titleSource).toBe("user");
  });

  it("resolves instead of rejecting when the live channel throws", async () => {
    // Titles ride the turn's critical path: a broken SSE write must never
    // surface as a failed turn.
    const store = fakeStore({ projectId: null, providerId: null, modelId: null, permissionMode: null } as ChatSessionMeta);
    const registry = registryFor(store, () => {
      throw new Error("socket closed");
    });

    await expect(registry.writeTitle("s1", "标题", "user")).resolves.toBe("written");
    expect(store.meta?.title).toBe("标题");
  });
});
