'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useChatStore } from '@/stores/chat-store';
import {
  composeChatEntries,
  mergeStoredAndLive,
  projectConversation,
  type ChatEntry,
} from '@/lib/projection';
import {
  getCachedSubagentEvents,
  setCachedSubagentEvents,
} from '@/lib/subagent-cache';
import { fetchSessionEvents } from '@/lib/sessions-api';
import type { TranscriptEventInput } from '@volto/sdk/sse';

/**
 * 某个子代理会话的对话流：盘上恢复（GET /sessions/:id/events，Task 4 端点）
 * 与实时桶（chat-store 的 SubagentBucket，Task 6）合并后的 feed。
 *
 * 拉取纪律：仅「桶已 done 且已有缓存」跳过重拉（终态不会再长）；其余情况
 * （桶在运行中——盘上内容在增长、桶尚不存在、上次拉取失败）每次都重拉。
 * 重试经 `nonce` 强制重拉。`childId` 不透明，只作键用。
 *
 * 展示状态（stored / error / loading）在渲染期按
 * `(childId, 桶终态, nonce)` 键派生——react-hooks 禁止 effect 内同步
 * setState（与 use-trajectory 的 useStoredRows 同一套约定），effect 只负责
 * 拉取这一外部交互，结果在异步回调里写回。
 *
 * `retry`/`bucket` 引用变化触发的重算均为有意设计——本 hook 不做 memo 化
 * （Task 11 处理渲染成本），不向 projection 传 `prev`。
 */
export function useSubagentConversation(childId: string | null): {
  entries: ChatEntry[];
  status: 'running' | 'done' | 'error' | 'idle';
  isLoading: boolean;
  error: string | null;
  retry: () => void;
  /**
   * The child's own `session_meta` (durable across reloads), or undefined
   * while neither the stored tail nor a live bucket has one.
   */
  meta: { permissionMode?: unknown } | undefined;
} {
  const bucket = useChatStore((s) => (childId ? s.subagents[childId] : undefined));
  const [nonce, setNonce] = useState(0);

  // 最近一次异步结果，键控到 (childId, 桶终态, nonce)；换子会话 / 重试 /
  // 桶终态翻转后旧键自然失配。
  const [resolved, setResolved] = useState<{
    key: string;
    state: { stored: TranscriptEventInput[] | null; error: string | null };
  } | null>(null);

  const bucketDone = bucket?.status === 'done';
  const cached = childId === null ? undefined : getCachedSubagentEvents(childId);
  // 唯一的免拉取路径：桶已终态且盘上事件已在手。命中即同步采用缓存，
  // 与实时桶按稳定消息 id 合流（live 胜出）。
  const cacheHit = bucketDone && cached !== undefined;
  const currentKey = childId === null ? null : `${childId}:${bucketDone ? 'd' : 'r'}:${nonce}`;

  const state: { stored: TranscriptEventInput[] | null; error: string | null } =
    cacheHit
      ? { stored: cached, error: null }
      : currentKey !== null && resolved !== null && resolved.key === currentKey
        ? resolved.state
        : { stored: null, error: null };
  const loading = !cacheHit && currentKey !== null && (resolved === null || resolved.key !== currentKey);

  useEffect(() => {
    if (childId === null) return;
    // done 且已有缓存 → 不重拉；运行中每次都重拉（盘上内容在增长）。
    if (bucketDone && getCachedSubagentEvents(childId) !== undefined) return;
    const key = `${childId}:${bucketDone ? 'd' : 'r'}:${nonce}`;
    let cancelled = false;
    void fetchSessionEvents(childId).then(
      (r) => {
        if (cancelled) return;
        setCachedSubagentEvents(childId, r.events);
        setResolved({ key, state: { stored: r.events, error: null } });
      },
      (err: unknown) => {
        if (cancelled) return;
        setResolved({
          key,
          state: {
            stored: null,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [childId, bucketDone, nonce]);

  const liveView = useMemo(
    () => (childId && bucket ? projectConversation(bucket.events, bucket.deltas) : null),
    [childId, bucket],
  );
  const storedView = useMemo(
    // memo 依赖 stored 引用；项目函数内部自带 asStored 伪 seq。
    () => (state.stored ? projectConversation(state.stored, []) : null),
    [state.stored],
  );
  const messages = useMemo(
    () => mergeStoredAndLive(storedView?.view.messages ?? [], liveView?.view.messages ?? []),
    [storedView, liveView],
  );
  const t = useTranslations('chat');
  const entries = useMemo(
    // Session notices (model-tier fallback) are main-feed rows: the tier
    // event is emitted un-tagged and never reaches a child bucket, so the
    // sub-agent pane renders none. Pass the empty list explicitly so the
    // choice stays visible at every call site instead of hiding behind the
    // parameter default.
    () => composeChatEntries(messages, liveView?.records ?? [], [], t),
    [messages, liveView, t],
  );

  // status：桶在场时桶状态胜出（done/error 括号、running）；桶缺席时由
  // 盘上拉取结果定——成功 → done，失败/未拉 → idle（error 单独走 error 字段）。
  const status: 'running' | 'done' | 'error' | 'idle' =
    childId === null
      ? 'idle'
      : (bucket?.status ??
        (state.error !== null ? 'idle' : state.stored !== null ? 'done' : 'idle'));
  // The child's own `session_meta`, taken from whichever source the pane is
  // reading. A reloaded tab has no live bucket, and the parent's event buffer
  // is not replayed for a settled session — so this is the only durable place
  // the child's boundary can come from (spec 2026-11-11 D7).
  const sourceEvents = state.stored ?? bucket?.events ?? [];
  const metaEvent = sourceEvents.find((event) => event.type === 'session_meta');
  const meta = metaEvent?.data as { permissionMode?: unknown } | undefined;

  return {
    entries,
    status,
    isLoading: loading,
    error: state.error,
    retry: () => setNonce((n) => n + 1),
    meta,
  };
}
