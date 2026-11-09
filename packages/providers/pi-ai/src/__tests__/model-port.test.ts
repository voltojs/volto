import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ModelEvent, ModelRequest } from "@volto/core";
import { buildModels } from "../collection.js";
import { createPiAiModelPort, createPiAiModelPortFromModels } from "../model-port.js";

const PLAIN_MODEL: Model<"openai-completions"> = {
  id: "plain-model",
  name: "Plain Model",
  api: "openai-completions",
  provider: "acme",
  baseUrl: "https://acme.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
};

const REASONING_MODEL: Model<"openai-completions"> = {
  id: "reasoner-1",
  name: "Reasoner One",
  api: "openai-completions",
  provider: "acme",
  baseUrl: "https://acme.example/v1",
  reasoning: true,
  thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

function baseRequest(model: string): ModelRequest {
  return {
    model,
    messages: [{ id: "m1", role: "user", content: "hello" }],
    tools: [],
  };
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

/** Build a scripted event stream reproducing a text-only assistant reply. */
function textConversationStream(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const finalMessage = fauxAssistantMessage("hi there", { stopReason: "stop" });
  stream.push({ type: "start", partial: finalMessage });
  stream.push({ type: "text_start", contentIndex: 0, partial: finalMessage });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "hi there", partial: finalMessage });
  stream.push({ type: "text_end", contentIndex: 0, content: "hi there", partial: finalMessage });
  stream.push({ type: "done", reason: "stop", message: finalMessage });
  stream.end(finalMessage);
  return stream;
}

function registerFakeProvider(streamSimple: Provider["streamSimple"]): ReturnType<typeof buildModels> {
  const models = buildModels([]);
  models.setProvider({
    id: "acme",
    name: "acme",
    auth: { apiKey: { name: "test", resolve: async () => ({ auth: {} }) } },
    getModels: () => [PLAIN_MODEL, REASONING_MODEL],
    streamSimple,
    stream: () => {
      throw new Error("not used in this test");
    },
  });
  return models;
}

describe("createPiAiModelPortFromModels: stream()", () => {
  it("streams a full text conversation: text_delta ... done", async () => {
    const streamSimple = vi.fn((..._args: Parameters<Provider["streamSimple"]>) => textConversationStream());
    const models = registerFakeProvider(streamSimple);
    const port = createPiAiModelPortFromModels(models, "acme");

    const events = await collect(port.stream(baseRequest("plain-model")));

    expect(streamSimple).toHaveBeenCalledTimes(1);
    const types = events.map((e) => e.type);
    expect(types).toContain("text_delta");
    expect(types.at(-1)).toBe("done");
    const textEvent = events.find((e) => e.type === "text_delta");
    expect(textEvent).toMatchObject({ type: "text_delta", text: "hi there" });
  });

  it("forwards maxTokens/temperature/reasoning to streamSimple's options", async () => {
    const streamSimple = vi.fn((..._args: Parameters<Provider["streamSimple"]>) =>
      textConversationStream(),
    );
    const models = registerFakeProvider(streamSimple);
    const port = createPiAiModelPortFromModels(models, "acme");

    const req: ModelRequest = {
      ...baseRequest("reasoner-1"),
      maxTokens: 111,
      temperature: 0.42,
      reasoningEffort: "low" as ModelRequest["reasoningEffort"],
    };
    await collect(port.stream(req));

    expect(streamSimple).toHaveBeenCalledTimes(1);
    const [, , options] = streamSimple.mock.calls[0]!;
    expect(options).toMatchObject({ maxTokens: 111, temperature: 0.42, reasoning: "low" });
  });

  it("rejects an unsupported reasoning effort WITHOUT attempting any I/O", async () => {
    const streamSimple = vi.fn((..._args: Parameters<Provider["streamSimple"]>) => textConversationStream());
    const models = registerFakeProvider(streamSimple);
    const port = createPiAiModelPortFromModels(models, "acme");

    const req: ModelRequest = {
      ...baseRequest("reasoner-1"),
      reasoningEffort: "nonexistent-effort" as ModelRequest["reasoningEffort"],
    };
    const events = await collect(port.stream(req));

    expect(streamSimple).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", retriable: false });
  });

  it("produces an error event (not a thrown exception) for an unknown model", async () => {
    const streamSimple = vi.fn((..._args: Parameters<Provider["streamSimple"]>) => textConversationStream());
    const models = registerFakeProvider(streamSimple);
    const port = createPiAiModelPortFromModels(models, "acme");

    const events = await collect(port.stream(baseRequest("does-not-exist")));

    expect(streamSimple).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", retriable: false });
  });
});

describe("createPiAiModelPortFromModels: route auth", () => {
  it("sends bearer auth and suppresses the Anthropic x-api-key default", async () => {
    const streamSimple = vi.fn((..._args: Parameters<Provider["streamSimple"]>) => textConversationStream());
    const models = registerFakeProvider(streamSimple);
    const port = createPiAiModelPortFromModels(models, "acme", undefined, "key-1", {
      auth: { kind: "bearer" },
      headers: { "x-extra": "1" },
      apiKey: "key-1",
    });

    await collect(port.stream(baseRequest("plain-model")));

    const options = streamSimple.mock.calls[0]![2]!;
    expect(options.headers).toMatchObject({
      authorization: "Bearer key-1",
      "x-api-key": null,
      "x-extra": "1",
    });
  });

  it("sends x-api-key auth without an authorization header", async () => {
    const streamSimple = vi.fn((..._args: Parameters<Provider["streamSimple"]>) => textConversationStream());
    const models = registerFakeProvider(streamSimple);
    const port = createPiAiModelPortFromModels(models, "acme", undefined, "key-1", {
      auth: { kind: "x-api-key" },
      apiKey: "key-1",
    });

    await collect(port.stream(baseRequest("plain-model")));

    const options = streamSimple.mock.calls[0]![2]!;
    expect(options.headers).toMatchObject({ "x-api-key": "key-1" });
    expect(options.headers?.["authorization"]).toBeUndefined();
  });

  it("uses a custom header name for header auth", async () => {
    const streamSimple = vi.fn((..._args: Parameters<Provider["streamSimple"]>) => textConversationStream());
    const models = registerFakeProvider(streamSimple);
    const port = createPiAiModelPortFromModels(models, "acme", undefined, undefined, {
      auth: { kind: "header", name: "x-token" },
      apiKey: "key-1",
    });

    await collect(port.stream(baseRequest("plain-model")));

    expect(streamSimple.mock.calls[0]![2]!.headers).toMatchObject({ "x-token": "key-1" });
  });
});

describe("createPiAiModelPortFromModels: describeModel()", () => {
  it("delegates to describeModelInfo for a known model", async () => {
    const models = registerFakeProvider(vi.fn(() => textConversationStream()));
    const port = createPiAiModelPortFromModels(models, "acme");

    const info = await port.describeModel!("reasoner-1");
    expect(info.model).toBe("reasoner-1");
    expect(info.reasoning?.efforts.map((e) => e.id)).toContain("low");
  });

  it("rejects (does not throw synchronously) for an unknown model", async () => {
    const models = registerFakeProvider(vi.fn(() => textConversationStream()));
    const port = createPiAiModelPortFromModels(models, "acme");

    // describeModel() is called, not deferred: if it threw synchronously,
    // this call itself (not the await) would throw. It doesn't — it returns
    // a rejected promise instead.
    let threwSynchronously = false;
    let result: Promise<unknown>;
    try {
      result = port.describeModel!("does-not-exist");
    } catch {
      threwSynchronously = true;
      result = Promise.resolve();
    }
    expect(threwSynchronously).toBe(false);
    await expect(result!).rejects.toThrow();
  });
});

describe("createPiAiModelPort: construction", () => {
  it("throws synchronously when multiple providers are configured without defaultProviderId", () => {
    expect(() =>
      createPiAiModelPort({
        providers: [
          { kind: "custom", id: "acme", baseURL: "https://acme.example/v1", models: [{ code: "m1" }] },
          { kind: "custom", id: "other", baseURL: "https://other.example/v1", models: [{ code: "m2" }] },
        ],
      }),
    ).toThrow();
  });

  it("does not throw when a defaultProviderId is given for multiple providers", () => {
    expect(() =>
      createPiAiModelPort({
        providers: [
          { kind: "custom", id: "acme", baseURL: "https://acme.example/v1", models: [{ code: "m1" }] },
          { kind: "custom", id: "other", baseURL: "https://other.example/v1", models: [{ code: "m2" }] },
        ],
        defaultProviderId: "acme",
      }),
    ).not.toThrow();
  });

  it("does not throw for a single configured provider without defaultProviderId", () => {
    expect(() =>
      createPiAiModelPort({
        providers: [{ kind: "custom", id: "acme", baseURL: "https://acme.example/v1", models: [{ code: "m1" }] }],
      }),
    ).not.toThrow();
  });
});
