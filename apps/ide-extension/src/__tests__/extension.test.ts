import { describe, it, expect } from "vitest";
import { createAgentClient } from "../extension.js";
import type { AgentRequest } from "../ipc-contract.js";

describe("IDE extension agent client", () => {
  it("createAgentClient returns client with run and stream methods", () => {
    const client = createAgentClient({ serverUrl: "http://localhost:9999" });
    expect(typeof client.run).toBe("function");
    expect(typeof client.stream).toBe("function");
  });

  it("AgentRequest type has correct shape", () => {
    const request: AgentRequest = {
      type: "run",
      message: "hello",
      sessionId: "test-123",
    };
    expect(request.type).toBe("run");
    expect(request.message).toBe("hello");
  });
});
