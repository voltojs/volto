/**
 * Session store tests.
 *
 * The store is memory-only (no persistence middleware): the server is the
 * sole source of truth, and this file's "session store persistence" describe
 * exists to pin that down as a regression guard.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../stores/session-store.js';
import { summary } from './helpers/session';

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

describe('session store persistence', () => {
  it('has no persist middleware attached', () => {
    // A "no localStorage writes happened" assertion is not a reliable guard:
    // zustand's `persist` middleware resolves its storage
    // (`window.localStorage` by default) in a try/catch at store-creation
    // time, so an environment where that read throws makes it silently
    // no-op instead of failing — re-adding
    // `persist(..., { name: 'volto-sessions' })` to the store still passes a
    // "writes nothing" test verbatim.
    //
    // The structural check this project's earlier fix reached for —
    // `expect('persist' in useSessionStore).toBe(false)`, since `persist`
    // attaches an `api.persist` property — is *also* not reliable in this
    // repo's plain "node" vitest environment specifically: verified
    // empirically (re-adding `persist(...)` and running this file) that
    // `window` itself is undefined here (not just `window.localStorage`), so
    // `persist`'s storage resolution throws a step earlier than the
    // `api.persist` assignment and it takes its "storage unavailable"
    // fallback path *before* ever setting `api.persist` — leaving
    // `'persist' in useSessionStore` at `false` whether or not the
    // middleware is attached. That fallback path still wraps every
    // `set()` call to warn once per call, though
    // (`[zustand persist middleware] Unable to update item ...`), which
    // *is* observable here and does fail this test when persist is
    // reintroduced. Both checks are kept: the property check is the
    // reliable signal in a real browser (where `window` exists and this
    // fallback path is not taken), the warning spy is what actually pins
    // this down in this test environment.
    expect('persist' in useSessionStore).toBe(false);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      useSessionStore.getState().createSession({ title: 't' });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
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

  it('drops a local session that is absent from the incoming list', () => {
    useSessionStore.getState().setSessions([summary('a'), summary('b')]);
    useSessionStore.getState().setSessions([summary('b')]);
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['b']);
  });

  it('clears the current session id when it is dropped from the list', () => {
    useSessionStore.getState().setSessions([summary('a')]);
    useSessionStore.getState().setCurrentSession('a');
    useSessionStore.getState().setSessions([summary('b')]);
    expect(useSessionStore.getState().currentSessionId).toBeNull();
  });

  it('keeps the current session id when it is still in the list', () => {
    useSessionStore.getState().setSessions([summary('a'), summary('b')]);
    useSessionStore.getState().setCurrentSession('a');
    useSessionStore.getState().setSessions([summary('a'), summary('b')]);
    expect(useSessionStore.getState().currentSessionId).toBe('a');
  });
});

describe('setSessionDetailError', () => {
  it('records a retryable error message on a session', () => {
    useSessionStore.getState().setSessions([summary('a')]);
    useSessionStore.getState().setSessionDetailError('a', 'boom');
    expect(useSessionStore.getState().sessions[0]!.detailError).toBe('boom');
  });

  it('is cleared by a subsequent successful applySessionDetail', () => {
    useSessionStore.getState().setSessions([summary('a')]);
    useSessionStore.getState().setSessionDetailError('a', 'boom');
    useSessionStore.getState().applySessionDetail('a', {
      messages: [],
      contextUsage: null,
      projectId: null,
      providerId: null,
      modelId: null,
      permissionMode: 'plan',
    });
    expect(useSessionStore.getState().sessions[0]!.detailError).toBeNull();
  });
});

describe('deleteSession', () => {
  it('moves the current session to the next one in the list', () => {
    useSessionStore.getState().setSessions([
      { ...summary('a'), updatedAt: 3 },
      { ...summary('b'), updatedAt: 2 },
    ]);
    useSessionStore.getState().setCurrentSession('a');
    useSessionStore.getState().deleteSession('a');
    expect(useSessionStore.getState().currentSessionId).toBe('b');
  });

  it('falls back to null when the list becomes empty', () => {
    useSessionStore.getState().setSessions([summary('a')]);
    useSessionStore.getState().setCurrentSession('a');
    useSessionStore.getState().deleteSession('a');
    expect(useSessionStore.getState().currentSessionId).toBeNull();
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
