'use client';

import { useEffect } from 'react';
import {
  fetchServerSessions,
  fetchServerSessionDetail,
} from '@/lib/sessions-api';
import { useSessionStore, type PermissionMode } from '@/stores/session-store';

/**
 * In-flight detail fetches, keyed by session id. Concurrent callers share one
 * request; the entry is dropped when it settles so a failed fetch can be
 * retried.
 */
const inFlight = new Map<string, Promise<void>>();

/**
 * Fetches one session's messages and context-usage seed, unless they are
 * already in memory. The response is applied even if the user has switched
 * away in the meantime — the data belongs to that session, not to the view.
 */
export async function ensureSessionDetail(id: string): Promise<void> {
  const known = useSessionStore.getState().sessions.find((s) => s.id === id);
  if (known?.detailLoaded) return;

  const existing = inFlight.get(id);
  if (existing) return existing;

  const request = (async () => {
    const detail = await fetchServerSessionDetail(id);
    if (!detail) return;
    useSessionStore.getState().applySessionDetail(id, {
      messages: detail.messages,
      contextUsage: detail.contextUsage,
      projectId: detail.projectId,
      providerId: detail.providerId,
      modelId: detail.modelId,
      permissionMode: (detail.permissionMode as PermissionMode | null) ?? 'plan',
    });
  })().finally(() => {
    inFlight.delete(id);
  });

  inFlight.set(id, request);
  return request;
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
      // Sessions created in this tab but not yet persisted (no message sent)
      // exist only here — keep them, they are not in the server's list.
      const unpersisted = local.filter(
        (s) => s.detailLoaded && s.messages.length === 0 && !summaries.some((r) => r.id === s.id),
      );

      useSessionStore.getState().setSessions([
        ...unpersisted,
        ...summaries.map((summary) => ({
          id: summary.id,
          title: summary.title,
          messages: [],
          messageCount: summary.messageCount,
          detailLoaded: false,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          projectId: summary.projectId,
          providerId: summary.providerId,
          modelId: summary.modelId,
          permissionMode: (summary.permissionMode as PermissionMode | null) ?? 'plan',
          contextUsage: null,
        })),
      ]);
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
