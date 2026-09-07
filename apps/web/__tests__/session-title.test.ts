import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deriveSessionTitle,
  runTitleWriteBack,
  runManualRename,
  cancelPendingTitleWriteBack,
  TITLE_RETRY_DELAY_MS,
} from '@/lib/session-title';
import type { ConversationMessage } from '@volto/sdk/sse';

const user = (content: string): ConversationMessage =>
  ({ id: 'm', role: 'user', content }) as ConversationMessage;

describe('deriveSessionTitle', () => {
  it('takes the first user message, collapsed to one line', () => {
    expect(deriveSessionTitle([user('修复\n上下文注入')])).toBe('修复 上下文注入');
  });

  it('caps the title at 30 characters with an ellipsis', () => {
    expect(deriveSessionTitle([user('x'.repeat(50))])).toBe(`${'x'.repeat(30)}…`);
  });

  it('skips assistant messages when looking for the first user turn', () => {
    const messages = [
      { id: 'a', role: 'assistant', content: 'hi' } as ConversationMessage,
      user('真正的第一句'),
    ];
    expect(deriveSessionTitle(messages)).toBe('真正的第一句');
  });

  it('returns null when there is no user message or it is blank', () => {
    expect(deriveSessionTitle([])).toBeNull();
    expect(deriveSessionTitle([user('   ')])).toBeNull();
  });

  it('truncates on a codepoint boundary for astral-plane characters', () => {
    // Each 😀 is a surrogate pair (2 UTF-16 code units, 1 codepoint). A naive
    // `.slice(0, 30)` on the raw string would cut one in half at the 30-unit
    // mark and produce an unpaired surrogate; codepoint-aware slicing must
    // keep all 30 emoji intact.
    const emoji = '😀'.repeat(40);
    const result = deriveSessionTitle([user(emoji)]);
    expect(result).toBe(`${'😀'.repeat(30)}…`);
    expect(Array.from(result ?? '').length).toBe(31); // 30 emoji + ellipsis
  });
});

describe('runTitleWriteBack', () => {
  const setup = (rename: (id: string, title: string) => Promise<void>) => {
    const titledIds = new Set<string>();
    const setTitle = vi.fn();
    return { titledIds, setTitle, rename };
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives and writes the title exactly once on success', async () => {
    const rename = vi.fn().mockResolvedValue(undefined);
    const { titledIds, setTitle } = setup(rename);

    await runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '',
      messages: [user('第一句话')],
      titledIds,
      setTitle,
      rename,
    });

    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith('s1', '第一句话');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith('s1', '第一句话', expect.anything());
    expect(titledIds.has('s1')).toBe(true);
  });

  it('never overwrites a title that is already set (user-set or already written back)', async () => {
    const rename = vi.fn().mockResolvedValue(undefined);
    const { titledIds, setTitle } = setup(rename);

    await runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '用户重命名的标题',
      messages: [user('第一句话')],
      titledIds,
      setTitle,
      rename,
    });

    expect(setTitle).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('is a no-op once the session id is already in titledIds, even if called again', async () => {
    const rename = vi.fn().mockResolvedValue(undefined);
    const { titledIds, setTitle } = setup(rename);
    titledIds.add('s1');

    await runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '',
      messages: [user('第一句话')],
      titledIds,
      setTitle,
      rename,
    });

    expect(setTitle).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('does nothing when there is no derivable title yet', async () => {
    const rename = vi.fn().mockResolvedValue(undefined);
    const { titledIds, setTitle } = setup(rename);

    await runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '',
      messages: [],
      titledIds,
      setTitle,
      rename,
    });

    expect(setTitle).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    // Nothing was derived, so the session isn't marked as titled — a later
    // call (once a first user message actually exists) must still be able
    // to run.
    expect(titledIds.has('s1')).toBe(false);
  });

  it('retries once on a PATCH failure, after a delay, then succeeds without a third call', async () => {
    const rename = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(undefined);
    const { titledIds, setTitle } = setup(rename);

    const done = runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '',
      messages: [user('第一句话')],
      titledIds,
      setTitle,
      rename,
    });

    // The retry must not fire immediately — it has to wait out the delay so
    // a transient failure (e.g. the session not persisted yet) has time to
    // clear before the retry lands in the same failure window.
    await vi.advanceTimersByTimeAsync(0);
    expect(rename).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TITLE_RETRY_DELAY_MS);
    await done;

    expect(rename).toHaveBeenCalledTimes(2);
    expect(titledIds.has('s1')).toBe(true);
    // Success on the retry: no rollback, only the original optimistic set.
    expect(setTitle).toHaveBeenCalledTimes(1);
  });

  it('gives up after the delayed retry also fails, rolls the title back to empty, and does not throw', async () => {
    const rename = vi.fn().mockRejectedValue(new Error('network'));
    const { titledIds, setTitle } = setup(rename);

    const done = runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '',
      messages: [user('第一句话')],
      titledIds,
      setTitle,
      rename,
    });
    await vi.advanceTimersByTimeAsync(TITLE_RETRY_DELAY_MS);
    await expect(done).resolves.toBeUndefined();

    expect(rename).toHaveBeenCalledTimes(2);
    // Permanently gated: even though the server never got the title, the id
    // is not retried again for the rest of the browsing session.
    expect(titledIds.has('s1')).toBe(true);
    // The optimistic local title must not survive a final failure — it never
    // reached the server, so the UI must not keep showing it.
    expect(setTitle).toHaveBeenNthCalledWith(1, 's1', '第一句话');
    expect(setTitle).toHaveBeenNthCalledWith(2, 's1', '');
  });

  it('does not issue a third call if invoked again after giving up', async () => {
    const rename = vi.fn().mockRejectedValue(new Error('network'));
    const { titledIds, setTitle } = setup(rename);

    const done = runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '',
      messages: [user('第一句话')],
      titledIds,
      setTitle,
      rename,
    });
    await vi.advanceTimersByTimeAsync(TITLE_RETRY_DELAY_MS);
    await done;
    expect(rename).toHaveBeenCalledTimes(2);

    // Simulates the effect re-firing because `messages` changed again
    // (e.g. more streamed deltas) while the title is still empty on the
    // client (the failed PATCH never reached the server).
    await runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '',
      messages: [user('第一句话'), { id: 'a2', role: 'assistant', content: 'more' } as ConversationMessage],
      titledIds,
      setTitle,
      rename,
    });

    expect(rename).toHaveBeenCalledTimes(2);
    // Two from the first run (optimistic set + rollback); none from the
    // no-op second run.
    expect(setTitle).toHaveBeenCalledTimes(2);
  });

  it('a manual rename cancels an in-flight derived write-back: no retry fires, and the manual title is the last write sent', async () => {
    const titledIds = new Set<string>();
    const setTitle = vi.fn();
    const rename = vi.fn();

    // First call: the derived write-back's PATCH(T1). Simulates a real
    // `fetch(..., { signal })` — it never settles on its own, only rejects
    // if its signal is aborted, exactly like the browser's AbortController
    // contract that `renameServerSession` relies on.
    let capturedSignal: AbortSignal | undefined;
    rename.mockImplementationOnce(
      (_id: string, _title: string, signal?: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        });
      },
    );
    // Second call: the manual rename's own PATCH(T2), issued directly by the
    // call site (ProjectList's onFinishEdit), not through runTitleWriteBack.
    rename.mockResolvedValueOnce(undefined);

    const writeBack = runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '',
      messages: [user('第一句话')],
      titledIds,
      setTitle,
      rename,
    });

    // The derived PATCH(T1) is now in flight (synchronously, before any
    // await inside runTitleWriteBack yields).
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenNthCalledWith(
      1,
      's1',
      '第一句话',
      expect.anything(),
    );
    expect(capturedSignal?.aborted).toBe(false);

    // The user renames the session before T1 settles. The call site cancels
    // the derived write-back first, then issues its own PATCH — exactly the
    // sequence `ProjectList`'s `onFinishEdit` follows.
    cancelPendingTitleWriteBack('s1');
    expect(capturedSignal?.aborted).toBe(true);
    await rename('s1', '用户重命名');

    await writeBack;

    // Exactly two calls total: the aborted derived PATCH(T1), and the manual
    // PATCH(T2). If the derived path treated the abort as an ordinary
    // failure it would have retried, producing a third call with T1 — and
    // if that retry's PATCH(T1) landed after PATCH(T2), the user's manual
    // title would be silently lost to the server's last-wins fold.
    expect(rename).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenLastCalledWith('s1', '用户重命名');
  });

  it('a manual rename that lands during the retry delay also suppresses the retry, with no leaked timer', async () => {
    const titledIds = new Set<string>();
    const setTitle = vi.fn();
    // First call fails immediately; the code then enters the retry delay.
    const rename = vi.fn().mockRejectedValueOnce(new Error('network'));

    const writeBack = runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '',
      messages: [user('第一句话')],
      titledIds,
      setTitle,
      rename,
    });

    // Let the first (failing) PATCH settle and the retry delay's timer start.
    await vi.advanceTimersByTimeAsync(0);
    expect(rename).toHaveBeenCalledTimes(1);

    // A manual rename lands while still inside the delay window.
    cancelPendingTitleWriteBack('s1');

    // Advancing past where the retry would have fired must not produce a
    // second call — the abort must be observed even mid-delay, and the
    // delay's own timer must not still be pending (a leaked timer would keep
    // vitest's fake-timer queue non-empty forever).
    await vi.advanceTimersByTimeAsync(TITLE_RETRY_DELAY_MS);
    await writeBack;

    expect(rename).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('runManualRename', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the title optimistically and succeeds without a retry', async () => {
    const setTitle = vi.fn();
    const setError = vi.fn();
    const rename = vi.fn().mockResolvedValue(undefined);

    await runManualRename({
      sessionId: 's1',
      title: '新标题',
      previousTitle: '旧标题',
      setTitle,
      rename,
      setError,
    });

    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith('s1', '新标题');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledWith(null);
    expect(setError).toHaveBeenCalledTimes(1);
  });

  it('retries once after a delay on failure, then succeeds without rollback', async () => {
    const setTitle = vi.fn();
    const setError = vi.fn();
    const rename = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(undefined);

    const done = runManualRename({
      sessionId: 's1',
      title: '新标题',
      previousTitle: '旧标题',
      setTitle,
      rename,
      setError,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(rename).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TITLE_RETRY_DELAY_MS);
    await done;

    expect(rename).toHaveBeenCalledTimes(2);
    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith('s1', '新标题');
  });

  it('rolls the title back to its pre-rename value and surfaces an error when both attempts fail', async () => {
    const setTitle = vi.fn();
    const setError = vi.fn();
    const rename = vi.fn().mockRejectedValue(new Error('network'));

    const done = runManualRename({
      sessionId: 's1',
      title: '新标题',
      previousTitle: '旧标题',
      setTitle,
      rename,
      setError,
    });
    await vi.advanceTimersByTimeAsync(TITLE_RETRY_DELAY_MS);
    await expect(done).resolves.toBeUndefined();

    expect(rename).toHaveBeenCalledTimes(2);
    expect(setTitle).toHaveBeenNthCalledWith(1, 's1', '新标题');
    expect(setTitle).toHaveBeenNthCalledWith(2, 's1', '旧标题');
    expect(setError).toHaveBeenLastCalledWith(
      expect.stringContaining('重命名失败'),
    );
  });
});
