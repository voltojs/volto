/**
 * Mock ModelPort — scripted event sequences for deterministic testing.
 * Each call to stream() consumes the next script entry and yields those events.
 *
 * Usage:
 *   const mock = createMockModelPort([
 *     [textDelta("Hello"), modelDone("end_turn")],
 *     [textDelta("World"), modelDone("end_turn")],
 *   ]);
 *   // First stream() yields ["Hello", done], second yields ["World", done]
 */

import type { ModelPort, ModelEvent, ModelRequest } from "../ports.js";

/** A script is an array of event sequences; one per stream() call */
export type ModelPortScript = ModelEvent[][];

/**
 * Create a mock ModelPort that yields scripted events.
 * Throws if stream() is called more times than scripts provided.
 * Supports AbortSignal — if aborted, yields an error event and stops.
 */
export function createMockModelPort(script: ModelPortScript): ModelPort & { callCount: number } {
  let callIndex = 0;
  const port: ModelPort & { callCount: number } = {
    get callCount() {
      return callIndex;
    },
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      const events = script[callIndex];
      callIndex++;

      if (!events) {
        throw new Error(`MockModelPort: no script for call ${callIndex - 1} (only ${script.length} scripts provided)`);
      }

      for (const event of events) {
        // Check abort before yielding each event
        if (req.abortSignal?.aborted) {
          yield { type: "error", error: "Aborted", retriable: false };
          return;
        }
        yield event;
      }
    },
  };
  return port;
}

// ──────────────────────────────────────────────
// Event builders (convenience helpers)
// ──────────────────────────────────────────────

export function textDelta(text: string): ModelEvent {
  return { type: "text_delta", text };
}

export function reasoningDelta(text: string): ModelEvent {
  return { type: "reasoning_delta", text };
}

export function toolUseStart(toolCallId: string, toolName: string): ModelEvent {
  return { type: "tool_use_start", toolCallId, toolName };
}

export function toolUseDelta(toolCallId: string, argumentsDelta: string): ModelEvent {
  return { type: "tool_use_delta", toolCallId, argumentsDelta };
}

export function usage(inputTokens: number, outputTokens: number): ModelEvent {
  return { type: "usage", inputTokens, outputTokens };
}

export function modelDone(stopReason: "end_turn" | "tool_use" | "max_tokens"): ModelEvent {
  return { type: "done", stopReason };
}

export function modelError(error: string, retriable?: boolean): ModelEvent {
  return { type: "error", error, retriable };
}

/**
 * Helper: build a tool-call script that streams tool_use_start → arguments deltas → done.
 * Simulates OpenAI's streaming pattern where tool calls arrive as start + delta chunks.
 */
export function toolCallScript(
  toolCallId: string,
  toolName: string,
  args: string,
  stopReason: "tool_use" = "tool_use",
): ModelEvent[] {
  return [
    toolUseStart(toolCallId, toolName),
    toolUseDelta(toolCallId, args),
    modelDone(stopReason),
  ];
}

/**
 * Helper: build a text-only script.
 */
export function textScript(text: string, usageIn?: number, usageOut?: number): ModelEvent[] {
  const events: ModelEvent[] = [textDelta(text)];
  if (usageIn !== undefined && usageOut !== undefined) {
    events.push(usage(usageIn, usageOut));
  }
  events.push(modelDone("end_turn"));
  return events;
}
