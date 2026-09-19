import { create } from 'zustand';
import type { ConversationMessage, ContextUsageSnapshot, TodoItem } from '@volto/sdk/sse';
import type { Model } from '@/lib/config-api';
import { useConfigStore } from './config-store';
import { rememberEffort, rememberedEffort } from '@/lib/reasoning-preferences';

/** The reasoning capability of the model a session is switching to, as reported by `configStore.getModelReasoning`. */
type ReasoningCapability = Model['reasoning'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionMode = 'read-only' | 'plan' | 'ask' | 'auto' | 'full';

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
   * extra round trip to the detail endpoint. `updateSessionMessages` does
   * NOT keep this field in sync with `messages.length` — it only bumps
   * `updatedAt` — so after the first turn on an active session this value is
   * stale (frozen at whatever `applySessionDetail`/`createSession` last set
   * it to). A future consumer must re-derive it from `messages.length` for a
   * session that's currently loaded, rather than reading this field as-is.
   */
  messageCount: number;
  /** false = summary only; the detail endpoint has not been fetched yet. */
  detailLoaded: boolean;
  /**
   * Message describing why the last detail fetch for this session failed, or
   * null/undefined when there is none. Cleared by a successful fetch.
   */
  detailError?: string | null;
  /**
   * 'legacy' = the transcript was written by an older build and a retry can
   * never succeed (mirrors the trajectory panel's `TrajectoryUnavailableError`
   * handling); 'network' = a transient failure a retry might clear.
   * null/undefined alongside a null `detailError` means no error.
   */
  detailErrorKind?: 'legacy' | 'network' | null;
  createdAt: number;
  updatedAt: number;
  /** Project this session runs against. Fixed at creation time. */
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  permissionMode: PermissionMode;
  /**
   * Opaque id of the selected reasoning-effort tier, or undefined when none
   * is selected. Never hardcode or interpret this id — display strings come
   * from the server's declared efforts list.
   */
  reasoningEffort?: string;
  /**
   * Numbers-only context-usage snapshot seeded from `GET /sessions/:id`. Held
   * in memory for this browsing session only — the server recomputes it from
   * the durable transcript on every load.
   */
  contextUsage?: ContextUsageSnapshot | null;
  /**
   * Standing todos seeded from `GET /sessions/:id`. Live SSE `todoListUpdated`
   * frames override this when the chat event buffer has any.
   */
  todos?: TodoItem[] | null;
}

/** Detail payload used to fill in a session fetched via `GET /sessions/:id`. */
export interface SessionDetail {
  messages: ConversationMessage[];
  contextUsage: ContextUsageSnapshot | null;
  todos?: TodoItem[] | null;
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  permissionMode: PermissionMode;
  reasoningEffort?: string;
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
   * Defaults to `'ask'` when omitted. Callers that let the user choose a
   * permission tier before the session exists (the welcome screen's picker)
   * can pass it through directly — nothing downstream forces a session to
   * start restrictive; that used to be a hardcoded rule here, deliberately
   * lifted so the pre-creation picker's choice actually takes effect from
   * the first turn instead of being silently overridden.
   */
  permissionMode?: PermissionMode;
  /**
   * Same "let the pre-creation picker's choice take effect immediately"
   * treatment as `permissionMode` above: the welcome screen's
   * `ReasoningPicker` operates on local state before a session exists, so
   * it has to be threaded through here rather than starting every session
   * at `undefined` and forcing the user to reselect it turn one.
   */
  reasoningEffort?: string;
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
  /**
   * The permission preset the session was on when `/plan` switched it to
   * `'plan'` (see ChatPanel's enter-plan action). Store-level rather than
   * per-session on purpose: plan mode is entered and exited within one
   * browsing session's active view, and the consumer (the plan pane's
   * execute path) restores exactly the mode that was current at entry.
   * `null` = no client-initiated plan switch is in flight. Not persisted —
   * a reload drops the memory of the entry mode, and the picker shows the
   * session's actual (plan) mode until the user changes it.
   */
  planPreviousMode: PermissionMode | null;

  createSession: (options?: CreateSessionOptions) => string;
  /** Replaces the whole list with the server's summaries (newest first). */
  setSessions: (sessions: Session[]) => void;
  /** Fills one session's detail and marks it loaded. No-op for an unknown id. */
  applySessionDetail: (id: string, detail: SessionDetail) => void;
  /** Records (or clears, with `null`) a retryable detail-fetch error for one session. */
  setSessionDetailError: (
    id: string,
    message: string | null,
    kind?: 'legacy' | 'network' | null,
  ) => void;
  setPendingProjectId: (id: string | null) => void;
  /** Records (or clears, with `null`) the mode to restore when plan mode exits. */
  setPlanPreviousMode: (mode: PermissionMode | null) => void;
  deleteSession: (id: string) => void;
  updateSessionTitle: (id: string, title: string) => void;
  setCurrentSession: (id: string | null) => void;
  getSessionMessages: (id: string) => ConversationMessage[];
  updateSessionMessages: (id: string, messages: ConversationMessage[]) => void;

  /**
   * Resolves the new model's declared reasoning capability itself (via
   * `configStore.getModelReasoning`) rather than taking it as a parameter —
   * an optional capability argument is a footgun every caller must remember
   * to pass, and omitting it is indistinguishable from "this model has no
   * reasoning capability", which would silently discard a still-valid
   * selection. The resolved capability drives the reset rule for the
   * currently selected effort: kept if still valid, reset to the new
   * model's default if not, cleared otherwise. Never mapped to a "closest"
   * tier.
   */
  setSessionModel: (id: string, providerId: string, modelId: string) => void;
  setSessionReasoningEffort: (id: string, effort: string | undefined) => void;
  setSessionPermissionMode: (id: string, mode: PermissionMode) => void;
  getProjectSessions: (projectId: string) => Session[];

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
}

const generateId = () => Math.random().toString(36).substring(2, 11);

/**
 * The model-change reset rule for a session's reasoning-effort selection:
 * - still declared by the new model → keep it;
 * - not declared, but the user has chosen an effort for the new model
 *   before → use that;
 * - neither, but the new model has a default → use that;
 * - not declared and no default (or the new model has no reasoning
 *   capability at all) → clear it.
 *
 * Deliberately never maps to a "closest" tier — a silent substitution would
 * make the visible selection disagree with the request that actually goes
 * out.
 */
function resetReasoningEffort(
  current: string | undefined,
  reasoning: ReasoningCapability,
  remembered: string | undefined,
): string | undefined {
  if (!reasoning) return undefined;
  if (current !== undefined && reasoning.efforts.some((e) => e.id === current)) {
    return current;
  }
  // Already validated against this model's declared efforts by
  // `rememberedEffort`, so it cannot reintroduce a stale tier here.
  return remembered ?? reasoning.defaultEffort;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  currentSessionId: null,
  sidebarOpen: true,
  pendingProjectId: null,
  planPreviousMode: null,

  setPendingProjectId: (id) => set({ pendingProjectId: id }),

  setPlanPreviousMode: (mode) => set({ planPreviousMode: mode }),

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
      // 'ask' is the default when the caller doesn't specify one — not
      // a floor. A caller that lets the user pick a tier up front (the
      // welcome screen) passes it straight through.
      permissionMode: options.permissionMode ?? 'ask',
      reasoningEffort: options.reasoningEffort,
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
              detailErrorKind: null,
            }
          : s,
      ),
    })),

  setSessionDetailError: (id, message, kind = null) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, detailError: message, detailErrorKind: kind } : s,
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

  setSessionModel: (id, providerId, modelId) => {
    const reasoning = useConfigStore
      .getState()
      .getModelReasoning(providerId, modelId);
    const remembered = rememberedEffort(
      providerId,
      modelId,
      reasoning?.efforts ?? [],
    );
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id
          ? {
              ...s,
              providerId,
              modelId,
              reasoningEffort: resetReasoningEffort(
                s.reasoningEffort,
                reasoning ?? undefined,
                remembered,
              ),
              updatedAt: Date.now(),
            }
          : s,
      ),
    }));
  },

  setSessionReasoningEffort: (id, effort) => {
    // An explicit choice is remembered for this model, so the next session
    // on it starts where the user left off instead of at the default.
    const session = get().sessions.find((s) => s.id === id);
    if (session) {
      rememberEffort(session.providerId, session.modelId, effort);
    }
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id
          ? { ...s, reasoningEffort: effort, updatedAt: Date.now() }
          : s,
      ),
    }));
  },

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
