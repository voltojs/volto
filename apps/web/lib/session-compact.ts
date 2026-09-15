/**
 * Manual compact toast flow. Extracted from `ChatPanel` so the busy /
 * nothing-to-compact / failure branching is unit-testable without rendering
 * the chat surface — same pattern as `session-delete.ts`.
 *
 * Deliberately has no conversation-feed callbacks: compaction must not
 * change what the user sees in the transcript (Task 6 contract). Results
 * are reported as toasts only.
 */

import {
  compactSession as defaultCompactSession,
  CompactSessionError,
  type CompactSessionResult,
} from './sessions-api';

export interface SessionCompactParams {
  sessionId: string;
  /** The POST client; injectable for tests. Defaults to `compactSession`. */
  compact?: (id: string) => Promise<CompactSessionResult>;
  notify: {
    success: (message: string) => void;
    error: (message: string) => void;
  };
}

/**
 * Runs one manual compact and maps the outcome to a toast.
 *
 * - compacted → success with how many messages were replaced
 * - nothing to compact → success (not an error; the session was simply idle)
 * - 409 busy → error toast telling the user to retry later
 * - 404 / network → error toast
 */
export async function runSessionCompact(
  params: SessionCompactParams,
): Promise<void> {
  const { sessionId, notify } = params;
  const compact = params.compact ?? defaultCompactSession;
  let result: CompactSessionResult;
  try {
    result = await compact(sessionId);
  } catch (err) {
    if (err instanceof CompactSessionError && err.kind === 'busy') {
      notify.error('会话正在生成中，请稍后再试');
      return;
    }
    if (err instanceof CompactSessionError && err.kind === 'notFound') {
      notify.error('会话不存在或已失效');
      return;
    }
    notify.error(
      err instanceof Error && err.message ? err.message : '压缩上下文失败，请重试',
    );
    return;
  }
  if (result.compacted) {
    notify.success(
      `已压缩上下文：${result.replacedCount} 条消息被摘要替换，约释放 ${result.tokensFreedEstimate} tokens`,
    );
    return;
  }
  notify.success('当前没有需要压缩的内容');
}
