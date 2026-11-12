/**
 * Client for `apps/headless-server`'s durable transcript endpoints
 * (`GET /sessions`, `GET /sessions/:id`, `GET /sessions/:id/trajectory`,
 * `GET /sessions/:id/events`) — the jsonl store's chat history, already
 * projected server-side into the shared `ConversationView` /
 * `TrajectoryView` shapes re-exported by `@volto/sdk/sse` (the raw-events
 * endpoint is the exception: wire-order events, projected client-side).
 */

import { gatewayUrl } from './gateway-base';
import type {
  ConversationMessage,
  ContextUsageSnapshot,
  TranscriptEventInput,
  TrajectoryView,
  TodoItem,
} from '@volto/sdk/sse';
import type { QueuedSeed } from './projection';

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
  /** Opaque selected reasoning-effort id; absent means the model default. */
  reasoningEffort?: string;
  messageCount: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** True while the gateway has a live turn for this session. */
  running?: boolean;
}

export interface ServerSessionDetail {
  id: string;
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  permissionMode: string | null;
  /** Opaque selected reasoning-effort id; absent means the model default. */
  reasoningEffort?: string;
  messages: ConversationMessage[];
  contextUsage: ContextUsageSnapshot | null;
  /** Standing todos folded from the durable event log; null when never written. */
  todos?: TodoItem[] | null;
  /**
   * The undelivered steering queue, FIFO with each entry's enqueue time,
   * folded server-side from the durable event log. Those entries are NOT in
   * `messages` (a still-queued message must not render as already sent), so
   * this is the only seed for the queue dock on a cold load. Optional so a
   * response from an older server still type-checks — consumers default to
   * `[]`.
   */
  queuedMessages?: QueuedSeed[];
  createdAt: number;
  updatedAt: number;
}

/** Lists every session the server has durably recorded. */
export async function fetchServerSessions(opts?: {
  q?: string;
  projectId?: string;
  limit?: number;
}): Promise<ServerSessionSummary[]> {
  const params = new URLSearchParams();
  if (opts?.q) params.set('q', opts.q);
  if (opts?.projectId) params.set('projectId', opts.projectId);
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const response = await fetch(gatewayUrl(`/sessions${query}`), {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Failed to list sessions: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { sessions: ServerSessionSummary[] };
  return body.sessions;
}

export interface ForkSessionOptions {
  throughSeq?: number;
  throughTurn?: number;
  title?: string;
}

/** Copies a completed turn prefix into a new session and returns its id. */
export async function forkSession(
  id: string,
  opts: ForkSessionOptions = {},
): Promise<{ id: string; title: string; parentSessionId: string }> {
  const response = await fetch(
    gatewayUrl(`/sessions/${encodeURIComponent(id)}/fork`),
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    },
  );
  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      `Failed to fork session ${id}: HTTP ${response.status}`,
    );
    throw new Error(message);
  }
  return (await response.json()) as { id: string; title: string; parentSessionId: string };
}

/** Download URL for a session export (cookie auth travels with the request). */
export function exportSessionUrl(id: string, format: "md" | "jsonl" = "md"): string {
  return gatewayUrl(
    `/sessions/${encodeURIComponent(id)}/export?format=${format}`,
  );
}

/** Fetches one session's projected conversation view. Returns null for an unknown id. */
export async function fetchServerSessionDetail(
  id: string,
): Promise<ServerSessionDetail | null> {
  const response = await fetch(
    gatewayUrl(`/sessions/${encodeURIComponent(id)}`),
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
    gatewayUrl(`/sessions/${encodeURIComponent(id)}/trajectory`),
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
    gatewayUrl(`/sessions/${encodeURIComponent(id)}/events`),
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
 * `GET /sessions/:id/events?tail=1` — the in-flight turn's events plus the
 * gateway's live `running` flag. A client that reconnects mid-turn replays
 * this tail so the composer can show generating and the turn's tool batch
 * exists for a later `tool_result`; an idle session answers an empty tail and
 * `running: false`.
 */
export interface SessionEventsTail {
  sessionId: string;
  events: TranscriptEventInput[];
  running: boolean;
}

export async function fetchSessionEventsTail(id: string): Promise<SessionEventsTail> {
  const response = await fetch(
    gatewayUrl(`/sessions/${encodeURIComponent(id)}/events?tail=1`),
    { credentials: 'include' },
  );
  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      `Failed to load events ${id}: HTTP ${response.status}`,
    );
    throw new TrajectoryUnavailableError(response.status, message);
  }
  const body = (await response.json()) as {
    sessionId?: string;
    events?: TranscriptEventInput[];
    running?: boolean;
  };
  return {
    sessionId: body.sessionId ?? id,
    events: body.events ?? [],
    running: body.running === true,
  };
}

/**
 * `GET /sessions/:id/plan` — the session's current plan document (plan mode,
 * spec 2026-09-19 §3.5). 404 = no plan yet (the session has no project
 * binding, or `save_plan` never wrote one) and folds to `null` per the
 * caller's "no plan" semantics; every other non-ok status is a network /
 * server fault and throws. `updatedAt` is the plan file's mtime, converted
 * from the server's ISO string to epoch milliseconds.
 */
export async function fetchPlan(
  id: string,
): Promise<{ content: string; updatedAt: number } | null> {
  const response = await fetch(
    gatewayUrl(`/sessions/${encodeURIComponent(id)}/plan`),
    { credentials: 'include' },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load plan ${id}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    content?: unknown;
    updatedAt?: unknown;
  };
  return {
    content: typeof body.content === 'string' ? body.content : '',
    updatedAt:
      typeof body.updatedAt === 'string' ? Date.parse(body.updatedAt) || 0 : 0,
  };
}

/**
 * Renames a session.
 *
 * `source` is the provenance the server ranks: `"user"` (the default) wins
 * over everything, so a generated title that lands later cannot bury a name
 * the human typed. A non-ok response rejects — including the 409 the server
 * answers when a lower-ranked source tries to overwrite a higher one — so a
 * caller that lost the ranking race sees a real failure instead of silence.
 */
export async function renameServerSession(
  id: string,
  title: string,
  opts: { signal?: AbortSignal; source?: 'user' | 'model' | 'heuristic' } = {},
): Promise<void> {
  const { signal, source = 'user' } = opts;
  const response = await fetch(gatewayUrl(`/sessions/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, source }),
    ...(signal ? { signal } : {}),
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
  const response = await fetch(gatewayUrl(`/sessions/${encodeURIComponent(id)}`), {
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
    gatewayUrl(`/sessions/${encodeURIComponent(id)}/compact`),
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
