/**
 * T8 Task 3 — Runner-side loop ladder injection (spec 2026-10-16 D2 / §5).
 *
 * Division of labor: the REDUCER books ladder tiers at model_done
 * (loopRemindedCount monotonic, hard termination on exhaustion); the RUNNER
 * fires the loop_reminder / loop_intervention inputs AFTER the batch's
 * tool_results — the same delayed-injection pattern as self_correct.
 *
 * Coverage:
 *  (a) ordering — all tool_results of the batch precede the injected message
 *  (b) full ladder — reminder → intervention → intervention → hard termination
 *  (c) fresh-tier dedup — a count tier already reminded never re-fires
 *  (d) replay — two runs of the same script produce identical (state, events)
 *  (e) repeat chains — reminder only, never intervention / termination
 *  (f) budget isolation — self_correct and loop_intervention counters are independent
 *  (g) maxLoopInterventions: 0 — intervention tier off, first >=K hard-terminates
 */
import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import type { ToolExecutor } from "../runner.js";
import type {
  Validator,
  ValidationResult,
  StepContext,
  ToolDefinition,
  PendingToolCall,
  ToolResult,
  ModelEvent,
  EventSink,
} from "@volto/core";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
  toolUseStart,
  toolUseDelta,
  modelDone,
} from "@volto/core";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const bashTool: ToolDefinition = {
  name: "bash",
  description: "Run a command",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  requires: ["shell:exec"],
  riskTier: "WRITE_LOW",
};

const capabilities = new Set(["filesystem:read", "shell:exec"]);

const FAIL: ToolResult = { modelContent: "EISDIR: file not found", isError: true };
const OK: ToolResult = { modelContent: "some contents", isError: false };

/** Executor driven by a per-tool-name result map. */
function executor(results: Record<string, ToolResult>): ToolExecutor {
  return async (call: PendingToolCall): Promise<ToolResult> =>
    results[call.name] ?? { modelContent: `unknown tool: ${call.name}`, isError: true };
}

/** Capture sink: records every event the runner forwards. */
function captureSink(): { sink: EventSink; events: Array<{ type: string; data: Record<string, unknown> }> } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const sink: EventSink = { emit: (e) => { events.push(e); } };
  return { sink, events };
}

/** Deterministic injected clock — replay must not read wall-clock time. */
function stepClock(): { now(): number } {
  let t = 0;
  return { now: () => (t += 1_000_000) };
}

/** One identical failing read_file call per batch, ids c1..c5. */
function failingReadScript(): ModelEvent[][] {
  return [1, 2, 3, 4, 5].map((i) =>
    toolCallScript(`c${i}`, "read_file", '{"path":"foo.ts"}'),
  );
}

/** A batch streaming TWO tool calls in a single assistant message. */
function twoCallBatch(prefix: string, args = '{"path":"foo.ts"}'): ModelEvent[] {
  return [
    toolUseStart(`${prefix}a`, "read_file"),
    toolUseDelta(`${prefix}a`, args),
    toolUseStart(`${prefix}b`, "read_file"),
    toolUseDelta(`${prefix}b`, args),
    modelDone("tool_use"),
  ];
}

/** Verbatim texts (spec 2 D3) — asserted byte-exact against the injection. */
const REMINDER_ERROR_2 =
  '[LOOP REMINDER] "read_file" has been called 2 times in a row with identical input and each attempt failed. This is the last reminder before a forced stop — change the approach now.';
const REMINDER_REPEAT_3 =
  '[LOOP REMINDER] "read_file" has been called 3 times in a row with identical input. If the repetition is intentional, continue; otherwise vary the input or switch tools.';
const INTERVENTION_3 =
  '[LOOP INTERVENTION] The identical call to "read_file" has failed 3 times. Do not repeat it: vary the input, choose a different tool, or ask the user for direction. Two more identical failures will force-stop this turn.';
const INTERVENTION_4 =
  '[LOOP INTERVENTION] The identical call to "read_file" has failed 4 times. Do not repeat it: vary the input, choose a different tool, or ask the user for direction. Two more identical failures will force-stop this turn.';
const LOOP_ERROR_4 =
  'Loop detected: tool "read_file" has been called 4 times with identical input and returned errors';

type CapturedEvent = { type: string; data: Record<string, unknown> };

/** Contents of all user messages, in order (the injected items are strings). */
function userTexts(messages: ReadonlyArray<{ role: string; content: unknown }>): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""));
}

/** Index of the message carrying a tool_result/tool_use block with this id. */
function messageIndexWithToolId(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  toolId: string,
): number {
  return messages.findIndex((m) => {
    if (!Array.isArray(m.content)) return false;
    return (m.content as Array<Record<string, unknown>>).some(
      (b) => b && (b.toolUseId === toolId || b.id === toolId),
    );
  });
}

/** Index of the injected repair user message containing `marker`. */
function injectedMessageIndex(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  marker: string,
): number {
  return messages.findIndex(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.includes(marker),
  );
}

function reminderKinds(events: CapturedEvent[]): unknown[] {
  return events.filter((e) => e.type === "context_reminder").map((e) => e.data.kind);
}

const loopCtx: StepContext = {
  tools: [readTool, bashTool],
  model: "test-model",
  maxLoopCount: 3,
};

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("T8 Task 3 — runner loop ladder injection", () => {
  it("(a) ordering: every tool_result of the batch precedes the loop_intervention message", async () => {
    const { sink, events } = captureSink();
    const mockModel = createMockModelPort([
      twoCallBatch("c1"),
      twoCallBatch("c2"),
      textScript("done."),
    ]);

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: loopCtx,
      toolExecutor: executor({ read_file: FAIL }),
      availableCapabilities: capabilities,
      eventSink: sink,
      clock: stepClock(),
    });

    const final = await runner.run({ type: "user_message", content: "Go" });

    // The >=K detection lands at batch 2 (1 + 2 prior identical failures).
    expect(final.status).toBe("done");
    expect(final.loopInterventionCount).toBe(1);
    expect(final.loopRemindedCount).toBe(0);

    // Event order: both tool_results of batch 2 (and batch 1) flow before
    // the context_reminder that carries the injected intervention.
    const toolResultIdx = (id: string): number =>
      events.findIndex((e) => e.type === "tool_result" && e.data.callId === id);
    const reminderIdx = events.findIndex((e) => e.type === "context_reminder");
    expect(reminderIdx).toBeGreaterThan(-1);
    for (const id of ["c1a", "c1b", "c2a", "c2b"]) {
      const idx = toolResultIdx(id);
      expect(idx, `tool_result ${id} must exist`).toBeGreaterThan(-1);
      expect(reminderIdx, `tool_result ${id} must precede the injection`).toBeGreaterThan(idx);
    }
    expect(events[reminderIdx]!.data.kind).toBe("loop_intervention");

    // Message order: the batch's two tool messages sit before the injected
    // user message in the canonical history.
    const injectedIdx = injectedMessageIndex(final.messages, "[LOOP INTERVENTION]");
    expect(injectedIdx).toBeGreaterThan(-1);
    expect(injectedIdx).toBeGreaterThan(messageIndexWithToolId(final.messages, "c2a"));
    expect(injectedIdx).toBeGreaterThan(messageIndexWithToolId(final.messages, "c2b"));

    // Exactly one loop item fired for the batch; the next model call saw it.
    expect(reminderKinds(events)).toEqual(["loop_intervention"]);
    expect(userTexts(final.messages)).toEqual(["Go", INTERVENTION_3]);
  });

  it("(b) full ladder: reminder → intervention → intervention → hard termination", async () => {
    const { sink, events } = captureSink();
    const mockModel = createMockModelPort(failingReadScript());

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: loopCtx,
      toolExecutor: executor({ read_file: FAIL }),
      availableCapabilities: capabilities,
      eventSink: sink,
      clock: stepClock(),
    });

    const final = await runner.run({ type: "user_message", content: "Go" });

    // Batch 5 exhausts the budget → done + error, batch never executes.
    expect(final.status).toBe("done");
    expect(mockModel.callCount).toBe(5);
    expect(final.loopRemindedCount).toBe(2);
    expect(final.loopInterventionCount).toBe(2);

    // Message sequence: reminder at count 2, then one intervention per
    // >=K round until the budget (2) is consumed.
    expect(userTexts(final.messages)).toEqual([
      "Go",
      REMINDER_ERROR_2,
      INTERVENTION_3,
      INTERVENTION_4,
    ]);

    // Event sequence: exactly one context_reminder per fresh tier, in order.
    expect(reminderKinds(events)).toEqual([
      "loop_reminder",
      "loop_intervention",
      "loop_intervention",
    ]);
    const err = events.find((e) => e.type === "error");
    expect(err, "hard termination must emit the loop error").toBeDefined();
    expect(err!.data.error).toBe(LOOP_ERROR_4);
  });

  it("(c) fresh-tier dedup: a count tier already reminded never fires twice", async () => {
    const { sink, events } = captureSink();
    // Chain A reaches K-1 (=2) → reminder fires. Chain breaks (different
    // input) and climbs back to count 2 → the monotonic loopRemindedCount
    // already covers that tier → NO second reminder, no intervention.
    const mockModel = createMockModelPort([
      toolCallScript("d1", "read_file", '{"path":"foo.ts"}'),
      toolCallScript("d2", "read_file", '{"path":"foo.ts"}'),
      toolCallScript("d3", "read_file", '{"path":"bar.ts"}'),
      toolCallScript("d4", "read_file", '{"path":"bar.ts"}'),
      textScript("done."),
    ]);

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: loopCtx,
      toolExecutor: executor({ read_file: FAIL }),
      availableCapabilities: capabilities,
      eventSink: sink,
      clock: stepClock(),
    });

    const final = await runner.run({ type: "user_message", content: "Go" });

    expect(final.status).toBe("done");
    expect(mockModel.callCount).toBe(5);
    expect(final.loopRemindedCount).toBe(2); // never re-marked, stays at tier 2
    expect(final.loopInterventionCount).toBe(0);

    expect(reminderKinds(events)).toEqual(["loop_reminder"]);
    const reminders = userTexts(final.messages).filter((t) => t.startsWith("[LOOP REMINDER]"));
    expect(reminders).toEqual([REMINDER_ERROR_2]);
    // No intervention and no termination at any point.
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  it("(d) replay: two runs of the same script produce identical (state, events)", async () => {
    const runOnce = async () => {
      const { sink, events } = captureSink();
      const mockModel = createMockModelPort(failingReadScript());
      const runner = createRunner({
        modelPort: mockModel,
        stepContext: loopCtx,
        toolExecutor: executor({ read_file: FAIL }),
        availableCapabilities: capabilities,
        eventSink: sink,
        clock: stepClock(),
      });
      const final = await runner.run({ type: "user_message", content: "Go" });
      return { final, events };
    };

    const first = await runOnce();
    const second = await runOnce();

    // Byte-identical final state, including the injected reminder /
    // intervention messages and both counters.
    expect(second.final).toEqual(first.final);
    // Byte-identical effect surface (the forwarded event sequence).
    expect(second.events).toEqual(first.events);
    expect(first.events.filter((e) => e.type === "context_reminder")).toHaveLength(3);
  });

  it("(e) repeat chain: reminder (repeat variant) only — never intervention or termination", async () => {
    const { sink, events } = captureSink();
    const mockModel = createMockModelPort([
      toolCallScript("p1", "read_file", '{"path":"foo.ts"}'),
      toolCallScript("p2", "read_file", '{"path":"foo.ts"}'),
      toolCallScript("p3", "read_file", '{"path":"foo.ts"}'),
      textScript("done."),
    ]);

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: loopCtx,
      toolExecutor: executor({ read_file: OK }),
      availableCapabilities: capabilities,
      eventSink: sink,
      clock: stepClock(),
    });

    const final = await runner.run({ type: "user_message", content: "Go" });

    // Reminder tier for repeat chains fires at >= K (count 3), not at K-1.
    expect(final.status).toBe("done");
    expect(mockModel.callCount).toBe(4);
    expect(final.loopRemindedCount).toBe(3);
    expect(final.loopInterventionCount).toBe(0);

    expect(reminderKinds(events)).toEqual(["loop_reminder"]);
    const texts = userTexts(final.messages);
    expect(texts).toEqual(["Go", REMINDER_REPEAT_3]);
    // A repeat chain never reaches the intervention tier nor the error path.
    expect(events.find((e) => e.type === "context_reminder" && e.data.kind === "loop_intervention")).toBeUndefined();
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  it("(f) budget isolation: self_correct repairs and loop_intervention coexist with independent counters", async () => {
    const { sink, events } = captureSink();
    // Validator fails only for read_file successes (self_correct tier);
    // bash results are errors and drive the loop ladder instead.
    const readFileValidator: Validator = {
      name: "schema-v",
      validate(toolName: string, _content: string): ValidationResult {
        return toolName === "read_file"
          ? { passed: false, failures: ["payload shape mismatch"], validatorName: "schema-v" }
          : { passed: true, failures: [], validatorName: "schema-v" };
      },
    };

    const mockModel = createMockModelPort([
      // self_correct tier: one successful read_file that fails validation.
      toolCallScript("s1", "read_file", '{"path":"bar.ts"}'),
      // loop ladder on bash: count 1 → 2 (reminder) → 3 → 4 → exhausted.
      toolCallScript("b1", "bash", '{"command":"echo hi"}'),
      toolCallScript("b2", "bash", '{"command":"echo hi"}'),
      toolCallScript("b3", "bash", '{"command":"echo hi"}'),
      toolCallScript("b4", "bash", '{"command":"echo hi"}'),
      toolCallScript("b5", "bash", '{"command":"echo hi"}'),
    ]);

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: loopCtx,
      toolExecutor: executor({ read_file: OK, bash: FAIL }),
      availableCapabilities: capabilities,
      validators: [readFileValidator],
      selfCorrectionMax: 2,
      eventSink: sink,
      clock: stepClock(),
    });

    const final = await runner.run({ type: "user_message", content: "Go" });

    expect(final.status).toBe("done");
    expect(mockModel.callCount).toBe(6);
    // Counters are fully independent: one self-correction consumed, both
    // loop interventions consumed, reminder bookkeeping untouched by either.
    expect(final.selfCorrectionCount).toBe(1);
    expect(final.loopInterventionCount).toBe(2);
    expect(final.loopRemindedCount).toBe(2);

    expect(reminderKinds(events)).toEqual([
      "self_correction",
      "loop_reminder",
      "loop_intervention",
      "loop_intervention",
    ]);
    const texts = userTexts(final.messages);
    expect(texts.filter((t) => t.includes("[SELF-CORRECT"))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith("[LOOP REMINDER]"))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith("[LOOP INTERVENTION]"))).toHaveLength(2);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.data.error).toBe(
      'Loop detected: tool "bash" has been called 4 times with identical input and returned errors',
    );
  });

  it("(g) maxLoopInterventions: 0 disables the intervention tier (today's hard termination)", async () => {
    const { sink, events } = captureSink();
    const zeroBudgetCtx: StepContext = { ...loopCtx, maxLoopInterventions: 0 };
    const mockModel = createMockModelPort([
      toolCallScript("z1", "read_file", '{"path":"foo.ts"}'),
      toolCallScript("z2", "read_file", '{"path":"foo.ts"}'),
      toolCallScript("z3", "read_file", '{"path":"foo.ts"}'),
    ]);

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: zeroBudgetCtx,
      toolExecutor: executor({ read_file: FAIL }),
      availableCapabilities: capabilities,
      eventSink: sink,
      clock: stepClock(),
    });

    const final = await runner.run({ type: "user_message", content: "Go" });

    // Soft reminder still fires at K-1; the first >=K detection
    // hard-terminates because the budget is zero.
    expect(final.status).toBe("done");
    expect(mockModel.callCount).toBe(3);
    expect(final.loopInterventionCount).toBe(0);
    expect(reminderKinds(events)).toEqual(["loop_reminder"]);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.data.error).toBe(
      'Loop detected: tool "read_file" has been called 3 times with identical input and returned errors',
    );
  });
});
