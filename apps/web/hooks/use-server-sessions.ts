'use client';

import { useEffect } from 'react';
import {
  fetchServerSessions,
  fetchServerSessionDetail,
  type ServerSessionSummary,
} from '@/lib/sessions-api';
import {
  useSessionStore,
  type PermissionMode,
  type Session,
} from '@/stores/session-store';

/**
 * In-flight detail fetches, keyed by session id. Concurrent callers share one
 * request; the entry is dropped when it settles so a failed fetch can be
 * retried.
 */
const inFlight = new Map<string, Promise<void>>();

/** The server sends `permissionMode` as a bare string; narrow it defensively
 * rather than casting, so a value outside the union can't flow into the
 * store (and from there into gateway requests) unchecked. */
function normalisePermissionMode(mode: string | null): PermissionMode {
  return mode === 'plan' || mode === 'auto-accept' ? mode : 'plan';
}

/**
 * Fetches one session's messages and context-usage seed, unless they are
 * already in memory. The response is applied even if the user has switched
 * away in the meantime — the data belongs to that session, not to the view.
 *
 * A failure (network/HTTP error, or a 404 meaning the transcript is gone) is
 * recorded on the session as a retryable `detailError` rather than left as a
 * silent, permanent skeleton. Non-404 failures also reject the returned
 * promise so callers don't need to poll the store to notice.
 */
export async function ensureSessionDetail(id: string): Promise<void> {
  const known = useSessionStore.getState().sessions.find((s) => s.id === id);
  if (known?.detailLoaded) return;

  const existing = inFlight.get(id);
  if (existing) return existing;

  const request = (async () => {
    let detail;
    try {
      detail = await fetchServerSessionDetail(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useSessionStore
        .getState()
        .setSessionDetailError(id, `加载会话失败：${message}`);
      throw error;
    }
    if (!detail) {
      // The transcript is gone server-side (deleted out of band, or a stale
      // link) — a permanently silent skeleton would be worse than an
      // explicit, retryable error notice.
      useSessionStore
        .getState()
        .setSessionDetailError(id, '会话不存在，可能已被删除');
      return;
    }
    useSessionStore.getState().applySessionDetail(id, {
      messages: detail.messages,
      contextUsage: detail.contextUsage,
      projectId: detail.projectId,
      providerId: detail.providerId,
      modelId: detail.modelId,
      permissionMode: normalisePermissionMode(detail.permissionMode),
    });
  })().finally(() => {
    inFlight.delete(id);
  });

  inFlight.set(id, request);
  return request;
}

/**
 * Local sessions to keep once the server's summary list replaces the store's
 * list: anything the server doesn't know about yet. Presence in `summaries`
 * is the only test — a session that already has messages locally (written by
 * `use-conversation`'s debounce) before a list request that started before
 * the session existed comes back is still "unpersisted" from the server's
 * point of view, not something to drop. `detailLoaded` excludes sessions that
 * came from a *previous* server summary and are simply waiting on their
 * detail fetch — those aren't locally-originated and should follow the
 * server's list, not survive independently of it.
 */
export function selectUnpersistedSessions(
  local: Session[],
  summaries: ServerSessionSummary[],
): Session[] {
  const serverIds = new Set(summaries.map((s) => s.id));
  return local.filter((s) => s.detailLoaded && !serverIds.has(s.id));
}

/**
 * On mount, loads the session list the headless-server has durably recorded.
 * The server is the sole source of truth: client state is memory-only, so
 * this replaces the list rather than merging into it.
 */
export function useServerSessions(): void {
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let summaries;
      try {
        summaries = await fetchServerSessions();
      } catch {
        // Server unreachable (not started yet, or offline) — the regular
        // connection-state UI already surfaces this.
        return;
      }
      if (cancelled) return;

      const local = useSessionStore.getState().sessions;
      const unpersisted = selectUnpersistedSessions(local, summaries);

      useSessionStore.getState().setSessions([
        ...unpersisted,
        ...summaries.map((summary) => ({
          id: summary.id,
          title: summary.title,
          messages: [],
          messageCount: summary.messageCount,
          detailLoaded: false,
          detailError: null,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          projectId: summary.projectId,
          providerId: summary.providerId,
          modelId: summary.modelId,
          permissionMode: normalisePermissionMode(summary.permissionMode),
          contextUsage: null,
        })),
      ]);
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
