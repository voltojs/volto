import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '@/stores/session-store';
import { ensureSessionDetail } from '@/hooks/use-server-sessions';
import { summary } from './helpers/session';

const fetchServerSessionDetail = vi.fn();
vi.mock('@/lib/sessions-api', () => ({
  fetchServerSessions: vi.fn(),
  fetchServerSessionDetail: (...args: unknown[]) => fetchServerSessionDetail(...args),
}));

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
      permissionMode: 'plan',
      createdAt: 0,
      updatedAt: 0,
    });

    await ensureSessionDetail('a');
    expect(useSessionStore.getState().sessions[0]!.detailLoaded).toBe(true);

    await ensureSessionDetail('a');
    expect(fetchServerSessionDetail).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request across concurrent callers', async () => {
    useSessionStore.setState({ sessions: [summary('a')] });
    let resolve!: (v: unknown) => void;
    fetchServerSessionDetail.mockReturnValue(new Promise((r) => (resolve = r)));

    const first = ensureSessionDetail('a');
    const second = ensureSessionDetail('a');
    resolve({
      id: 'a', messages: [], contextUsage: null, projectId: null, providerId: null,
      modelId: null, permissionMode: 'plan', createdAt: 0, updatedAt: 0,
    });
    await Promise.all([first, second]);
    expect(fetchServerSessionDetail).toHaveBeenCalledTimes(1);
  });

  it('writes the detail even when the user has switched away', async () => {
    useSessionStore.setState({ sessions: [summary('a'), summary('b')], currentSessionId: 'a' });
    fetchServerSessionDetail.mockResolvedValue({
      id: 'a', messages: [{ id: 'm', role: 'user', content: 'hi' }], contextUsage: null,
      projectId: null, providerId: null, modelId: null, permissionMode: 'plan',
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
    expect(useSessionStore.getState().sessions[0]!.detailLoaded).toBe(false);
  });
});
