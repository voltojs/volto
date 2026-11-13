/**
 * SDK file-watcher wiring + idle auto-wake.
 *
 * Covers F-026..F-031 from the file-watcher plan:
 * - capability + three tools only when fileWatcher is injected
 * - onFileWatchEvents runs before agent.run
 * - default auto-wake starts a turn on file_changed
 * - fileWatchAutoWake: false never starts a turn
 * - run rejection surfaces as an error emit; callback does not throw
 * - busy: a batch during an in-flight turn queues and runs after settle
 *
 * Model-call indexing note: a registration turn costs TWO model calls —
 * (1) tool_use watch_files, (2) text end_turn after the tool result.
 * Auto-wake turns start at call 3.
 */

import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type {
  FileWatchEvent,
  FileWatcher,
  ModelPort,
  ModelEvent,
  ModelRequest,
} from "@voltojs/core";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

interface FakeWatcher extends FileWatcher {
  /** Fire a debounced batch on a registered watch id. */
  emit(watchId: string, events: FileWatchEvent[]): void;
  /** Currently registered ids (test assertion aid). */
  activeIds(): string[];
}

function createFakeFileWatcher(): FakeWatcher {
  const callbacks = new Map<string, (events: FileWatchEvent[]) => void>();
  let nextId = 0;
  return {
    async watch(_reg, onEvents) {
      const id = `watch-${nextId++}`;
      callbacks.set(id, onEvents);
      return id;
    },
    async unwatch(id) {
      return callbacks.delete(id);
    },
    async list() {
      return [...callbacks.keys()];
    },
    async dispose() {
      callbacks.clear();
    },
    emit(watchId, events) {
      const cb = callbacks.get(watchId);
      if (!cb) throw new Error(`no watch registered: ${watchId}`);
      cb(events);
    },
    activeIds() {
      return [...callbacks.keys()];
    },
  };
}

const changeEvent: FileWatchEvent = { type: "change", path: "src/a.ts" };

/** Poll until `predicate` is true or the deadline elapses. */
async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

/**
 * Scripted model port. `scripts[n]` is consumed by stream() call n (1-based
 * via the counter). Helper `registrationScripts` builds the two-call
 * watch_files registration preamble.
 */
function scriptedModelPort(
  scripts: Array<() => AsyncGenerator<ModelEvent> | Generator<ModelEvent>>,
): ModelPort & { callCount: number } {
  let call = 0;
  return {
    get callCount() {
      return call;
    },
    async *stream() {
      call++;
      const gen = scripts[call - 1];
      if (!gen) {
        throw new Error(`scriptedModelPort: no script for call ${call}`);
      }
      yield* gen();
    },
  };
}

function* regCall1(paths = ["src"]): Generator<ModelEvent> {
  yield { type: "tool_use_start", toolCallId: "c1", toolName: "watch_files" };
  yield {
    type: "tool_use_delta",
    toolCallId: "c1",
    argumentsDelta: JSON.stringify({ paths }),
  };
  yield { type: "done", stopReason: "tool_use" };
}

function* regCall2(text = "watching"): Generator<ModelEvent> {
  yield { type: "text_delta", text };
  yield { type: "done", stopReason: "end_turn" };
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("createAgent file-watcher wiring", () => {
  it("does not register watch tools or filesystem:watch without fileWatcher (F-026/F-027)", async () => {
    const captured: ModelRequest[] = [];
    const agent = createAgent({
      modelPort: {
        async *stream(req) {
          captured.push(req);
          yield { type: "text_delta", text: "ok" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      capabilities: new Set<string>(),
    });

    await agent.run("hi");

    expect(captured).toHaveLength(1);
    const names = captured[0]!.tools.map((t) => t.name);
    expect(names).not.toContain("watch_files");
    expect(names).not.toContain("unwatch_files");
    expect(names).not.toContain("list_watches");
  });

  it("registers the three watch tools and filesystem:watch when fileWatcher is injected (F-026/F-027)", async () => {
    const captured: ModelRequest[] = [];
    const agent = createAgent({
      modelPort: {
        async *stream(req) {
          captured.push(req);
          yield { type: "text_delta", text: "ok" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      fileWatcher: createFakeFileWatcher(),
      // Empty host capabilities — proves createAgent adds filesystem:watch
      // itself (tools require it; without the cap they would be gated out).
      capabilities: new Set<string>(),
    });

    await agent.run("hi");

    expect(captured).toHaveLength(1);
    const names = captured[0]!.tools.map((t) => t.name);
    expect(names).toContain("watch_files");
    expect(names).toContain("unwatch_files");
    expect(names).toContain("list_watches");
  });

  it("routes watch_files through the FileWatcher port, not the FileSystem executor (F-027)", async () => {
    const watcher = createFakeFileWatcher();
    // Provide BOTH fs and fileWatcher — this is the shape that used to
    // short-circuit watch_files into createFsToolExecutor ("Unknown tool").
    const modelPort = scriptedModelPort([
      () => regCall1(),
      () => regCall2("watched"),
    ]);
    const agent = createAgent({
      modelPort,
      fileWatcher: watcher,
      fs: {
        read: async () => ({ content: "", totalLines: 0, truncated: false }),
        readBytes: async () => ({ data: "", size: 0 }),
        write: async () => {},
        stat: async (path: string) => ({ path, isDirectory: false, size: 0, mtime: 0 }),
        list: async () => ({ entries: [] }),
        glob: async () => ({ paths: [] }),
        grep: async () => ({ matches: [], truncated: false }),
      },
      capabilities: new Set<string>([
        "filesystem:read",
        "filesystem:write",
        "filesystem:watch",
      ]),
    });

    const state = await agent.run("watch src");
    expect(state.status).toBe("done");
    expect(modelPort.callCount).toBe(2);

    const toolMsg = state.messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMsg)).toContain("watch_id=watch-0");
    expect(watcher.activeIds()).toEqual(["watch-0"]);
  });
});

describe("createAgent file-watch auto-wake", () => {
  it("calls onFileWatchEvents before starting the auto-wake run (F-030)", async () => {
    const order: string[] = [];
    const watcher = createFakeFileWatcher();
    const modelPort = scriptedModelPort([
      () => {
        order.push("register-turn");
        return regCall1();
      },
      () => {
        order.push("reg-end");
        return regCall2();
      },
      () => {
        order.push("model-stream");
        return regCall2("woke");
      },
    ]);

    const agent = createAgent({
      modelPort,
      fileWatcher: watcher,
      onFileWatchEvents: (watchId) => {
        order.push(`callback:${watchId}`);
      },
    });

    await agent.run("start watching");
    watcher.emit("watch-0", [changeEvent]);

    await waitUntil(() => order.includes("model-stream"), "auto-wake model call");

    expect(order).toEqual([
      "register-turn",
      "reg-end",
      "callback:watch-0",
      "model-stream",
    ]);
  });

  it("auto-wakes a turn on file_changed by default and injects the notice (F-028)", async () => {
    const watcher = createFakeFileWatcher();
    const modelPort = scriptedModelPort([
      () => regCall1(),
      () => regCall2(),
      () => regCall2("handling watch"),
    ]);

    const agent = createAgent({ modelPort, fileWatcher: watcher });
    const regState = await agent.run("start watching src");
    expect(regState.status).toBe("done");
    expect(modelPort.callCount).toBe(2);

    // Default auto-wake: idle + event → a third turn starts by itself.
    watcher.emit("watch-0", [
      { type: "change", path: "src/app.ts" },
      { type: "rename", path: "src/old.ts" },
    ]);

    await waitUntil(() => modelPort.callCount >= 3, "auto-wake model call");
    await waitUntil(() => {
      try {
        return agent.getState().status === "done";
      } catch {
        return false;
      }
    }, "auto-wake turn done");

    const state = agent.getState();
    const notice = state.messages.find(
      (m) => typeof m.content === "string" && m.content.includes('File watch "watch-0"'),
    );
    expect(notice).toBeDefined();
    expect(notice!.content).toContain("src/app.ts");
    expect(notice!.content).toContain("src/old.ts");
    expect(state.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("does not auto-wake when fileWatchAutoWake is false (F-029)", async () => {
    const watcher = createFakeFileWatcher();
    const modelPort = scriptedModelPort([
      () => regCall1(),
      () => regCall2(),
      // Script 3 exists only so a mistaken auto-wake would not throw
      // "no script" — the assertion is that callCount stays at 2.
      () => regCall2("should not run"),
    ]);

    const agent = createAgent({
      modelPort,
      fileWatcher: watcher,
      fileWatchAutoWake: false,
    });

    await agent.run("start watching");
    expect(modelPort.callCount).toBe(2);

    watcher.emit("watch-0", [changeEvent]);

    // Give any (incorrect) auto-wake a chance to start.
    await new Promise((r) => setTimeout(r, 50));

    expect(modelPort.callCount).toBe(2);
    expect(agent.getState().status).toBe("done");
    expect(
      agent.getState().messages.some(
        (m) => typeof m.content === "string" && m.content.includes("File watch"),
      ),
    ).toBe(false);
  });

  it("still invokes onFileWatchEvents when auto-wake is off (F-029/F-030)", async () => {
    const watcher = createFakeFileWatcher();
    const batches: Array<{ watchId: string; events: FileWatchEvent[] }> = [];
    const modelPort = scriptedModelPort([
      () => regCall1(),
      () => regCall2(),
    ]);

    const agent = createAgent({
      modelPort,
      fileWatcher: watcher,
      fileWatchAutoWake: false,
      onFileWatchEvents: (watchId, events) => {
        batches.push({ watchId, events });
      },
    });

    await agent.run("start watching");
    watcher.emit("watch-0", [changeEvent]);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({ watchId: "watch-0", events: [changeEvent] });
    expect(modelPort.callCount).toBe(2);
  });

  it("emits error on auto-wake run rejection and does not throw into the watcher callback (F-031)", async () => {
    const watcher = createFakeFileWatcher();
    const sinkEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    // The Runner swallows model-port throws (retry → model_error). Force a
    // real run() rejection via a per-turn createNextRunner failure (config
    // layer is re-read on every turn claim), rethrown by agent.run().
    // resolveContextLayers is once-per-conversation and cannot fail the wake.
    let configReads = 0;
    const modelPort = scriptedModelPort([
      () => regCall1(),
      () => regCall2(),
      () => regCall2("should not reach"),
    ]);

    const agent = createAgent({
      modelPort,
      fileWatcher: watcher,
      eventSink: { emit: (e) => sinkEvents.push(e) },
      config: {
        config: {
          get reasoningStrategy(): "emit" {
            configReads++;
            if (configReads > 1) {
              throw new Error("context layers exploded during auto-wake");
            }
            return "emit";
          },
        },
        resolvedFrom: {},
      },
      resolveContextLayers: async () => [],
    });

    await agent.run("start watching");

    // Must not throw into the fake watcher's emit → adapter callback.
    expect(() => watcher.emit("watch-0", [changeEvent])).not.toThrow();

    await waitUntil(
      () => sinkEvents.some((e) => e.type === "error"),
      "error event on auto-wake failure",
    );

    const err = sinkEvents.find((e) => e.type === "error")!;
    expect(String(err.data["error"])).toContain("context layers exploded during auto-wake");
    // The auto-wake turn never reached the model.
    expect(modelPort.callCount).toBe(2);
  });

  it("does not throw into the watcher callback when onFileWatchEvents throws (F-031)", async () => {
    const watcher = createFakeFileWatcher();
    const modelPort = scriptedModelPort([
      () => regCall1(),
      () => regCall2(),
      () => regCall2("still woke"),
    ]);

    const agent = createAgent({
      modelPort,
      fileWatcher: watcher,
      onFileWatchEvents: () => {
        throw new Error("host sink blew up");
      },
    });

    await agent.run("start watching");

    expect(() => watcher.emit("watch-0", [changeEvent])).not.toThrow();
    // Auto-wake still proceeds despite the host callback throwing.
    await waitUntil(() => modelPort.callCount >= 3, "auto-wake despite host callback throw");
  });

  it("queues a batch that arrives during an in-flight turn and runs it after settle (busy)", async () => {
    const watcher = createFakeFileWatcher();
    let releaseSlow: (() => void) | null = null;
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r;
    });

    // call 1+2: register; call 3: slow host turn; call 4: queued auto-wake.
    const modelPort = scriptedModelPort([
      () => regCall1(),
      () => regCall2(),
      async function* () {
        yield { type: "text_delta", text: "slow start" };
        await slowGate;
        yield { type: "done", stopReason: "end_turn" };
      },
      () => regCall2("woke from queue"),
    ]);

    const agent = createAgent({ modelPort, fileWatcher: watcher });
    await agent.run("start watching");
    expect(modelPort.callCount).toBe(2);

    // Start a slow host turn — do not await yet.
    const slowPromise = agent.run("slow work");
    // turnInFlight is set synchronously at the start of run(); yield so the
    // runner actually enters the model call.
    await new Promise((r) => setTimeout(r, 20));
    expect(modelPort.callCount).toBe(3);

    // Event arrives while busy → must queue, not start a concurrent runner.
    watcher.emit("watch-0", [changeEvent]);
    expect(modelPort.callCount).toBe(3);

    releaseSlow!();
    await slowPromise;

    // Drain starts the auto-wake turn after the slow turn settles.
    await waitUntil(() => modelPort.callCount >= 4, "queued auto-wake after busy turn");
    await waitUntil(() => {
      try {
        return agent.getState().status === "done";
      } catch {
        return false;
      }
    }, "queued turn done");

    const state = agent.getState();
    expect(
      state.messages.some(
        (m) => typeof m.content === "string" && m.content.includes('File watch "watch-0"'),
      ),
    ).toBe(true);
  });
});
