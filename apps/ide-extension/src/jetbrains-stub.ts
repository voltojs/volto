/**
 * JetBrains IPC Contract Stub — placeholder for future JetBrains IDE integration.
 *
 * TODO: Implement full JetBrains IPC bridge using the shared contract types.
 * This stub documents the expected interface and will be completed in a future phase.
 */

import type { AgentRequest, AgentEvent, AgentResponse } from "./ipc-contract.js";

export interface JetBrainsAgentClient {
  run(request: AgentRequest): Promise<AgentResponse>;
  stream(request: AgentRequest): AsyncGenerator<AgentEvent>;
}

/**
 * Placeholder factory — returns a client that throws on any call.
 * Replace with real JetBrains IPC transport when implementing.
 */
export function createJetBrainsClient(): JetBrainsAgentClient {
  const notImplemented = () => {
    throw new Error("JetBrains IPC not yet implemented — see TODO in jetbrains-stub.ts");
  };

  return {
    run: notImplemented as (req: AgentRequest) => Promise<AgentResponse>,
    stream: notImplemented as (req: AgentRequest) => AsyncGenerator<AgentEvent>,
  };
}
