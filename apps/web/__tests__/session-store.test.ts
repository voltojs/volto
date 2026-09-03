/**
 * Session store tests.
 *
 * The store uses zustand's persist middleware. Under vitest's node
 * environment there is no localStorage; zustand warns and skips persistence,
 * which is fine — these tests cover in-memory behaviour only.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore, migrate } from '../stores/session-store.js';

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
    useSessionStore
      .getState()
      .updateSessionMessages(id, [
        { id: 'm1', role: 'user', content: 'hi', timestamp: Date.now() },
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

describe('migrate', () => {
  it('normalises a v0-shaped persisted payload to the current shape', () => {
    // v0 sessions predate project-binding: they carry a `workspaceId` and
    // have none of `projectId`/`providerId`/`modelId`/`permissionMode`.
    const v0Payload = {
      sessions: [
        {
          id: 's1',
          title: 'old session',
          messages: [],
          createdAt: 1,
          updatedAt: 1,
          workspaceId: 'w1',
        },
      ],
      workspaces: [{ id: 'w1', name: 'old workspace', createdAt: 1 }],
      currentSessionId: 's1',
      currentWorkspaceId: 'w1',
      sidebarOpen: true,
    };

    const migrated = migrate(v0Payload);

    expect(migrated.sessions).toHaveLength(1);
    const session = migrated.sessions[0];
    expect(session).not.toHaveProperty('workspaceId');
    expect(session?.projectId).toBeNull();
    expect(session?.providerId).toBeNull();
    expect(session?.modelId).toBeNull();
    expect(session?.permissionMode).toBe('plan');
    expect(migrated.currentSessionId).toBe('s1');
    expect(migrated.sidebarOpen).toBe(true);
    expect(migrated).not.toHaveProperty('workspaces');
    expect(migrated).not.toHaveProperty('currentWorkspaceId');
  });

  it('tolerates an empty or missing persisted payload', () => {
    expect(migrate(undefined)).toEqual({
      sessions: [],
      currentSessionId: null,
      sidebarOpen: true,
    });
  });
});
