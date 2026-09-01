/**
 * Agent factory tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@volto/sdk", () => {
  return {
    createAgent: vi.fn(() => ({ run: vi.fn(), stream: vi.fn(), resume: vi.fn(), getState: vi.fn(), sessionStore: {}, ports: {} })),
    sse: {
      createSSEClient: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), destroy: vi.fn() })),
    },
  };
});

import { createWebAgent } from "../lib/agent.js";
import { createAgent, sse, type ModelPort } from "@volto/sdk";

const createAgentMock = vi.mocked(createAgent);
const createSSEClientMock = vi.mocked(sse.createSSEClient);

describe("createWebAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("remote mode", () => {
    it("should return an SSE client", () => {
      const agent = createWebAgent({ mode: "remote", serverUrl: "http://localhost:3000/sse" });
      expect(createSSEClientMock).toHaveBeenCalledWith("http://localhost:3000/sse");
      expect(agent).toBeDefined();
    });

    it("should throw if serverUrl is missing", () => {
      expect(() => createWebAgent({ mode: "remote" })).toThrow("serverUrl is required for remote mode");
    });
  });

  describe("local mode", () => {
    it("should return an SDK agent instance", () => {
      const agent = createWebAgent({
        mode: "local",
        sdkConfig: { modelPort: { generate: vi.fn() } as unknown as ModelPort },
      });
      expect(createAgentMock).toHaveBeenCalledTimes(1);
      expect(agent).toBeDefined();
    });

    it("should throw if sdkConfig is missing", () => {
      expect(() => createWebAgent({ mode: "local" })).toThrow("sdkConfig is required for local mode");
    });
  });
});
