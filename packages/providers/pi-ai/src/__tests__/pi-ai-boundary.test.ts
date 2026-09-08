import { describe, expect, it } from "vitest";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { AssistantMessage as PiAssistantMessage } from "@earendil-works/pi-ai";

import type { ModelRequest } from "@volto/core";
import { buildModels, type PiAiProviderConfig } from "../collection.js";
import { toPiContext } from "../context.js";

/**
 * Regression test for Finding 1 (thinking-block signatures lost on replay).
 *
 * Every other test in this package exercises volto's own boundary against a
 * faux/hand-built pi-ai `Models` collection — nothing observes what the REAL
 * installed `@earendil-works/pi-ai` package does with volto's output. This
 * test builds a real catalog-backed `Models` collection via `buildModels`
 * (the same code path `createPiAiModelPort` uses), runs volto's real
 * `toPiContext` over an assistant message carrying a signed thinking block,
 * and then feeds the result through pi-ai's OWN `transformMessages` — the
 * exact function that gates whether a signed thinking block survives or gets
 * rewritten to plain text, based on comparing `provider`/`api`/`model` on
 * the outgoing assistant message against the resolved `Model`.
 */
describe("pi-ai boundary: real transformMessages over toPiContext output", () => {
  it("keeps a signed thinking block as type 'thinking' with its signature intact", () => {
    const config: PiAiProviderConfig[] = [
      {
        kind: "catalog",
        id: "anthropic",
        piProvider: "anthropic",
        modelCodes: ["claude-haiku-4-5"],
      },
    ];
    const models = buildModels(config);
    const model = models.getModel("anthropic", "claude-haiku-4-5");
    if (model === undefined) {
      throw new Error("test setup: expected catalog model 'claude-haiku-4-5' to exist");
    }

    const req: ModelRequest = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "let me think about this..." }],
          // Real replay envelope shape, as core would carry it across turns.
          modelMeta: {
            version: 1,
            model: model.id,
            blocks: [{ type: "reasoning", thinkingSignature: "SIG123" }],
          },
        },
      ],
      tools: [],
    };

    const context = toPiContext(req, model);
    const transformed = transformMessages(context.messages, model);
    const assistantMsg = transformed.find((m) => m.role === "assistant") as
      | PiAssistantMessage
      | undefined;
    expect(assistantMsg).toBeDefined();

    const thinkingBlock = assistantMsg?.content.find((b) => b.type === "thinking" || b.type === "text");
    expect(thinkingBlock?.type).toBe("thinking");
    expect((thinkingBlock as { thinkingSignature?: string } | undefined)?.thinkingSignature).toBe(
      "SIG123",
    );
  });
});
