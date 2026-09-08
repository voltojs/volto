import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Adapter-private, pure-JSON envelope that carries pi-ai's per-block replay
 * signatures (textSignature / thinkingSignature / thoughtSignature) across
 * core's neutral AssistantMessage representation.
 *
 * Core stores and returns this verbatim (as AssistantMessage.modelMeta) and
 * never reads it. It is persisted through a JSONL transcript store and
 * rebuilt in another process, so it must stay pure JSON: no Map, no
 * Uint8Array, no class instances, no undefined-valued keys.
 *
 * The envelope is block-aligned: one entry per assistant content block, in
 * order. Neutral content (text, reasoning text, tool call arguments) is
 * already carried by core's AssistantMessage.content; this envelope only
 * carries the provider-private signature/marker fields.
 */
export interface PiReplayEnvelope {
  version: 1;
  model: string;
  blocks: PiReplayBlock[];
}

export type PiReplayBlock =
  | { type: "text"; textSignature?: string }
  | { type: "reasoning"; thinkingSignature?: string; redacted?: boolean }
  | { type: "tool_use"; thoughtSignature?: string };

type PiAssistantContent = AssistantMessage["content"][number];

/**
 * Build the replay envelope for a finished pi-ai AssistantMessage. One
 * envelope block per content block, in the same order.
 */
export function toReplayEnvelope(message: AssistantMessage, model: string): PiReplayEnvelope {
  return {
    version: 1,
    model,
    blocks: message.content.map(toReplayBlock),
  };
}

function toReplayBlock(block: PiAssistantContent): PiReplayBlock {
  switch (block.type) {
    case "text":
      return withOptional({ type: "text" }, "textSignature", block.textSignature);
    case "thinking":
      return withOptional(
        withOptional({ type: "reasoning" }, "thinkingSignature", block.thinkingSignature),
        "redacted",
        block.redacted,
      );
    case "toolCall":
      return withOptional({ type: "tool_use" }, "thoughtSignature", block.thoughtSignature);
  }
}

// Only set the key when the value is present, so an absent signature never
// round-trips as an explicit `undefined`-valued key (which JSON.stringify
// drops silently, but which would still show up via `in`/`Object.keys` on
// the in-memory object before serialization).
function withOptional<T extends object, K extends string, V>(
  obj: T,
  key: K,
  value: V | undefined,
): T & Partial<Record<K, V>> {
  if (value === undefined) {
    return obj as T & Partial<Record<K, V>>;
  }
  return { ...obj, [key]: value } as T & Partial<Record<K, V>>;
}

/**
 * Parse and validate a replay envelope from persisted/foreign data.
 *
 * Never throws: malformed input, a model mismatch, or a wrong shape all
 * return `undefined` ("foreign replay"), so the caller can degrade to
 * unsigned blocks rather than failing the turn.
 */
export function readReplayEnvelope(value: unknown, model: string): PiReplayEnvelope | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;

  if (candidate.version !== 1) {
    return undefined;
  }
  if (typeof candidate.model !== "string" || candidate.model !== model) {
    return undefined;
  }
  if (!Array.isArray(candidate.blocks)) {
    return undefined;
  }

  const blocks: PiReplayBlock[] = [];
  for (const rawBlock of candidate.blocks) {
    const block = readReplayBlock(rawBlock);
    if (block === undefined) {
      return undefined;
    }
    blocks.push(block);
  }

  return { version: 1, model: candidate.model, blocks };
}

function readReplayBlock(value: unknown): PiReplayBlock | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;

  switch (candidate.type) {
    case "text": {
      if (candidate.textSignature !== undefined && typeof candidate.textSignature !== "string") {
        return undefined;
      }
      const block: PiReplayBlock = { type: "text" };
      return withOptional(block, "textSignature", candidate.textSignature as string | undefined);
    }
    case "reasoning": {
      if (
        candidate.thinkingSignature !== undefined &&
        typeof candidate.thinkingSignature !== "string"
      ) {
        return undefined;
      }
      if (candidate.redacted !== undefined && typeof candidate.redacted !== "boolean") {
        return undefined;
      }
      const block: PiReplayBlock = { type: "reasoning" };
      return withOptional(
        withOptional(block, "thinkingSignature", candidate.thinkingSignature as string | undefined),
        "redacted",
        candidate.redacted as boolean | undefined,
      );
    }
    case "tool_use": {
      if (
        candidate.thoughtSignature !== undefined &&
        typeof candidate.thoughtSignature !== "string"
      ) {
        return undefined;
      }
      const block: PiReplayBlock = { type: "tool_use" };
      return withOptional(block, "thoughtSignature", candidate.thoughtSignature as string | undefined);
    }
    default:
      return undefined;
  }
}
