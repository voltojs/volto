/**
 * Client for `apps/headless-server`'s durable transcript endpoints
 * (`GET /sessions`, `GET /sessions/:id`, `GET /sessions/:id/trajectory`) —
 * the jsonl store's chat history, already projected server-side into the
 * shared `ConversationView` / `TrajectoryView` shapes re-exported by
 * `@volto/sdk/sse`.
 */

import { SERVER_URL } from './agent-config';
import type { ConversationMessage, TrajectoryView } from '@volto/sdk/sse';

export interface ServerSessionSummary {
  id: string;
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  permissionMode: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ServerSessionDetail {
  id: string;
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  permissionMode: string | null;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Lists every session the server has durably recorded. */
export async function fetchServerSessions(): Promise<ServerSessionSummary[]> {
  const response = await fetch(`${SERVER_URL}/sessions`);
  if (!response.ok) {
    throw new Error(`Failed to list sessions: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { sessions: ServerSessionSummary[] };
  return body.sessions;
}

/** Fetches one session's projected conversation view. Returns null for an unknown id. */
export async function fetchServerSessionDetail(
  id: string,
): Promise<ServerSessionDetail | null> {
  const response = await fetch(`${SERVER_URL}/sessions/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load session ${id}: HTTP ${response.status}`);
  }
  return (await response.json()) as ServerSessionDetail;
}

/** Fetches one session's audit ledger. Returns null for an unknown id. */
export async function fetchServerTrajectory(
  id: string,
): Promise<TrajectoryView | null> {
  const response = await fetch(`${SERVER_URL}/sessions/${encodeURIComponent(id)}/trajectory`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load trajectory ${id}: HTTP ${response.status}`);
  }
  return (await response.json()) as TrajectoryView;
}
