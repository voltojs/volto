import { describe, it, expect, vi } from 'vitest';
import { deriveSessionTitle, runTitleWriteBack } from '@/lib/session-title';
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
    expect(rename).toHaveBeenCalledWith('s1', '第一句话');
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

  it('retries once on a PATCH failure, then succeeds without a third call', async () => {
    const rename = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(undefined);
    const { titledIds, setTitle } = setup(rename);

    await runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '',
      messages: [user('第一句话')],
      titledIds,
      setTitle,
      rename,
    });

    expect(rename).toHaveBeenCalledTimes(2);
    expect(titledIds.has('s1')).toBe(true);
  });

  it('gives up silently after the retry also fails, and does not throw', async () => {
    const rename = vi.fn().mockRejectedValue(new Error('network'));
    const { titledIds, setTitle } = setup(rename);

    await expect(
      runTitleWriteBack({
        sessionId: 's1',
        currentTitle: '',
        messages: [user('第一句话')],
        titledIds,
        setTitle,
        rename,
      }),
    ).resolves.toBeUndefined();

    expect(rename).toHaveBeenCalledTimes(2);
    // Permanently gated: even though the server never got the title, the id
    // is not retried again for the rest of the browsing session.
    expect(titledIds.has('s1')).toBe(true);
  });

  it('does not issue a third call if invoked again after giving up', async () => {
    const rename = vi.fn().mockRejectedValue(new Error('network'));
    const { titledIds, setTitle } = setup(rename);

    await runTitleWriteBack({
      sessionId: 's1',
      currentTitle: '',
      messages: [user('第一句话')],
      titledIds,
      setTitle,
      rename,
    });
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
    expect(setTitle).toHaveBeenCalledTimes(1);
  });
});
