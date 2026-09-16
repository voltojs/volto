import { describe, it, expect, vi } from "vitest";
import { resolveImageRefs, createRunner } from "../runner.js";
import { pruneOversizedToolResults, textScript } from "@volto/core";
import type {
  AttachmentStore,
  Message,
  EventSink,
  ModelPort,
  ModelRequest,
  ModelEvent,
  StepContext,
  ReducerState,
} from "@volto/core";

const PNG = "iVBORw0KGgo=";

function storeWith(entries: Record<string, string>): AttachmentStore {
  return {
    put: vi.fn(),
    get: async (id: string) => (entries[id] ? { data: entries[id]!, mimeType: "image/png" } : undefined),
    deleteBySession: vi.fn(),
  } as unknown as AttachmentStore;
}

const messages: Message[] = [
  {
    id: "m1",
    role: "tool",
    content: [
      {
        type: "tool_result",
        toolUseId: "call-1",
        content: [
          { type: "text", text: "a chart" },
          { type: "image", source: { type: "ref", id: "att-1", mediaType: "image/png" }, width: 8, height: 8 },
        ],
      },
    ],
  },
];

/** Narrow a message to its first tool_result's block array, without casting through the union. */
function toolResultBlocks(msg: Message | undefined): Array<Record<string, unknown>> {
  if (!msg || !Array.isArray(msg.content)) throw new Error("expected block-array message");
  const first = msg.content[0];
  if (!first || first.type !== "tool_result") throw new Error("expected tool_result");
  return first.content as unknown as Array<Record<string, unknown>>;
}

describe("resolveImageRefs", () => {
  it("replaces a ref with base64 bytes for the provider", async () => {
    const events: unknown[] = [];
    const sink: EventSink = { emit: (e) => void events.push(e) } as EventSink;
    const out = await resolveImageRefs(messages, storeWith({ "att-1": PNG }), sink);
    const block = toolResultBlocks(out[0])[1]!;
    expect(block).toMatchObject({ type: "image", source: { type: "base64", data: PNG, mediaType: "image/png" } });
  });

  it("degrades to placeholder text when the attachment is gone, without throwing", async () => {
    const events: Array<{ type: string }> = [];
    const sink: EventSink = { emit: (e) => void events.push(e as { type: string }) } as EventSink;
    const out = await resolveImageRefs(messages, storeWith({}), sink);
    const block = toolResultBlocks(out[0])[1]!;
    expect(block).toEqual({ type: "text", text: "[image unavailable: att-1]" });
    expect(events.some((e) => e.type === "attachment_unavailable")).toBe(true);
  });

  it("leaves non-image blocks and string content untouched", async () => {
    const plain: Message[] = [
      { id: "u1", role: "user", content: "hello" },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", id: "call-9", name: "read_file", input: { path: "a.png" } },
        ],
      },
    ];
    const sink: EventSink = { emit: vi.fn() } as unknown as EventSink;
    const out = await resolveImageRefs(plain, storeWith({}), sink);
    expect(out[0]).toEqual(plain[0]);
    expect(out[1]).toEqual(plain[1]);
  });
});

describe("request-surface pruning with images", () => {
  // The runner's request-surface prune is core's pruneOversizedToolResults
  // (already text-only budget from task 2); this pins the contract the
  // runner depends on, from the runner package's own test surface.
  it("truncates text but leaves image blocks whole", () => {
    const long = "x".repeat(50_000);
    const input: Message[] = [
      {
        id: "m1",
        role: "tool",
        content: [{
          type: "tool_result",
          toolUseId: "call-1",
          content: [
            { type: "text", text: long },
            { type: "image", source: { type: "ref", id: "att-1", mediaType: "image/png" }, width: 8, height: 8 },
          ],
        }],
      },
    ];

    const { messages: prunedMessages, pruned } = pruneOversizedToolResults(input, { maxChars: 1000 });
    const blocks = toolResultBlocks(prunedMessages[0]);

    // The image survives: its cost is fixed by area, so dropping it would
    // waste the tool call without saving a comparable number of tokens.
    expect(blocks.find((b) => b.type === "image")).toBeDefined();
    const textAfter = String(blocks[0]!.text ?? "");
    expect(textAfter.length).toBeGreaterThan(0);
    expect(textAfter.length).toBeLessThan(long.length);

    // Char counts describe the text only — counting an image's base64 here
    // would be meaningless, since state never holds its bytes.
    expect(pruned[0]!.charsBefore).toBe(long.length);
    expect(pruned[0]!.charsAfter).toBeLessThan(long.length);
  });
});

// ──────────────────────────────────────────────
// Wiring: the Runner must resolve refs on the request surface
// ──────────────────────────────────────────────

function createSpyModelPort(script: ModelEvent[][]): ModelPort & {
  calls: Array<{ messages: Message[] }>;
} {
  const calls: Array<{ messages: Message[] }> = [];
  let index = 0;
  return {
    calls,
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      calls.push({ messages: req.messages });
      const events = script[index++];
      if (!events) throw new Error(`spy port: no script for call ${index - 1}`);
      for (const ev of events) yield ev;
    },
  };
}

const ctx: StepContext = { tools: [], model: "test-model" };

function makeInitial(messages: Message[]): ReducerState {
  return {
    messages,
    pendingTools: [],
    status: "idle",
    tokenBudget: undefined,
    tokensUsed: 0,
    maxIterations: 20,
    iterationCount: 0,
    readFiles: [],
    _accumulatedText: "",
    _accumulatedReasoning: "",
    _accumulatedToolCalls: [],
    _toolResultBuffer: {},
    queuedUserInputs: [],
    toolCallCount: 0,
    maxToolCalls: undefined,
    maxCostDollars: undefined,
    maxTokensPerTurn: undefined,
    maxWallclockMs: undefined,
    maxLoopCount: undefined,
    selfCorrectionCount: 0,
    maxSelfCorrections: undefined,
  };
}

describe("Runner wires resolveImageRefs into the model request", () => {
  it("sends base64 bytes to the model while state keeps the ref", async () => {
    const history: Message[] = [
      { id: "u0", role: "user", content: "read the chart" },
      {
        id: "t0",
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: "call-1",
            content: [
              { type: "text", text: "a chart" },
              { type: "image", source: { type: "ref", id: "att-1", mediaType: "image/png" }, width: 8, height: 8 },
            ],
          },
        ],
      },
    ];
    const spy = createSpyModelPort([textScript("I see a chart")]);
    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(history),
      attachmentStore: storeWith({ "att-1": PNG }),
    });

    await runner.run({ type: "user_message", content: "what is it?" });

    expect(spy.calls).toHaveLength(1);
    const toolMsg = spy.calls[0]!.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const blocks = toolResultBlocks(toolMsg);
    // Request surface: bytes, not a ref.
    expect(blocks[1]).toMatchObject({
      type: "image",
      source: { type: "base64", data: PNG, mediaType: "image/png" },
    });

    // State surface: the ref, never the bytes.
    const stateTool = runner.getState().messages.find((m) => m.role === "tool");
    const stateBlocks = toolResultBlocks(stateTool);
    expect(stateBlocks[1]).toMatchObject({
      type: "image",
      source: { type: "ref", id: "att-1", mediaType: "image/png" },
    });
  });

  it("degrades a missing attachment on the request surface without breaking the loop", async () => {
    const history: Message[] = [
      {
        id: "t0",
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: "call-1",
            content: [
              { type: "image", source: { type: "ref", id: "att-gone", mediaType: "image/png" } },
            ],
          },
        ],
      },
    ];
    const events: Array<{ type: string }> = [];
    const sink: EventSink = { emit: (e) => void events.push(e as { type: string }) } as EventSink;
    const spy = createSpyModelPort([textScript("ok")]);
    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(history),
      attachmentStore: storeWith({}),
      eventSink: sink,
    });

    // The loop must complete — a cleaned-up attachment is the expected case
    // when replaying an old session, not a crash.
    await runner.run({ type: "user_message", content: "still there?" });

    expect(spy.calls).toHaveLength(1);
    const toolMsg = spy.calls[0]!.messages.find((m) => m.role === "tool");
    const blocks = toolResultBlocks(toolMsg);
    expect(blocks[0]).toEqual({ type: "text", text: "[image unavailable: att-gone]" });
    expect(events.some((e) => e.type === "attachment_unavailable")).toBe(true);
  });
});
