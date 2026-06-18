/**
 * Integration test — exercises a REAL OpenAI-compatible endpoint.
 *
 * Gated on env: only runs when OPENAI_API_KEY is set, so CI / offline runs
 * skip it automatically. Configure via:
 *   OPENAI_API_KEY   (required to run)
 *   OPENAI_BASE_URL  (optional, default https://api.openai.com)
 *   OPENAI_MODEL     (optional, default gpt-4o-mini)
 *
 * Verifies AC2: one streamed turn completes and usage is normalized.
 */

import { describe, it, expect } from "vitest";
import { createOpenAIModelPort } from "../model-port.js";
import type { ModelEvent, ModelRequest } from "@volto/core";

const apiKey = process.env.OPENAI_API_KEY;

// Only run when an API key is present; otherwise the whole suite is skipped.
describe.skipIf(!apiKey)("OpenAI ModelPort integration (live)", () => {
  it("completes one streamed turn and normalizes usage", async () => {
    const port = createOpenAIModelPort({
      apiKey: apiKey as string,
      baseURL: process.env.OPENAI_BASE_URL,
      defaultModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    });

    const req: ModelRequest = {
      messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
      tools: [],
      // Generous budget: reasoning models spend tokens on reasoning_content
      // before emitting the final answer; too small a budget truncates the text.
      maxTokens: 256,
      temperature: 0,
    };

    const events: ModelEvent[] = [];
    for await (const event of port.stream(req)) {
      events.push(event);
    }

    // No transport/auth error
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent, errorEvent && "error" in errorEvent ? errorEvent.error : undefined).toBeUndefined();

    // Got at least some text
    const text = events
      .filter((e): e is Extract<ModelEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);

    // A terminal done event with a valid stop reason
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(["end_turn", "tool_use", "max_tokens"]).toContain(
      (done as Extract<ModelEvent, { type: "done" }>).stopReason,
    );

    // Usage normalized (include_usage requested): non-negative token counts
    const usage = events.find(
      (e): e is Extract<ModelEvent, { type: "usage" }> => e.type === "usage",
    );
    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBeGreaterThanOrEqual(0);
    expect(usage!.outputTokens).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
