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
import type { ConversationMessage } from '@volto/sdk/sse';
import { dropCachedTrajectory } from '@/lib/trajectory-cache';

const EMPTY_MESSAGES: ConversationMessage[] = [];

const EMPTY_PROJECTED: ProjectedConversation = {
  view: { messages: [] },
  records: [],
};

/** Debounce before a session's history snapshot is persisted. */
const SAVE_DEBOUNCE_MS = 100;

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
   * does (a session switch or new streamed events), so it doubles as the
   * trigger for the debounced history save.
   */
  live: ProjectedConversation;
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
  // switch effect below can flush it once the session id has changed (by
  // then the render already shows the next session, but the buffer — and
  // therefore the live feed — still belongs to the one being left).
  useEffect(() => {
    if (bufferIsCurrent && currentSessionId) {
      snapshotsRef.current.set(currentSessionId, messages);
    }
  }, [messages, currentSessionId, bufferIsCurrent]);

  useEffect(() => {
    const previous = sessionRef.current;
    sessionRef.current = currentSessionId;
    if (previous === currentSessionId) return;

    // Persist the outgoing session's latest feed before dropping its buffer,
    // so switching away mid-turn does not lose the turn's tail.
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

  // -- persistence ----------------------------------------------------------

  // Persist the session's history snapshot, debounced. Triggered by the live
  // projection's identity, never by the snapshot itself, so persisting
  // cannot feed back into the render and loop. The snapshot is recomputed
  // from store state when the timer fires, so it always captures the latest
  // merged feed even if events kept streaming after this effect ran.
  useEffect(() => {
    if (!currentSessionId) return;
    const timeoutId = setTimeout(() => {
      const sessionStore = useSessionStore.getState();
      const chat = useChatStore.getState();
      if (chat.currentSessionId !== currentSessionId) return;
      const stored =
        sessionStore.sessions.find((s) => s.id === currentSessionId)
          ?.messages ?? [];
      const projected = projectConversation(chat.events, chat.deltas);
      const snapshot = mergeStoredAndLive(stored, projected.view.messages);
      sessionStore.updateSessionMessages(currentSessionId, snapshot);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [live, currentSessionId]);

  return { entries, messages, live };
}
