/**
 * Agent transport configuration.
 *
 * The web app talks to `apps/headless-server` over the shared SSE protocol.
 * Importing from `@volto/sdk/sse` rather than the package root keeps Node-only
 * dependencies (runtime-node, tools-shell, sqlite store) out of the browser
 * bundle — the SSE subtree only depends on protocol types.
 */

import { createSSEClient } from '@volto/sdk/sse';
import type { ConnectionState } from '@volto/sdk/sse';

export { createSSEClient };
export type { ConnectionState };

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
  /** Opaque id of a reasoning-effort tier declared by the selected model. */
  reasoningEffort?: string;
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
      ...(config.permissionMode
        ? { permissionMode: config.permissionMode }
        : {}),
      ...(config.reasoningEffort
        ? { reasoningEffort: config.reasoningEffort }
        : {}),
    }),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      detail?.error ?? `Request failed with HTTP ${response.status}`,
    );
  }
}

/**
 * Ask the server to cancel the turn currently streaming on a session.
 *
 * Returns false on a 409 — the server had nothing running, so the client's
 * "generating" state was simply stale. That is not an error (nothing is left
 * to stop), but the caller does need to tell the two apart: an interrupted
 * turn still emits its own `turn_end`, while a stale one never will.
 */
export async function interruptTurn(sessionId: string): Promise<boolean> {
  const response = await fetch(`${SERVER_URL}/interrupt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });

  if (response.ok) return true;
  if (response.status === 409) return false;

  const detail = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(
    detail?.error ?? `Request failed with HTTP ${response.status}`,
  );
}

/**
 * Settle one pending approval. Returns false when the gateway no longer has
 * it pending (409) — the card is stale and should simply disappear.
 *
 * `token` is the per-connection approval token learned from the session's
 * `/events` channel (the SSE client's `getConnectionToken()` — see
 * use-chat-agent.ts). The gateway requires it and answers 403 for a missing
 * or wrong one, thrown here like any other non-409 failure: unlike a stale
 * card (409), a rejected token is not something the UI should silently shrug
 * off.
 */
export async function postApproval(
  sessionId: string,
  callId: string,
  decision: 'allow' | 'allow_always' | 'deny',
  token: string | null,
): Promise<boolean> {
  const response = await fetch(`${SERVER_URL}/approvals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      callId,
      decision,
      ...(token ? { token } : {}),
    }),
  });

  if (response.ok) return true;
  if (response.status === 409) return false;

  const detail = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(
    detail?.error ?? `Request failed with HTTP ${response.status}`,
  );
}
