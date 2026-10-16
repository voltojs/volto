/**
 * Anthropic ModelPort adapter.
 *
 * Connects to /v1/messages with stream:true,
 * normalizes the SSE response into core ModelEvents.
 */

import type { ModelPort, ModelEvent, ModelRequest, Message, ContentBlock, ModelInputValue, ToolResultBlock, ResolvedModelInfo } from "@volto/core";
import { normalizeStream, type RawAnthropicEvent } from "./stream-normalize.js";

export interface AnthropicModelPortOptions {
  /** Base URL of the Anthropic API (default: https://api.anthropic.com) */
  baseURL?: string;
  /** API key for x-api-key header */
  apiKey: string;
  /** Default model if not specified in request */
  defaultModel?: string;
  /**
   * Input-modalities override for every model this port serves. Absent lets
   * {@link anthropicFamilyVision} decide from well-known Anthropic model ids;
   * unrecognized ids stay UNKNOWN rather than guessing text-only.
   */
  input?: ModelInputValue;
}

/**
 * Image-input support for known Anthropic model-id families.
 * Claude 3 and later accept images; Claude 2 / Instant do not. Unrecognized
 * ids (proxied, renamed, or future models) return undefined = UNKNOWN.
 */
export function anthropicFamilyVision(model: string): boolean | undefined {
  if (/^claude-instant|^claude-2/.test(model)) return false;
  if (/^claude-3|^claude-(?:sonnet|opus|haiku|fable)-\d/.test(model)) return true;
  return undefined;
}

/** bool→input at the projection boundary; keeps the family helpers boolean-shaped. */
function toInput(vision: boolean | undefined): ModelInputValue | undefined {
  if (vision === undefined) return undefined;
  return vision ? ["text", "image"] : ["text"];
}

export function createAnthropicModelPort(opts: AnthropicModelPortOptions): ModelPort {
  const baseURL = (opts.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");

  return {
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      const model = req.model ?? opts.defaultModel ?? "claude-sonnet-4-20250514";

      const body = buildRequestBody(req, model);

      let response: Response;
      try {
        response = await fetch(`${baseURL}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: req.abortSignal,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          yield { type: "error", error: "Request aborted", retriable: false };
          return;
        }
        yield {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          retriable: true,
        };
        return;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        yield {
          type: "error",
          error: `Anthropic API error ${response.status}: ${errorText}`,
          retriable: response.status >= 500 || response.status === 429,
        };
        return;
      }

      if (!response.body) {
        yield { type: "error", error: "Empty response body", retriable: true };
        return;
      }

      const rawEvents = parseSSEStream(response.body);
      yield* normalizeStream(rawEvents);
    },
    describeModel: async (model: string): Promise<ResolvedModelInfo> => {
      const info: ResolvedModelInfo = { model };
      const input = opts.input ?? toInput(anthropicFamilyVision(model));
      if (input !== undefined) {
        info.input = input;
      }
      return info;
    },
  };
}

// ──────────────────────────────────────────────
// Request body builder
// ──────────────────────────────────────────────

function buildRequestBody(req: ModelRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? 4096,
    stream: true,
  };

  // System prompt goes as a top-level field (not a message role)
  const systemParts: string[] = [];
  const otherMessages: Message[] = [];

  for (const msg of req.messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else {
      otherMessages.push(msg);
    }
  }

  // Cache breakpoints: convert system to block format if cache_control needed
  const hasSystemCacheBreakpoint = (req.cacheBreakpoints ?? []).some(
    (bp) => bp === 0 && systemParts.length > 0,
  );

  if (hasSystemCacheBreakpoint) {
    // Anthropic system field can be an array of content blocks with cache_control
    body.system = [
      {
        type: "text",
        text: systemParts.join("\n\n"),
        cache_control: { type: "ephemeral" },
      },
    ];
  } else if (systemParts.length > 0) {
    body.system = systemParts.join("\n\n");
  }

  // Convert messages and apply cache_control at breakpoint indices
  const breakpoints = new Set(req.cacheBreakpoints ?? []);
  // Adjust breakpoints: system messages are extracted, so message indices shift
  const systemCount = systemParts.length;
  const convertedMessages = otherMessages.map((msg, i) => {
    const converted = convertMessage(msg);
    // Breakpoint index i+systemCount in original = breakpoint at i in otherMessages
    if (breakpoints.has(i + systemCount)) {
      return { ...converted, cache_control: { type: "ephemeral" } };
    }
    return converted;
  });

  body.messages = convertedMessages;

  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  if (req.temperature !== undefined) {
    body.temperature = req.temperature;
  }

  // Structured / JSON output mode — Anthropic doesn't have native JSON schema
  // mode, so inject a system instruction to enforce JSON output.
  if (req.responseFormat?.type === "json") {
    const schemaHint = req.responseFormat.schema
      ? `\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(req.responseFormat.schema, null, 2)}`
      : "\nYou MUST respond with valid JSON only. No markdown, no explanations outside the JSON.";
    systemParts.push(schemaHint);
    body.system = systemParts.join("\n\n");
  }

  return body;
}

/**
 * Map a request-surface image block (base64 wire shape produced by the
 * Runner's resolveImageRefs) to Anthropic's image block. Returns null when
 * the block is not a resolvable base64 image so callers can degrade.
 */
function toAnthropicImageBlock(block: ContentBlock): Record<string, unknown> | null {
  if (block.type !== "image") return null;
  // Core's ImageContent is ref-only; the wire shape arrives as an untyped
  // cast at the request boundary. Narrow at runtime rather than widening core.
  const src = block.source as { type?: string; mediaType?: string; data?: string };
  if (src.type === "base64" && typeof src.mediaType === "string" && typeof src.data === "string") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: src.mediaType,
        data: src.data,
      },
    };
  }
  return null;
}

/** Map a tool-result content block (text | structured | image) to Anthropic's shape. */
function toAnthropicToolResultBlock(block: ToolResultBlock): Record<string, unknown> {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "structured") {
    // Anthropic tool_result content accepts text/image only — degrade the
    // structured block to a text block carrying its text projection rather
    // than pretending native structured support or silently dropping it.
    return { type: "text", text: block.text };
  }
  const image = toAnthropicImageBlock(block);
  return image ?? { type: "text", text: "[image omitted]" };
}

/**
 * Map core messages to Anthropic's message array. Exported for tests;
 * buildRequestBody applies cache breakpoints on top of this.
 */
export function toAnthropicMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map(convertMessage);
}

function convertMessage(msg: Message): Record<string, unknown> {
  switch (msg.role) {
    case "user": {
      if (typeof msg.content === "string") {
        return { role: "user", content: msg.content };
      }
      // ContentBlock[] — convert to Anthropic content blocks
      return {
        role: "user",
        content: msg.content.map((block) => {
          if (block.type === "text") {
            return { type: "text", text: block.text };
          }
          if (block.type === "image") {
            const image = toAnthropicImageBlock(block);
            return image ?? { type: "text", text: "[image omitted]" };
          }
          if (block.type === "tool_result") {
            return {
              type: "tool_result",
              tool_use_id: block.toolUseId,
              content: block.content.map(toAnthropicToolResultBlock),
              ...(block.isError ? { is_error: true } : {}),
            };
          }
          return block;
        }),
      };
    }

    case "assistant": {
      const content: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          content.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
        // The core does carry reasoning blocks now, but faithful replay of a
        // "thinking" block back to Anthropic needs its per-block signature,
        // which travels in modelMeta — this adapter does not read that yet,
        // so the reasoning text is dropped here rather than resent unsigned.
      }
      return { role: "assistant", content };
    }

    case "tool": {
      // Anthropic uses "user" role with tool_result content blocks
      return {
        role: "user",
        content: msg.content.map((tc) => ({
          type: "tool_result",
          tool_use_id: tc.toolUseId,
          content: tc.content.map(toAnthropicToolResultBlock),
          ...(tc.isError ? { is_error: true } : {}),
        })),
      };
    }

    default:
      // System messages are filtered in buildRequestBody; this path is unreachable
      return msg as unknown as Record<string, unknown>;
  }
}

// ──────────────────────────────────────────────
// SSE parser
// ──────────────────────────────────────────────

async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<RawAnthropicEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        try {
          const parsed = JSON.parse(data) as RawAnthropicEvent;
          yield parsed;
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
