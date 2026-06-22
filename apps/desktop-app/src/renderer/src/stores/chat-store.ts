/**
 * Chat Store
 * 使用 Zustand 管理聊天状态，并通过 IPC 持久化到主进程 electron-store。
 *
 * 持久化策略：
 * - 启动调用 `hydrateFromStore()` 一次性从主进程拉回会话与消息
 * - 任何 mutation 完成后异步将受影响的会话写回主进程
 * - 仅持久化 `Session`（含 messages）和 `currentSessionId`；瞬态字段
 *   `isStreaming` / `isLoading` / `error` 不入盘
 */

import { create } from "zustand";

/** 消息角色 */
export type MessageRole = "user" | "assistant" | "system";

/** 工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  duration?: number;
}

/** 消息 */
export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
}

/** 会话 */
export interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

/** 持久化端的会话元数据（与 store/schema.ts 同步） */
interface PersistedSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** Chat Store 状态 */
export interface ChatState {
  /** 当前会话 ID */
  currentSessionId: string | null;
  /** 所有会话 */
  sessions: Map<string, Session>;
  /** 是否正在加载 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 是否已完成首次 hydration */
  hydrated: boolean;
}

/** Chat Store 操作 */
export interface ChatActions {
  /** 从持久层加载（启动时调用一次） */
  hydrateFromStore: () => Promise<void>;
  /** 创建新会话 */
  createSession: () => string;
  /** 切换会话 */
  switchSession: (sessionId: string) => void;
  /** 删除会话 */
  deleteSession: (sessionId: string) => void;
  /** 重命名会话 */
  renameSession: (sessionId: string, title: string) => void;
  /** 添加消息 */
  addMessage: (sessionId: string, message: Message) => void;
  /** 更新消息 */
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void;
  /** 删除消息 */
  deleteMessage: (sessionId: string, messageId: string) => void;
  /** 清空会话消息 */
  clearSession: (sessionId: string) => void;
  /** 设置加载状态 */
  setLoading: (loading: boolean) => void;
  /** 设置错误 */
  setError: (error: string | null) => void;
  /** 获取当前会话 */
  getCurrentSession: () => Session | null;
  /** 获取当前会话消息 */
  getCurrentMessages: () => Message[];
}

/** 生成唯一 ID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** 将瞬态字段剥掉，得到可持久化的消息 */
function toPersistedMessage(msg: Message): Omit<Message, "isStreaming"> {
  const { isStreaming: _drop, ...rest } = msg;
  void _drop;
  return rest;
}

/** 渲染端通过 preload 访问 electron-store 的薄包装 */
function getStoreApi() {
  if (typeof window === "undefined" || !window.electronAPI?.store) return null;
  return window.electronAPI.store;
}

/** 异步持久化整个 Map（防呆，写失败时只记日志不抛） */
async function persistAll(sessions: Map<string, Session>, currentSessionId: string | null): Promise<void> {
  const store = getStoreApi();
  if (!store) return;
  try {
    const metas: PersistedSessionMeta[] = [];
    const messagesMap: Record<string, ReturnType<typeof toPersistedMessage>[]> = {};
    for (const [id, session] of sessions) {
      metas.push({
        id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
      });
      messagesMap[id] = session.messages.map(toPersistedMessage);
    }
    await store.set("sessions", metas);
    await store.set("sessionMessages", messagesMap);
    await store.set("lastActiveSessionId", currentSessionId);
  } catch (err) {
    console.error("[chat-store] persist failed:", err);
  }
}

/** 创建 Chat Store */
export const useChatStore = create<ChatState & ChatActions>((set, get) => {
  /** mutation 完成后 schedule 一次持久化 */
  const schedulePersist = (): void => {
    if (!get().hydrated) return; // hydration 之前不要回写覆盖
    const { sessions, currentSessionId } = get();
    void persistAll(sessions, currentSessionId);
  };

  return {
    // 初始状态
    currentSessionId: null,
    sessions: new Map(),
    isLoading: false,
    error: null,
    hydrated: false,

    /** 从主进程 electron-store 加载会话 */
    hydrateFromStore: async () => {
      const store = getStoreApi();
      if (!store) {
        set({ hydrated: true });
        return;
      }
      try {
        const metas = await store.get<PersistedSessionMeta[]>("sessions");
        const messagesMap = await store.get<Record<string, Message[]>>("sessionMessages");
        const lastId = await store.get<string | null>("lastActiveSessionId");
        const newSessions = new Map<string, Session>();
        for (const meta of metas ?? []) {
          const messages = messagesMap?.[meta.id] ?? [];
          newSessions.set(meta.id, {
            id: meta.id,
            title: meta.title,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            messages,
          });
        }
        const resolvedCurrent = lastId && newSessions.has(lastId) ? lastId : null;
        set({
          sessions: newSessions,
          currentSessionId: resolvedCurrent,
          hydrated: true,
        });
      } catch (err) {
        console.error("[chat-store] hydrate failed:", err);
        set({ hydrated: true, error: err instanceof Error ? err.message : String(err) });
      }
    },

    // 创建新会话
    createSession: () => {
      const id = generateId();
      const session: Session = {
        id,
        title: `会话 ${get().sessions.size + 1}`,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      set((state) => {
        const newSessions = new Map(state.sessions);
        newSessions.set(id, session);
        return {
          sessions: newSessions,
          currentSessionId: id,
        };
      });
      schedulePersist();
      return id;
    },

    // 切换会话
    switchSession: (sessionId: string) => {
      const { sessions } = get();
      if (sessions.has(sessionId)) {
        set({ currentSessionId: sessionId });
        schedulePersist();
      }
    },

    // 删除会话
    deleteSession: (sessionId: string) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        newSessions.delete(sessionId);

        // 如果删除的是当前会话，切换到第一个会话
        let newCurrentSessionId = state.currentSessionId;
        if (state.currentSessionId === sessionId) {
          const firstSession = newSessions.keys().next().value;
          newCurrentSessionId = firstSession ?? null;
        }

        return {
          sessions: newSessions,
          currentSessionId: newCurrentSessionId,
        };
      });
      schedulePersist();
    },

    // 重命名会话
    renameSession: (sessionId: string, title: string) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(sessionId);
        if (session) {
          newSessions.set(sessionId, { ...session, title, updatedAt: Date.now() });
        }
        return { sessions: newSessions };
      });
      schedulePersist();
    },

    // 添加消息
    addMessage: (sessionId: string, message: Message) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(sessionId);
        if (session) {
          newSessions.set(sessionId, {
            ...session,
            messages: [...session.messages, message],
            updatedAt: Date.now(),
          });
        }
        return { sessions: newSessions };
      });
      schedulePersist();
    },

    // 更新消息
    updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(sessionId);
        if (session) {
          const updatedMessages = session.messages.map((msg) =>
            msg.id === messageId ? { ...msg, ...updates } : msg,
          );
          newSessions.set(sessionId, {
            ...session,
            messages: updatedMessages,
            updatedAt: Date.now(),
          });
        }
        return { sessions: newSessions };
      });
      schedulePersist();
    },

    // 删除消息
    deleteMessage: (sessionId: string, messageId: string) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(sessionId);
        if (session) {
          const filteredMessages = session.messages.filter((msg) => msg.id !== messageId);
          newSessions.set(sessionId, {
            ...session,
            messages: filteredMessages,
            updatedAt: Date.now(),
          });
        }
        return { sessions: newSessions };
      });
      schedulePersist();
    },

    // 清空会话消息
    clearSession: (sessionId: string) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(sessionId);
        if (session) {
          newSessions.set(sessionId, {
            ...session,
            messages: [],
            updatedAt: Date.now(),
          });
        }
        return { sessions: newSessions };
      });
      schedulePersist();
    },

    // 设置加载状态
    setLoading: (loading: boolean) => {
      set({ isLoading: loading });
    },

    // 设置错误
    setError: (error: string | null) => {
      set({ error });
    },

    // 获取当前会话
    getCurrentSession: () => {
      const { currentSessionId, sessions } = get();
      if (!currentSessionId) return null;
      return sessions.get(currentSessionId) ?? null;
    },

    // 获取当前会话消息
    getCurrentMessages: () => {
      const session = get().getCurrentSession();
      return session?.messages ?? [];
    },
  };
});
