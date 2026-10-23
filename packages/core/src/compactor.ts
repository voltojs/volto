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
 *
 * Incomplete-todo detection is a best-effort sort key for informal markdown
 * checklists. Standing `todo_write` state is re-injected every assemble from
 * `AgentState.todos` and does NOT rely on this heuristic.
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
  /**
   * Message ids that must never be compressed.
   * Entries address `Message.id` (stable identity), not array indices.
   */
  pinnedMessageIds?: string[];
  /**
   * Provider-anchored current prompt pressure (usage baseline + heuristic
   * delta). When present it wins over the absolute `estimateTokens` — the
   * anchor already includes the static prefix and tool schemas.
   */
  measuredTokens?: number;
  /**
   * Static context layers + tool schemas, in tokens. Added only when
   * `measuredTokens` is absent; counting them alongside an anchor would
   * double-price what the provider already reported.
   */
  reservedTokens?: number;
}

export interface CompactionDecision {
  /** Whether compaction is needed */
  shouldCompact: boolean;
  /** Exact indices of messages selected for compression (may be non-contiguous) */
  compressedIndices?: number[];
  /**
   * Ids of the messages selected for compression, derived from
   * `compressedIndices` (`messages[i].id`). Write-back (Plan 2) uses this
   * to replace the compressed span with a summary message.
   */
  replacedIds?: string[];
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
  /**
   * Soft character budget for a single tool_result text block. Oversized
   * blocks are head/tail pruned before summarization; default 8000 at the
   * Runner call site.
   */
  toolResultMaxChars?: number;
  /** maxTokens cap for the summarization model call (default: 4096) */
  summaryMaxTokens?: number;
  /**
   * Maximum number of recent images (refs) preserved on the user-role
   * carrier message right after the summary (spec D3). Default 4 at the
   * Runner; 0 or negative disables the feature (all images degrade to
   * placeholders — today's behavior).
   */
  preserveImageCount?: number;
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

/**
 * Check if a message contains incomplete todo items.
 *
 * Incomplete-todo detection is a best-effort sort key for informal markdown
 * checklists. Standing `todo_write` state is re-injected every assemble from
 * `AgentState.todos` and does NOT rely on this heuristic.
 */
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

  // Provider-anchored pressure wins; the absolute estimate is the fallback
  // and adds the static layers / tool schemas the anchor already includes.
  const currentTokens = opts.measuredTokens
    ?? estimateTokens(messages, tokenizer) + (opts.reservedTokens ?? 0);

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
  const pinned = new Set(opts.pinnedMessageIds ?? []);
  const compressible = recencyEligible.filter(
    (item) => !pinned.has(item.msg.id) && !isPermissionReminder(item.msg),
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

  // Soft tool pairing: if either side of a tool_use / tool_result pair is
  // selected, pull in the other side when it is still compressible. Leaving
  // one side behind produces a request the provider rejects (orphaned
  // tool_use or orphaned tool_result). "Soft" because a partner that is
  // pinned, recent-kept, or a permission reminder is left alone.
  pairToolInteractions(compressedIndices, toCompress, otherMessages, compressible);

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

  const sortedIndices = Array.from(compressedIndices).sort((a, b) => a - b);

  return {
    shouldCompact: true,
    compressedIndices: sortedIndices,
    replacedIds: sortedIndices.map((i) => messages[i]!.id),
    preservedMessages,
    compressibleMessages,
    summaryPrompt,
    currentTokens,
    estimatedTokensAfter,
  };
}

type CompressibleItem = { msg: Message; index: number; tokens: number };

/**
 * Soft tool pairing. Mutates `compressedIndices` / `toCompress` in place so
 * every selected tool_use has its matching tool_result selected too, and
 * vice versa — but only when the partner is itself compressible. Pure.
 */
function pairToolInteractions(
  compressedIndices: Set<number>,
  toCompress: CompressibleItem[],
  otherMessages: CompressibleItem[],
  compressible: CompressibleItem[],
): void {
  const byIndex = new Map(otherMessages.map((o) => [o.index, o]));
  const compressibleByIndex = new Map(compressible.map((c) => [c.index, c]));
  const useIndexByToolId = new Map<string, number>();
  const resultIndexByToolId = new Map<string, number>();

  for (const item of otherMessages) {
    if (!Array.isArray(item.msg.content)) continue;
    for (const block of item.msg.content) {
      if (block.type === "tool_use") {
        useIndexByToolId.set(block.id, item.index);
      } else if (block.type === "tool_result") {
        resultIndexByToolId.set(block.toolUseId, item.index);
      }
    }
  }

  // Fixpoint: an assistant message can carry several tool_use blocks, so
  // pulling in one partner may expose another unpaired partner.
  let changed = true;
  while (changed) {
    changed = false;
    for (const index of Array.from(compressedIndices)) {
      const item = byIndex.get(index);
      if (!item || !Array.isArray(item.msg.content)) continue;
      for (const block of item.msg.content) {
        const partnerIndex =
          block.type === "tool_use"
            ? resultIndexByToolId.get(block.id)
            : block.type === "tool_result"
              ? useIndexByToolId.get(block.toolUseId)
              : undefined;
        if (partnerIndex === undefined || compressedIndices.has(partnerIndex)) continue;
        const partner = compressibleByIndex.get(partnerIndex);
        if (!partner) continue; // pinned / recent / permission reminder — soft skip
        compressedIndices.add(partnerIndex);
        toCompress.push(partner);
        changed = true;
      }
    }
  }
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
 * Build the structured checkpoint prompt the model uses to summarize a
 * compressed span. dsh-style condensed checkpoint: fixed section headings,
 * empty sections write `(none)`, prior summaries are merged not copied.
 * Exported so tests can assert on the template directly.
 */
export function buildSummaryPrompt(messages: Message[]): string {
  const conversationText = messages
    .map((msg) => {
      const role = msg.role;
      const text = extractMessageText(msg);
      return `[${role}]: ${text}`;
    })
    .join("\n\n");

  return `Summarize the conversation segment below into a durable checkpoint. Write concise English engineering prose.

Rules:
- Keep every section heading exactly as given. If a section has nothing to record, write (none) — never drop a section.
- Preserve file paths, commands, identifiers, and numeric values verbatim.
- If the segment already contains a prior summary, merge it into these sections; do not copy it verbatim.

## Primary Request and Intent
## Key Technical Concepts
## Files and Code
## Errors and Fixes
## Pending Jobs
## Current Work
## Next Step
## Critical Context

Conversation segment:
${conversationText}`;
}
