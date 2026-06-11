/**
 * VS Code extension — thin wiring that talks to headless server.
 * Provides commands to run agent conversations from the IDE.
 */

import type { AgentRequest, AgentEvent, AgentResponse } from "./ipc-contract.js";

export interface ExtensionOptions {
  /** Headless server URL (default: http://localhost:3100) */
  serverUrl?: string;
}

export interface AgentClient {
  run(request: AgentRequest): Promise<AgentResponse>;
  stream(request: AgentRequest): AsyncGenerator<AgentEvent>;
}

export function createAgentClient(opts: ExtensionOptions = {}): AgentClient {
  const serverUrl = opts.serverUrl ?? "http://localhost:3100";

  return {
    async run(request: AgentRequest): Promise<AgentResponse> {
      const response = await fetch(`${serverUrl}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: request.message, sessionId: request.sessionId }),
      });
      return response.json() as Promise<AgentResponse>;
    },

    async *stream(request: AgentRequest): AsyncGenerator<AgentEvent> {
      const url = new URL("/stream", serverUrl);
      url.searchParams.set("message", request.message);
      const response = await fetch(url.toString());
      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") return;
            yield JSON.parse(data) as AgentEvent;
          }
        }
      }
    },
  };
}
