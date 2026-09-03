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

export interface ContextLayer {
  /** Diagnostic label, e.g. "user-memory" | "project-memory" | "skill:<name>" */
  id: string;
  /** Host-resolved plain text — core never reads files, queries memory, or talks to MCP. */
  text: string;
}

export interface AssembleContextOptions {
  /** All messages in chronological order */
  messages: Message[];
  /** Tool definitions to include in the context */
  tools: ToolDefinition[];
  /** Optional system prompt override (default: extract from messages) */
  systemPrompt?: string;
  /**
   * IDs (indices as strings) of pinned messages.
   * Pinned messages are stably placed in the prefix slot (after system messages)
   * so they are never displaced by compaction or rearrangement.
   */
  pinnedMessageIds?: string[];
  /** Optional context layers to inject as system messages after existing system messages */
  contextLayers?: ContextLayer[];
}

export interface AssembledContext {
  /** Messages ordered for cache-friendly consumption */
  messages: Message[];
  /** The static prefix length (number of messages) — for cache diagnostics */
  staticPrefixLength: number;
  /**
   * Cache breakpoints — message indices where provider-side prompt cache
   * should be anchored. These correspond to boundaries in the static prefix:
   * - Index 0: first system message (always a breakpoint)
   * - Indices within system messages: after each distinct system message
   * - Index after all system + pinned messages: the boundary before variable content
   *
   * Providers translate these to their native cache_control mechanism:
   * - Anthropic: cache_control: { type: "ephemeral" } on messages at these indices
   * - OpenAI: automatic prefix caching (breakpoints are diagnostic only)
   */
  cacheBreakpoints: number[];
  /** Mapping of each context layer id to its message index in the assembled context */
  layerOrigins: Array<{ id: string; messageIndex: number }>;
}

// ──────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────

/**
 * Assemble messages into a cache-friendly order.
 *
 * Ordering strategy:
 * 1. System message (static) — stable across turns unless tools change
 * 2. Context layers (static) — injected as additional system messages after existing system messages
 * 3. Tool definitions are NOT embedded in messages; they go via ModelRequest.tools
 *    (this keeps the message array clean and avoids re-serializing tools into content)
 * 4. Pinned messages (static) — placed in the prefix slot before variable content
 * 5. User messages + tool results (variable) — chronological order preserved
 *
 * The key insight: the system prompt is the cacheable prefix. Tool definitions
 * are sent separately in ModelRequest.tools, so they don't pollute the message
 * array ordering. This function focuses on ordering messages such that the
 * system messages (and context layers) are always first, followed by pinned
 * messages, and all other messages follow in their original chronological order.
 */
export function assembleContext(opts: AssembleContextOptions): AssembledContext {
  const { messages } = opts;
  const pinnedIndices = new Set((opts.pinnedMessageIds ?? []).map(Number));

  const systemMessages: Message[] = [];
  const pinnedMessages: Message[] = [];
  const otherMessages: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "system") {
      systemMessages.push(msg);
    } else if (pinnedIndices.has(i)) {
      pinnedMessages.push(msg);
    } else {
      otherMessages.push(msg);
    }
  }

  const layers = opts.contextLayers ?? [];
  const layerMessages: Message[] = layers.map((layer) => ({ role: "system", content: layer.text }));

  // System messages → layer messages → pinned messages → everything else (stable prefix includes all three)
  const assembled = [...systemMessages, ...layerMessages, ...pinnedMessages, ...otherMessages];
  const prefixLen = systemMessages.length + layerMessages.length + pinnedMessages.length;

  const layerOrigins = layers.map((layer, i) => ({
    id: layer.id,
    messageIndex: systemMessages.length + i,
  }));

  // Cache breakpoints: indices where provider-side prompt cache should anchor.
  // Always include index 0 (first message) and the boundary after the static prefix.
  const cacheBreakpoints: number[] = [0];
  if (prefixLen > 0 && prefixLen < assembled.length) {
    cacheBreakpoints.push(prefixLen);
  }

  return {
    messages: assembled,
    staticPrefixLength: prefixLen,
    cacheBreakpoints,
    layerOrigins,
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
