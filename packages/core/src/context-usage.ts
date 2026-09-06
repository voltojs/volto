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

/** System prompt layers + tool definitions exactly as the last request carried them. */
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

export interface ContextUsageFold {
  /** The most recent request_header (last-wins). */
  header: ContextUsageHeader | null;
  /** The most recent assistant_message that carried provider usage. */
  anchor: ContextUsageAnchor | null;
  /** Estimated tokens added to the surface since the anchor (or since start). */
  pendingTokens: number;
}

export interface ContextUsageView {
  projectedTokens: number;
  /** The three buckets sum exactly to projectedTokens — messages is the residual. */
  breakdown: { system: number; tools: number; messages: number };
  /** Per system layer estimates, in layer order. */
  layers: Array<{ id: string; tokens: number }>;
  /** false = no provider usage seen yet; every number is a pure estimate. */
  anchored: boolean;
}

export function emptyContextUsageFold(): ContextUsageFold {
  return { header: null, anchor: null, pendingTokens: 0 };
}

function countBlocks(blocks: readonly ContentBlock[], tokenizer: Tokenizer): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === "text") total += tokenizer.count(block.text);
    else if (block.type === "tool_use") total += tokenizer.count(JSON.stringify(block.input));
    // Image and tool_result blocks are not estimated here — tool results
    // reach the fold as their own tool_result events.
  }
  return total;
}

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
        };
      }
      // A response still lands on the surface even when the provider reports
      // no usage — estimate it so the projection keeps moving.
      return {
        ...fold,
        pendingTokens:
          fold.pendingTokens +
          (data.reasoning ? tokenizer.count(data.reasoning) : 0) +
          countBlocks(data.content, tokenizer),
      };
    }
    case "tool_result": {
      const data = event.data as TranscriptEventMap["tool_result"];
      return { ...fold, pendingTokens: fold.pendingTokens + tokenizer.count(data.content) };
    }
    case "user_message":
    case "steering_queued": {
      const data = event.data as TranscriptEventMap["user_message"] | TranscriptEventMap["steering_queued"];
      const added =
        typeof data.content === "string"
          ? tokenizer.count(data.content)
          : countBlocks(data.content, tokenizer);
      return { ...fold, pendingTokens: fold.pendingTokens + added };
    }
    default:
      return fold;
  }
}

function estimateHeader(
  header: ContextUsageHeader,
  tokenizer: Tokenizer,
): { system: number; tools: number; layers: Array<{ id: string; tokens: number }> } {
  let system = 0;
  const layers = header.systemLayers.map((layer) => {
    const tokens = tokenizer.count(layer.text);
    system += tokens;
    return { id: layer.id, tokens };
  });
  let tools = 0;
  for (const tool of header.tools) tools += tokenizer.count(JSON.stringify(tool));
  return { system, tools, layers };
}

export function contextUsageView(
  fold: ContextUsageFold,
  tokenizer: Tokenizer,
): ContextUsageView | null {
  if (!fold.header) return null;
  const { system, tools, layers } = estimateHeader(fold.header, tokenizer);
  const anchorTotal = fold.anchor
    ? fold.anchor.promptTokens + fold.anchor.outputTokens + fold.pendingTokens
    : system + tools + fold.pendingTokens;
  // The floor keeps the projected total from falling below the header
  // estimate + pending, so the three breakdown buckets (whose residual is
  // clamped at zero) always sum exactly to `projectedTokens`.
  const projectedTokens = Math.max(anchorTotal, system + tools + fold.pendingTokens);
  // Residual bucket: keeps the three segments summing exactly to the total.
  const messages = Math.max(0, projectedTokens - system - tools);
  return {
    projectedTokens,
    breakdown: { system, tools, messages },
    layers,
    anchored: fold.anchor !== null,
  };
}

export function computeContextUsage(
  events: readonly TranscriptEventInput[],
  tokenizer: Tokenizer,
): ContextUsageFold {
  let fold = emptyContextUsageFold();
  for (const event of events) fold = foldContextUsageEvent(fold, event, tokenizer);
  return fold;
}
