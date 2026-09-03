/**
 * Translates core's structured `Message[]` (content blocks, separate
 * tool_use / tool_result messages) into the shape `apps/web` renders — an
 * ordered `blocks` sequence per message, so a tool call lands at the point
 * in the reply where it actually happened rather than after all the text.
 * This is the only place that shape conversion happens — the wire contract
 * for `GET /sessions/:id` is web-ready JSON, not a leak of core's internal
 * message representation.
 */

import type { Message } from "@volto/core";

export interface UiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

export type UiMessageBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: UiToolCall };

export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  /** Full text, all segments concatenated — kept for copy-to-clipboard. */
  content: string;
  blocks: UiMessageBlock[];
  timestamp: number;
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
 * rather than appearing as its own entry. Adjacent text content blocks are
 * merged into one text block — core can emit several in a row (e.g. around
 * an image block), but the UI only needs segment boundaries at tool calls.
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
      const text = textOf(message.content);
      result.push({
        id,
        role: "user",
        content: text,
        blocks: text ? [{ type: "text", text }] : [],
        timestamp,
      });
      return;
    }

    if (message.role === "assistant") {
      const blocks: UiMessageBlock[] = [];
      let textBuffer = "";
      const flushText = () => {
        if (textBuffer) {
          blocks.push({ type: "text", text: textBuffer });
          textBuffer = "";
        }
      };
      for (const block of message.content) {
        if (block.type === "text") {
          textBuffer += block.text;
        } else if (block.type === "tool_use") {
          flushText();
          const call: UiToolCall = { id: block.id, name: block.name, args: block.input };
          blocks.push({ type: "tool_call", call });
          pendingByToolUseId.set(block.id, call);
        }
        // Image blocks have no UI representation yet — dropped, same as
        // the flattened `content` string already did.
      }
      flushText();
      result.push({ id, role: "assistant", content: textOf(message.content), blocks, timestamp });
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
