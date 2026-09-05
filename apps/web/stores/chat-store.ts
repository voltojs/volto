import { create } from 'zustand';
import type { TranscriptDelta, TranscriptEventInput } from '@volto/sdk/sse';

interface ChatState {
  /** Durable events for the active session, in arrival order. */
  events: TranscriptEventInput[];
  /** Increments received since the last authoritative event. */
  deltas: TranscriptDelta[];
  isGenerating: boolean;
  currentSessionId: string | null;

  /** Appends an authoritative event and clears the streaming tail it supersedes. */
  pushEvent: (event: TranscriptEventInput) => void;
  /** Appends a streaming increment. */
  pushDelta: (delta: TranscriptDelta) => void;
  /** Replaces the whole log — used when loading a session from the server. */
  setEvents: (events: TranscriptEventInput[]) => void;
  clear: () => void;
  setGenerating: (isGenerating: boolean) => void;
  setSessionId: (sessionId: string | null) => void;
  /**
   * Force-clear generation state when the transport is torn down mid-turn.
   * `destroy()` disconnects silently and emits no terminal frame, so nothing
   * else would ever clear this. Idempotent.
   */
  cancelStreaming: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  events: [],
  deltas: [],
  isGenerating: false,
  currentSessionId: null,

  pushEvent: (event) =>
    set((state) => ({
      events: [...state.events, event],
      // An assistant_message is the authoritative version of whatever was
      // streaming; keeping the deltas would double-render the same text.
      deltas: event.type === 'assistant_message' ? [] : state.deltas,
    })),

  pushDelta: (delta) => set((state) => ({ deltas: [...state.deltas, delta] })),

  setEvents: (events) => set({ events, deltas: [] }),

  clear: () => set({ events: [], deltas: [] }),

  setGenerating: (isGenerating) => set({ isGenerating }),

  setSessionId: (sessionId) => set({ currentSessionId: sessionId }),

  cancelStreaming: () => set({ isGenerating: false, deltas: [] }),
}));
