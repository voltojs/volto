/**
 * Client for the gateway's agent-definition endpoints
 * (`GET|POST /agents`, `PUT|DELETE /agents/:id`, `GET /tools`).
 *
 * `spec` is carried as the SDK's serializable `AgentSpec` via a type-only
 * import, so nothing of the Node-bound package root reaches the browser
 * bundle — the same boundary `agent-config.ts` keeps for `/sse`.
 */

import type { AgentSpec } from '@volto/sdk';
import { gatewayUrl } from './gateway-base';
import { ApiError } from './config-api';

export type { AgentSpec };

/** One entry of the merged `GET /agents` list — mirrors the server's PublicAgentEntry. */
export interface AgentEntry {
  id: string;
  name: string;
  description: string;
  scope: 'project' | 'user' | 'plugin' | 'builtin';
  /** True for plugin-sourced entries: PUT/DELETE answer 409. */
  readOnly: boolean;
  /**
   * True when this row is a built-in type (the implicit row, or a same-named
   * override file standing in for it). Editable, never deletable.
   */
  builtIn?: boolean;
  /** True when a higher-priority same-named definition shadows this one. */
  shadowed: boolean;
  /** Absent for plugin entries, which have no on-disk file. */
  filePath?: string;
  spec: AgentSpec;
}

/** One tool in the `GET /tools` catalogue. */
export interface ToolInfo {
  name: string;
  description: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(gatewayUrl(path), {
    // Cookie auth (Route P): the gateway rejects unauthenticated calls.
    credentials: 'include',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(
      detail?.error ?? `Request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  // DELETE answers 204 with no body.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Optional `?projectId=`, resolved on the gateway exactly like `/skills`. */
function projectQuery(projectId?: string | null): string {
  return projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
}

export async function listAgents(
  projectId?: string | null,
): Promise<AgentEntry[]> {
  const body = await request<{ agents: AgentEntry[] }>(
    `/agents${projectQuery(projectId)}`,
  );
  return body.agents;
}

export function createAgent(
  input: { scope: 'project' | 'user'; spec: AgentSpec },
  projectId?: string | null,
): Promise<AgentEntry> {
  return request<AgentEntry>(`/agents${projectQuery(projectId)}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAgent(
  id: string,
  spec: AgentSpec,
  projectId?: string | null,
): Promise<AgentEntry> {
  return request<AgentEntry>(
    `/agents/${encodeURIComponent(id)}${projectQuery(projectId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ spec }),
    },
  );
}

export function deleteAgent(
  id: string,
  projectId?: string | null,
): Promise<void> {
  return request<void>(
    `/agents/${encodeURIComponent(id)}${projectQuery(projectId)}`,
    { method: 'DELETE' },
  );
}

export async function listTools(
  projectId?: string | null,
): Promise<ToolInfo[]> {
  const body = await request<{ tools: ToolInfo[] }>(
    `/tools${projectQuery(projectId)}`,
  );
  return body.tools;
}
