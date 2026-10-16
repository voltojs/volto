/**
 * Runner compaction image offload (T7 Task 2, F-023) — after the summary
 * model call succeeds and BEFORE compaction_applied is fed, the Runner plans
 * image preservation purely (planImageOffload), offloads inline base64 bytes
 * into the AttachmentStore under deterministic ids, and feeds the resolved
 * ref blocks back via compaction_applied.preservedImages.
 *
 * Groups: inline offload (deterministic id + original bytes), ref-only
 * passthrough, put-failure fail-soft (Review Focus 3), replay determinism
 * (Review Focus 4), idSuffix collision (top-level vs nested at the same
 * container-local index), cap (last N), and the preserveImageCount <= 0
 * guard (today's behavior, byte-identical string summary).
 */

import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import { createCharTokenizer, textScript } from "@volto/core";
import type {
  AttachmentStore,
  ContentBlock,
  EventSink,
  Message,
  ModelEvent,
  ModelPort,
  ModelRequest,
  ReducerState,
  StepContext,
  StoredAttachment,
} from "@volto/core";

const ctx: StepContext = { tools: [], model: "test-model" };

/** Recording ModelPort: replays a script of event sequences per call. */
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

function captureEvents(): { events: Array<{ type: string; data: Record<string, unknown> }>; sink: EventSink } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return { events, sink: { emit: (e) => { events.push(e); } } };
}

/** Fake AttachmentStore recording every put attempt (success or throw). */
function fakeAttachmentStore(opts: {
  failOn?: (id: string) => boolean;
  seed?: Record<string, { data: string; mimeType: string }>;
} = {}) {
  const attempts: Array<{ data: string; mimeType: string; opts?: { name?: string; id?: string } }> = [];
  const files = new Map<string, StoredAttachment & { data: string }>();
  for (const [id, v] of Object.entries(opts.seed ?? {})) {
    files.set(id, { id, mimeType: v.mimeType, size: 4, data: v.data });
  }
  const store: AttachmentStore = {
    async put(data, mimeType, putOpts) {
      attempts.push({ data, mimeType, ...(putOpts !== undefined ? { opts: putOpts } : {}) });
      const id = putOpts?.id ?? `uuid-${attempts.length}`;
      if (opts.failOn?.(id)) throw new Error("disk full");
      const meta: StoredAttachment = { id, mimeType, size: Buffer.byteLength(data, "base64") };
      files.set(id, { ...meta, data });
      return meta;
    },
    async get(id) {
      return files.get(id);
    },
    async deleteBySession() {},
  };
  return { attempts, store };
}

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

const SYS: Message = { id: "sys", role: "system", content: "S" };

/** Alternating user/assistant filler, long enough to blow a small budget. */
function textHistory(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    const filler = `turn ${i} `.padEnd(48, i % 2 === 0 ? "x" : "y");
    out.push({
      id: `old-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? filler : [{ type: "text", text: filler }],
    } as Message);
  }
  return out;
}

function inlineImage(data: string, dims?: { width?: number; height?: number }): ContentBlock {
  // Runtime histories do carry inline base64 image blocks even though core's
  // ImageContent types the source as ref-only; tests mirror that.
  return { type: "image", source: { type: "base64", data, mediaType: "image/png" }, ...dims } as unknown as ContentBlock;
}

function refImage(id: string, dims?: { width?: number; height?: number }): ContentBlock {
  return { type: "image", source: { type: "ref", id, mediaType: "image/png" }, ...dims } as unknown as ContentBlock;
}

function imageMsg(id: string, blocks: ContentBlock[]): Message {
  return { id, role: "user", content: blocks } as Message;
}

/** The compaction summary message, by its verbatim leading text. */
function findSummary(messages: Message[]): Message | undefined {
  return messages.find((m) => {
    if (typeof m.content === "string") return m.content.startsWith("[Earlier conversation summary]");
    if (Array.isArray(m.content)) {
      const first = m.content[0];
      return first?.type === "text" && first.text.startsWith("[Earlier conversation summary]");
    }
    return false;
  });
}

async function runOffloadScenario(opts: {
  messages: Message[];
  store?: ReturnType<typeof fakeAttachmentStore>;
  preserveImageCount?: number;
}) {
  const { events, sink } = captureEvents();
  const store = opts.store ?? fakeAttachmentStore();
  const spy = createSpyModelPort([textScript("SUMMARY-TEXT"), textScript("ack")]);
  const runner = createRunner({
    modelPort: spy,
    stepContext: ctx,
    initialState: makeInitial(opts.messages),
    attachmentStore: store.store,
    eventSink: sink,
    compaction: {
      tokenizer: createCharTokenizer(1),
      maxTokens: 80,
      recentKeepCount: 2,
      ...(opts.preserveImageCount !== undefined ? { preserveImageCount: opts.preserveImageCount } : {}),
    },
  });
  await runner.run({ type: "user_message", content: "now" });
  return { final: runner.getState(), attempts: store.attempts, events, spy };
}

describe("Runner — compaction image offload", () => {
  it("offloads inline base64 images under deterministic ids and carries the ref into the summary", async () => {
    const store = fakeAttachmentStore();
    const { final, attempts, spy } = await runOffloadScenario({
      messages: [SYS, imageMsg("img-1", [inlineImage("QUJD", { width: 1, height: 1 })]), ...textHistory(18)],
      store,
    });

    // put recorded the ORIGINAL bytes plus the deterministic id
    // sanitizeSegment(`${messageId}-${idSuffix}`).
    expect(attempts).toEqual([
      { data: "QUJD", mimeType: "image/png", opts: { id: "img-1-t0" } },
    ]);

    const summary = findSummary(final.messages);
    expect(summary).toBeDefined();
    expect(Array.isArray(summary!.content)).toBe(true);
    const blocks = summary!.content as ContentBlock[];
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({
      type: "text",
      text: "[Earlier conversation summary]\nSUMMARY-TEXT",
    });
    // Marker verbatim (spec D5), immediately before its image block.
    expect(blocks[1]).toEqual({
      type: "text",
      text: "[image preserved from compressed conversation: 1x1 image/png]",
    });
    expect(blocks[2]).toMatchObject({
      type: "image",
      source: { type: "ref", id: "img-1-t0", mediaType: "image/png" },
      width: 1,
      height: 1,
    });

    // The replaced span is gone; the turn completed.
    expect(final.messages.some((m) => m.id === "img-1")).toBe(false);
    expect(final.status).toBe("done");

    // The next model request resolves the preserved ref back to base64 bytes.
    const mainSummary = findSummary(spy.calls[1]!.messages)!;
    const mainBlocks = mainSummary.content as ContentBlock[];
    expect(mainBlocks[2]).toMatchObject({
      type: "image",
      source: { type: "base64", data: "QUJD", mediaType: "image/png" },
    });
  });

  it("performs no puts for a ref-only span and the existing ref rides the summary", async () => {
    const store = fakeAttachmentStore({ seed: { "att-1": { data: "QUJD", mimeType: "image/png" } } });
    const { final, attempts } = await runOffloadScenario({
      messages: [SYS, imageMsg("img-1", [refImage("att-1", { width: 2, height: 3 })]), ...textHistory(18)],
      store,
    });

    expect(attempts).toEqual([]);

    const summary = findSummary(final.messages)!;
    const blocks = summary.content as ContentBlock[];
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toEqual({
      type: "text",
      text: "[image preserved from compressed conversation: 2x3 image/png]",
    });
    expect(blocks[2]).toMatchObject({
      type: "image",
      source: { type: "ref", id: "att-1", mediaType: "image/png" },
    });
  });

  it("Review Focus 3: a rejected put degrades to a placeholder, emits attachment_unavailable, and the compaction still completes", async () => {
    const store = fakeAttachmentStore({ failOn: () => true });
    const { final, attempts, events } = await runOffloadScenario({
      messages: [SYS, imageMsg("img-1", [inlineImage("QUJD", { width: 1, height: 1 })]), ...textHistory(18)],
      store,
    });

    // The put was ATTEMPTED with the deterministic id, then threw.
    expect(attempts).toEqual([
      { data: "QUJD", mimeType: "image/png", opts: { id: "img-1-t0" } },
    ]);
    expect(
      events.some(
        (e) => e.type === "attachment_unavailable" && (e.data as { id?: string }).id === "img-1-t0",
      ),
    ).toBe(true);

    // No image survived → the summary stays a plain string, carrying the
    // degraded placeholder (droppedPlaceholder format) ahead of the model text.
    const summary = findSummary(final.messages)!;
    expect(typeof summary.content).toBe("string");
    expect(summary.content).toBe(
      "[Earlier conversation summary]\n[image: 1x1 image/png]\nSUMMARY-TEXT",
    );

    // Compaction completed: the span was replaced and the turn finished.
    expect(final.messages.some((m) => m.id === "img-1")).toBe(false);
    expect(final.status).toBe("done");
  });

  it("Review Focus 4: identical inputs produce identical put arguments across two runs", async () => {
    const messages = () => [SYS, imageMsg("img-1", [inlineImage("QUJD"), inlineImage("BA==")]), ...textHistory(18)];

    const run1 = await runOffloadScenario({ messages: messages(), store: fakeAttachmentStore() });
    const run2 = await runOffloadScenario({ messages: messages(), store: fakeAttachmentStore() });

    expect(run1.attempts).toEqual([
      { data: "QUJD", mimeType: "image/png", opts: { id: "img-1-t0" } },
      { data: "BA==", mimeType: "image/png", opts: { id: "img-1-t1" } },
    ]);
    expect(run2.attempts).toEqual(run1.attempts);

    // The summary messages (including ref ids) are byte-identical too.
    expect(findSummary(run2.final.messages)?.content).toEqual(
      findSummary(run1.final.messages)?.content,
    );
  });

  it("derives distinct ids for a top-level image and a nested tool_result image at the same index", async () => {
    const store = fakeAttachmentStore();
    const mixed: Message = {
      id: "img-1",
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "tc-1",
          content: [{ type: "text", text: "r" }, inlineImage("TkVTVEVE")],
        } as unknown as ContentBlock,
        inlineImage("VE9Q"),
      ],
    } as Message;
    const { final, attempts } = await runOffloadScenario({
      messages: [SYS, mixed, ...textHistory(18)],
      store,
    });

    // Nested (r0-1) and top-level (t1) must not collide.
    expect(attempts.map((a) => a.opts?.id)).toEqual(["img-1-r0-1", "img-1-t1"]);

    const blocks = findSummary(final.messages)!.content as ContentBlock[];
    const refIds = blocks
      .filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image")
      .map((b) => (b.source as { id: string }).id);
    expect(refIds).toEqual(["img-1-r0-1", "img-1-t1"]);
  });

  it("sanitizes a dirty messageId into a valid, deterministic path segment", async () => {
    // sanitizeSegment is the ONLY defense between a hostile/odd messageId
    // and the store's segment validation: an unsanitized id would make
    // every put throw and every image silently degrade. Drive a compaction
    // whose replaced message id carries "/", ".." and a space.
    const store = fakeAttachmentStore();
    const dirty = "msg/../x y";
    const { attempts } = await runOffloadScenario({
      messages: [SYS, imageMsg(dirty, [inlineImage("QUJD")]), ...textHistory(18)],
      store,
    });

    const id = attempts[0]!.opts?.id;
    // Pinned literal after the documented transforms: every non
    // [A-Za-z0-9._-] char becomes "-", then dot runs collapse to a single
    // "." (".." -> "."), then the idSuffix rides along.
    expect(id).toBe("msg-.-x-y-t0");
    // A valid path segment by the store's isValidSegment rules: non-empty,
    // safe charset only, no separators, no ".." (no throw → no silent
    // degradation of this image).
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(id).not.toContain("..");
    expect(id).not.toContain("/");
  });

  it("honors the cap: only the last N images are offloaded and preserved, older ones degrade to placeholder text", async () => {
    const store = fakeAttachmentStore();
    const { final, attempts } = await runOffloadScenario({
      messages: [
        SYS,
        imageMsg("img-1", [inlineImage("AA"), inlineImage("BB"), inlineImage("CC", { width: 1, height: 1 })]),
        ...textHistory(18),
      ],
      store,
      preserveImageCount: 2,
    });

    // Only the END 2 candidates are offloaded.
    expect(attempts.map((a) => a.opts?.id)).toEqual(["img-1-t1", "img-1-t2"]);

    const summary = findSummary(final.messages)!;
    // The dropped oldest image degrades into the summary TEXT.
    expect(typeof summary.content).toBe("object");
    expect((summary.content as ContentBlock[])[0]).toEqual({
      type: "text",
      text: "[Earlier conversation summary]\n[image: image/png]\nSUMMARY-TEXT",
    });
    const refIds = (summary.content as ContentBlock[])
      .filter((b) => b.type === "image")
      .map((b) => (b as { source: { id: string } }).source.id);
    expect(refIds).toEqual(["img-1-t1", "img-1-t2"]);
  });

  it("preserveImageCount: 0 keeps today's behavior: no puts, byte-identical string summary", async () => {
    const store = fakeAttachmentStore();
    const { final, attempts } = await runOffloadScenario({
      messages: [SYS, imageMsg("img-1", [inlineImage("QUJD", { width: 1, height: 1 })]), ...textHistory(18)],
      store,
      preserveImageCount: 0,
    });

    expect(attempts).toEqual([]);
    const summary = findSummary(final.messages)!;
    expect(summary.content).toBe("[Earlier conversation summary]\nSUMMARY-TEXT");
  });

  it("without an attachment store: existing refs still ride the summary, inline images degrade to placeholders", async () => {
    const { events, sink } = captureEvents();
    const spy = createSpyModelPort([textScript("SUMMARY-TEXT"), textScript("ack")]);
    const messages = [
      SYS,
      imageMsg("img-1", [refImage("att-1"), inlineImage("QUJD", { width: 1, height: 1 })]),
      ...textHistory(18),
    ];
    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(messages),
      eventSink: sink,
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 80,
        recentKeepCount: 2,
      },
    });
    await runner.run({ type: "user_message", content: "now" });

    const blocks = findSummary(runner.getState().messages)!.content as ContentBlock[];
    expect(blocks[0]).toEqual({
      type: "text",
      text: "[Earlier conversation summary]\n[image: 1x1 image/png]\nSUMMARY-TEXT",
    });
    expect(blocks[2]).toMatchObject({
      type: "image",
      source: { type: "ref", id: "att-1", mediaType: "image/png" },
    });
    // The preserved ref needed no store access — no false "unavailable" warning.
    expect(events.some((e) => e.type === "attachment_unavailable")).toBe(false);
  });
});
