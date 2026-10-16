import type {
  Api as PiApi,
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  ImageContent as PiImageContent,
  JsonObject as PiJsonObject,
  JsonValue as PiJsonValue,
  Message as PiMessage,
  Model as PiModel,
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
 * `model` is the current route's resolved pi-ai Model. Its `id` is passed
 * through to `readReplayEnvelope` so a message produced by a different model
 * degrades to unsigned content instead of replaying a foreign provider's
 * signatures; its `api`/`provider`/`id` are also stamped onto outgoing
 * assistant messages so pi-ai's own `transformMessages` isSameModel check
 * (which gates whether signed thinking/tool-call blocks survive) passes.
 */
export function toPiContext(req: ModelRequest, model: PiModel<PiApi>): PiContext {
  const modelId = model.id;
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
      messages.push(mapAssistantMessage(message, modelId, model));
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

/**
 * Map a request-surface image block to pi-ai's `ImageContent`.
 *
 * The Runner's `resolveImageRefs` replaces AttachmentStore refs with base64
 * before the provider sees the request. A ref that still reaches here means
 * that resolve step was skipped — throw rather than silently shipping a
 * payload the model cannot use, so the failure surfaces as a broken pipeline
 * instead of "the model cannot see the image".
 *
 * Vision gating is deliberately NOT done here: pi-ai's own transformMessages
 * strips images when `model.input` lacks "image" (collection.ts only puts it
 * there when the model is known-vision). This mapper is a pure wire-shape
 * translation.
 */
function toPiImageContent(block: { source: unknown }): PiImageContent {
  // Core's ImageContent is ref-only; the wire shape arrives as an untyped
  // cast at the request boundary. Narrow at runtime rather than widening core.
  const src = block.source as {
    type?: string;
    id?: string;
    mediaType?: string;
    data?: string;
  };
  if (src.type === "base64" && typeof src.mediaType === "string" && typeof src.data === "string") {
    return { type: "image", data: src.data, mimeType: src.mediaType };
  }
  if (src.type === "ref") {
    throw new Error(
      `pi-ai: unresolved image ref "${src.id ?? "<unknown>"}" reached the provider; ` +
        `the Runner must resolve AttachmentStore refs to base64 before modelPort.stream()`,
    );
  }
  throw new Error(`pi-ai: unsupported image source type "${src.type ?? "<missing>"}"`);
}

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
      content.push(toPiImageContent(block));
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

function mapAssistantMessage(
  message: AssistantMessage,
  model: string,
  piModel: PiModel<PiApi>,
): PiAssistantMessage {
  // Second, independent guard alongside readReplayEnvelope's own model check:
  // `source` is stamped by the kernel from the step context at assembly time,
  // while `modelMeta` is adapter-private and self-declared. A message whose
  // envelope claims the current model but whose kernel-stamped source
  // disagrees is foreign replay just as much as a mismatched envelope is; do
  // not trust the envelope in that case. An absent `source` (older messages,
  // or messages assembled before this field existed) is not a mismatch — it
  // falls back to the envelope's own check alone.
  //
  // `source.providerId` is deliberately not compared. It is provenance for
  // display (the host's provider-config id, e.g. "deepseek-official"), not a
  // routing predicate: pi-ai's own `model.provider` is a different vocabulary
  // ("deepseek"), so comparing them would mark every replay foreign and
  // silently strip signed thinking/tool-call blocks. modelId remains the
  // only field this decision reads.
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
    // content + stopReason + modelMeta. `usage` is a genuine placeholder
    // (we don't track historical token counts), but api/provider/model MUST
    // match the current route's real Model: pi-ai's own transformMessages
    // (dist/api/transform-messages.js) computes `isSameModel` by comparing
    // `assistantMsg.provider === model.provider && assistantMsg.api ===
    // model.api && assistantMsg.model === model.id` before deciding whether
    // to keep signed thinking/tool-call blocks or strip them to plain text.
    // Hardcoding "unknown" here made isSameModel always false, silently
    // dropping thinkingSignature/thoughtSignature on every replay.
    api: piModel.api,
    provider: piModel.provider,
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
        arguments: toPiToolArguments(block.input),
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

// ──────────────────────────────────────────────
// tool arguments
// ──────────────────────────────────────────────

/**
 * Validate a tool_use input as JSON before handing it to pi-ai, whose
 * `ToolCall.arguments` is `JsonObject` while core's `ToolUseContent.input`
 * is the wider `Record<string, unknown>`.
 *
 * The data in practice is JSON (provider tool-call parsing, zod-validated
 * tool output), so this rejects only states that could never survive wire
 * serialization anyway — throwing names the offending path instead of
 * letting `JSON.stringify` silently drop a `function`/`undefined` field and
 * ship a tool call the model never authorized.
 */
function toPiToolArguments(input: Record<string, unknown>): PiJsonObject {
  const out: PiJsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = toPiJsonValue(value, key);
  }
  return out;
}

function toPiJsonValue(value: unknown, path: string): PiJsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`pi-ai: tool argument "${path}" is ${String(value)}, which JSON cannot represent`);
      }
      return value;
    case "object": {
      if (Array.isArray(value)) {
        return value.map((item, index) => toPiJsonValue(item, `${path}[${index}]`));
      }
      return toPiToolArguments(value as Record<string, unknown>);
    }
    default:
      throw new Error(`pi-ai: tool argument "${path}" has type ${typeof value}, which JSON cannot represent`);
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
    // Map text and structured blocks 1:1 (structured degrades to a text
    // block with its text projection — pi-ai's tool result content takes
    // text/image only), preserving order so interleaved content stays
    // meaningful to the model. An empty content
    // array degrades to a single empty text block (same as before image
    // passthrough), because a toolResult with no content at all is not a
    // shape any provider path expects.
    const content: (PiTextContent | PiImageContent)[] = [];
    for (const b of block.content) {
      if (b.type === "text") {
        content.push({ type: "text", text: b.text });
      } else if (b.type === "structured") {
        content.push({ type: "text", text: b.text });
      } else {
        content.push(toPiImageContent(b));
      }
    }
    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }
    messages.push({
      role: "toolResult",
      toolCallId: block.toolUseId,
      toolName,
      content,
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
