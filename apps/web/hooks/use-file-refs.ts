'use client';

import { useEffect } from 'react';
import { fetchFileRefs } from '@/lib/file-refs-api';
import { selectLastTurnEnd } from '@/lib/todos-model';
import { useChatStore } from '@/stores/chat-store';
import { useFileRefsStore } from '@/stores/file-refs-store';

/**
 * Keep a session's file reference annotations fresh: fetch on mount and on
 * param change, re-fetch whenever a turn settles (the turn_end event's
 * identity is the settle signal), and drop stale responses so a session
 * switch never lets an older fetch land. Fetch failures degrade to plain
 * text — annotations are decoration, never an error path.
 */
export function useFileRefs(projectId: string | null, sessionId: string | null): void {
  const lastTurnEnd = useChatStore((s) => selectLastTurnEnd(s.events));
  useEffect(() => {
    if (projectId === null || sessionId === null) return;
    let cancelled = false;
    fetchFileRefs(projectId, sessionId).then(
      (refs) => {
        if (!cancelled) useFileRefsStore.getState().setFileRefs(sessionId, refs);
      },
      () => {
        // Annotations are optional decoration: silence failures.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, lastTurnEnd]);
}
