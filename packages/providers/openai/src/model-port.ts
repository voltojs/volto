/**
 * OpenAI-compatible ModelPort adapter.
 *
 * Connects to /v1/chat/completions with stream:true,
 * normalizes the SSE response into core ModelEvents.
 * Supports any OpenAI-compatible gateway via configurable baseURL.
 */

import type {
  ModelPort,
  ModelEvent,
  ModelRequest,
  Message,
  ToolResultMessage,
  ToolResultBlock,
  ResolvedModelInfo,
} from "@volto/core";
import { normalizeStream, type RawStreamChunk } from "./stream-normalize.js";

export interface OpenAIModelPortOptions {
  /** Base URL of the OpenAI-compatible API (default: https://api.openai.com) */
  baseURL?: string;
  /** API key for Authorization header */
  apiKey: string;
  /** Default model if not specified in request */
  defaultModel?: string;
  /**
   * Image-input override for every model this port serves. Absent lets
   * {@link openaiFamilyVision} decide from well-known OpenAI model ids;
   * unrecognized gateway ids stay UNKNOWN rather than guessing false.
   */
  vision?: boolean;
}

/**
 * Image-input support for well-known OpenAI model-id families.
 * gpt-4o / gpt-4-turbo / gpt-4.1 / o-series accept images; gpt-3.5 does
 * not. Everything else — bare gpt-4, custom gateway names, future ids —
 * returns undefined = UNKNOWN so an OpenAI-compatible proxy is never
 * silently stripped of image support.
 */
export function openaiFamilyVision(model: string): boolean | undefined {
  if (/^gpt-4o|^gpt-4-turbo|^gpt-4\.1|^gpt-4-vision|^o[134](?:-|$)/.test(model)) return true;
  if (/^gpt-3\.5/.test(model)) return false;
  return undefined;
}

export function createOpenAIModelPort(opts: OpenAIModelPortOptions): ModelPort {
  const trimmed = (opts.baseURL ?? "https://api.openai.com").replace(/\/+$/, "");
  // Gateways are commonly published with the version segment already included
  // (that is what the official OpenAI SDK expects in `baseURL`). Appending our
  // own would produce `/v1/v1/chat/completions`, so only add it when missing.
  const endpoint = /\/v\d+$/.test(trimmed)
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`;

  return {
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      const model = req.model ?? opts.defaultModel ?? "gpt-4o";

      const body = buildRequestBody(req, model);
      const url = endpoint;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.apiKey}`,
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
          error: `OpenAI API error ${response.status}: ${errorText}`,
          retriable: response.status >= 500 || response.status === 429,
        };
        return;
      }

      if (!response.body) {
        yield { type: "error", error: "Empty response body", retriable: true };
        return;
      }

      // Parse SSE stream → raw chunks → normalize → ModelEvents
      const rawChunks = parseSSEStream(response.body);
      // Request body always sets stream_options.include_usage: true (see
      // buildRequestBody below), so normalizeStream can watch for a provider
      // that silently never honors it.
      yield* normalizeStream(rawChunks, { includeUsageRequested: true });
    },
    describeModel: async (model: string): Promise<ResolvedModelInfo> => {
      const info: ResolvedModelInfo = { model };
      const vision = opts.vision ?? openaiFamilyVision(model);
      if (vision !== undefined) {
        info.vision = vision;
      }
      return info;
    },
  };
}

// ──────────────────────────────────────────────
// Request body builder
// ──────────────────────────────────────────────

/**
 * Request-surface image block: the base64 bytes a provider needs.
 * Mirrors the Runner's WireImageContent; core's ImageContent stays ref-only,
 * so the wire shape arrives as an untyped cast at the request boundary.
 */
interface WireImageContent {
  type: "image";
  source: { type: "base64"; mediaType: string; data: string };
}

function asWireImage(block: ToolResultBlock): WireImageContent | null {
  if (block.type !== "image") return null;
  // Narrow at runtime rather than widening core's ImageContent.
  const src = block.source as { type?: string; mediaType?: string; data?: string };
  if (src.type === "base64" && typeof src.mediaType === "string" && typeof src.data === "string") {
    return {
      type: "image",
      source: { type: "base64", mediaType: src.mediaType, data: src.data },
    };
  }
  return null;
}

/**
 * Chat Completions accepts text only in a tool message, so images ride in a
 * user message inserted right after the tool batch they came from. One
 * carrier per batch, not per result: separate carriers cost extra role
 * overhead and blur which call produced which image, so each image is
 * labelled with its tool_call_id instead.
 *
 * Responses API would take images directly, but OpenAI-compatible gateways
 * (vLLM, local models) generally implement only this endpoint.
 */
function splitToolBatch(msg: ToolResultMessage): { toolMessages: unknown[]; carrier?: unknown } {
  const toolMessages: unknown[] = [];
  const parts: Array<Record<string, unknown>> = [];

  for (const tr of msg.content) {
    const texts = tr.content.filter((b) => b.type === "text").map((b) => b.text);
    const images = tr.content
      .map(asWireImage)
      .filter((img): img is WireImageContent => img !== null);
    const note = images.length > 0
      ? `\n[${images.length} image${images.length > 1 ? "s" : ""} returned — see next message]`
      : "";
    toolMessages.push({
      role: "tool",
      tool_call_id: tr.toolUseId,
      content: texts.join("\n") + note,
    });
    for (const image of images) {
      parts.push({ type: "text", text: `Image from tool_call_id ${tr.toolUseId}:` });
      parts.push({
        type: "image_url",
        image_url: { url: `data:${image.source.mediaType};base64,${image.source.data}` },
      });
    }
  }

  return parts.length > 0
    ? { toolMessages, carrier: { role: "user", content: parts } }
    : { toolMessages };
}

/**
 * Map core messages to the OpenAI Chat Completions message array.
 * Exported for tests; buildRequestBody wraps it with model/stream options.
 */
export function toOpenAiMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      out.push({ role: "system", content: msg.content });
      continue;
    }
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
      continue;
    }
    if (msg.role === "assistant") {
      // OpenAI expects tool_calls at the message level (not inside content).
      const text = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      const toolCalls = msg.content
        .filter((c) => c.type === "tool_use")
        .map((c) => ({
          id: c.id,
          type: "function",
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input),
          },
        }));

      if (toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: text.length > 0 ? text : null,
          tool_calls: toolCalls,
        });
        continue;
      }

      out.push({ role: "assistant", content: text });
      continue;
    }
    if (msg.role === "tool") {
      const { toolMessages, carrier } = splitToolBatch(msg);
      out.push(...toolMessages);
      if (carrier !== undefined) out.push(carrier);
    }
  }
  return out;
}

function buildRequestBody(req: ModelRequest, model: string): Record<string, unknown> {
  const messages = toOpenAiMessages(req.messages);

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  // Map core tools to OpenAI function format
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;

  // Structured / JSON output mode
  if (req.responseFormat?.type === "json") {
    if (req.responseFormat.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "response",
          strict: true,
          schema: req.responseFormat.schema,
        },
      };
    } else {
      body.response_format = { type: "json_object" };
    }
  }

  return body;
}

// ──────────────────────────────────────────────
// SSE parser
// ──────────────────────────────────────────────

async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<RawStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep last incomplete line in buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // empty or comment
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data) as RawStreamChunk;
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
