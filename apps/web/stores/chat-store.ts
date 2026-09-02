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
  /**
   * Force-clear generation state: stops the "generating" flag and marks any
   * still-streaming message as no longer streaming, without requiring the
   * caller to know which message id was in flight. Used when the transport
   * is torn down mid-turn (e.g. switching sessions while tokens are still
   * arriving) — the SSE client's `destroy()` disconnects silently and never
   * emits a DONE/ERROR event, so nothing else would ever clear this state.
   * Idempotent: a no-op when no turn is in flight.
   */
  cancelStreaming: () => void;
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

  cancelStreaming: () =>
    set((state) => ({
      isGenerating: false,
      messages: state.messages.map((m) =>
        m.isStreaming ? { ...m, isStreaming: false } : m,
      ),
    })),
}));
