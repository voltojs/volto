import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConversationMessage } from '@volto/sdk/sse';
import { useSessionStore, type Session } from '@/stores/session-store';
import {
  ensureSessionDetail,
  needsQueueResync,
  selectUnpersistedSessions,
} from '@/hooks/use-server-sessions';
import type { ServerSessionSummary } from '@/lib/sessions-api';
import { SessionDetailUnavailableError } from '@/lib/sessions-api';
import { summary } from './helpers/session';

/** A stored-feed entry, optionally carrying the queue badge. */
function storedMessage(extra: { queued?: boolean } = {}): ConversationMessage {
  return {
    id: 'm',
    role: 'user',
    blocks: [],
    content: 'hi',
    timestamp: 0,
    ...extra,
  };
}

const fetchServerSessionDetail = vi.fn();
vi.mock('@/lib/sessions-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sessions-api')>(
    '@/lib/sessions-api',
  );
  return {
    ...actual,
    fetchServerSessions: vi.fn(),
    fetchServerSessionDetail: (...args: unknown[]) => fetchServerSessionDetail(...args),
  };
});

/** A minimal server-summary-shaped record for `selectUnpersistedSessions` tests. */
function serverSummary(id: string): ServerSessionSummary {
  return {
    id,
    projectId: null,
    providerId: null,
    modelId: null,
    permissionMode: null,
    messageCount: 0,
    title: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

// `ensureSessionDetail` is imported once, statically, rather than re-imported
// per test via `vi.resetModules()` — that would re-evaluate `session-store`
// too, handing this file's `useSessionStore` binding and the hook's internal
// one two different zustand store instances, so writes the hook makes would
// never be visible through this file's binding. The module-level `inFlight`
// map self-cleans (each promise deletes its own entry in `.finally`), so
// nothing needs resetting between tests anyway.
describe('ensureSessionDetail', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], currentSessionId: null });
    fetchServerSessionDetail.mockReset();
  });

  it('fetches once and marks the session loaded', async () => {
    useSessionStore.setState({ sessions: [summary('a')] });
    fetchServerSessionDetail.mockResolvedValue({
      id: 'a',
      messages: [{ id: 'm', role: 'user', content: 'hi' }],
      contextUsage: null,
      projectId: null,
      providerId: null,
      modelId: null,
      permissionMode: 'ask',
      createdAt: 0,
      updatedAt: 0,
    });

    await ensureSessionDetail('a');
    expect(useSessionStore.getState().sessions[0]!.detailLoaded).toBe(true);

    await ensureSessionDetail('a');
    expect(fetchServerSessionDetail).toHaveBeenCalledTimes(1);
  });

  it('force refetches a session whose detail is already loaded', async () => {
    useSessionStore.setState({ sessions: [summary('a')] });
    fetchServerSessionDetail.mockResolvedValueOnce({
      id: 'a',
      messages: [{ id: 'm1', role: 'user', content: 'first' }],
      contextUsage: null,
      projectId: null,
      providerId: null,
      modelId: null,
      permissionMode: 'ask',
      createdAt: 0,
      updatedAt: 0,
    });

    await ensureSessionDetail('a');
    expect(fetchServerSessionDetail).toHaveBeenCalledTimes(1);

    // Already loaded, no force: still one request, as before.
    await ensureSessionDetail('a');
    expect(fetchServerSessionDetail).toHaveBeenCalledTimes(1);

    // Simulate the switch-away flush: the stored feed now holds a queued
    // entry that delivery/edit/retract while unattached has since invalidated.
    useSessionStore
      .getState()
      .updateSessionMessages('a', [storedMessage({ queued: true })]);

    // The server reports a different history; forcing must replace the stale
    // snapshot wholesale (including the frozen queue badge), not keep it.
    fetchServerSessionDetail.mockResolvedValueOnce({
      id: 'a',
      messages: [{ id: 'm2', role: 'user', content: 'second' }],
      contextUsage: null,
      projectId: null,
      providerId: null,
      modelId: null,
      permissionMode: 'ask',
      createdAt: 0,
      updatedAt: 0,
    });

    await ensureSessionDetail('a', undefined, { force: true });
    expect(fetchServerSessionDetail).toHaveBeenCalledTimes(2);
    const replaced = useSessionStore.getState().sessions[0]!.messages;
    expect(replaced.map((m) => m.id)).toEqual(['m2']);
    expect(needsQueueResync(replaced)).toBe(false);
  });

  it('stores queuedMessages from the detail response', async () => {
    useSessionStore.setState({ sessions: [summary('a')] });
    fetchServerSessionDetail.mockResolvedValue({
      id: 'a',
      messages: [],
      contextUsage: null,
      projectId: null,
      providerId: null,
      modelId: null,
      permissionMode: 'ask',
      queuedMessages: [{ id: 'q1', content: 'queued', time: 5 }],
      createdAt: 0,
      updatedAt: 0,
    });

    await ensureSessionDetail('a');
    expect(useSessionStore.getState().sessions[0]!.queuedMessages).toEqual([
      { id: 'q1', content: 'queued', time: 5 },
    ]);

    // A response that omits the field (an older server) seeds no queue.
    useSessionStore.setState({ sessions: [summary('b')] });
    fetchServerSessionDetail.mockResolvedValue({
      id: 'b',
      messages: [],
      contextUsage: null,
      projectId: null,
      providerId: null,
      modelId: null,
      permissionMode: 'ask',
      createdAt: 0,
      updatedAt: 0,
    });

    await ensureSessionDetail('b');
    expect(
      useSessionStore.getState().sessions.find((s) => s.id === 'b')!.queuedMessages,
    ).toEqual([]);
  });

  it('shares one in-flight request across concurrent callers', async () => {
    useSessionStore.setState({ sessions: [summary('a')] });
    let resolve!: (v: unknown) => void;
    fetchServerSessionDetail.mockReturnValue(new Promise((r) => (resolve = r)));

    const first = ensureSessionDetail('a');
    const second = ensureSessionDetail('a');
    resolve({
      id: 'a', messages: [], contextUsage: null, projectId: null, providerId: null,
      modelId: null, permissionMode: 'ask', createdAt: 0, updatedAt: 0,
    });
    await Promise.all([first, second]);
    expect(fetchServerSessionDetail).toHaveBeenCalledTimes(1);
  });

  it('writes the detail even when the user has switched away', async () => {
    useSessionStore.setState({ sessions: [summary('a'), summary('b')], currentSessionId: 'a' });
    fetchServerSessionDetail.mockResolvedValue({
      id: 'a', messages: [{ id: 'm', role: 'user', content: 'hi' }], contextUsage: null,
      projectId: null, providerId: null, modelId: null, permissionMode: 'ask',
      createdAt: 0, updatedAt: 0,
    });

    const pending = ensureSessionDetail('a');
    useSessionStore.setState({ currentSessionId: 'b' });
    await pending;
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'a')!.detailLoaded).toBe(true);
  });

  it('leaves the session unloaded when the fetch fails', async () => {
    useSessionStore.setState({ sessions: [summary('a')] });
    fetchServerSessionDetail.mockRejectedValue(new Error('offline'));

    await expect(ensureSessionDetail('a')).rejects.toThrow('offline');
    const session = useSessionStore.getState().sessions[0]!;
    expect(session.detailLoaded).toBe(false);
    // A failed fetch is a retryable error state, not a silent, permanent
    // skeleton — the message must be recorded on the session.
    expect(session.detailError).toBe('errors.sessionLoadFailed');
  });

  it('records a retryable error instead of a silent no-op on a 404', async () => {
    useSessionStore.setState({ sessions: [summary('a')] });
    fetchServerSessionDetail.mockResolvedValue(null);

    await ensureSessionDetail('a');
    const session = useSessionStore.getState().sessions[0]!;
    expect(session.detailLoaded).toBe(false);
    expect(session.detailError).toBeTruthy();
  });

  it('records a legacy-kind, retry-discouraging error for a 410 (legacy transcript)', async () => {
    useSessionStore.setState({ sessions: [summary('a')] });
    fetchServerSessionDetail.mockRejectedValue(
      new SessionDetailUnavailableError(410, 'This session was written by an older version and cannot be read by this build.'),
    );

    await expect(ensureSessionDetail('a')).rejects.toBeInstanceOf(SessionDetailUnavailableError);
    const session = useSessionStore.getState().sessions[0]!;
    // Dedicated copy, not the raw "HTTP 410" the generic branch would produce.
    expect(session.detailError).toBe('errors.legacySession');
    expect(session.detailErrorKind).toBe('legacy');
  });

  it('records a network-kind error (retryable) for a non-410 failure', async () => {
    useSessionStore.setState({ sessions: [summary('a')] });
    fetchServerSessionDetail.mockRejectedValue(
      new SessionDetailUnavailableError(500, 'boom'),
    );

    await expect(ensureSessionDetail('a')).rejects.toBeInstanceOf(SessionDetailUnavailableError);
    const session = useSessionStore.getState().sessions[0]!;
    expect(session.detailError).toBe('errors.sessionLoadFailed');
    expect(session.detailErrorKind).toBe('network');
  });

  it('can be retried after a failure, and clears the error on success', async () => {
    useSessionStore.setState({ sessions: [summary('a')] });
    fetchServerSessionDetail.mockRejectedValueOnce(new Error('offline'));
    await expect(ensureSessionDetail('a')).rejects.toThrow('offline');
    expect(useSessionStore.getState().sessions[0]!.detailError).toBeTruthy();

    fetchServerSessionDetail.mockResolvedValueOnce({
      id: 'a', messages: [{ id: 'm', role: 'user', content: 'hi' }], contextUsage: null,
      projectId: null, providerId: null, modelId: null, permissionMode: 'ask',
      createdAt: 0, updatedAt: 0,
    });
    await ensureSessionDetail('a');
    const session = useSessionStore.getState().sessions[0]!;
    expect(session.detailLoaded).toBe(true);
    expect(session.detailError).toBeNull();
  });
});

describe('needsQueueResync', () => {
  it('is true only for a stored feed carrying a queued entry', () => {
    expect(needsQueueResync([])).toBe(false);
    expect(needsQueueResync([storedMessage()])).toBe(false);
    expect(needsQueueResync([storedMessage({ queued: false })])).toBe(false);
    expect(needsQueueResync([storedMessage(), storedMessage({ queued: true })])).toBe(
      true,
    );
  });
});

describe('selectUnpersistedSessions', () => {
  it('keeps a brand-new empty session absent from the server list', () => {
    const local: Session[] = [{ ...summary('a'), detailLoaded: true, messages: [] }];
    expect(selectUnpersistedSessions(local, [])).toEqual(local);
  });

  it('keeps an unpersisted session that already has messages', () => {
    // The bug this guards against: the list request was in flight before the
    // session existed, but by the time it resolves the session already has
    // its first message (written by use-conversation's session-switch flush —
    // there is no debounce). It must not be dropped just because it's
    // non-empty.
    const withMessage: Session = {
      ...summary('a'),
      detailLoaded: true,
      messages: [{ id: 'm', role: 'user', content: 'hi' } as never],
    };
    expect(selectUnpersistedSessions([withMessage], [])).toEqual([withMessage]);
  });

  it('drops a local session that is on the server', () => {
    const local: Session[] = [{ ...summary('a'), detailLoaded: true, messages: [] }];
    expect(selectUnpersistedSessions(local, [serverSummary('a')])).toEqual([]);
  });

  it('does not resurrect a session absent from both local-unloaded and the server', () => {
    const local: Session[] = [{ ...summary('a'), detailLoaded: false }];
    expect(selectUnpersistedSessions(local, [])).toEqual([]);
  });
});
