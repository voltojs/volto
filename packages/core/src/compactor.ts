/**
 * Compactor — pure compression decision logic.
 * Determines when and what to compress in the conversation history.
 * The actual summarization is performed by the model (via CallModel effect),
 * keeping the Compactor itself pure.
 *
 * Design principles:
 * - Pure function: zero I/O, zero side effects
 * - Preserves: system message, recent N messages, file paths, incomplete todos
 * - Compresses: older tool call/result pairs that are no longer immediately relevant
 * - Returns a CompactionDecision for the Runner to interpret
 */

import type { Message } from "./state.js";
import type { Tokenizer } from "./ports.js";
import { extractMessageText } from "./text-extract.js";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface CompactionOptions {
  /** Maximum tokens before compaction is triggered */
  maxTokens: number;
  /** Number of recent messages to always preserve (not compress) */
  recentKeepCount: number;
  /** Tokenizer for estimating message sizes */
  tokenizer: Tokenizer;
}

export interface CompactionDecision {
  /** Whether compaction is needed */
  shouldCompact: boolean;
  /** Index range of messages eligible for summarization [start, end) */
  compactRange?: { start: number; end: number };
  /** Messages that will be kept as-is (not compressed) */
  preservedMessages: Message[];
  /** Messages eligible for compression */
  compressibleMessages: Message[];
  /** A prompt for the model to summarize the compressible messages */
  summaryPrompt?: string;
  /** Estimated tokens before compaction */
  currentTokens: number;
  /** Estimated tokens after compaction (system + recent + summary) */
  estimatedTokensAfter: number;
}

/**
 * Runner-level compaction configuration.
 * Passed to the Runner to enable automatic context compression.
 */
export interface CompactionConfig {
  /** Tokenizer for estimating token counts */
  tokenizer: Tokenizer;
  /** Maximum tokens before compaction is triggered */
  maxTokens: number;
  /** Number of recent messages to always preserve (default: 4) */
  recentKeepCount?: number;
}

// ──────────────────────────────────────────────
// Key information extractors (pure)
// ──────────────────────────────────────────────

/** Extract file paths mentioned in a message's text content */
export function extractFilePaths(msg: Message): string[] {
  const paths: string[] = [];
  const text = extractMessageText(msg);

  // Match common path patterns: /path/to/file, ./relative, ~/home.
  // The leading boundary accepts start-of-string, whitespace, or punctuation
  // wrappers like ( [ < " ' so paths embedded as `(/a/b.ts)` are still caught.
  const pathRegex = /(?:^|[\s([<"'`])((?:\/|\.\.?\/|~\/)[\w./-]+)/g;
  let match;
  while ((match = pathRegex.exec(text)) !== null) {
    const path = match[1]!.trim();
    if (!paths.includes(path)) {
      paths.push(path);
    }
  }

  return paths;
}

/** Check if a message contains incomplete todo items */
export function hasIncompleteTodos(msg: Message): boolean {
  const text = extractMessageText(msg);
  // Match patterns like "- [ ]", "TODO:", "FIXME:", "HACK:"
  return /(?:^|\n)\s*-\s*\[[ ]\]/m.test(text) || /(?:TODO|FIXME|HACK):/i.test(text);
}

/** Check if a message is a tool call or tool result (compressible pair) */
export function isToolInteraction(msg: Message): boolean {
  return (
    msg.role === "assistant" &&
    Array.isArray(msg.content) &&
    msg.content.some((b) => b.type === "tool_use")
  ) || (
    msg.role === "tool"
  );
}

/**
 * A message is "key" — never compressible — when it carries information the
 * model must not lose across a compaction: file paths or incomplete todos.
 */
export function isKeyMessage(msg: Message): boolean {
  return hasIncompleteTodos(msg) || extractFilePaths(msg).length > 0;
}

// ──────────────────────────────────────────────
// Core compaction logic
// ──────────────────────────────────────────────

/**
 * Decide whether to compact and what to compress.
 *
 * Strategy:
 * 1. Count total tokens across all messages
 * 2. If under threshold → no compaction needed
 * 3. If over threshold:
 *    a. Always preserve: system message(s) + last N messages
 *    b. Among remaining messages, identify tool call → tool result pairs
 *    c. Compress the oldest compressible messages first
 *    d. Generate a summary prompt for the model
 */
export function decideCompaction(
  messages: Message[],
  opts: CompactionOptions,
): CompactionDecision {
  const { maxTokens, recentKeepCount, tokenizer } = opts;

  // Estimate total tokens
  const currentTokens = estimateTokens(messages, tokenizer);

  if (currentTokens <= maxTokens) {
    return {
      shouldCompact: false,
      preservedMessages: messages,
      compressibleMessages: [],
      currentTokens,
      estimatedTokensAfter: currentTokens,
    };
  }

  // Partition: system messages (always preserve) + other messages
  const systemMessages: Message[] = [];
  const otherMessages: Array<{ msg: Message; index: number; tokens: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const tokens = estimateTokens([msg], tokenizer);
    if (msg.role === "system") {
      systemMessages.push(msg);
    } else {
      otherMessages.push({ msg, index: i, tokens });
    }
  }

  // Always preserve the last N non-system messages
  const keepCount = Math.min(recentKeepCount, otherMessages.length);
  const recencyEligible = otherMessages.slice(0, otherMessages.length - keepCount);

  // Key messages — those carrying file paths or incomplete todos — are NEVER
  // compressed: they hold information the model must not lose. Excluding them
  // here keeps them in `preservedMessages` (built below from the un-compressed
  // set). This is the kernel-level preservation guarantee required by AC1;
  // the summary-prompt instruction is only a best-effort backstop for the rest.
  const compressible = recencyEligible.filter((item) => !isKeyMessage(item.msg));

  // Among compressible, prefer compressing old tool interactions
  // Sort: compress tool interactions first, then oldest first
  compressible.sort((a, b) => {
    const aIsTool = isToolInteraction(a.msg) ? 0 : 1;
    const bIsTool = isToolInteraction(b.msg) ? 0 : 1;
    if (aIsTool !== bIsTool) return aIsTool - bIsTool;
    return a.index - b.index;
  });

  // Greedily select messages to compress until we're under budget
  // Start from the oldest tool interactions and work forward
  const toCompress: typeof compressible = [];
  const compressedIndices = new Set<number>();
  let tokensToRemove = currentTokens - maxTokens;

  for (const item of compressible) {
    if (tokensToRemove <= 0) break;
    toCompress.push(item);
    compressedIndices.add(item.index);
    tokensToRemove -= item.tokens;
  }

  // If we still need to compress more, include non-tool messages
  if (tokensToRemove > 0) {
    for (const item of compressible) {
      if (compressedIndices.has(item.index)) continue;
      if (tokensToRemove <= 0) break;
      toCompress.push(item);
      compressedIndices.add(item.index);
      tokensToRemove -= item.tokens;
    }
  }

  // Sort compressible by original index for the summary prompt
  toCompress.sort((a, b) => a.index - b.index);

  const preservedMessages: Message[] = [
    ...systemMessages,
    ...otherMessages
      .filter((o) => !compressedIndices.has(o.index))
      .map((o) => o.msg),
  ];

  const compressibleMessages = toCompress.map((c) => c.msg);

  // Estimate tokens after compaction: system + preserved recent + ~200 tokens for summary
  const preservedTokens = estimateTokens(preservedMessages, tokenizer);
  const summaryOverhead = 200; // approximate tokens for the summary output
  const estimatedTokensAfter = preservedTokens + summaryOverhead;

  // Build summary prompt
  const summaryPrompt = buildSummaryPrompt(compressibleMessages);

  return {
    shouldCompact: true,
    compactRange: {
      start: toCompress.length > 0 ? toCompress[0]!.index : 0,
      end: toCompress.length > 0 ? toCompress[toCompress.length - 1]!.index + 1 : 0,
    },
    preservedMessages,
    compressibleMessages,
    summaryPrompt,
    currentTokens,
    estimatedTokensAfter,
  };
}

// ──────────────────────────────────────────────
// Token estimation
// ──────────────────────────────────────────────

/** Estimate total tokens across an array of messages */
export function estimateTokens(messages: Message[], tokenizer: Tokenizer): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg, tokenizer);
  }
  return total;
}

/** Estimate tokens for a single message */
export function estimateMessageTokens(msg: Message, tokenizer: Tokenizer): number {
  const text = extractMessageText(msg);
  // Add overhead for message structure (role, content blocks, etc.)
  const contentTokens = tokenizer.count(text);
  const overhead = 4; // role + separators
  return contentTokens + overhead;
}

// ──────────────────────────────────────────────
// Summary prompt builder
// ──────────────────────────────────────────────

/**
 * Build a prompt for the model to summarize compressible messages.
 * The summary should preserve: file paths, key decisions, incomplete tasks.
 */
function buildSummaryPrompt(messages: Message[]): string {
  const conversationText = messages
    .map((msg) => {
      const role = msg.role;
      const text = extractMessageText(msg);
      return `[${role}]: ${text}`;
    })
    .join("\n\n");

  return `Summarize the following conversation segment concisely. Preserve:
- All file paths mentioned
- Key decisions and their reasoning
- Incomplete tasks or TODOs
- Important factual statements

Conversation segment:
${conversationText}

Provide a structured summary in under 200 words.`;
}
