// @vitest-environment jsdom
/**
 * Session store tests.
 *
 * The store is memory-only (no persistence middleware): the server is the
 * sole source of truth, and this file's "session store persistence" describe
 * exists to pin that down as a regression guard.
 *
 * This file runs under the jsdom environment (see the docblock above) rather
 * than the workspace default of plain "node", specifically so `window` and
 * `window.localStorage` exist. Without a real `window`, zustand's `persist`
 * middleware throws while resolving `createJSONStorage(() => window.localStorage)`
 * and silently takes its "storage unavailable" no-op fallback *before* ever
 * assigning `api.persist` — which means a structural check like
 * `'persist' in useSessionStore` passes whether or not `persist(...)` is
 * actually attached to the store, and cannot fail the regression guard below.
 * With jsdom, `localStorage` is real, so the structural check and the direct
 * `localStorage` assertions are both genuinely load-bearing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../stores/session-store.js';
import { useConfigStore } from '../stores/config-store.js';
import { summary } from './helpers/session';
import { rememberEffort } from '../lib/reasoning-preferences.js';

beforeEach(() => {
  // Reasoning-effort choices are remembered per model in localStorage
  // (lib/reasoning-preferences.ts); a leftover entry would leak between
  // these cases.
  window.localStorage.clear();
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    pendingProjectId: null,
  });
  // setSessionModel now resolves the new model's reasoning capability itself
  // via useConfigStore.getModelReasoning, so tests that exercise the reset
  // rule must seed the provider/model catalog the same way the real app does.
  useConfigStore.setState({
    projects: [],
    providers: [],
    loaded: false,
    error: null,
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

  it('sets and updates the reasoning effort of an existing session', () => {
    const id = useSessionStore.getState().createSession({ projectId: 'p1' });
    useSessionStore.getState().setSessionReasoningEffort(id, 'eff-high');
    expect(
      useSessionStore.getState().sessions.find((s) => s.id === id)
        ?.reasoningEffort,
    ).toBe('eff-high');
  });

  describe('setSessionModel reasoning-effort reset rule', () => {
    // Never map to the "closest" effort — a silent substitution would make
    // the visible selection disagree with the request that actually goes
    // out. Only these three outcomes are allowed.
    it('keeps the selected effort when the new model still declares it', () => {
      useConfigStore.setState({
        providers: [
          {
            id: 'v2',
            kind: 'custom' as const,
            name: 'v2',
            baseURL: '',
            apiKeyMasked: '',
            models: [
              {
                id: 'm2',
                name: 'm2',
                code: 'm2',
                reasoning: {
                  efforts: [
                    { id: 'eff-low', name: 'Low' },
                    { id: 'eff-high', name: 'High' },
                  ],
                  defaultEffort: 'eff-low',
                },
              },
            ],
          },
        ],
      });
      const id = useSessionStore.getState().createSession({ projectId: 'p1' });
      useSessionStore.getState().setSessionReasoningEffort(id, 'eff-high');
      useSessionStore.getState().setSessionModel(id, 'v2', 'm2');
      expect(
        useSessionStore.getState().sessions.find((s) => s.id === id)
          ?.reasoningEffort,
      ).toBe('eff-high');
    });

    it('falls back to the new model default when the selected effort is gone', () => {
      useConfigStore.setState({
        providers: [
          {
            id: 'v2',
            kind: 'custom' as const,
            name: 'v2',
            baseURL: '',
            apiKeyMasked: '',
            models: [
              {
                id: 'm2',
                name: 'm2',
                code: 'm2',
                reasoning: {
                  efforts: [
                    { id: 'eff-low', name: 'Low' },
                    { id: 'eff-high', name: 'High' },
                  ],
                  defaultEffort: 'eff-low',
                },
              },
            ],
          },
        ],
      });
      const id = useSessionStore.getState().createSession({ projectId: 'p1' });
      useSessionStore.getState().setSessionReasoningEffort(id, 'eff-medium');
      useSessionStore.getState().setSessionModel(id, 'v2', 'm2');
      expect(
        useSessionStore.getState().sessions.find((s) => s.id === id)
          ?.reasoningEffort,
      ).toBe('eff-low');
    });

    it('prefers a previously remembered effort for the new model over its default', () => {
      const providers = [
        {
          id: 'v2',
          kind: 'custom' as const,
          name: 'v2',
          baseURL: '',
          apiKeyMasked: '',
          models: [
            {
              id: 'm2',
              name: 'm2',
              code: 'm2',
              reasoning: {
                efforts: [
                  { id: 'eff-low', name: 'Low' },
                  { id: 'eff-high', name: 'High' },
                ],
                defaultEffort: 'eff-low',
              },
            },
          ],
        },
      ];
      useConfigStore.setState({ providers });

      // First session: switch to the model, then choose an effort on it.
      const first = useSessionStore.getState().createSession({ projectId: 'p1' });
      useSessionStore.getState().setSessionModel(first, 'v2', 'm2');
      useSessionStore.getState().setSessionReasoningEffort(first, 'eff-high');

      // A later session arriving at the same model resumes that choice
      // instead of resetting to the model's default.
      const second = useSessionStore.getState().createSession({ projectId: 'p1' });
      useSessionStore.getState().setSessionModel(second, 'v2', 'm2');
      expect(
        useSessionStore.getState().sessions.find((s) => s.id === second)
          ?.reasoningEffort,
      ).toBe('eff-high');
    });

    it('does not let a remembered effort override a still-valid selection', () => {
      // Ordering rule: keep > remembered > default. A remembered value must
      // not silently replace what the user currently has selected.
      useConfigStore.setState({
        providers: [
          {
            id: 'v2',
            kind: 'custom' as const,
            name: 'v2',
            baseURL: '',
            apiKeyMasked: '',
            models: [
              {
                id: 'm2',
                name: 'm2',
                code: 'm2',
                reasoning: {
                  efforts: [
                    { id: 'eff-low', name: 'Low' },
                    { id: 'eff-high', name: 'High' },
                  ],
                  defaultEffort: 'eff-low',
                },
              },
            ],
          },
        ],
      });
      // Seed a memory that differs from what the session will be holding.
      rememberEffort('v2', 'm2', 'eff-low');

      const id = useSessionStore.getState().createSession({ projectId: 'p1' });
      useSessionStore.getState().setSessionReasoningEffort(id, 'eff-high');
      useSessionStore.getState().setSessionModel(id, 'v2', 'm2');

      expect(
        useSessionStore.getState().sessions.find((s) => s.id === id)
          ?.reasoningEffort,
      ).toBe('eff-high');
    });

    it('clears the effort when the new model has no default and no match', () => {
      useConfigStore.setState({
        providers: [
          {
            id: 'v2',
            kind: 'custom' as const,
            name: 'v2',
            baseURL: '',
            apiKeyMasked: '',
            models: [
              {
                id: 'm2',
                name: 'm2',
                code: 'm2',
                reasoning: { efforts: [{ id: 'eff-low', name: 'Low' }] },
              },
            ],
          },
        ],
      });
      const id = useSessionStore.getState().createSession({ projectId: 'p1' });
      useSessionStore.getState().setSessionReasoningEffort(id, 'eff-medium');
      useSessionStore.getState().setSessionModel(id, 'v2', 'm2');
      expect(
        useSessionStore.getState().sessions.find((s) => s.id === id)
          ?.reasoningEffort,
      ).toBeUndefined();
    });

    it('clears the effort when the new model has no reasoning capability at all', () => {
      useConfigStore.setState({
        providers: [
          {
            id: 'v2',
            kind: 'custom' as const,
            name: 'v2',
            baseURL: '',
            apiKeyMasked: '',
            models: [{ id: 'm2', name: 'm2', code: 'm2' }],
          },
        ],
      });
      const id = useSessionStore.getState().createSession({ projectId: 'p1' });
      useSessionStore.getState().setSessionReasoningEffort(id, 'eff-medium');
      useSessionStore.getState().setSessionModel(id, 'v2', 'm2');
      expect(
        useSessionStore.getState().sessions.find((s) => s.id === id)
          ?.reasoningEffort,
      ).toBeUndefined();
    });

    it('regression: a caller that changes only the model (no capability arg exists anymore) still gets the correct outcome', () => {
      // This is exactly the bug the fix removes: setSessionModel used to take
      // an optional capability parameter that every caller could forget,
      // silently clearing a still-valid selection. Now the store resolves
      // the capability itself, so a caller that only passes id/providerId/
      // modelId — the only signature available now — still gets the right
      // reset-rule outcome instead of an accidental clear.
      useConfigStore.setState({
        providers: [
          {
            id: 'v2',
            kind: 'custom' as const,
            name: 'v2',
            baseURL: '',
            apiKeyMasked: '',
            models: [
              {
                id: 'm2',
                name: 'm2',
                code: 'm2',
                reasoning: {
                  efforts: [
                    { id: 'eff-low', name: 'Low' },
                    { id: 'eff-high', name: 'High' },
                  ],
                  defaultEffort: 'eff-low',
                },
              },
            ],
          },
        ],
      });
      const id = useSessionStore.getState().createSession({ projectId: 'p1' });
      useSessionStore.getState().setSessionReasoningEffort(id, 'eff-high');
      useSessionStore.getState().setSessionModel(id, 'v2', 'm2');
      expect(
        useSessionStore.getState().sessions.find((s) => s.id === id)
          ?.reasoningEffort,
      ).toBe('eff-high');
    });
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
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('has no persist middleware attached', () => {
    // With a real `window.localStorage` (jsdom), zustand's `persist`
    // middleware resolves its storage successfully at store-creation time
    // and attaches an `api.persist` property — so this structural check is
    // now genuinely load-bearing: it fails if `persist(...)` is reintroduced
    // to the store. (In this repo's default plain "node" vitest environment,
    // `window` doesn't exist at all, so `persist`'s storage resolution throws
    // and it silently takes its "storage unavailable" fallback *before* ever
    // setting `api.persist` — leaving this check unable to fail. That's why
    // this file opts into jsdom via the docblock above.)
    expect('persist' in useSessionStore).toBe(false);

    // The warning spy is kept as a second, independent signal: if a future
    // zustand version changes how storage resolution failure is detected,
    // this still catches persistence being silently reintroduced via a
    // console warning path. (It is not load-bearing on its own — see the
    // file-level docblock's history of why a warning-only guard is fragile.)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      useSessionStore.getState().createSession({ title: 't' });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('never writes the session store to localStorage', () => {
    useSessionStore.getState().createSession({ title: 't' });
    useSessionStore
      .getState()
      .updateSessionTitle(
        useSessionStore.getState().sessions[0]!.id,
        'renamed',
      );
    expect(window.localStorage.getItem('volto-sessions')).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });
});

describe('setSessions', () => {
  it('replaces the list with server summaries, newest first', () => {
    useSessionStore.getState().setSessions([
      { ...summary('a'), updatedAt: 1 },
      { ...summary('b'), updatedAt: 3 },
      { ...summary('c'), updatedAt: 2 },
    ]);
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
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
      reasoningEffort: 'eff-high',
    });
    const session = useSessionStore.getState().sessions[0]!;
    expect(session.detailLoaded).toBe(true);
    expect(session.messages).toHaveLength(1);
    expect(session.projectId).toBe('p');
    expect(session.reasoningEffort).toBe('eff-high');
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
