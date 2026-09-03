/**
 * Translates core's structured `Message[]` (content blocks, separate
 * tool_use / tool_result messages) into the flattened shape `apps/web`
 * renders (one entry per turn step, tool calls carrying their own result
 * inline). This is the only place that shape conversion happens — the wire
 * contract for `GET /sessions/:id` is web-ready JSON, not a leak of core's
 * internal message representation.
 */

import type { Message } from "@volto/core";

export interface UiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: UiToolCall[];
}

function textOf(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Converts a session's core message history into the web app's `Message[]`.
 * System messages are dropped — host-injected scaffolding, never shown in
 * the chat feed. A tool's result arrives as a separate, later message in the
 * core stream (`role: "tool"`); it is matched back to the assistant's
 * `tool_use` block by id and folded into that call's `result`/`isError`
 * rather than appearing as its own entry.
 */
export function toUiMessages(
  sessionId: string,
  messages: Message[],
  timestamps: number[],
): UiMessage[] {
  const result: UiMessage[] = [];
  const pendingByToolUseId = new Map<string, UiToolCall>();

  messages.forEach((message, index) => {
    const id = `${sessionId}-${index}`;
    const timestamp = timestamps[index] ?? 0;

    if (message.role === "system") return;

    if (message.role === "user") {
      result.push({ id, role: "user", content: textOf(message.content), timestamp });
      return;
    }

    if (message.role === "assistant") {
      const toolCalls: UiToolCall[] = [];
      for (const block of message.content) {
        if (block.type === "tool_use") {
          const call: UiToolCall = { id: block.id, name: block.name, args: block.input };
          toolCalls.push(call);
          pendingByToolUseId.set(block.id, call);
        }
      }
      result.push({
        id,
        role: "assistant",
        content: textOf(message.content),
        timestamp,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      return;
    }

    // role === "tool": fold each result into the matching pending call
    // in-place rather than emitting a separate UI entry for it.
    for (const block of message.content) {
      const call = pendingByToolUseId.get(block.toolUseId);
      if (call) {
        call.result = block.content;
        call.isError = block.isError;
      }
    }
  });

  return result;
}
