'use client';

import { useEffect } from 'react';
import { fetchServerSessions, fetchServerSessionDetail } from '@/lib/sessions-api';
import { useSessionStore, type PermissionMode } from '@/stores/session-store';

/**
 * On mount, pulls the list of sessions the headless-server has durably
 * recorded (the jsonl transcript store) and adds any this browser doesn't
 * already know about — a fresh browser profile, or localStorage cleared
 * while the server process kept running. Never overwrites a session already
 * present locally: local state may be more current than what the server has
 * flushed to disk.
 */
export function useRecoverServerSessions(): void {
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let summaries;
      try {
        summaries = await fetchServerSessions();
      } catch {
        // Server unreachable (not started yet, or offline) — nothing to
        // recover; the regular connection-state UI already surfaces this.
        return;
      }

      const localIds = new Set(useSessionStore.getState().sessions.map((s) => s.id));
      const missing = summaries.filter((summary) => !localIds.has(summary.id));

      for (const summary of missing) {
        if (cancelled) return;
        const detail = await fetchServerSessionDetail(summary.id).catch(() => null);
        if (!detail || cancelled) continue;

        useSessionStore.getState().hydrateFromServer({
          id: detail.id,
          title: `会话 ${new Date(detail.createdAt).toLocaleDateString('zh-CN')}`,
          messages: detail.messages.map((message) => ({ ...message })),
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          projectId: detail.projectId,
          providerId: detail.providerId,
          modelId: detail.modelId,
          permissionMode: (detail.permissionMode as PermissionMode | null) ?? 'plan',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
