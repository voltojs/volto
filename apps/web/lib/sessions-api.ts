/**
 * Client for `apps/headless-server`'s durable transcript endpoints
 * (`GET /sessions`, `GET /sessions/:id`) — the jsonl store's chat history,
 * already translated server-side into this app's `Message` shape.
 */

import { SERVER_URL } from './agent-config';

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

export interface ServerToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

export type ServerMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ServerToolCall };

export interface ServerMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  blocks: ServerMessageBlock[];
  timestamp: number;
}

export interface ServerSessionDetail {
  id: string;
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  permissionMode: string | null;
  messages: ServerMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Lists every session the server has durably recorded. */
export async function fetchServerSessions(): Promise<ServerSessionSummary[]> {
  const response = await fetch(`${SERVER_URL}/sessions`);
  if (!response.ok) {
    throw new Error(`Failed to list sessions: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { sessions?: ServerSessionSummary[] };
  // Defensive against an unupgraded server still returning a bare array (or
  // any other unexpected shape) — an undefined `sessions` would otherwise
  // propagate to use-recover-server-sessions.ts's `.filter(...)`, which is
  // not itself wrapped in a try/catch, surfacing as an unhandled rejection.
  return body.sessions ?? [];
}

/** Fetches one session's full transcript. Returns null for an unknown id. */
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
