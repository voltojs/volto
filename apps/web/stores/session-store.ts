import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ConversationMessage, ContextUsageFold } from '@volto/sdk/sse';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionMode = 'plan' | 'auto-accept';

export interface Session {
  id: string;
  title: string;
  /**
   * The session's conversation history as projected messages — recovered
   * from `GET /sessions/:id` (already projected server-side) or snapshotted
   * from the client's live projection while the session was active.
   */
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
  /** Project this session runs against. Fixed at creation time. */
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  permissionMode: PermissionMode;
  /**
   * The context-usage fold state as of this session's last snapshot —
   * seeded from `GET /sessions/:id` on recovery, rewritten whenever the
   * session's feed snapshot is flushed. Serializable; may be null/undefined
   * (no context projected yet, e.g. legacy sessions).
   */
  contextUsage?: ContextUsageFold | null;
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
  /**
   * Adds a session recovered from the server's durable transcript — never
   * overwrites a session already known locally, since local state may be
   * more current (e.g. a message sent while offline from the server's view).
   * Used to recover history after localStorage was cleared or this is a
   * fresh browser profile, while the headless-server process kept running.
   */
  hydrateFromServer: (session: Session) => void;
  setPendingProjectId: (id: string | null) => void;
  deleteSession: (id: string) => void;
  updateSessionTitle: (id: string, title: string) => void;
  setCurrentSession: (id: string | null) => void;
  getSessionMessages: (id: string) => ConversationMessage[];
  updateSessionMessages: (id: string, messages: ConversationMessage[]) => void;
  updateSessionContextUsage: (id: string, fold: ContextUsageFold | null) => void;

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
 * the removed `workspaceId`, no guarantee that the project/model/permission
 * fields introduced by project-binding are present at all, and (before the
 * view-projection consolidation) messages stored in the old client-side
 * `Message` shape rather than the projected `ConversationMessage` shape.
 */
type LegacySession = Partial<Session> & {
  workspaceId?: string;
  messages?: unknown[];
};

interface PersistedSessionState {
  sessions: Session[];
  currentSessionId: string | null;
  sidebarOpen: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalises one persisted message of any prior shape into the projected
 * `ConversationMessage` shape the renderer consumes. Old persisted messages
 * carried a `blocks` array of `{text, tool_call}` items whose tool result was
 * an opaque metadata object; the protocol now carries the tool's real string
 * output, so a surviving metadata object is dropped (its durationMs, if any,
 * is promoted to the call's top-level field).
 */
function normaliseMessage(raw: unknown): ConversationMessage | null {
  if (!isRecord(raw)) return null;
  const content = typeof raw.content === 'string' ? raw.content : '';
  const timestamp =
    typeof raw.timestamp === 'number' ? raw.timestamp : Date.now();
  const id =
    typeof raw.id === 'string' && raw.id !== ''
      ? raw.id
      : `legacy-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const role = raw.role === 'user' ? 'user' : 'assistant';
  const isStreaming = raw.isStreaming === true;

  const blocks = Array.isArray(raw.blocks)
    ? raw.blocks
        .map((block) => normaliseBlock(block))
        .filter(
          (block): block is ConversationMessage['blocks'][number] =>
            block !== null,
        )
    : [];

  return {
    id,
    role,
    content,
    timestamp,
    blocks,
    ...(isStreaming ? { isStreaming } : {}),
  };
}

function normaliseBlock(
  raw: unknown,
): ConversationMessage['blocks'][number] | null {
  if (!isRecord(raw)) return null;
  if (raw.type === 'text' && typeof raw.text === 'string') {
    return { type: 'text', text: raw.text };
  }
  if (raw.type === 'reasoning' && typeof raw.text === 'string') {
    return { type: 'reasoning', text: raw.text };
  }
  if (raw.type !== 'tool_call' || !isRecord(raw.call)) return null;
  const call = raw.call;
  const args = isRecord(call.args) ? call.args : {};
  const resultRaw = isRecord(call.result)
    ? // Legacy metadata envelope `{toolName, durationMs}` — not the tool's
      // output. Only its duration is still meaningful; promote it.
      typeof call.result.durationMs === 'number'
      ? { durationMs: call.result.durationMs }
      : {}
    : typeof call.result === 'string'
      ? { result: call.result }
      : {};
  return {
    type: 'tool_call',
    call: {
      id:
        typeof call.id === 'string'
          ? call.id
          : `legacy-call-${Math.random().toString(36).slice(2, 8)}`,
      name: typeof call.name === 'string' ? call.name : 'tool',
      args,
      ...(call.isError === true ? { isError: true } : {}),
      ...resultRaw,
    },
  };
}

/**
 * Normalises a persisted session (from any prior schema version) into the
 * current `Session` shape: drops the removed `workspaceId`, defaults the
 * fields introduced by project-binding so they read as `null`/`'plan'`
 * rather than `undefined` — an `undefined` projectId would match no project
 * in the sidebar, and an `undefined` permissionMode would leak into the
 * gateway request the permission picker sends later. Messages in the legacy
 * client `Message` shape are converted to projected `ConversationMessage`s.
 */
function migrateSession(raw: LegacySession): Session {
  const messages = Array.isArray(raw.messages)
    ? raw.messages
        .map(normaliseMessage)
        .filter((m): m is ConversationMessage => m !== null)
    : [];
  return {
    id: raw.id ?? generateId(),
    title: raw.title ?? '',
    messages,
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
          title:
            options.title ||
            `会话 ${new Date(now).toLocaleDateString('zh-CN')}`,
          messages: [],
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

      hydrateFromServer: (session) =>
        set((state) =>
          state.sessions.some((s) => s.id === session.id)
            ? state
            : { sessions: [session, ...state.sessions] },
        ),

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

      updateSessionContextUsage: (id, fold) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, contextUsage: fold, updatedAt: Date.now() } : s,
          ),
        })),

      setSessionModel: (id, providerId, modelId) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id
              ? { ...s, providerId, modelId, updatedAt: Date.now() }
              : s,
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

      toggleSidebar: () =>
        set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      setSidebarOpen: (open) => set({ sidebarOpen: open }),
    }),
    {
      name: 'volto-sessions',
      version: 2,
      migrate,
      partialize: (state) => ({
        sessions: state.sessions,
        currentSessionId: state.currentSessionId,
        sidebarOpen: state.sidebarOpen,
      }),
    },
  ),
);
