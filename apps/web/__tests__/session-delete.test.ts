import { describe, it, expect, vi } from 'vitest';
import { runSessionDelete } from '@/lib/session-delete';

describe('runSessionDelete', () => {
  it('deletes on the server before removing locally, and only after it resolves', async () => {
    const calls: string[] = [];
    let resolveServer: () => void = () => {};
    const deleteServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveServer = () => {
            calls.push('server');
            resolve();
          };
        }),
    );
    const deleteLocal = vi.fn((id: string) => {
      calls.push('local');
      void id;
    });
    const setError = vi.fn();
    const deletingIds = new Set<string>();

    const pending = runSessionDelete({
      sessionId: 's1',
      deletingIds,
      deleteServer,
      deleteLocal,
      setError,
    });

    // The server request has gone out synchronously, but it has not
    // resolved yet — a local-first implementation would already have called
    // `deleteLocal` by this point, since nothing here has awaited anything.
    expect(deleteServer).toHaveBeenCalledWith('s1');
    expect(deleteLocal).not.toHaveBeenCalled();

    resolveServer();
    await pending;

    // Order, not just occurrence: a broken implementation that calls
    // `deleteLocal` first and `deleteServer` second (or fires both without
    // awaiting) would still make both mocks "have been called", but would
    // never produce this exact sequence.
    expect(calls).toEqual(['server', 'local']);
    expect(deleteLocal).toHaveBeenCalledWith('s1');
    expect(setError).toHaveBeenCalledWith(null);
  });

  it('never removes the session locally when the server delete fails, and surfaces the retry message', async () => {
    const deleteServer = vi.fn().mockRejectedValue(new Error('network'));
    const deleteLocal = vi.fn();
    const setError = vi.fn();
    const deletingIds = new Set<string>();

    await runSessionDelete({
      sessionId: 's1',
      deletingIds,
      deleteServer,
      deleteLocal,
      setError,
    });

    expect(deleteServer).toHaveBeenCalledWith('s1');
    expect(deleteLocal).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('删除失败，请重试');
  });

  it('releases the in-flight guard after a failure, so a retry can go through', async () => {
    const deleteServer = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(undefined);
    const deleteLocal = vi.fn();
    const setError = vi.fn();
    const deletingIds = new Set<string>();

    await runSessionDelete({
      sessionId: 's1',
      deletingIds,
      deleteServer,
      deleteLocal,
      setError,
    });
    expect(deleteLocal).not.toHaveBeenCalled();

    await runSessionDelete({
      sessionId: 's1',
      deletingIds,
      deleteServer,
      deleteLocal,
      setError,
    });

    expect(deleteServer).toHaveBeenCalledTimes(2);
    expect(deleteLocal).toHaveBeenCalledWith('s1');
  });

  it('treats a resolved deleteServer (the 404-as-already-gone case) as success and removes locally', async () => {
    // `deleteServerSession`'s documented contract is to resolve rather than
    // throw on a 404. From this function's point of view that is
    // indistinguishable from an ordinary success — it only ever sees
    // "resolved" vs. "rejected" — so this pins that a resolved call still
    // reaches local removal.
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const deleteLocal = vi.fn();
    const setError = vi.fn();
    const deletingIds = new Set<string>();

    await runSessionDelete({
      sessionId: 's1',
      deletingIds,
      deleteServer,
      deleteLocal,
      setError,
    });

    expect(deleteLocal).toHaveBeenCalledWith('s1');
  });

  it('ignores a second call for the same session while the first is still pending', async () => {
    let resolveServer: () => void = () => {};
    const deleteServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveServer = resolve;
        }),
    );
    const deleteLocal = vi.fn();
    const setError = vi.fn();
    const deletingIds = new Set<string>();

    const first = runSessionDelete({
      sessionId: 's1',
      deletingIds,
      deleteServer,
      deleteLocal,
      setError,
    });
    // Simulates a double click: a second invocation for the same id lands
    // before the first has awaited anything.
    const second = runSessionDelete({
      sessionId: 's1',
      deletingIds,
      deleteServer,
      deleteLocal,
      setError,
    });

    expect(deleteServer).toHaveBeenCalledTimes(1);

    resolveServer();
    await Promise.all([first, second]);

    expect(deleteServer).toHaveBeenCalledTimes(1);
    expect(deleteLocal).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending title write-back before the server delete goes out, when provided', async () => {
    const calls: string[] = [];
    const deleteServer = vi.fn(async () => {
      calls.push('deleteServer');
    });
    const deleteLocal = vi.fn();
    const setError = vi.fn();
    const cancelTitleWriteBack = vi.fn((id: string) => {
      calls.push(`cancel:${id}`);
    });

    await runSessionDelete({
      sessionId: 's1',
      deletingIds: new Set<string>(),
      deleteServer,
      deleteLocal,
      setError,
      cancelTitleWriteBack,
    });

    expect(cancelTitleWriteBack).toHaveBeenCalledWith('s1');
    // Must happen before the server request, so a title PATCH the delete
    // would otherwise race can never still be in flight when DELETE is sent.
    expect(calls).toEqual(['cancel:s1', 'deleteServer']);
  });

  it('does not require cancelTitleWriteBack (optional, existing callers keep working)', async () => {
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const deleteLocal = vi.fn();
    const setError = vi.fn();

    await expect(
      runSessionDelete({
        sessionId: 's1',
        deletingIds: new Set<string>(),
        deleteServer,
        deleteLocal,
        setError,
      }),
    ).resolves.toBeUndefined();
    expect(deleteLocal).toHaveBeenCalledWith('s1');
  });
});
