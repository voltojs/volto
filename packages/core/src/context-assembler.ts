/**
 * ContextAssembler — cache-friendly message ordering.
 * Puts static content (system prompt, tool definitions) in a stable prefix
 * so LLM prompt caches can reuse it across turns. Variable content (user
 * messages, tool results) is appended as a suffix.
 *
 * Pure function — zero I/O, zero side effects.
 */

import type { Message } from "./state.js";
import type { ToolDefinition } from "./tool.js";
import type { Tokenizer } from "./ports.js";
import { extractMessageText } from "./text-extract.js";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface AssembleContextOptions {
  /** All messages in chronological order */
  messages: Message[];
  /** Tool definitions to include in the context */
  tools: ToolDefinition[];
  /** Optional system prompt override (default: extract from messages) */
  systemPrompt?: string;
}

export interface AssembledContext {
  /** Messages ordered for cache-friendly consumption */
  messages: Message[];
  /** The static prefix length (number of messages) — for cache diagnostics */
  staticPrefixLength: number;
}

// ──────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────

/**
 * Assemble messages into a cache-friendly order.
 *
 * Ordering strategy:
 * 1. System message (static) — stable across turns unless tools change
 * 2. Tool definitions are NOT embedded in messages; they go via ModelRequest.tools
 *    (this keeps the message array clean and avoids re-serializing tools into content)
 * 3. User messages + tool results (variable) — chronological order preserved
 *
 * The key insight: the system prompt is the cacheable prefix. Tool definitions
 * are sent separately in ModelRequest.tools, so they don't pollute the message
 * array ordering. This function focuses on ordering messages such that the
 * system message (if present) is always first, and all other messages follow
 * in their original chronological order.
 */
export function assembleContext(opts: AssembleContextOptions): AssembledContext {
  const { messages } = opts;

  const systemMessages: Message[] = [];
  const otherMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemMessages.push(msg);
    } else {
      otherMessages.push(msg);
    }
  }

  // System messages first (stable prefix), then everything else in order
  const assembled = [...systemMessages, ...otherMessages];

  return {
    messages: assembled,
    staticPrefixLength: systemMessages.length,
  };
}

/**
 * Build a system prompt string from tool definitions and an optional
 * additional prompt. This is a pure helper — the resulting string can
 * be injected as the system message by the caller.
 *
 * Tool definitions are formatted as a structured block so the model
 * can reference them. The format is stable: tools are sorted by name,
 * ensuring the same tools always produce the same prompt bytes.
 */
export function buildToolPrompt(tools: ToolDefinition[], additionalPrompt?: string): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));

  const toolBlocks = sorted.map((tool) => {
    const lines = [`## ${tool.name}`, tool.description];
    if (tool.inputSchema && Object.keys(tool.inputSchema).length > 0) {
      lines.push(`Input: ${JSON.stringify(tool.inputSchema, null, 2)}`);
    }
    if (tool.requires.length > 0) {
      lines.push(`Requires: ${tool.requires.join(", ")}`);
    }
    return lines.join("\n");
  });

  const parts: string[] = [];
  if (additionalPrompt) {
    parts.push(additionalPrompt);
  }
  if (toolBlocks.length > 0) {
    parts.push("# Available Tools\n\n" + toolBlocks.join("\n\n"));
  }

  return parts.join("\n\n");
}

/**
 * Compute the token count of the static prefix for cache diagnostics.
 * Returns the total tokens in system messages only (tool definitions
 * are sent separately and don't count toward message-level prefix).
 */
export function computeStaticPrefixTokens(
  messages: Message[],
  tokenizer: Tokenizer,
): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.role === "system") {
      total += tokenizer.count(extractMessageText(msg));
    }
  }
  return total;
}
