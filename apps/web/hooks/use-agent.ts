"use client";

import { useEffect, useRef } from "react";
import { type AgentInstance } from "@volto/sdk";
import { sse } from "@volto/sdk";
import { createWebAgent, type AgentConfig } from "@/lib/agent";
import { disconnectSSEClient } from "@/lib/sse-client";

type AgentReturn = AgentInstance | ReturnType<typeof sse.createSSEClient>;

interface UseAgentOptions {
  config: AgentConfig;
  /** Whether to create the agent on mount. @default true */
  autoConnect?: boolean;
}

interface UseAgentReturn {
  agent: AgentReturn | null;
}

function destroyAgent(agent: AgentReturn | null): void {
  if (agent && typeof agent === "object" && "destroy" in agent) {
    (agent as ReturnType<typeof sse.createSSEClient>).destroy();
  }
}

/**
 * Hook that manages agent instance lifecycle.
 *
 * Creates a `createWebAgent` inside useEffect (Safe for StrictMode:
 * React calls effect + cleanup + effect; the cleanup destroys the
 * first instance, and the second effect creates a fresh one).
 */
export function useAgent({ config, autoConnect = true }: UseAgentOptions): UseAgentReturn {
  const agentRef = useRef<AgentReturn | null>(null);

  useEffect(() => {
    if (!autoConnect) return;

    agentRef.current = createWebAgent(config);

    return () => {
      destroyAgent(agentRef.current);
      disconnectSSEClient();
      agentRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.mode, config.serverUrl, autoConnect]);

  return {
    // Read from ref — not rendered, so no lint issue.
    get agent(): AgentReturn | null {
      return agentRef.current;
    },
  };
}
