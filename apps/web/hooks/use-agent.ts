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
 * Creates a `createWebAgent` on mount (when `autoConnect` is true) and
 * tears it down on unmount. The returned `agent` reference updates on
 * config changes.
 */
export function useAgent({ config, autoConnect = true }: UseAgentOptions): UseAgentReturn {
  // Lazy initializer: only create the agent when autoConnect is true.
  const agentRef = useRef<AgentReturn | null>(
    autoConnect ? createWebAgent(config) : null,
  );

  useEffect(() => {
    if (!autoConnect) {
      destroyAgent(agentRef.current);
      disconnectSSEClient();
      agentRef.current = null;
      return;
    }

    destroyAgent(agentRef.current);
    agentRef.current = createWebAgent(config);

    return () => {
      destroyAgent(agentRef.current);
      disconnectSSEClient();
      agentRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.mode, config.serverUrl, autoConnect]);

  return {
    // Read from ref for external callers (not rendered, so no lint issue).
    get agent(): AgentReturn | null {
      return agentRef.current;
    },
  };
}
