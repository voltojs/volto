import type {
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  ImageContent as PiImageContent,
  Message as PiMessage,
  TextContent as PiTextContent,
  ThinkingContent as PiThinkingContent,
  Tool as PiTool,
  ToolCall as PiToolCall,
  ToolResultMessage as PiToolResultMessage,
  Usage as PiUsage,
  UserMessage as PiUserMessage,
} from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  ModelRequest,
  ToolDefinition,
  ToolResultContent,
} from "@volto/core";
import { readReplayEnvelope, type PiReplayBlock } from "./replay.js";

/**
 * Translate core's neutral Message[] (and tool definitions) into a pi-ai
 * Context ready to hand to Models.stream/streamSimple.
 *
 * `model` is the current route's model id, passed through to
 * `readReplayEnvelope` so a message produced by a different model degrades
 * to unsigned content instead of replaying a foreign provider's signatures.
 */
export function toPiContext(req: ModelRequest, model: string): PiContext {
  const systemPrompt = req.messages
    .filter((m): m is Extract<Message, { role: "system" }> => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  // Built once per call (not rescanned per tool-result block): maps a
  // tool_use block's id to its name, for mapToolResultMessage's reverse
  // lookup below.
  const toolNameById = buildToolNameIndex(req.messages);

  const messages: PiMessage[] = [];
  for (const message of req.messages) {
    if (message.role === "system") {
      continue; // merged into systemPrompt above
    }
    if (message.role === "user") {
      messages.push(mapUserMessage(message));
    } else if (message.role === "assistant") {
      messages.push(mapAssistantMessage(message, model));
    } else {
      messages.push(...mapToolResultMessage(message.content, toolNameById));
    }
  }

  const context: PiContext = { messages };
  if (systemPrompt.length > 0) {
    context.systemPrompt = systemPrompt;
  }
  if (req.tools.length > 0) {
    context.tools = req.tools.map(mapToolDefinition);
  }
  return context;
}

// ──────────────────────────────────────────────
// user
// ──────────────────────────────────────────────

function mapUserMessage(message: Extract<Message, { role: "user" }>): PiUserMessage {
  const timestamp = 0; // see note in mapAssistantMessage about historical timestamps
  if (typeof message.content === "string") {
    return { role: "user", content: message.content, timestamp };
  }
  const content: (PiTextContent | PiImageContent)[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      // pi-ai's ImageContent.data is unconditionally treated as base64 —
      // there is no separate URL variant, and no way to say "fetch this
      // URL" instead. Passing a URL through as `data` would produce a
      // malformed (not merely degraded) request, so skip URL-sourced image
      // blocks defensively, consistent with this file's other defensive
      // skips.
      if (block.source.type === "url") {
        continue;
      }
      content.push({ type: "image", data: block.source.data, mimeType: block.source.mediaType });
    }
    // Other ContentBlock variants (tool_use / tool_result / reasoning) are not
    // part of core's user-message contract; skip defensively rather than
    // throwing so a malformed upstream state doesn't break the whole request.
  }
  return { role: "user", content, timestamp };
}

// ──────────────────────────────────────────────
// assistant
// ──────────────────────────────────────────────

function mapAssistantMessage(message: AssistantMessage, model: string): PiAssistantMessage {
  // Second, independent guard alongside readReplayEnvelope's own model check:
  // `source` is stamped by the kernel from the step context at assembly time,
  // while `modelMeta` is adapter-private and self-declared. A message whose
  // envelope claims the current model but whose kernel-stamped source
  // disagrees is foreign replay just as much as a mismatched envelope is; do
  // not trust the envelope in that case. An absent `source` (older messages,
  // or messages assembled before this field existed) is not a mismatch — it
  // falls back to the envelope's own check alone.
  //
  // `source.providerId` is intentionally not compared: the Runner only knows
  // `stepContext.model`, so the kernel never populates `providerId` today.
  // Cross-provider routing is a later phase; comparing an always-undefined
  // field would just make every message look foreign.
  const isForeignSource = message.source !== undefined && message.source.modelId !== model;
  const envelope = isForeignSource ? undefined : readReplayEnvelope(message.modelMeta, model);

  const content: (PiTextContent | PiThinkingContent | PiToolCall)[] = [];
  message.content.forEach((block, index) => {
    const replayBlock = envelope?.blocks[index];
    const mapped = mapAssistantContentBlock(block, replayBlock);
    if (mapped !== undefined) {
      content.push(mapped);
    }
  });

  return {
    role: "assistant",
    content,
    // pi-ai's AssistantMessage doubles as "the full response envelope from a
    // provider" (api/provider/model/usage/stopReason are all required,
    // non-optional fields), but core's neutral AssistantMessage only tracks
    // content + stopReason + modelMeta. When we're reconstructing history to
    // send back out (not receiving a fresh response), those provenance
    // fields are placeholders: pi-ai's own `convertMessages` implementations
    // only read `content` (and the replay signatures within it) when
    // building an outgoing request from message history, not `usage`/`api`.
    api: "unknown",
    provider: "unknown",
    model,
    usage: zeroUsage(),
    stopReason: mapStopReason(message.stopReason),
    // See mapUserMessage: core does not track per-message wall-clock time,
    // so historical messages get a static placeholder timestamp rather than
    // reading the clock here (which would make this pure-translation
    // function's output depend on when it happens to run).
    timestamp: 0,
  };
}

function mapAssistantContentBlock(
  block: ContentBlock,
  replayBlock: PiReplayBlock | undefined,
): PiTextContent | PiThinkingContent | PiToolCall | undefined {
  switch (block.type) {
    case "text": {
      const textSignature =
        replayBlock?.type === "text" ? replayBlock.textSignature : undefined;
      const text: PiTextContent = { type: "text", text: block.text };
      if (textSignature !== undefined) {
        text.textSignature = textSignature;
      }
      return text;
    }
    case "reasoning": {
      // The thinking block must always carry the reasoning text through,
      // whether or not a signature is available (foreign replay / missing
      // envelope / predates the envelope). Losing the text would silently
      // break a provider that relies on seeing its own prior reasoning.
      const thinking: PiThinkingContent = { type: "thinking", thinking: block.text };
      if (replayBlock?.type === "reasoning") {
        if (replayBlock.thinkingSignature !== undefined) {
          thinking.thinkingSignature = replayBlock.thinkingSignature;
        }
        if (replayBlock.redacted !== undefined) {
          thinking.redacted = replayBlock.redacted;
        }
      }
      return thinking;
    }
    case "tool_use": {
      const thoughtSignature =
        replayBlock?.type === "tool_use" ? replayBlock.thoughtSignature : undefined;
      const toolCall: PiToolCall = {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: block.input,
      };
      if (thoughtSignature !== undefined) {
        toolCall.thoughtSignature = thoughtSignature;
      }
      return toolCall;
    }
    case "image":
    case "tool_result":
      // Assistant messages do not carry image or tool_result blocks in
      // core's model; skip defensively rather than throwing, so a
      // malformed upstream state doesn't break the whole request.
      return undefined;
  }
}

function mapStopReason(stopReason: AssistantMessage["stopReason"]): PiAssistantMessage["stopReason"] {
  switch (stopReason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    case "end_turn":
    case undefined:
      return "stop";
  }
}

function zeroUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// ──────────────────────────────────────────────
// tool result
// ──────────────────────────────────────────────

/**
 * Map tool results to pi-ai's `ToolResultMessage`, dropping any result whose
 * originating `tool_use` block cannot be found.
 *
 * This is not hypothetical: compaction (`packages/core/src/compactor.ts`)
 * walks the message list greedily against a token budget and can compress an
 * old assistant `tool_use` message while its later `tool` result message
 * stays inside the recent-keep window, with nothing pairing the two. That is
 * an ordinary, expected outcome of normal operation, not a corrupted
 * transcript — so we degrade (drop the orphaned result) instead of throwing.
 * pi-ai's ToolResultMessage.toolName is a required, non-empty-in-practice
 * string; there is no sensible placeholder to send for an orphaned result,
 * so omitting the whole message is the only safe option.
 */
function mapToolResultMessage(
  blocks: ToolResultContent[],
  toolNameById: ReadonlyMap<string, string>,
): PiToolResultMessage[] {
  const messages: PiToolResultMessage[] = [];
  for (const block of blocks) {
    const toolName = toolNameById.get(block.toolUseId);
    if (toolName === undefined) {
      continue;
    }
    messages.push({
      role: "toolResult",
      toolCallId: block.toolUseId,
      toolName,
      content: [{ type: "text", text: block.content }],
      isError: block.isError ?? false,
      timestamp: 0,
    });
  }
  return messages;
}

/** Index every assistant `tool_use` block's id -> name, once per toPiContext call. */
function buildToolNameIndex(allMessages: readonly Message[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const message of allMessages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_use") {
        index.set(block.id, block.name);
      }
    }
  }
  return index;
}

// ──────────────────────────────────────────────
// tools
// ──────────────────────────────────────────────

function mapToolDefinition(tool: ToolDefinition): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    // `Tool<TParameters extends TSchema>` — `TSchema` (from the `typebox`
    // package) is declared as `export interface TSchema {}`: a structurally
    // empty interface with no required members and no hidden Symbol brand.
    // Any plain JSON-Schema-shaped object is therefore structurally
    // assignable to it without a cast; TypeBox schemas are just JSON Schema
    // objects with extra optional properties (see typebox's
    // types/schema.d.mts). Verified by reading the installed
    // typebox@1.3.7 package directly.
    parameters: tool.inputSchema,
  };
}
