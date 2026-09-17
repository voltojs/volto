import { describe, it, expect } from "vitest";
import { createTranscriptRecorder } from "../transcript-recorder.js";
import { projectMessages, buildTurnRecords, toConversationView } from "@volto/core";
import type { TranscriptEvent, TranscriptEventInput, TranscriptStore } from "@volto/core";

function memoryStore(sink: TranscriptEventInput[]): TranscriptStore {
  return {
    appendEvents: async (_sessionId: string, events: TranscriptEventInput[]) => {
      sink.push(...events);
    },
  };
}

/** Assign seq the way a real store would, so projectMessages accepts the log. */
function asStored(sink: TranscriptEventInput[]): TranscriptEvent[] {
  return sink.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

const imageBlock = {
  type: "image" as const,
  source: { type: "ref" as const, id: "att-42", mediaType: "image/png" },
  width: 800,
  height: 600,
};

async function recordAndFlush(
  events: Array<{ type: "user_message" | "tool_result"; data: unknown }>,
): Promise<TranscriptEvent[]> {
  const sink: TranscriptEventInput[] = [];
  const recorder = createTranscriptRecorder({
    store: memoryStore(sink),
    sessionId: "session-1",
    turn: 1,
    now: () => 1000,
  });
  for (const e of events) {
    recorder.record(e.type, e.data as never);
  }
  await recorder.flush();
  return asStored(sink);
}

describe("transcript image recording", () => {
  it("keeps the image block instead of flattening it to text (F-006)", async () => {
    const stored = await recordAndFlush([
      {
        type: "user_message",
        data: { content: [{ type: "text", text: "what is this" }, imageBlock] },
      },
    ]);

    const event = stored.find((e) => e.type === "user_message")!;
    const content = (event.data as { content: unknown }).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toContainEqual(expect.objectContaining({ type: "image" }));
  });

  it("preserves the attachment id so the image can be rehydrated", async () => {
    const stored = await recordAndFlush([
      { type: "user_message", data: { content: [imageBlock] } },
    ]);
    // The id is the only thing that can bring the picture back after a
    // reload; flattening to text loses it permanently.
    expect(JSON.stringify(stored)).toContain("att-42");
  });

  it("still records a plain string message unchanged", async () => {
    const stored = await recordAndFlush([{ type: "user_message", data: { content: "hello" } }]);
    expect((stored[0]!.data as { content: unknown }).content).toBe("hello");
  });

  it("keeps image blocks in a structured tool_result event", async () => {
    const blocks = [{ type: "text" as const, text: "caption" }, imageBlock];
    const stored = await recordAndFlush([
      {
        type: "tool_result",
        data: {
          callId: "c1",
          name: "read_file",
          content: blocks,
          isError: false,
          orderInBatch: 0,
        },
      },
    ]);
    expect((stored[0]!.data as { content: unknown }).content).toEqual(blocks);
  });

  it("rebuilds a user message that still carries the image ref (F-007)", async () => {
    const stored = await recordAndFlush([
      {
        type: "user_message",
        data: { content: [{ type: "text", text: "look at this" }, imageBlock] },
      },
    ]);

    const messages = projectMessages(stored);
    expect(messages).toHaveLength(1);
    const content = messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toContainEqual(
      expect.objectContaining({
        type: "image",
        source: expect.objectContaining({ type: "ref", id: "att-42" }),
      }),
    );
  });

  it("rebuilds a tool message that still carries the image ref (F-007)", async () => {
    const blocks = [imageBlock];
    // projectMessages pairs a tool_result into the batch its assistant_message
    // opened; a lone tool_result is deliberately dropped as unmatched.
    const stored = await recordAndFlush([
      {
        type: "tool_result",
        data: {
          callId: "c1",
          name: "read_file",
          content: blocks,
          isError: false,
          orderInBatch: 0,
        },
      },
    ]);
    // Prepend the assistant_message that opened the batch, so the projection
    // has a roster to resolve the result against.
    const withBatch: TranscriptEvent[] = [
      {
        seq: 0,
        time: 900,
        type: "assistant_message",
        turn: 1,
        step: 1,
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
          stopReason: "tool_use",
          durationMs: 1,
        },
      },
      ...stored.map((e) => ({ ...e, seq: e.seq + 1 })),
    ];

    const messages = projectMessages(withBatch);
    // assistant(tool_use) + the paired tool_result.
    expect(messages).toHaveLength(2);
    const toolMsg = messages.find((m) => m.role === "tool")!;
    const block = (toolMsg.content as Array<{ type: string; content: unknown }>)[0]!;
    expect(block.type).toBe("tool_result");
    expect(block.content).toEqual(blocks);
  });

  it("conversation view emits an image block after a cold rebuild (F-006/F-007)", async () => {
    const stored = await recordAndFlush([
      {
        type: "user_message",
        data: { content: [{ type: "text", text: "what is this" }, imageBlock] },
      },
    ]);

    const view = toConversationView(buildTurnRecords(stored));
    const message = view.messages[0]!;
    expect(message.blocks).toContainEqual(
      expect.objectContaining({ type: "image", attachmentId: "att-42" }),
    );
  });
});
