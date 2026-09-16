/**
 * Client for `apps/headless-server`'s durable transcript endpoints
 * (`GET /sessions`, `GET /sessions/:id`, `GET /sessions/:id/trajectory`,
 * `GET /sessions/:id/events`) — the jsonl store's chat history, already
 * projected server-side into the shared `ConversationView` /
 * `TrajectoryView` shapes re-exported by `@volto/sdk/sse` (the raw-events
 * endpoint is the exception: wire-order events, projected client-side).
 */

import { SERVER_URL } from './agent-config';
import type {
  ConversationMessage,
  ContextUsageSnapshot,
  TranscriptEventInput,
  TrajectoryView,
  TodoItem,
} from '@volto/sdk/sse';

/** trajectory 接口失败。410 = 旧版本写入的会话，其余归为网络/服务端故障。 */
export class TrajectoryUnavailableError extends Error {
  readonly status: number;
  readonly kind: 'legacy' | 'network';

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TrajectoryUnavailableError';
    this.status = status;
    this.kind = status === 410 ? 'legacy' : 'network';
  }
}

/**
 * `GET /sessions/:id` failure. 410 = a legacy-format transcript this build
 * cannot read (mirrors `TrajectoryUnavailableError` — same server-side
 * `TranscriptFormatError` mapping), the rest are network/server faults.
 */
export class SessionDetailUnavailableError extends Error {
  readonly status: number;
  readonly kind: 'legacy' | 'network';

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SessionDetailUnavailableError';
    this.status = status;
    this.kind = status === 410 ? 'legacy' : 'network';
  }
}

/**
 * Reads the server's `{ error: string }` body for a non-ok response, falling
 * back to a generic message when the body isn't in that shape (e.g. the
 * server is unreachable and a proxy returned an HTML error page).
 */
async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error.length > 0
      ? body.error
      : fallback;
  } catch {
    return fallback;
  }
}

export interface ServerSessionSummary {
  id: string;
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  permissionMode: string | null;
  messageCount: number;
  title: string;
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
  contextUsage: ContextUsageSnapshot | null;
  /** Standing todos folded from the durable event log; null when never written. */
  todos?: TodoItem[] | null;
  createdAt: number;
  updatedAt: number;
}

/** Lists every session the server has durably recorded. */
export async function fetchServerSessions(): Promise<ServerSessionSummary[]> {
  const response = await fetch(`${SERVER_URL}/sessions`, {
    credentials: 'include',
  });
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
  const response = await fetch(
    `${SERVER_URL}/sessions/${encodeURIComponent(id)}`,
    { credentials: 'include' },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      `Failed to load session ${id}: HTTP ${response.status}`,
    );
    throw new SessionDetailUnavailableError(response.status, message);
  }
  return (await response.json()) as ServerSessionDetail;
}

/** Fetches one session's audit ledger. Returns null for an unknown id. */
export async function fetchServerTrajectory(
  id: string,
): Promise<TrajectoryView | null> {
  const response = await fetch(
    `${SERVER_URL}/sessions/${encodeURIComponent(id)}/trajectory`,
    { credentials: 'include' },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new TrajectoryUnavailableError(
      response.status,
      `Failed to load trajectory ${id}: HTTP ${response.status}`,
    );
  }
  return (await response.json()) as TrajectoryView;
}

/**
 * Fetches one session's raw persisted events — no projection, wire order.
 * Serves sub-agent pane hydration: unknown ids answer 200 + empty (the
 * /trajectory contract), so there is no 404 branch here. 410 = a
 * legacy-format transcript this build cannot read (same server-side
 * `TranscriptFormatError` mapping as the detail/trajectory endpoints, hence
 * the shared `TrajectoryUnavailableError`), the rest are network/server
 * faults.
 */
export async function fetchSessionEvents(
  id: string,
): Promise<{ sessionId: string; events: TranscriptEventInput[] }> {
  const response = await fetch(
    `${SERVER_URL}/sessions/${encodeURIComponent(id)}/events`,
    { credentials: 'include' },
  );
  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      `Failed to load events ${id}: HTTP ${response.status}`,
    );
    throw new TrajectoryUnavailableError(response.status, message);
  }
  return (await response.json()) as {
    sessionId: string;
    events: TranscriptEventInput[];
  };
}

/**
 * Renames a session. The server stores titles as session_meta (last-wins),
 * so callers that race each other (the derived title vs. a manual rename)
 * must serialize via cancellation rather than relying on request ordering —
 * see `apps/web/lib/session-title.ts`'s `cancelPendingTitleWriteBack`. An
 * optional `signal` lets a caller abort the request; an aborted fetch
 * rejects (typically with `AbortError`) like any other failure, so callers
 * that pass a signal are responsible for distinguishing "aborted" from "the
 * server said no".
 */
export async function renameServerSession(
  id: string,
  title: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${SERVER_URL}/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to rename session ${id}: HTTP ${response.status}`);
  }
}

/**
 * Deletes a session's durable transcript. A 404 is treated as success —
 * the caller's intent (the session should not exist) is already satisfied.
 */
export async function deleteServerSession(id: string): Promise<void> {
  const response = await fetch(`${SERVER_URL}/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete session ${id}: HTTP ${response.status}`);
  }
}

/**
 * `POST /sessions/:id/compact` failure. 409 = a turn is mid-flight (retry
 * later); 404 = the gateway does not know this session; everything else is
 * a network/server fault.
 */
export class CompactSessionError extends Error {
  readonly status: number;
  readonly kind: 'busy' | 'notFound' | 'network';

  constructor(status: number, kind: CompactSessionError['kind'], message: string) {
    super(message);
    this.name = 'CompactSessionError';
    this.status = status;
    this.kind = kind;
  }
}

/**
 * Result of an on-demand compaction. Branches on the server's two 200
 * shapes (Task 5 contract): `{ ok: true, compacted: false }` when there was
 * nothing to do, vs `{ replacedCount, tokensFreedEstimate }` when state
 * shrank. Compaction never rewrites the visible transcript — the UI keeps
 * showing the full history either way.
 */
export type CompactSessionResult =
  | { compacted: true; replacedCount: number; tokensFreedEstimate: number }
  | { compacted: false };

/**
 * Requests on-demand compaction of an idle session. Empty POST body — the
 * session id is the path param. Callers must not treat a successful
 * compact as a reason to reload conversation content: the feed is the
 * durable transcript and is unchanged by compaction itself.
 */
export async function compactSession(id: string): Promise<CompactSessionResult> {
  const response = await fetch(
    `${SERVER_URL}/sessions/${encodeURIComponent(id)}/compact`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
  );
  if (response.status === 409) {
    const message = await readErrorMessage(
      response,
      `Session ${id} is busy; try again later`,
    );
    throw new CompactSessionError(409, 'busy', message);
  }
  if (response.status === 404) {
    const message = await readErrorMessage(
      response,
      `Unknown session: ${id}`,
    );
    throw new CompactSessionError(404, 'notFound', message);
  }
  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      `Failed to compact session ${id}: HTTP ${response.status}`,
    );
    throw new CompactSessionError(response.status, 'network', message);
  }
  const body = (await response.json()) as {
    ok?: boolean;
    compacted?: boolean;
    replacedCount?: number;
    tokensFreedEstimate?: number;
  };
  // Prefer the explicit `compacted === false` marker; fall back to the
  // presence of `replacedCount` so a future server that drops `ok` still
  // classifies correctly.
  if (body.compacted === false || typeof body.replacedCount !== 'number') {
    return { compacted: false };
  }
  return {
    compacted: true,
    replacedCount: body.replacedCount,
    tokensFreedEstimate: body.tokensFreedEstimate ?? 0,
  };
}
