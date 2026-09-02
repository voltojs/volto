/**
 * Agent transport configuration.
 *
 * The web app talks to `apps/headless-server` over the shared SSE protocol.
 * Importing from `@volto/sdk/sse` rather than the package root keeps Node-only
 * dependencies (runtime-node, tools-shell, sqlite store) out of the browser
 * bundle — the SSE subtree only depends on protocol types.
 */

import { createSSEClient, SSEEventType } from '@volto/sdk/sse';
import type {
  ConnectionState,
  SSEMessage,
  TokenData,
  ToolCallData,
  ToolResultData,
  ErrorData,
} from '@volto/sdk/sse';

export { SSEEventType, createSSEClient };
export type {
  ConnectionState,
  SSEMessage,
  TokenData,
  ToolCallData,
  ToolResultData,
  ErrorData,
};

/** Base URL of the headless server. */
export const SERVER_URL =
  process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? 'http://localhost:3100';

/** URL of the long-lived SSE channel for a chat session. */
export function eventsUrl(sessionId: string): string {
  return `${SERVER_URL}/events?sessionId=${encodeURIComponent(sessionId)}`;
}

export interface TurnConfig {
  projectId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  permissionMode?: string;
}

/**
 * Ask the server to run one turn. The response only acknowledges the request —
 * the actual output arrives on the session's SSE channel.
 */
export async function postMessage(
  sessionId: string,
  message: string,
  config: TurnConfig = {},
): Promise<void> {
  const response = await fetch(`${SERVER_URL}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message,
      ...(config.projectId ? { projectId: config.projectId } : {}),
      ...(config.providerId ? { providerId: config.providerId } : {}),
      ...(config.modelId ? { modelId: config.modelId } : {}),
      ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    }),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(detail?.error ?? `Request failed with HTTP ${response.status}`);
  }
}
