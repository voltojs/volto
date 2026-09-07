/**
 * Session store tests.
 *
 * The store is memory-only (no persistence middleware): the server is the
 * sole source of truth, and this file's "session store persistence" describe
 * exists to pin that down as a regression guard.
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { useSessionStore } from '../stores/session-store.js';
import { summary } from './helpers/session';

// Vitest's default "node" environment has no Web Storage API. This suite
// only asserts that the store never touches it, so an in-memory stand-in is
// enough — no jsdom/happy-dom dependency needed for that.
beforeAll(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const backing = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (key) => backing.get(key) ?? null,
      setItem: (key, value) => void backing.set(key, value),
      removeItem: (key) => void backing.delete(key),
      clear: () => backing.clear(),
      key: (index) => Array.from(backing.keys())[index] ?? null,
      get length() {
        return backing.size;
      },
    } as Storage;
  }
});

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    pendingProjectId: null,
  });
});

describe('useSessionStore', () => {
  it('binds a project at creation time', () => {
    const id = useSessionStore.getState().createSession({ projectId: 'p1' });
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === id);
    expect(session?.projectId).toBe('p1');
  });

  it('defaults permissionMode to plan when none is given', () => {
    const id = useSessionStore.getState().createSession({ projectId: 'p1' });
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === id);
    expect(session?.permissionMode).toBe('plan');
  });

  it('starts a session in the requested permission mode when one is given', () => {
    // The welcome screen lets the user pick a tier before the session
    // exists; that choice must actually take effect from the first turn
    // rather than being silently forced back to 'plan'.
    const id = useSessionStore
      .getState()
      .createSession({ projectId: 'p1', permissionMode: 'auto-accept' });
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === id);
    expect(session?.permissionMode).toBe('auto-accept');
  });

  it('carries the initial model binding', () => {
    const id = useSessionStore
      .getState()
      .createSession({ projectId: 'p1', providerId: 'v1', modelId: 'm1' });
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === id);
    expect(session?.providerId).toBe('v1');
    expect(session?.modelId).toBe('m1');
  });

  it('creates a new session already marked as loaded, with an empty title', () => {
    const id = useSessionStore.getState().createSession({ projectId: 'p1' });
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === id);
    expect(session?.detailLoaded).toBe(true);
    expect(session?.messageCount).toBe(0);
    expect(session?.title).toBe('');
  });

  it('changes the model of an existing session', () => {
    const id = useSessionStore.getState().createSession({ projectId: 'p1' });
    useSessionStore.getState().setSessionModel(id, 'v2', 'm2');
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === id);
    expect(session?.providerId).toBe('v2');
    expect(session?.modelId).toBe('m2');
    // The project is fixed at creation time — changing the model must not
    // disturb it, or the session would silently lose its sidebar grouping
    // and its agent cwd.
    expect(session?.projectId).toBe('p1');
  });

  it('changes the permission mode of an existing session', () => {
    const id = useSessionStore.getState().createSession({ projectId: 'p1' });
    useSessionStore.getState().setSessionPermissionMode(id, 'auto-accept');
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === id);
    expect(session?.permissionMode).toBe('auto-accept');
    expect(session?.projectId).toBe('p1');
  });

  it('keeps the project bound when the title changes', () => {
    const id = useSessionStore.getState().createSession({ projectId: 'p1' });
    useSessionStore.getState().updateSessionTitle(id, 'renamed');
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === id);
    expect(session?.title).toBe('renamed');
    expect(session?.projectId).toBe('p1');
  });

  it('keeps the project bound when messages update', () => {
    const id = useSessionStore.getState().createSession({ projectId: 'p1' });
    useSessionStore.getState().updateSessionMessages(id, [
      {
        id: 'm1',
        role: 'user',
        content: 'hi',
        timestamp: Date.now(),
        blocks: [{ type: 'text', text: 'hi' }],
      },
    ]);
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === id);
    expect(session?.messages).toHaveLength(1);
    expect(session?.projectId).toBe('p1');
  });

  it('sets the pending project for the next new session', () => {
    expect(useSessionStore.getState().pendingProjectId).toBeNull();
    useSessionStore.getState().setPendingProjectId('p1');
    expect(useSessionStore.getState().pendingProjectId).toBe('p1');
    useSessionStore.getState().setPendingProjectId(null);
    expect(useSessionStore.getState().pendingProjectId).toBeNull();
  });

  it('groups sessions by project', () => {
    const a = useSessionStore.getState().createSession({ projectId: 'p1' });
    useSessionStore.getState().createSession({ projectId: 'p2' });
    const forP1 = useSessionStore.getState().getProjectSessions('p1');
    expect(forP1.map((s) => s.id)).toEqual([a]);
  });
});

describe('updateSessionContextUsage', () => {
  it('stores and replaces the fold for one session', () => {
    const store = useSessionStore.getState();
    const id = store.createSession({});
    const fold = { header: null, anchor: { promptTokens: 10, outputTokens: 2 }, pendingTokens: 4 };
    store.updateSessionContextUsage(id, fold);
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)?.contextUsage).toEqual(fold);
    store.updateSessionContextUsage(id, null);
    expect(useSessionStore.getState().sessions.find((s) => s.id === id)?.contextUsage).toBeNull();
  });
});

describe('session store persistence', () => {
  it('writes nothing to localStorage', () => {
    localStorage.clear();
    useSessionStore.getState().createSession({ title: 't' });
    expect(localStorage.getItem('volto-sessions')).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});

describe('setSessions', () => {
  it('replaces the list with server summaries, newest first', () => {
    useSessionStore.getState().setSessions([
      { ...summary('a'), updatedAt: 1 },
      { ...summary('b'), updatedAt: 3 },
      { ...summary('c'), updatedAt: 2 },
    ]);
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('applySessionDetail', () => {
  it('fills messages and marks the session loaded', () => {
    useSessionStore.getState().setSessions([summary('a')]);
    useSessionStore.getState().applySessionDetail('a', {
      messages: [{ id: 'm1', role: 'user', content: 'hi' } as never],
      contextUsage: null,
      projectId: 'p',
      providerId: 'pr',
      modelId: 'm',
      permissionMode: 'plan',
    });
    const session = useSessionStore.getState().sessions[0]!;
    expect(session.detailLoaded).toBe(true);
    expect(session.messages).toHaveLength(1);
    expect(session.projectId).toBe('p');
  });

  it('ignores a detail for a session no longer in the list', () => {
    useSessionStore.getState().setSessions([]);
    expect(() =>
      useSessionStore.getState().applySessionDetail('gone', {
        messages: [],
        contextUsage: null,
        projectId: null,
        providerId: null,
        modelId: null,
        permissionMode: 'plan',
      }),
    ).not.toThrow();
  });
});
