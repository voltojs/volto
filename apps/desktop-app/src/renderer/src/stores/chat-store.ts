/**
 * Chat Store
 * 使用 Zustand 管理聊天状态
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
}

/** Chat Store 操作 */
export interface ChatActions {
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
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/** 创建 Chat Store */
export const useChatStore = create<ChatState & ChatActions>((set, get) => ({
  // 初始状态
  currentSessionId: null,
  sessions: new Map(),
  isLoading: false,
  error: null,

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

    return id;
  },

  // 切换会话
  switchSession: (sessionId: string) => {
    const { sessions } = get();
    if (sessions.has(sessionId)) {
      set({ currentSessionId: sessionId });
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
}));
