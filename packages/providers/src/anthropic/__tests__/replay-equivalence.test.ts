/**
 * Cross-provider replay equivalence test.
 *
 * Verifies that the same logical conversation script produces
 * identical (state, effects) sequences when run through either
 * OpenAI or Anthropic stream normalizers.
 */

import { describe, it, expect } from "vitest";
import { normalizeStream as normalizeOpenAI } from "../../openai/stream-normalize.js";
import { normalizeStream as normalizeAnthropic } from "../stream-normalize.js";
import type { RawStreamChunk } from "../../openai/stream-normalize.js";
import type { RawAnthropicEvent } from "../stream-normalize.js";
import type { ModelEvent } from "@voltojs/core";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function collectOpenAI(chunks: RawStreamChunk[]): Promise<ModelEvent[]> {
  async function* gen() { for (const c of chunks) yield c; }
  const events: ModelEvent[] = [];
  for await (const e of normalizeOpenAI(gen())) events.push(e);
  return events;
}

async function collectAnthropic(events: RawAnthropicEvent[]): Promise<ModelEvent[]> {
  async function* gen() { for (const e of events) yield e; }
  const result: ModelEvent[] = [];
  for await (const e of normalizeAnthropic(gen())) result.push(e);
  return result;
}

// ──────────────────────────────────────────────
// Scenario: text response
// ──────────────────────────────────────────────

describe("replay equivalence", () => {
  it("text-only response produces identical events", async () => {
    const openaiChunks: RawStreamChunk[] = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: " world" }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 15 } },
    ];

    const anthropicEvents: RawAnthropicEvent[] = [
      { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } },
      { type: "message_stop" },
    ];

    const oai = await collectOpenAI(openaiChunks);
    const ant = await collectAnthropic(anthropicEvents);

    expect(ant).toEqual(oai);
  });

  it("tool use response produces identical events", async () => {
    const openaiChunks: RawStreamChunk[] = [
      { choices: [{ delta: { content: "Let me check." }, finish_reason: null }], usage: null },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"location":' } }] }, finish_reason: null }], usage: null },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' "SF"}' } }] }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: "" }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 200, completion_tokens: 30 } },
    ];

    const anthropicEvents: RawAnthropicEvent[] = [
      { type: "message_start", message: { usage: { input_tokens: 200, output_tokens: 2 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_abc", name: "get_weather", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"location":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' "SF"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ];

    const oai = await collectOpenAI(openaiChunks);
    const ant = await collectAnthropic(anthropicEvents);

    expect(ant).toEqual(oai);
  });

  it("reasoning + text response produces identical events", async () => {
    const openaiChunks: RawStreamChunk[] = [
      { choices: [{ delta: { reasoning_content: "Analyzing..." }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: "Done." }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 25 } },
    ];

    const anthropicEvents: RawAnthropicEvent[] = [
      { type: "message_start", message: { usage: { input_tokens: 80, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Analyzing..." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25 } },
      { type: "message_stop" },
    ];

    const oai = await collectOpenAI(openaiChunks);
    const ant = await collectAnthropic(anthropicEvents);

    expect(ant).toEqual(oai);
  });

  it("parallel tool calls produce identical events", async () => {
    const openaiChunks: RawStreamChunk[] = [
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        { index: 1, id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
      ] }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: "" }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 20 } },
    ];

    const anthropicEvents: RawAnthropicEvent[] = [
      { type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 2 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_2", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"b.ts"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ];

    const oai = await collectOpenAI(openaiChunks);
    const ant = await collectAnthropic(anthropicEvents);

    expect(ant).toEqual(oai);
  });
});
