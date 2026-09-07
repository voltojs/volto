import { create } from 'zustand';
import type { ConversationMessage, ContextUsageFold } from '@volto/sdk/sse';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionMode = 'plan' | 'auto-accept';

export interface Session {
  id: string;
  title: string;
  /**
   * The session's conversation history. Empty while `detailLoaded` is false —
   * that means "not fetched yet", not "no messages".
   */
  messages: ConversationMessage[];
  /**
   * Message count carried by the server's list-endpoint summary. Nothing in
   * the UI renders it today; kept so a future sidebar count doesn't need an
   * extra round trip to the detail endpoint.
   */
  messageCount: number;
  /** false = summary only; the detail endpoint has not been fetched yet. */
  detailLoaded: boolean;
  /**
   * Message describing why the last detail fetch for this session failed, or
   * null/undefined when there is none. Cleared by a successful fetch.
   */
  detailError?: string | null;
  createdAt: number;
  updatedAt: number;
  /** Project this session runs against. Fixed at creation time. */
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  permissionMode: PermissionMode;
  /**
   * Context-usage fold seeded from `GET /sessions/:id`. Held in memory for
   * this browsing session only — the server recomputes it from the durable
   * transcript on every load.
   */
  contextUsage?: ContextUsageFold | null;
}

/** Detail payload used to fill in a session fetched via `GET /sessions/:id`. */
export interface SessionDetail {
  messages: ConversationMessage[];
  contextUsage: ContextUsageFold | null;
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
  /**
   * Defaults to `'plan'` when omitted. Callers that let the user choose a
   * permission tier before the session exists (the welcome screen's picker)
   * can pass it through directly — nothing downstream forces a session to
   * start restrictive; that used to be a hardcoded rule here, deliberately
   * lifted so the pre-creation picker's choice actually takes effect from
   * the first turn instead of being silently overridden.
   */
  permissionMode?: PermissionMode;
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
  /** Replaces the whole list with the server's summaries (newest first). */
  setSessions: (sessions: Session[]) => void;
  /** Fills one session's detail and marks it loaded. No-op for an unknown id. */
  applySessionDetail: (id: string, detail: SessionDetail) => void;
  /** Records (or clears, with `null`) a retryable detail-fetch error for one session. */
  setSessionDetailError: (id: string, message: string | null) => void;
  setPendingProjectId: (id: string | null) => void;
  deleteSession: (id: string) => void;
  updateSessionTitle: (id: string, title: string) => void;
  setCurrentSession: (id: string | null) => void;
  getSessionMessages: (id: string) => ConversationMessage[];
  updateSessionMessages: (id: string, messages: ConversationMessage[]) => void;

  setSessionModel: (id: string, providerId: string, modelId: string) => void;
  setSessionPermissionMode: (id: string, mode: PermissionMode) => void;
  getProjectSessions: (projectId: string) => Session[];

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
}

const generateId = () => Math.random().toString(36).substring(2, 11);

export const useSessionStore = create<SessionState>()((set, get) => ({
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
      // Title is derived from the first message and written back to the
      // server later; the sidebar shows a placeholder until then.
      title: options.title ?? '',
      messages: [],
      messageCount: 0,
      // A brand-new session exists only in memory until its first message
      // is persisted; there is nothing to lazy-load.
      detailLoaded: true,
      createdAt: now,
      updatedAt: now,
      projectId: options.projectId ?? null,
      providerId: options.providerId ?? null,
      modelId: options.modelId ?? null,
      // 'plan' is the default when the caller doesn't specify one — not
      // a floor. A caller that lets the user pick a tier up front (the
      // welcome screen) passes it straight through.
      permissionMode: options.permissionMode ?? 'plan',
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }));
    return id;
  },

  setSessions: (sessions) =>
    set((state) => {
      const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
      // A session the incoming list doesn't contain (deleted, or dropped by
      // the caller's own filtering) can't stay "current" — leaving the id
      // dangling would point the rest of the UI at a session that no longer
      // exists in `sessions`.
      const currentStillPresent =
        state.currentSessionId === null ||
        sorted.some((s) => s.id === state.currentSessionId);
      return {
        sessions: sorted,
        currentSessionId: currentStillPresent ? state.currentSessionId : null,
      };
    }),

  applySessionDetail: (id, detail) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id
          ? {
              ...s,
              ...detail,
              messageCount: detail.messages.length,
              detailLoaded: true,
              detailError: null,
            }
          : s,
      ),
    })),

  setSessionDetailError: (id, message) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, detailError: message } : s,
      ),
    })),

  deleteSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      return {
        sessions,
        // Land on the first remaining session in list order (not
        // necessarily the most-recently-updated one — `updateSessionTitle`,
        // `updateSessionMessages`, `setSessionModel`, and
        // `setSessionPermissionMode` all bump `updatedAt` in place without
        // resorting, so this array isn't guaranteed to stay sorted) rather
        // than the welcome screen: with the list coming from the server, an
        // empty selection after a delete reads as data loss.
        currentSessionId:
          state.currentSessionId === id
            ? (sessions[0]?.id ?? null)
            : state.currentSessionId,
      };
    }),

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
}));
