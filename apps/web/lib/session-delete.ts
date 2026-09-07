/**
 * Session deletion ordering. Client state is memory-only (the server is the
 * sole source of truth), so removing a session locally before the server
 * confirms the delete would only make it reappear on the next list fetch —
 * this module exists to make that ordering testable without rendering
 * `ProjectList`.
 */

export interface SessionDeleteParams {
  sessionId: string;
  /**
   * Session ids with a delete currently in flight, mutated in place by this
   * function. The membership check and the `add` both happen synchronously,
   * before the first `await` below — so a second call for the same id made
   * while the first is still pending (e.g. a double click) sees the id
   * already present and returns immediately, even though nothing has
   * `await`ed yet and React has not re-rendered. Callers must pass the same
   * `Set` instance across calls (e.g. a `useRef`) for this guard to work.
   */
  deletingIds: Set<string>;
  /**
   * The DELETE request to the server. Resolves (does not throw) when the
   * session is already gone (404) — that is treated the same as an ordinary
   * success below.
   */
  deleteServer: (id: string) => Promise<void>;
  /** Removes the session from local state. Must run only after `deleteServer` resolves. */
  deleteLocal: (id: string) => void;
  /** Surfaces a user-facing error message, or clears it (pass `null`) at the start of a new attempt. */
  setError: (message: string | null) => void;
  /**
   * Cancels a pending derived-title write-back for this session, if any
   * (`apps/web/lib/session-title.ts`'s `cancelPendingTitleWriteBack`).
   * Called before the server delete goes out.
   *
   * This closes the one client-triggerable path into the server's
   * read-session→append TOCTOU window around DELETE (documented at
   * `apps/headless-server/src/server.ts`'s PATCH handler): if a title PATCH's
   * append lands after a delete's `readSession` but the delete hasn't
   * unlinked yet — or vice versa — `resolveWritePath` can fall through to
   * `defaultFilePath` and recreate a zombie top-level jsonl for the
   * just-deleted session. Optional so existing callers/tests that don't
   * exercise this path aren't forced to wire it up.
   */
  cancelTitleWriteBack?: (id: string) => void;
}

/**
 * Runs one session delete: server first, local removal only on success.
 *
 * On failure, `deleteLocal` is never called and `setError` receives
 * `删除失败，请重试`, so the session stays visible and selectable in the
 * sidebar for a retry.
 *
 * Extracted from `ProjectList`'s `handleDeleteSession` so this ordering (the
 * task's single most important invariant) and the in-flight guard can be
 * unit-tested without a component-rendering harness, which this repo does
 * not have.
 */
export async function runSessionDelete(
  params: SessionDeleteParams,
): Promise<void> {
  const {
    sessionId,
    deletingIds,
    deleteServer,
    deleteLocal,
    setError,
    cancelTitleWriteBack,
  } = params;
  if (deletingIds.has(sessionId)) return;
  deletingIds.add(sessionId);
  setError(null);
  cancelTitleWriteBack?.(sessionId);
  try {
    // Delete order is load-bearing: request the server first. Removing the
    // session locally before the server confirms would only make it
    // reappear on the next list fetch, since the server is now the sole
    // source of truth.
    await deleteServer(sessionId);
  } catch {
    // Keep the session in the list — the user can retry.
    setError('删除失败，请重试');
    return;
  } finally {
    deletingIds.delete(sessionId);
  }
  deleteLocal(sessionId);
}
