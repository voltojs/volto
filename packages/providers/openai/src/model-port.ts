/**
 * OpenAI-compatible ModelPort adapter.
 *
 * Connects to /v1/chat/completions with stream:true,
 * normalizes the SSE response into core ModelEvents.
 * Supports any OpenAI-compatible gateway via configurable baseURL.
 */

import type { ModelPort, ModelEvent, ModelRequest } from "@volto/core";
import { normalizeStream, type RawStreamChunk } from "./stream-normalize.js";

export interface OpenAIModelPortOptions {
  /** Base URL of the OpenAI-compatible API (default: https://api.openai.com) */
  baseURL?: string;
  /** API key for Authorization header */
  apiKey: string;
  /** Default model if not specified in request */
  defaultModel?: string;
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
      yield* normalizeStream(rawChunks);
    },
  };
}

// ──────────────────────────────────────────────
// Request body builder
// ──────────────────────────────────────────────

function buildRequestBody(req: ModelRequest, model: string): Record<string, unknown> {
  const messages = req.messages.map((msg) => {
    if (msg.role === "system") {
      return { role: "system", content: msg.content };
    }
    if (msg.role === "user") {
      return { role: "user", content: msg.content };
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
        return {
          role: "assistant",
          content: text.length > 0 ? text : null,
          tool_calls: toolCalls,
        };
      }

      return { role: "assistant", content: text };
    }
    if (msg.role === "tool") {
      return msg.content.map((tc) => ({
        role: "tool",
        tool_call_id: tc.toolUseId,
        content: tc.content,
      }));
    }
    return msg;
  }).flat();

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
