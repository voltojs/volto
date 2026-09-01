import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface ChatState {
  messages: Message[];
  isGenerating: boolean;
  currentSessionId: string | null;

  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  appendToMessage: (id: string, delta: string) => void;
  clearMessages: () => void;
  setGenerating: (isGenerating: boolean) => void;
  setSessionId: (sessionId: string | null) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isGenerating: false,
  currentSessionId: null,

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...updates } : m,
      ),
    })),

  appendToMessage: (id, delta) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, content: m.content + delta } : m,
      ),
    })),

  clearMessages: () => set({ messages: [] }),

  setGenerating: (isGenerating) => set({ isGenerating }),

  setSessionId: (sessionId) => set({ currentSessionId: sessionId }),
}));
