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
import { extractMessageText, estimateContentTokens } from "./text-extract.js";

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
  /** IDs of messages that must never be compressed (pinned) */
  pinnedMessageIds?: string[];
}

export interface CompactionDecision {
  /** Whether compaction is needed */
  shouldCompact: boolean;
  /** Exact indices of messages selected for compression (may be non-contiguous) */
  compressedIndices?: number[];
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

  // Match file paths with known extensions (stricter than generic path-like strings).
  // This avoids matching import specifiers, shell builtins (/dev/null), and URL fragments.
  // Accepted: /path/to/file.ts, ./relative.js, ~/home/config.json
  // Rejected: import "./foo", /dev/null, https://example.com/path
  const pathRegex = /(?:^|[\s([<"'`])((?:\/|\.\.?\/|~\/)[\w./-]+\.\w{1,10})\b/g;
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
 * A permission reminder states the boundary the model is operating under.
 * Summarising it away leaves the model believing it may do things the policy
 * refuses, so `decideCompaction` excludes it from the compressible set
 * outright — the same absolute exemption pinned messages get, not the
 * "compressed last" ordering `isKeyMessage` buys.
 *
 * Matched case-insensitively: the first announcement opens with "Permission
 * boundary for this session:" and a mid-session change with "The permission
 * boundary for this session has changed." — both must be caught.
 */
export function isPermissionReminder(msg: Message): boolean {
  return (
    typeof msg.content === "string" &&
    msg.content.includes("<system-reminder>") &&
    msg.content.toLowerCase().includes("permission boundary for this session")
  );
}

/**
 * A message is "key" when it carries information the model must not lose
 * across a compaction: file paths, incomplete todos, or permission
 * boundaries. This is a SORT KEY — key messages are compressed LAST, not
 * exempted. Only pinned messages and permission reminders are truly exempt.
 */
export function isKeyMessage(msg: Message): boolean {
  return isPermissionReminder(msg) || hasIncompleteTodos(msg) || extractFilePaths(msg).length > 0;
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

  // Key messages — those carrying file paths or incomplete todos — are deprioritized
  // (compressed last) rather than absolutely exempt. This ensures the summary prompt
  // captures their content while keeping the compaction surface wide enough for
  // long conversations.
  //
  // Two things ARE absolutely exempt: pinned messages, and the permission
  // reminder. Deprioritizing the reminder is not enough — in a long session
  // where every tool interaction is already compressed and the budget is still
  // exceeded, "compress last" still means compressed, and a summarised
  // boundary is a lost boundary: the fingerprint has not changed, so it is
  // never re-announced and the model silently stops knowing what it may do.
  const pinnedIndices = new Set((opts.pinnedMessageIds ?? []).map(Number));
  const compressible = recencyEligible.filter(
    (item) => !pinnedIndices.has(item.index) && !isPermissionReminder(item.msg),
  );

  // Among compressible, prefer compressing old tool interactions,
  // deprioritize key messages (compress last), then oldest first
  compressible.sort((a, b) => {
    const aIsKey = isKeyMessage(a.msg) ? 1 : 0;
    const bIsKey = isKeyMessage(b.msg) ? 1 : 0;
    if (aIsKey !== bIsKey) return aIsKey - bIsKey;
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
    compressedIndices: Array.from(compressedIndices).sort((a, b) => a - b),
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

/**
 * Estimate tokens for a single message. Prices content per-block via
 * estimateContentTokens (not extractMessageText, which zeroes reasoning
 * blocks for display purposes) so reasoning — which does ride in the
 * request sent to the provider — is not priced at zero here.
 */
export function estimateMessageTokens(msg: Message, tokenizer: Tokenizer): number {
  const contentTokens = estimateContentTokens(msg.content, tokenizer);
  const overhead = 4; // role + separators
  return contentTokens + overhead;
}

// ──────────────────────────────────────────────
// Summary prompt builder
// ──────────────────────────────────────────────

/**
 * Build a prompt for the model to summarize compressible messages.
 * The summary should preserve: file paths, key decisions, incomplete tasks.
 * Key messages (with file paths/incomplete todos) are included in compression
 * as a last resort — the summary prompt ensures their content is retained.
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
- All file paths mentioned (critical — model needs these for file operations)
- Key decisions and their reasoning
- Incomplete tasks or TODOs
- Important factual statements

Conversation segment:
${conversationText}

Provide a structured summary in under 200 words.`;
}
