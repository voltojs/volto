import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Message } from './chat-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionMode = 'plan' | 'auto-accept';

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /** Project this session runs against. Fixed at creation time. */
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  permissionMode: PermissionMode;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface CreateSessionOptions {
  title?: string;
  projectId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
}

interface SessionState {
  sessions: Session[];
  currentSessionId: string | null;
  sidebarOpen: boolean;
  /**
   * The project a new session will bind to, shown by the welcome screen's
   * `ProjectPicker`. Lives here (rather than as local component state) so
   * the sidebar's per-project "new conversation" action can set it directly —
   * not persisted, since a stale default from a prior visit isn't meaningful.
   */
  pendingProjectId: string | null;

  createSession: (options?: CreateSessionOptions) => string;
  setPendingProjectId: (id: string | null) => void;
  deleteSession: (id: string) => void;
  updateSessionTitle: (id: string, title: string) => void;
  setCurrentSession: (id: string | null) => void;
  getSessionMessages: (id: string) => Message[];
  updateSessionMessages: (id: string, messages: Message[]) => void;

  setSessionModel: (id: string, providerId: string, modelId: string) => void;
  setSessionPermissionMode: (id: string, mode: PermissionMode) => void;
  getProjectSessions: (projectId: string) => Session[];

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
}

const generateId = () => Math.random().toString(36).substring(2, 11);

// ---------------------------------------------------------------------------
// Persistence migration
// ---------------------------------------------------------------------------

/**
 * Shape a persisted session may have taken under any prior schema version:
 * the removed `workspaceId`, and no guarantee that the project/model/
 * permission fields introduced by project-binding are present at all.
 */
type LegacySession = Partial<Session> & { workspaceId?: string };

interface PersistedSessionState {
  sessions: Session[];
  currentSessionId: string | null;
  sidebarOpen: boolean;
}

/**
 * Normalises one persisted session (from any prior schema version) into the
 * current `Session` shape: drops the removed `workspaceId`, and defaults the
 * fields introduced by project-binding so they read as `null`/`'plan'`
 * rather than `undefined` — an `undefined` projectId would match no project
 * in the sidebar, and an `undefined` permissionMode would leak into the
 * gateway request the permission picker sends later.
 */
function migrateSession(raw: LegacySession): Session {
  return {
    id: raw.id ?? generateId(),
    title: raw.title ?? '',
    messages: raw.messages ?? [],
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
    projectId: raw.projectId ?? null,
    providerId: raw.providerId ?? null,
    modelId: raw.modelId ?? null,
    permissionMode: raw.permissionMode ?? 'plan',
  };
}

/**
 * Migrates a persisted store of any prior schema version to the current
 * shape. Exported so tests can exercise it directly — the node test
 * environment has no localStorage to round-trip a persisted payload through.
 */
export function migrate(persistedState: unknown): PersistedSessionState {
  const state = (persistedState ?? {}) as Partial<PersistedSessionState> & {
    sessions?: LegacySession[];
  };
  return {
    sessions: (state.sessions ?? []).map(migrateSession),
    currentSessionId: state.currentSessionId ?? null,
    sidebarOpen: state.sidebarOpen ?? true,
  };
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      sidebarOpen: true,
      pendingProjectId: null,

      setPendingProjectId: (id) => set({ pendingProjectId: id }),

      createSession: (options = {}) => {
        const id = generateId();
        const now = Date.now();
        const session: Session = {
          id,
          title: options.title || `会话 ${new Date(now).toLocaleDateString('zh-CN')}`,
          messages: [],
          createdAt: now,
          updatedAt: now,
          projectId: options.projectId ?? null,
          providerId: options.providerId ?? null,
          modelId: options.modelId ?? null,
          // Start in the restrictive tier; widening it is an explicit choice.
          permissionMode: 'plan',
        };
        set((state) => ({
          sessions: [session, ...state.sessions],
          currentSessionId: id,
        }));
        return id;
      },

      deleteSession: (id) =>
        set((state) => ({
          sessions: state.sessions.filter((s) => s.id !== id),
          currentSessionId:
            state.currentSessionId === id ? null : state.currentSessionId,
        })),

      updateSessionTitle: (id, title) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, title, updatedAt: Date.now() } : s,
          ),
        })),

      setCurrentSession: (id) => set({ currentSessionId: id }),

      getSessionMessages: (id) =>
        get().sessions.find((s) => s.id === id)?.messages ?? [],

      updateSessionMessages: (id, messages) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, messages, updatedAt: Date.now() } : s,
          ),
        })),

      setSessionModel: (id, providerId, modelId) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, providerId, modelId, updatedAt: Date.now() } : s,
          ),
        })),

      setSessionPermissionMode: (id, permissionMode) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, permissionMode, updatedAt: Date.now() } : s,
          ),
        })),

      getProjectSessions: (projectId) =>
        get().sessions.filter((s) => s.projectId === projectId),

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      setSidebarOpen: (open) => set({ sidebarOpen: open }),
    }),
    {
      name: 'volto-sessions',
      version: 1,
      migrate,
      partialize: (state) => ({
        sessions: state.sessions,
        currentSessionId: state.currentSessionId,
        sidebarOpen: state.sidebarOpen,
      }),
    },
  ),
);
