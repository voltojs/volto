import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  expandStoredTitle,
  titleFromSessionMeta,
  runManualRename,
  TITLE_RETRY_DELAY_MS,
} from '@/lib/session-title';
import type { ConversationMessage, TranscriptEventInput } from '@voltojs/sdk/sse';

const user = (content: string): ConversationMessage =>
  ({ id: 'm', role: 'user', content }) as ConversationMessage;

describe('titleFromSessionMeta', () => {
  const meta = (data: Record<string, unknown>): TranscriptEventInput =>
    ({ type: 'session_meta', data, time: 0 }) as TranscriptEventInput;

  it('returns the title a live session_meta carries', () => {
    // The gateway names a session itself and mirrors the record onto the live
    // channel; this is how the header and the sidebar hear about it.
    expect(titleFromSessionMeta(meta({ title: '新标题', titleSource: 'model' }))).toBe('新标题');
  });

  it('ignores other events', () => {
    expect(
      titleFromSessionMeta({ type: 'turn_end', data: { title: 'x' }, time: 0 } as TranscriptEventInput),
    ).toBeNull();
  });

  it('ignores a meta without a usable title', () => {
    expect(titleFromSessionMeta(meta({ projectId: 'p1' }))).toBeNull();
    expect(titleFromSessionMeta(meta({ title: 42 }))).toBeNull();
    expect(titleFromSessionMeta(meta({ title: '' }))).toBeNull();
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
      expect.stringContaining('session.renameFailed'),
    );
  });
});

describe('expandStoredTitle', () => {
  it('restores the full message behind an old clipped title', () => {
    const title = 'review 从 29cd234ac054b96542e37…';
    const full = 'review 从 29cd234ac054b96542e37af1aced46b2222d748d 到最新的这些提交记录，并给出分析报告';
    expect(expandStoredTitle(title, [user(full)])).toBe(full);
  });

  it('leaves a hand-written title alone', () => {
    expect(expandStoredTitle('我的手写标题…', [user('完全不同的内容')])).toBe('我的手写标题…');
  });

  it('does nothing when the stored title is not clipped', () => {
    expect(expandStoredTitle('普通标题', [user('普通标题但更长')])).toBe('普通标题');
  });
});
