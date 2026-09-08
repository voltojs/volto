/**
 * Context usage — how full the model's context window is for one session,
 * projected from the durable transcript.
 *
 * Dual-track measurement: the last provider-reported usage anchors the real
 * prompt size; whatever lands on the surface after that anchor (tool results,
 * user messages, usage-less assistant output) is estimated with the injected
 * heuristic tokenizer. The next usage re-anchors and absorbs the accumulated
 * estimation error.
 *
 * Pure functions only: no I/O, no clock, no randomness; the tokenizer is
 * injected. The fold state is JSON-serializable so a host can snapshot it
 * (GET /sessions/:id) and a client can continue folding live events from it.
 */

import type { Tokenizer, TranscriptEventInput, TranscriptEventMap } from "./ports.js";
import type { JSONSchema } from "./tool.js";
import type { ContentBlock } from "./state.js";

/**
 * System prompt layers + tool definitions exactly as the last request
 * carried them. Fold-side only (see the docblock on ContextUsageFold below)
 * — has no production consumer today.
 */
export interface ContextUsageHeader {
  systemLayers: Array<{ id: string; text: string }>;
  tools: Array<{ name: string; description: string; schema: JSONSchema }>;
}

/** The last provider-measured call: full prompt size plus what it produced. */
export interface ContextUsageAnchor {
  /** inputTokens + cacheReadTokens + cacheWriteTokens (see the usage-semantics note in stream-normalize). */
  promptTokens: number;
  outputTokens: number;
}

/**
 * Fold-side API (this interface plus emptyContextUsageFold,
 * foldContextUsageEvent, contextUsageView, computeContextUsage and
 * snapshotFold below): retains the header's full text, which is what lets
 * the server re-price a whole session if the tokenizer changes, and backs
 * the oracle used by the snapshot-equivalence tests. It currently has no
 * production consumer — every production path (headless-server, web) uses
 * the snapshot API (`ContextUsageSnapshot`, `emptyContextUsageSnapshot`,
 * `foldSnapshotEvent`, `snapshotView`) instead, which is the entry point for
 * anything crossing a process or storage boundary. This is not deprecated —
 * keep it — but new code should reach for the snapshot API first.
 */
export interface ContextUsageFold {
  /** The most recent request_header (last-wins). */
  header: ContextUsageHeader | null;
  /** The most recent assistant_message that carried provider usage. */
  anchor: ContextUsageAnchor | null;
  /**
   * Estimated tokens added since the anchor. Reset by every measured
   * assistant_message — this is what rides on top of the anchor to project
   * the next prompt size.
   */
  pendingTokens: number;
  /**
   * Estimated tokens of everything currently on the conversation surface.
   * Never reset by an anchor (the messages are still there); only a
   * compaction, which actually removes them, resets it. This is the
   * breakdown's messages bucket — an independent estimate, not a residual.
   */
  messageTokens: number;
}

export interface ContextUsageView {
  projectedTokens: number;
  /**
   * Three independent estimates. They deliberately do NOT sum to
   * projectedTokens: when anchored, projectedTokens is a measurement and
   * these are estimates over a different (and overlapping) surface.
   */
  breakdown: { system: number; tools: number; messages: number };
  /** Per system layer estimates, in layer order. */
  layers: Array<{ id: string; tokens: number }>;
  /** false = no provider usage seen yet; every number is a pure estimate. */
  anchored: boolean;
}

/** Fold-side (see the docblock on ContextUsageFold) — no production consumer today. */
export function emptyContextUsageFold(): ContextUsageFold {
  return { header: null, anchor: null, pendingTokens: 0, messageTokens: 0 };
}

/**
 * Per-block overhead for JSON framing and type tags, and per-message overhead
 * for the role field. Pure chars/4 systematically under-counts a
 * tool-call-heavy conversation; these constants match deepseek-harness's
 * token-meter so both estimators price the same content the same way.
 */
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;

function countBlocks(blocks: readonly ContentBlock[], tokenizer: Tokenizer): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === "text") {
      total += tokenizer.count(block.text) + BLOCK_OVERHEAD;
    } else if (block.type === "tool_use") {
      total +=
        tokenizer.count(block.name) + tokenizer.count(JSON.stringify(block.input)) + BLOCK_OVERHEAD;
    } else {
      // Images, tool_result blocks embedded in a message, and any future
      // block type keep a conservative structural price via JSON.stringify.
      // A tool_result block here is priced once against this event's own
      // content; it cannot double-count against the separate tool_result
      // EVENT handled below, since the two are independent data sources.
      total += tokenizer.count(JSON.stringify(block)) + BLOCK_OVERHEAD;
    }
  }
  return total;
}

/** One message's price: its blocks plus the role framing. */
function countMessage(blocks: readonly ContentBlock[], tokenizer: Tokenizer): number {
  return countBlocks(blocks, tokenizer) + ROLE_OVERHEAD;
}

/** Fold-side (see the docblock on ContextUsageFold) — no production consumer today. */
export function foldContextUsageEvent(
  fold: ContextUsageFold,
  event: TranscriptEventInput,
  tokenizer: Tokenizer,
): ContextUsageFold {
  switch (event.type) {
    case "request_header": {
      const data = event.data as TranscriptEventMap["request_header"];
      return {
        ...fold,
        header: {
          systemLayers: data.systemLayers.map((l) => ({ ...l })),
          tools: data.tools.map((t) => ({ ...t })),
        },
      };
    }
    case "assistant_message": {
      const data = event.data as TranscriptEventMap["assistant_message"];
      const usage = data.usage;
      if (usage) {
        return {
          ...fold,
          anchor: {
            promptTokens:
              usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
            outputTokens: usage.outputTokens,
          },
          pendingTokens: 0,
          // The response is on the surface regardless of it being measured.
          messageTokens:
            fold.messageTokens +
            (data.reasoning ? tokenizer.count(data.reasoning) + BLOCK_OVERHEAD : 0) +
            countMessage(data.content, tokenizer),
        };
      }
      // A response still lands on the surface even when the provider reports
      // no usage — estimate it so the projection keeps moving.
      {
        const added =
          (data.reasoning ? tokenizer.count(data.reasoning) + BLOCK_OVERHEAD : 0) +
          countMessage(data.content, tokenizer);
        return {
          ...fold,
          pendingTokens: fold.pendingTokens + added,
          messageTokens: fold.messageTokens + added,
        };
      }
    }
    case "tool_result": {
      const data = event.data as TranscriptEventMap["tool_result"];
      const added = tokenizer.count(data.content) + BLOCK_OVERHEAD;
      return {
        ...fold,
        pendingTokens: fold.pendingTokens + added,
        messageTokens: fold.messageTokens + added,
      };
    }
    case "user_message":
    case "steering_queued": {
      const data = event.data as TranscriptEventMap["user_message"] | TranscriptEventMap["steering_queued"];
      const added =
        typeof data.content === "string"
          ? tokenizer.count(data.content) + BLOCK_OVERHEAD + ROLE_OVERHEAD
          : countMessage(data.content, tokenizer);
      return { ...fold, pendingTokens: fold.pendingTokens + added, messageTokens: fold.messageTokens + added };
    }
    case "compaction": {
      const data = event.data as TranscriptEventMap["compaction"];
      // Compaction replaces the surface with a summary: both counters restart
      // from what actually remains. Note: the Runner does not yet emit this
      // event (see the "not yet recorded" comment on ports.ts); this arm is
      // implemented ahead of that so the fold is ready once it does.
      return {
        ...fold,
        pendingTokens: 0,
        messageTokens: tokenizer.count(data.summaryText) + BLOCK_OVERHEAD,
      };
    }
    default:
      return fold;
  }
}

function estimateHeader(
  header: ContextUsageHeader,
  tokenizer: Tokenizer,
): ContextUsageHeaderEstimate {
  let system = 0;
  const layers = header.systemLayers.map((layer) => {
    const tokens = tokenizer.count(layer.text);
    system += tokens;
    return { id: layer.id, tokens };
  });
  let tools = 0;
  if (header.tools.length > 0) {
    tools = tokenizer.count(JSON.stringify(header.tools)) + BLOCK_OVERHEAD;
  }
  return { system: system > 0 ? system + ROLE_OVERHEAD : 0, tools, layers };
}

/**
 * Fold-shaped convenience wrapper: prices the header first, then delegates to
 * `snapshotView` for the actual projection arithmetic. Kept so callers that
 * hold a `ContextUsageFold` (the server, mid-request) don't need to build a
 * snapshot by hand — but `snapshotView` below is the single implementation.
 * Fold-side (see the docblock on ContextUsageFold) — no production consumer today.
 */
export function contextUsageView(
  fold: ContextUsageFold,
  tokenizer: Tokenizer,
): ContextUsageView | null {
  return snapshotView(snapshotFold(fold, tokenizer));
}

/** Fold-side (see the docblock on ContextUsageFold) — no production consumer today. */
export function computeContextUsage(
  events: readonly TranscriptEventInput[],
  tokenizer: Tokenizer,
): ContextUsageFold {
  let fold = emptyContextUsageFold();
  for (const event of events) fold = foldContextUsageEvent(fold, event, tokenizer);
  return fold;
}

/** Header composition already priced — the serializable form, no full text. */
export interface ContextUsageHeaderEstimate {
  system: number;
  tools: number;
  layers: Array<{ id: string; tokens: number }>;
}

/**
 * The fold's cross-process transport form: a handful of numbers.
 *
 * ContextUsageFold keeps the header's full text because the server folds from
 * raw events and can re-price it if the tokenizer changes. None of that
 * travels: a header carries every system layer plus every tool schema, tens
 * of kilobytes per session. The client re-derives the estimate itself the
 * moment a new request_header arrives (the event carries the full text), so
 * nothing is lost by sending numbers.
 */
export interface ContextUsageSnapshot {
  headerEstimate: ContextUsageHeaderEstimate | null;
  anchor: ContextUsageAnchor | null;
  pendingTokens: number;
  messageTokens: number;
}

export function emptyContextUsageSnapshot(): ContextUsageSnapshot {
  return { headerEstimate: null, anchor: null, pendingTokens: 0, messageTokens: 0 };
}

/**
 * Prices a fold's header once and drops the text.
 * Fold-side input (see the docblock on ContextUsageFold) — no production
 * consumer today; used by the snapshot-equivalence tests, for which this
 * fold API is the oracle.
 */
export function snapshotFold(
  fold: ContextUsageFold,
  tokenizer: Tokenizer,
): ContextUsageSnapshot {
  return {
    headerEstimate: fold.header ? estimateHeader(fold.header, tokenizer) : null,
    anchor: fold.anchor ? { ...fold.anchor } : null,
    pendingTokens: fold.pendingTokens,
    messageTokens: fold.messageTokens,
  };
}

/**
 * The same per-event rules as foldContextUsageEvent, over a snapshot: only the
 * request_header arm differs, pricing the header on arrival instead of
 * storing its text.
 */
export function foldSnapshotEvent(
  snap: ContextUsageSnapshot,
  event: TranscriptEventInput,
  tokenizer: Tokenizer,
): ContextUsageSnapshot {
  if (event.type === "request_header") {
    const data = event.data as TranscriptEventMap["request_header"];
    return {
      ...snap,
      headerEstimate: estimateHeader(
        {
          systemLayers: data.systemLayers.map((l) => ({ ...l })),
          tools: data.tools.map((t) => ({ ...t })),
        },
        tokenizer,
      ),
    };
  }
  // Every other arm only touches the two counters, so reuse the fold rules
  // verbatim through a header-less carrier — one implementation, no drift.
  const carrier: ContextUsageFold = {
    header: null,
    anchor: snap.anchor,
    pendingTokens: snap.pendingTokens,
    messageTokens: snap.messageTokens,
  };
  const folded = foldContextUsageEvent(carrier, event, tokenizer);
  return {
    headerEstimate: snap.headerEstimate,
    anchor: folded.anchor,
    pendingTokens: folded.pendingTokens,
    messageTokens: folded.messageTokens,
  };
}

/**
 * The view, straight from the numbers — no tokenizer needed. This is the
 * single implementation of the projection arithmetic; `contextUsageView`
 * above is a thin wrapper that prices a fold's header into a snapshot first.
 */
export function snapshotView(snap: ContextUsageSnapshot): ContextUsageView | null {
  if (!snap.headerEstimate) return null;
  const { system, tools, layers } = snap.headerEstimate;
  const projectedTokens = snap.anchor
    ? snap.anchor.promptTokens + snap.anchor.outputTokens + snap.pendingTokens
    : system + tools + snap.messageTokens;
  return {
    projectedTokens,
    breakdown: { system, tools, messages: snap.messageTokens },
    layers,
    anchored: snap.anchor !== null,
  };
}
