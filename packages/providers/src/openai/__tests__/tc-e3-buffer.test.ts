import { describe, it, expect } from "vitest";
import { normalizeStream } from "../stream-normalize.js";
import type { RawStreamChunk } from "../stream-normalize.js";
import type { ModelEvent } from "@voltojs/core";

async function collect(chunks: RawStreamChunk[]): Promise<ModelEvent[]> {
  async function* generate() {
    for (const chunk of chunks) yield chunk;
  }
  const events: ModelEvent[] = [];
  for await (const event of normalizeStream(generate())) {
    events.push(event);
  }
  return events;
}

function chunk(
  delta: Record<string, unknown>,
  finishReason?: string | null,
  usage?: RawStreamChunk["usage"],
): RawStreamChunk {
  return {
    choices: [{ delta, finish_reason: finishReason ?? null }],
    usage: usage ?? null,
  };
}

describe("TC-E3: stream-normalize 非标准 provider tool call 缓冲", () => {
  it("first chunk without id/name buffers arguments and replays them when identity arrives", async () => {
    const events = await collect([
      // chunk 1: argument-only, no id or name (vLLM / Azure style)
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: '{"path":' } },
        ],
      }),
      // chunk 2: identity arrives with additional arguments
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '"foo.ts"}' },
          },
        ],
      }),
      // chunk 3: finish
      chunk({}, "tool_calls"),
    ]);

    const startEvents = events.filter((e) => e.type === "tool_use_start");
    const deltaEvents = events.filter((e) => e.type === "tool_use_delta");
    const doneEvents = events.filter((e) => e.type === "done");

    // tool_use_start emitted once identity arrives
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]).toMatchObject({
      type: "tool_use_start",
      toolCallId: "call_1",
      toolName: "read_file",
    });

    // The buffered '{"path":' from chunk 1 is merged with '"foo.ts"}' from chunk 2
    // into a single delta, then the chunk-2-only args are emitted separately.
    expect(deltaEvents.length).toBeGreaterThanOrEqual(1);
    const allArgs = deltaEvents.map((e) => (e as { argumentsDelta: string }).argumentsDelta).join("");
    expect(allArgs).toContain('{"path":');
    expect(allArgs).toContain('"foo.ts"}');

    // done with stopReason = tool_use
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ stopReason: "tool_use" });
  });

  it("multiple argument-only chunks before identity are all buffered", async () => {
    const events = await collect([
      chunk({
        tool_calls: [{ index: 0, function: { arguments: '{"a":' } }],
      }),
      chunk({
        tool_calls: [{ index: 0, function: { arguments: '"b",' } }],
      }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_x",
            type: "function",
            function: { name: "write_file", arguments: '"c":1}' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ]);

    const startEvents = events.filter((e) => e.type === "tool_use_start");
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]).toMatchObject({
      toolCallId: "call_x",
      toolName: "write_file",
    });

    const deltaEvents = events.filter((e) => e.type === "tool_use_delta");
    const allArgs = deltaEvents
      .map((e) => (e as { argumentsDelta: string }).argumentsDelta)
      .join("");
    expect(allArgs).toContain('{"a":');
    expect(allArgs).toContain('"b",');
    expect(allArgs).toContain('"c":1}');
  });
});
