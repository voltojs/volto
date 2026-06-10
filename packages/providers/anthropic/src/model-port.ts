/**
 * Anthropic ModelPort adapter.
 *
 * Connects to /v1/messages with stream:true,
 * normalizes the SSE response into core ModelEvents.
 */

import type { ModelPort, ModelEvent, ModelRequest, Message } from "@agent-core/core";
import { normalizeStream, type RawAnthropicEvent } from "./stream-normalize.js";

export interface AnthropicModelPortOptions {
  /** Base URL of the Anthropic API (default: https://api.anthropic.com) */
  baseURL?: string;
  /** API key for x-api-key header */
  apiKey: string;
  /** Default model if not specified in request */
  defaultModel?: string;
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
            return {
              type: "image",
              source: {
                type: block.source.type === "base64" ? "base64" : "url",
                media_type: block.source.mediaType,
                ...(block.source.type === "base64"
                  ? { data: block.source.data }
                  : { url: block.source.data }),
              },
            };
          }
          if (block.type === "tool_result") {
            return {
              type: "tool_result",
              tool_use_id: block.toolUseId,
              content: block.content,
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
        // thinking blocks are not persisted in core state; skip
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
          content: tc.content,
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
