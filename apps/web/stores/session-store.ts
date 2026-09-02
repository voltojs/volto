import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Message } from './chat-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  workspaceId?: string;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SessionState {
  sessions: Session[];
  workspaces: Workspace[];
  currentSessionId: string | null;
  currentWorkspaceId: string | null;
  sidebarOpen: boolean;

  // Session actions
  createSession: (title?: string, workspaceId?: string) => string;
  deleteSession: (id: string) => void;
  updateSessionTitle: (id: string, title: string) => void;
  setCurrentSession: (id: string | null) => void;
  getSessionMessages: (id: string) => Message[];
  updateSessionMessages: (id: string, messages: Message[]) => void;

  // Workspace actions
  createWorkspace: (name: string) => string;
  deleteWorkspace: (id: string) => void;
  setCurrentWorkspace: (id: string | null) => void;
  getWorkspaceSessions: (workspaceId: string) => Session[];

  // Sidebar actions
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
}

const generateId = () => Math.random().toString(36).substring(2, 11);

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      workspaces: [],
      currentSessionId: null,
      currentWorkspaceId: null,
      sidebarOpen: true,

      // Session actions
      createSession: (title, workspaceId) => {
        const id = generateId();
        const now = Date.now();
        const session: Session = {
          id,
          title: title || `会话 ${new Date(now).toLocaleDateString('zh-CN')}`,
          messages: [],
          createdAt: now,
          updatedAt: now,
          workspaceId,
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

      getSessionMessages: (id) => {
        const session = get().sessions.find((s) => s.id === id);
        return session?.messages || [];
      },

      updateSessionMessages: (id, messages) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id
              ? { ...s, messages, updatedAt: Date.now() }
              : s,
          ),
        })),

      // Workspace actions
      createWorkspace: (name) => {
        const id = generateId();
        const workspace: Workspace = {
          id,
          name,
          createdAt: Date.now(),
        };
        set((state) => ({
          workspaces: [...state.workspaces, workspace],
          currentWorkspaceId: id,
        }));
        return id;
      },

      deleteWorkspace: (id) =>
        set((state) => ({
          workspaces: state.workspaces.filter((w) => w.id !== id),
          sessions: state.sessions.filter((s) => s.workspaceId !== id),
          currentWorkspaceId:
            state.currentWorkspaceId === id ? null : state.currentWorkspaceId,
        })),

      setCurrentWorkspace: (id) => set({ currentWorkspaceId: id }),

      getWorkspaceSessions: (workspaceId) => {
        return get().sessions.filter((s) => s.workspaceId === workspaceId);
      },

      // Sidebar actions
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      setSidebarOpen: (open) => set({ sidebarOpen: open }),
    }),
    {
      name: 'volto-sessions',
      partialize: (state) => ({
        sessions: state.sessions,
        workspaces: state.workspaces,
        currentSessionId: state.currentSessionId,
        currentWorkspaceId: state.currentWorkspaceId,
        sidebarOpen: state.sidebarOpen,
      }),
    },
  ),
);
