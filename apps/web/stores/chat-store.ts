import { create } from 'zustand';
import type {
  ConnectionState,
  TaggedTranscriptDelta,
  TranscriptDelta,
  TranscriptEventInput,
} from '@volto/sdk/sse';
import type { ChatNotice } from '@/lib/projection';
import { mergeEventTail } from '@/lib/event-tail';

/**
 * Per-sub-agent transcript. One bucket per childSessionId; the bucket's
 * `status` is closed by the main feed's `subagent_finished` bracket — either
 * through `markSubagentFinished` when the bracket arrives, or immediately on
 * lazy creation when the bracket already landed (zombie close, spec §10).
 * The card's duration comes from the bracket, so the bucket only stores the
 * finished `durationMs`, never a start time.
 */
export interface SubagentBucket {
  /** Tagged events routed to this child, in arrival order. */
  events: TranscriptEventInput[];
  /** Streaming increments routed to this child, in arrival order. */
  deltas: TranscriptDelta[];
  status: 'running' | 'done' | 'error';
  durationMs?: number;
  /** Whether this child is currently streaming. Independent of the global
   * `isGenerating` flag, which only tracks the main-chat turn. */
  isGenerating?: boolean;
}

/** The `subagent_finished` bracket data the store needs to close a bucket. */
interface SubagentFinishData {
  childSessionId?: unknown;
  isError?: unknown;
  durationMs?: unknown;
}

function isFinishBracketFor(
  event: TranscriptEventInput,
  childId: string,
): boolean {
  return (
    event.type === 'subagent_finished' &&
    (event.data as SubagentFinishData).childSessionId === childId
  );
}

/**
 * Lazily create the child's bucket. If the main buffer already holds this
 * child's `subagent_finished` (straggler tagged frames after the bracket —
 * e.g. after a refresh truncated the SSE ring buffer), the bucket closes
 * immediately instead of running forever with no bracket ever coming.
 */
function ensureBucket(
  subagents: Record<string, SubagentBucket>,
  childId: string,
  mainEvents: TranscriptEventInput[],
): Record<string, SubagentBucket> {
  if (subagents[childId]) return subagents;
  const bracket = mainEvents.find((event) => isFinishBracketFor(event, childId));
  let bucket: SubagentBucket = { events: [], deltas: [], status: 'running' };
  if (bracket) {
    const data = bracket.data as SubagentFinishData;
    bucket = {
      events: [],
      deltas: [],
      status: data.isError === true ? 'error' : 'done',
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
    };
  }
  return { ...subagents, [childId]: bucket };
}

interface ChatState {
  /** Durable events for the active session, in arrival order. */
  events: TranscriptEventInput[];
  /** Increments received since the last authoritative event. */
  deltas: TranscriptDelta[];
  isGenerating: boolean;
  currentSessionId: string | null;
  /** Sub-agent transcripts, keyed by opaque childSessionId. */
  subagents: Record<string, SubagentBucket>;
  /** SSE 通道连接状态（Sidebar 状态指示与 ChatPanel 共读）。 */
  connectionState: ConnectionState;
  /**
   * Session-level notice rows (e.g. a model-tier fallback) that trail the
   * composed feed. Session-scoped like the event buffer — dropped whenever
   * the log is cleared or replaced (session switch).
   */
  notices: ChatNotice[];

  /** Appends an authoritative event and clears the streaming tail it supersedes. */
  pushEvent: (event: TranscriptEventInput) => void;
  /** Appends a streaming increment. */
  pushDelta: (delta: TranscriptDelta) => void;
  /** Appends one session-level notice row to the trailing notice feed. */
  pushNotice: (notice: ChatNotice) => void;
  /** Appends a tagged sub-agent event to its child bucket (lazily created). */
  pushSubagentEvent: (childId: string, event: TranscriptEventInput) => void;
  /** Appends a tagged sub-agent increment to its child bucket (lazily created). */
  pushSubagentDelta: (childId: string, delta: TaggedTranscriptDelta) => void;
  /**
   * Closes the child's bucket with the main feed's `subagent_finished`
   * bracket. A missing bucket is created empty — the "sub-agent crashed with
   * zero output" case still gets its card.
   */
  markSubagentFinished: (
    childId: string,
    isError: boolean,
    durationMs?: number,
  ) => void;
  /**
   * Sets the child's streaming flag. Independent of the global
   * `isGenerating` — a sub-agent can stream while the main chat is idle.
   */
  setSubagentGenerating: (childId: string, isGenerating: boolean) => void;
  setConnectionState: (state: ConnectionState) => void;
  /** Drops every bucket — used on session switch. */
  resetSubagents: () => void;
  /** Replaces the whole log — used when loading a session from the server. */
  setEvents: (events: TranscriptEventInput[]) => void;
  /**
   * Prepend a replayed event tail (a turn that was already running when this
   * connection opened) without dropping the deltas/notices the live stream
   * may already have produced. Overlapping events are deduped by
   * `mergeEventTail`, so calling this twice is harmless.
   */
  seedEvents: (events: TranscriptEventInput[]) => void;
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
  subagents: {},
  connectionState: 'disconnected',
  notices: [],

  pushEvent: (event) =>
    set((state) => ({
      events: [...state.events, event],
      // An assistant_message is the authoritative version of whatever was
      // streaming; keeping the deltas would double-render the same text.
      deltas: event.type === 'assistant_message' ? [] : state.deltas,
    })),

  pushDelta: (delta) => set((state) => ({ deltas: [...state.deltas, delta] })),

  pushNotice: (notice) =>
    set((state) => ({ notices: [...state.notices, notice] })),

  pushSubagentEvent: (childId, event) =>
    set((state) => {
      const subagents = ensureBucket(state.subagents, childId, state.events);
      const bucket = subagents[childId]!;
      // Same rule as the main buffer: the authoritative assistant_message
      // supersedes whatever was streaming in the bucket.
      const deltas = event.type === 'assistant_message' ? [] : bucket.deltas;
      return {
        subagents: {
          ...subagents,
          [childId]: { ...bucket, deltas, events: [...bucket.events, event] },
        },
      };
    }),

  pushSubagentDelta: (childId, delta) =>
    set((state) => {
      const subagents = ensureBucket(state.subagents, childId, state.events);
      const bucket = subagents[childId]!;
      return {
        subagents: {
          ...subagents,
          [childId]: { ...bucket, deltas: [...bucket.deltas, delta] },
        },
      };
    }),

  markSubagentFinished: (childId, isError, durationMs) =>
    set((state) => {
      const existing = state.subagents[childId];
      const bucket: SubagentBucket = existing
        ? {
            ...existing,
            status: isError ? 'error' : 'done',
            durationMs: durationMs ?? existing.durationMs,
          }
        : // The bracket landed with no bucket behind it: the child produced
          // nothing before finishing (or crashed). An empty closed bucket
          // keeps the card visible with its "no execution record" empty state.
          { events: [], deltas: [], status: isError ? 'error' : 'done', durationMs };
      return { subagents: { ...state.subagents, [childId]: bucket } };
    }),

  setSubagentGenerating: (childId, isGenerating) =>
    set((state) => {
      const subagents = ensureBucket(state.subagents, childId, state.events);
      const bucket = subagents[childId]!;
      return {
        subagents: { ...subagents, [childId]: { ...bucket, isGenerating } },
      };
    }),

  setConnectionState: (connectionState) => set({ connectionState }),

  resetSubagents: () => set({ subagents: {} }),

  // Notices are session-scoped like the log itself: replacing the log (a
  // session switch) or clearing it starts a fresh feed, so the notices go
  // with it — a tier fallback must never leak into the next session.
  setEvents: (events) => set({ events, deltas: [], notices: [] }),

  seedEvents: (events) =>
    set((state) => ({ events: mergeEventTail(events, state.events) })),

  clear: () => set({ events: [], deltas: [], notices: [] }),

  setGenerating: (isGenerating) => set({ isGenerating }),

  setSessionId: (sessionId) => set({ currentSessionId: sessionId }),

  cancelStreaming: () => set({ isGenerating: false, deltas: [] }),
}));
