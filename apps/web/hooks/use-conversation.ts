'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import {
  composeChatEntries,
  mergeStoredAndLive,
  projectConversation,
  type ChatEntry,
  type ProjectedConversation,
} from '@/lib/projection';
import type { ConversationMessage, ContextUsageView } from '@volto/sdk/sse';
import { dropCachedTrajectory } from '@/lib/trajectory-cache';
import { projectContextUsage } from '@/lib/context-usage';

const EMPTY_MESSAGES: ConversationMessage[] = [];

const EMPTY_PROJECTED: ProjectedConversation = {
  view: { messages: [] },
  records: [],
};

export interface ConversationFeed {
  /** Rendered rows: chat bubbles plus error notices for failed turns. */
  entries: ChatEntry[];
  /**
   * Conversation messages only (no error notices) — what gets persisted as
   * the session's history snapshot.
   */
  messages: ConversationMessage[];
  /**
   * The live projection. Its identity changes only when the event buffer
   * does (a session switch or new streamed events).
   */
  live: ProjectedConversation;
  /**
   * Context usage projected from the recovered seed plus the live event
   * fold. null = no request header seen yet (nothing to anchor on), so the
   * consumer renders no context meter at all.
   */
  usage: ContextUsageView | null;
}

/**
 * Composes the feed for the current session and keeps it in sync with the
 * session and chat stores.
 *
 * A session's rendered feed is its persisted history (projected server-side
 * when recovered, or snapshotted client-side while active) merged with the
 * live projection of whatever the SSE channel has streamed since the session
 * was opened. The chat store's event buffer belongs to exactly one session;
 * when the current session changes the outgoing feed is flushed to the
 * session store and the buffer is dropped, so switching back to a recovered
 * session and continuing it shows one continuous conversation.
 */
export function useConversation(): ConversationFeed {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const currentSession = useSessionStore((s) =>
    s.sessions.find((session) => session.id === s.currentSessionId),
  );
  const stored = currentSession?.messages ?? EMPTY_MESSAGES;
  const events = useChatStore((s) => s.events);
  const deltas = useChatStore((s) => s.deltas);
  const bufferSessionId = useChatStore((s) => s.currentSessionId);
  const bufferIsCurrent = bufferSessionId === currentSessionId;

  // The projection is derived synchronously from the event buffer. `prev`
  // (which would let closed turns keep their identity for memoised rows) is
  // intentionally not threaded through a ref: this repo's react-hooks rules
  // forbid ref access during render, and no row component here is memoised,
  // so identity reuse has no observable effect on render cost. `prev` must be
  // wired in together with row-level memoisation, never separately (see the
  // deviation note in §五 of the plan-013 view-projection design doc); until
  // then, core's structural watermark check guards against stale reuse of a
  // closed turn from `prev`.
  const live = useMemo<ProjectedConversation>(() => {
    if (!bufferIsCurrent) return EMPTY_PROJECTED;
    return projectConversation(events, deltas);
  }, [events, deltas, bufferIsCurrent]);

  // Context usage: the session's fold seed (filled by ensureSessionDetail from
  // GET /sessions/:id) plus the live event buffer folded on top. With client
  // state memory-only there is no write-back to guard against, so the seed is
  // read straight from the store.
  const contextUsage = useMemo(
    () => projectContextUsage(currentSession?.contextUsage ?? null, events, bufferIsCurrent),
    [events, bufferIsCurrent, currentSession?.contextUsage],
  );

  const messages = useMemo(
    () => mergeStoredAndLive(stored, live.view.messages),
    [stored, live],
  );

  const entries = useMemo(
    () => composeChatEntries(messages, live.records),
    [messages, live],
  );

  // -- session switch bookkeeping ------------------------------------------

  const sessionRef = useRef<string | null>(null);
  const snapshotsRef = useRef(new Map<string, ConversationMessage[]>());

  // Record the committed feed of the session that owns the buffer, so the
  // switch effect below can flush it into the in-memory store once the
  // session id has changed. This is not persistence — it keeps the tail of an
  // in-flight turn from being lost when the event buffer is dropped.
  useEffect(() => {
    if (bufferIsCurrent && currentSessionId) {
      snapshotsRef.current.set(currentSessionId, messages);
    }
  }, [messages, currentSessionId, bufferIsCurrent]);

  useEffect(() => {
    const previous = sessionRef.current;
    sessionRef.current = currentSessionId;
    if (previous === currentSessionId) return;

    // Flush the outgoing session's latest feed into the store before dropping
    // its buffer, so switching away mid-turn does not lose the turn's tail.
    if (previous !== null) {
      const snapshot = snapshotsRef.current.get(previous);
      if (snapshot) {
        useSessionStore.getState().updateSessionMessages(previous, snapshot);
      }
    }
    snapshotsRef.current.clear();

    // The event buffer belongs to exactly one session; whatever is still in
    // it belongs to the session just left, so it must never project into the
    // next session's feed.
    const chat = useChatStore.getState();
    if (chat.currentSessionId !== currentSessionId) {
      chat.setEvents([]);
      chat.setSessionId(currentSessionId);
      // 切走即丢弃上一会话的轨迹缓存行：缓存于切换前，可能缺少离开期间
      // 在服务端完成的轮次，切回时须重拉而不是命中陈旧缓存。
      if (previous !== null) dropCachedTrajectory(previous);
    }
  }, [currentSessionId]);

  const usage = contextUsage.view;

  return { entries, messages, live, usage };
}
