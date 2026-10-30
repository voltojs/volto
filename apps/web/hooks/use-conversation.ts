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
import { runTitleWriteBack } from '@/lib/session-title';
import { renameServerSession } from '@/lib/sessions-api';

const EMPTY_MESSAGES: ConversationMessage[] = [];

const EMPTY_PROJECTED: ProjectedConversation = {
  view: { messages: [] },
  records: [],
};

export interface ConversationFeed {
  /** Rendered rows: chat bubbles plus error notices for failed turns. */
  entries: ChatEntry[];
  /**
   * Conversation messages only (no error notices) — the in-memory snapshot
   * flushed into the session store when the session is switched away from.
   * Nothing here is persisted to disk or `localStorage`; the server's
   * transcript is the only durable copy.
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
 * when recovered from `GET /sessions/:id`, or held in memory from the
 * moment it was created client-side) merged with the live projection of
 * whatever the SSE channel has streamed since the session was opened. The
 * chat store's event buffer belongs to exactly one session; when the current
 * session changes the outgoing feed is flushed into the (memory-only)
 * session store and the buffer is dropped, so switching back to a recovered
 * session and continuing it shows one continuous conversation. Nothing here
 * is written to disk or `localStorage` — the server's transcript is the
 * sole durable copy.
 */
export function useConversation(): ConversationFeed {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const currentSession = useSessionStore((s) =>
    s.sessions.find((session) => session.id === s.currentSessionId),
  );
  const stored = currentSession?.messages ?? EMPTY_MESSAGES;
  const events = useChatStore((s) => s.events);
  const deltas = useChatStore((s) => s.deltas);
  const notices = useChatStore((s) => s.notices);
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

  // Context usage: the session's numbers-only snapshot seed (filled by
  // ensureSessionDetail from GET /sessions/:id) plus the live event buffer
  // folded on top. With client state memory-only there is no write-back to
  // guard against, so the seed is read straight from the store.
  const contextUsage = useMemo(
    () => projectContextUsage(currentSession?.contextUsage ?? null, events, bufferIsCurrent),
    [events, bufferIsCurrent, currentSession?.contextUsage],
  );

  const messages = useMemo(
    () => mergeStoredAndLive(stored, live.view.messages),
    [stored, live],
  );

  const entries = useMemo(
    // Session notices (model-tier fallback) are appended to the feed's end.
    () => composeChatEntries(messages, live.records, notices),
    [messages, live, notices],
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
    // next session's feed. The sub-agent buckets are per-session the same
    // way — a leftover childSessionId from the outgoing session must not be
    // openable in the next one.
    const chat = useChatStore.getState();
    if (chat.currentSessionId !== currentSessionId) {
      chat.setEvents([]);
      chat.setSessionId(currentSessionId);
      chat.resetSubagents();
      // 切走即丢弃上一会话的轨迹缓存行：缓存于切换前，可能缺少离开期间
      // 在服务端完成的轮次，切回时须重拉而不是命中陈旧缓存。
      if (previous !== null) dropCachedTrajectory(previous);
    }
  }, [currentSessionId]);

  const usage = contextUsage.view;

  // -- title write-back -----------------------------------------------------

  // `titledRef` guards a session's title derivation+write-back to happen at
  // most once per session for the whole browsing session, no matter how many
  // times this effect re-fires. That matters because `messages` changes on
  // every streamed delta while the assistant answers the first turn, so this
  // effect keeps re-running throughout that reply; `runTitleWriteBack` adds
  // the id to the set synchronously, in the same pass that derives a
  // non-null title, before the network call — so every later re-run this
  // session is a cheap no-op. The gate is permanent: a PATCH failure does not
  // remove the id (see the retry inside `runTitleWriteBack`), matching spec
  // §4.2's "retry once, then give up for good" — titles are not on the
  // critical path.
  const titledRef = useRef(new Set<string>());
  useEffect(() => {
    if (!currentSessionId || !currentSession) return;
    void runTitleWriteBack({
      sessionId: currentSessionId,
      currentTitle: currentSession.title,
      messages,
      titledIds: titledRef.current,
      setTitle: (id, title) =>
        useSessionStore.getState().updateSessionTitle(id, title),
      rename: renameServerSession,
    });
  }, [currentSessionId, currentSession, messages]);

  return { entries, messages, live, usage };
}
