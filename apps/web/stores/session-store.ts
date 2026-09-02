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

  createSession: (options?: CreateSessionOptions) => string;
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

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      sidebarOpen: true,

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
      partialize: (state) => ({
        sessions: state.sessions,
        currentSessionId: state.currentSessionId,
        sidebarOpen: state.sidebarOpen,
      }),
    },
  ),
);
