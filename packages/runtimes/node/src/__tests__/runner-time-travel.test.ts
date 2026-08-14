/**
 * Time-travel resume — execution-side of the M12 time-travel debugger.
 *
 * Proves the full loop: run a turn → checkpoint written at the turn boundary
 * → rewind to that checkpoint state (debugger.rewindTo) → start a fresh
 * runner from it via `initialState` → the session continues with its history
 * intact. This is what the desktop debug panel's "rewind & continue" will
 * drive over IPC.
 */

import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import { createMockModelPort, toolCallScript, textScript, resetTurnForNextInput } from "@volto/core";
import type { SessionStore, SessionSnapshot, StepContext, ToolDefinition, ReducerState } from "@volto/core";

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const ctx: StepContext = { tools: [readTool], model: "test-model" };
const capabilities = new Set(["filesystem:read"]);

/** In-memory SessionStore that records every save (checkpoint history). */
function memoryStore(): SessionStore & { snapshots: SessionSnapshot[] } {
  const snapshots: SessionSnapshot[] = [];
  return {
    snapshots,
    async save(s) {
      snapshots.push(s);
    },
    async load(id) {
      return [...snapshots].reverse().find((s) => s.id === id);
    },
    async list() {
      return snapshots;
    },
  };
}

describe("time-travel resume", () => {
  it("rewinds to a checkpoint state and continues running from it", async () => {
    const store = memoryStore();

    // ── Turn 1: user → model(tool_use) → tool → model(text) → done ──
    const runner1 = createRunner({
      modelPort: createMockModelPort([
        toolCallScript("call_1", "read_file", '{"path":"a.ts"}'),
        textScript("a.ts 已读取。"),
      ]),
      stepContext: ctx,
      toolExecutor: async () => ({ modelContent: "file-a" }),
      availableCapabilities: capabilities,
      sessionStore: store,
      sessionId: "tt-1",
    });
    const final1 = await runner1.run({ type: "user_message", content: "读 a.ts" });
    expect(final1.status).toBe("done");

    // Checkpoint history was written at the turn boundary: tt-1#1
    const cp = store.snapshots.find((s) => s.id === "tt-1#1");
    expect(cp).toBeDefined();
    // SessionSnapshot.state is typed as AgentState; the stored payload is the
    // full ReducerState (incl. internal accumulator fields) — safe cast.
    const checkpointState = cp!.state as ReducerState;
    expect(checkpointState.status).toBe("done");
    expect(checkpointState.messages[0]).toMatchObject({ role: "user", content: "读 a.ts" });

    // ── Time travel: continue from the rewound checkpoint state ──
    // The checkpoint is a terminal `done` state; reducer rejects inputs on
    // done. `resetTurnForNextInput` (the same primitive createAgent uses to
    // carry history across turns) makes it resumable while preserving all
    // conversation history.
    const resumable = resetTurnForNextInput(checkpointState);
    const runner2 = createRunner({
      modelPort: createMockModelPort([textScript("b.ts 也读好了。")]),
      stepContext: ctx,
      toolExecutor: async () => ({ modelContent: "file-b" }),
      availableCapabilities: capabilities,
      sessionStore: store,
      sessionId: "tt-1",
      initialState: resumable,
    });
    const final2 = await runner2.run({ type: "user_message", content: "继续读 b.ts" });

    expect(final2.status).toBe("done");
    // History from the rewound state is preserved…
    const roles = final2.messages.map((m) => m.role);
    expect(roles[0]).toBe("user");
    expect(final2.messages[0]).toMatchObject({ content: "读 a.ts" });
    expect(final2.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", stopReason: "end_turn" }),
    );
    // …and the new turn ran to completion on top of it (last message is the
    // turn-2 assistant reply).
    expect(final2.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "end_turn" });
    // Turn 2 user message is present in the continued session.
    expect(final2.messages.some((m) => m.role === "user" && m.content === "继续读 b.ts")).toBe(true);
  });
});
