import { describe, it, expect, vi, afterEach } from "vitest";
import { createOpenAIModelPort } from "../model-port.js";

/** Capture the URL the port requests, then end the stream immediately. */
function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function drain(port: ReturnType<typeof createOpenAIModelPort>): Promise<void> {
  for await (const _ of port.stream({ messages: [], tools: [], model: "m" })) {
    // consume
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOpenAIModelPort endpoint resolution", () => {
  it("appends /v1 when the base URL omits it", async () => {
    const fetchMock = mockFetch();
    await drain(createOpenAIModelPort({ apiKey: "k", baseURL: "https://api.example.com" }));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/v1/chat/completions");
  });

  it("does not duplicate a version segment already in the base URL", async () => {
    const fetchMock = mockFetch();
    await drain(createOpenAIModelPort({ apiKey: "k", baseURL: "https://gateway.example.com/v1" }));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://gateway.example.com/v1/chat/completions");
  });

  it("tolerates a trailing slash", async () => {
    const fetchMock = mockFetch();
    await drain(createOpenAIModelPort({ apiKey: "k", baseURL: "https://gateway.example.com/v1/" }));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://gateway.example.com/v1/chat/completions");
  });
});
