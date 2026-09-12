'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { mergeStoredAndLiveRows, projectTrajectory } from '@/lib/projection';
import {
  getCachedTrajectory,
  setCachedTrajectory,
} from '@/lib/trajectory-cache';
import {
  fetchServerTrajectory,
  TrajectoryUnavailableError,
} from '@/lib/sessions-api';
import type { TrajectoryRow } from '@volto/sdk/sse';

export interface TrajectoryFeed {
  rows: TrajectoryRow[];
  streamingRowId: string | null;
  isLoading: boolean;
  error: { kind: 'legacy' | 'network'; message: string } | null;
  retry: () => void;
}

interface StoredState {
  rows: TrajectoryRow[] | null;
  error: { kind: 'legacy' | 'network'; message: string } | null;
  loading: boolean;
}

/** 空闲态：无会话，或服务端无可展示的持久化轨迹（空行集）。 */
const IDLE_STORED: StoredState = { rows: null, error: null, loading: false };

/**
 * 当前会话的服务端行：缓存命中即用，未命中拉取。
 *
 * 展示状态在渲染期按 (sessionId, nonce) 键派生（react-hooks 禁止 effect
 * 内同步 setState）：缓存命中 → 缓存行；异步结果未到前一律 loading。
 * effect 只负责拉取这一外部交互，结果在异步回调里写回。
 */
function useStoredRows(sessionId: string | null): StoredState & { retry: () => void } {
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce((n) => n + 1), []);

  // 最近一次异步结果，键控到 (sessionId, nonce)；换会话 / 重试后旧键自然失配。
  const [resolved, setResolved] = useState<{
    key: string;
    state: StoredState;
  } | null>(null);

  const cached = sessionId === null ? undefined : getCachedTrajectory(sessionId);
  const currentKey = sessionId === null ? null : `${sessionId}:${nonce}`;

  const state: StoredState =
    cached !== undefined
      ? { rows: cached, error: null, loading: false }
      : currentKey !== null && resolved !== null && resolved.key === currentKey
        ? resolved.state
        : currentKey === null
          ? IDLE_STORED
          : { rows: null, error: null, loading: true };

  useEffect(() => {
    if (sessionId === null || getCachedTrajectory(sessionId) !== undefined) return;
    const key = `${sessionId}:${nonce}`;
    let cancelled = false;
    void (async () => {
      try {
        const view = await fetchServerTrajectory(sessionId);
        if (cancelled) return;
        if (view === null) {
          // 防御性契约护栏：当前服务端对未知会话返回 200 + 空行集，并不
          // 404；null 仅在契约被破坏时出现。行为不变——展示退化为空行 +
          // 纯实时投影；不入缓存，落盘后下次拉取即可见。
          setResolved({ key, state: IDLE_STORED });
          return;
        }
        setCachedTrajectory(sessionId, view.rows);
        setResolved({ key, state: { rows: view.rows, error: null, loading: false } });
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof TrajectoryUnavailableError) {
          setResolved({
            key,
            state: {
              rows: null,
              error: {
                kind: err.kind,
                message:
                  err.kind === 'legacy'
                    ? '此会话由旧版本写入，无法读取轨迹'
                    : `加载轨迹失败：${err.message}`,
              },
              loading: false,
            },
          });
        } else {
          setResolved({
            key,
            state: {
              rows: null,
              error: {
                kind: 'network',
                message: `加载轨迹失败：${err instanceof Error ? err.message : String(err)}`,
              },
              loading: false,
            },
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, nonce]);

  return { ...state, retry };
}

export function useTrajectory(): TrajectoryFeed {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const events = useChatStore((s) => s.events);
  const deltas = useChatStore((s) => s.deltas);
  const bufferSessionId = useChatStore((s) => s.currentSessionId);
  const bufferIsCurrent = bufferSessionId !== null && bufferSessionId === currentSessionId;

  const root = useStoredRows(currentSessionId);

  const live = useMemo(() => {
    if (!bufferIsCurrent) return { rows: [] as TrajectoryRow[], streamingRowId: null };
    return projectTrajectory(events, deltas);
  }, [bufferIsCurrent, events, deltas]);

  const rows = useMemo(() => {
    if (root.rows === null) return live.rows;
    return mergeStoredAndLiveRows(root.rows, live.rows);
  }, [root.rows, live.rows]);

  return {
    rows,
    streamingRowId: live.streamingRowId,
    isLoading: root.loading,
    error: root.error,
    retry: root.retry,
  };
}
