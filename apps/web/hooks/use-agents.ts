'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listAgents,
  listTools,
  type AgentEntry,
  type ToolInfo,
} from '@/lib/agents-api';

export type AgentsStatus = 'loading' | 'ready' | 'error';

export interface UseAgentsResult {
  agents: AgentEntry[];
  tools: ToolInfo[];
  status: AgentsStatus;
  /** Re-fetches agents and tools; resolves once the reload settles. */
  refresh: () => Promise<void>;
  /**
   * Runs a mutation (create/update/delete) and then re-fetches the whole
   * list. `shadowed` is computed across entries server-side, so a local
   * patch of the returned entry cannot get it right — always reload.
   */
  mutate: <T>(run: () => Promise<T>) => Promise<T>;
}

/**
 * Loads the agent-definition list and the tool catalogue together.
 *
 * `projectId` scopes the project-level source and write target on the
 * gateway; null means the server default cwd. A failed load surfaces as
 * `status: 'error'` rather than a silent empty list, so the panel can tell
 * "there are no agents" apart from "the gateway is down".
 */
export function useAgents(projectId: string | null): UseAgentsResult {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [status, setStatus] = useState<AgentsStatus>('loading');

  // Monotonic load id: a load that settles after a newer one started must
  // not clobber the newer result (stale-response guard).
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    try {
      const [agentList, toolList] = await Promise.all([
        listAgents(projectId),
        listTools(projectId),
      ]);
      if (loadId !== loadIdRef.current) return;
      setAgents(agentList);
      setTools(toolList);
      setStatus('ready');
    } catch {
      if (loadId !== loadIdRef.current) return;
      setStatus('error');
    }
  }, [projectId]);

  useEffect(() => {
    // Async IIFE, not a bare `void load()`: the set-state-in-effect rule
    // flags the direct callback reference even though every setState in
    // `load` happens only after an await. Same shape as the other
    // fetch-on-mount hooks in this directory.
    void (async () => {
      await load();
    })();
  }, [load]);

  const refresh = useCallback(() => load(), [load]);

  const mutate = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      const result = await run();
      // Full refetch, never a local patch — see UseAgentsResult.mutate.
      await load();
      return result;
    },
    [load],
  );

  return { agents, tools, status, refresh, mutate };
}
