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

export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall };

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** Full text, all segments concatenated — kept for copy-to-clipboard. */
  content: string;
  timestamp: number;
  /**
   * Ordered text/tool_call sequence, so a tool call renders at the point in
   * the reply where it actually happened instead of after all the text.
   */
  blocks?: MessageBlock[];
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
  /**
   * Sets the trailing text block to `text` — the segment currently
   * streaming. Appends a new text block if the last one isn't text (e.g.
   * right after a tool_call block) rather than overwriting it.
   */
  setLastTextBlock: (id: string, text: string) => void;
  /** Appends a tool_call block, closing off whatever text block preceded it. */
  pushToolCallBlock: (id: string, call: ToolCall) => void;
  /** Merges `updates` into the tool_call block whose call id matches. */
  updateToolCallBlock: (
    id: string,
    callId: string,
    updates: Partial<ToolCall>,
  ) => void;
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

  setLastTextBlock: (id, text) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== id) return m;
        const blocks = m.blocks ?? [];
        const last = blocks[blocks.length - 1];
        if (last?.type === 'text') {
          return { ...m, blocks: [...blocks.slice(0, -1), { type: 'text', text }] };
        }
        if (text === '') return m;
        return { ...m, blocks: [...blocks, { type: 'text', text }] };
      }),
    })),

  pushToolCallBlock: (id, call) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id
          ? { ...m, blocks: [...(m.blocks ?? []), { type: 'tool_call', call }] }
          : m,
      ),
    })),

  updateToolCallBlock: (id, callId, updates) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== id || !m.blocks) return m;
        return {
          ...m,
          blocks: m.blocks.map((b) =>
            b.type === 'tool_call' && b.call.id === callId
              ? { ...b, call: { ...b.call, ...updates } }
              : b,
          ),
        };
      }),
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
