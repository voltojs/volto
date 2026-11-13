/**
 * Chat store tests.
 *
 * Since the view-projection consolidation the chat store is a pure event
 * buffer: authoritative events and streaming deltas accumulate here, and the
 * projection (lib/projection.ts) derives the rendered feed from them. Message
 * assembly itself no longer exists in the store, so these tests cover
 * accumulation, the delta-clear on the authoritative event, and the
 * generation-state flags.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chat-store.js';
import type { TranscriptDelta, TranscriptEventInput } from '@voltojs/sdk/sse';

function resetStore(): void {
  useChatStore.setState({
    events: [],
    deltas: [],
    isGenerating: false,
    currentSessionId: null,
    subagents: {},
  });
}

const TURN_START: TranscriptEventInput = {
  time: 100,
  type: 'turn_start',
  data: { turn: 1 },
  turn: 1,
};

const ASSISTANT_MESSAGE: TranscriptEventInput = {
  time: 200,
  type: 'assistant_message',
  data: {
    content: [{ type: 'text', text: 'hello' }],
    stopReason: 'end_turn',
    durationMs: 80,
  },
  turn: 1,
  step: 1,
};

const TEXT_DELTA: TranscriptDelta = { kind: 'text', text: 'he' };

describe('useChatStore', () => {
  beforeEach(() => {
    resetStore();
  });

  // -----------------------------------------------------------------------
  // pushEvent
  // -----------------------------------------------------------------------

  describe('pushEvent', () => {
    it('appends an authoritative event to the log', () => {
      useChatStore.getState().pushEvent(TURN_START);

      expect(useChatStore.getState().events).toEqual([TURN_START]);
    });

    it('keeps the streaming deltas when the event is not the authoritative reply', () => {
      useChatStore.getState().pushDelta(TEXT_DELTA);
      useChatStore.getState().pushEvent(TURN_START);

      const { events, deltas } = useChatStore.getState();
      expect(events).toEqual([TURN_START]);
      expect(deltas).toEqual([TEXT_DELTA]);
    });

    it('clears the deltas once the authoritative assistant_message lands', () => {
      useChatStore.getState().pushDelta(TEXT_DELTA);
      useChatStore.getState().pushEvent(TURN_START);
      useChatStore.getState().pushEvent(ASSISTANT_MESSAGE);

      const { events, deltas } = useChatStore.getState();
      expect(events).toEqual([TURN_START, ASSISTANT_MESSAGE]);
      expect(deltas).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // pushDelta
  // -----------------------------------------------------------------------

  describe('pushDelta', () => {
    it('appends a streaming increment', () => {
      useChatStore.getState().pushDelta(TEXT_DELTA);
      useChatStore.getState().pushDelta({ kind: 'text', text: 'llo' });

      expect(useChatStore.getState().deltas).toEqual([
        TEXT_DELTA,
        { kind: 'text', text: 'llo' },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // setEvents
  // -----------------------------------------------------------------------

  describe('setEvents', () => {
    it('replaces the whole log and clears the streaming tail', () => {
      useChatStore.getState().pushDelta(TEXT_DELTA);
      useChatStore.getState().setEvents([TURN_START]);

      const { events, deltas } = useChatStore.getState();
      expect(events).toEqual([TURN_START]);
      expect(deltas).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // clear
  // -----------------------------------------------------------------------

  describe('clear', () => {
    it('empties events and deltas', () => {
      useChatStore.getState().pushEvent(TURN_START);
      useChatStore.getState().pushDelta(TEXT_DELTA);

      useChatStore.getState().clear();

      const { events, deltas } = useChatStore.getState();
      expect(events).toEqual([]);
      expect(deltas).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // setGenerating / setSessionId
  // -----------------------------------------------------------------------

  describe('setGenerating', () => {
    it('toggles isGenerating', () => {
      useChatStore.getState().setGenerating(true);
      expect(useChatStore.getState().isGenerating).toBe(true);

      useChatStore.getState().setGenerating(false);
      expect(useChatStore.getState().isGenerating).toBe(false);
    });
  });

  describe('setSessionId', () => {
    it('sets a session id', () => {
      useChatStore.getState().setSessionId('sess-abc');
      expect(useChatStore.getState().currentSessionId).toBe('sess-abc');
    });

    it('clears session id with null', () => {
      useChatStore.getState().setSessionId('sess-abc');
      useChatStore.getState().setSessionId(null);
      expect(useChatStore.getState().currentSessionId).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // cancelStreaming — tearing down the SSE channel mid-turn (e.g. switching
  // sessions while tokens are still arriving) must not leave isGenerating
  // stuck true forever, which would disable every session's input box since
  // this store is a global singleton. The durable event log is preserved.
  // -----------------------------------------------------------------------

  describe('cancelStreaming', () => {
    it('clears isGenerating and the streaming tail', () => {
      useChatStore.getState().setGenerating(true);
      useChatStore.getState().pushDelta(TEXT_DELTA);

      useChatStore.getState().cancelStreaming();

      const { isGenerating, deltas } = useChatStore.getState();
      expect(isGenerating).toBe(false);
      expect(deltas).toEqual([]);
    });

    it('leaves the durable event log untouched', () => {
      useChatStore.getState().pushEvent(TURN_START);
      useChatStore.getState().setGenerating(true);

      useChatStore.getState().cancelStreaming();

      expect(useChatStore.getState().events).toEqual([TURN_START]);
    });

    it('is idempotent when no turn is in flight', () => {
      expect(() => useChatStore.getState().cancelStreaming()).not.toThrow();
      expect(useChatStore.getState().isGenerating).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // subagent buckets — tagged sub-agent frames are routed here by
  // lib/subagent-routing.ts and must never leak into the main event buffer
  // (that leak is what froze the whole conversation pane, hence the
  // regression gate below).
  // -----------------------------------------------------------------------

  describe('subagents', () => {
    it('regression: tagged sub-agent events never reach the main event buffer', () => {
      const store = useChatStore.getState();
      store.pushEvent({ time: 1, type: 'user_message', data: { content: 'q' } } as never);
      store.pushSubagentEvent('s-sub-0', {
        time: 2,
        type: 'model_call_start',
        data: { agentDepth: 1, childSessionId: 's-sub-0' },
      } as never);
      store.pushSubagentDelta('s-sub-0', {
        kind: 'text',
        text: 'chunk',
        agentDepth: 1,
        childSessionId: 's-sub-0',
      });
      const state = useChatStore.getState();
      expect(state.events).toHaveLength(1); // ← 卡死回归门：主缓冲长度不变
      expect(state.subagents['s-sub-0']!.events).toHaveLength(1);
      expect(state.subagents['s-sub-0']!.deltas).toHaveLength(1);
    });

    it('lazy bucket closes immediately when the finished bracket already landed', () => {
      const store = useChatStore.getState();
      store.pushEvent({
        time: 1,
        type: 'subagent_finished',
        data: { childSessionId: 's-sub-9', isError: false, durationMs: 5 },
      } as never);
      store.pushSubagentEvent('s-sub-9', {
        time: 2,
        type: 'model_call_start',
        data: { agentDepth: 1, childSessionId: 's-sub-9' },
      } as never);
      expect(useChatStore.getState().subagents['s-sub-9']!.status).toBe('done');
    });

    it('lazy bucket closes as error when the landed bracket failed', () => {
      const store = useChatStore.getState();
      store.pushEvent({
        time: 1,
        type: 'subagent_finished',
        data: { childSessionId: 's-sub-8', isError: true, durationMs: 7 },
      } as never);
      store.pushSubagentDelta('s-sub-8', {
        kind: 'text',
        text: 'late',
        agentDepth: 1,
        childSessionId: 's-sub-8',
      });
      const bucket = useChatStore.getState().subagents['s-sub-8']!;
      expect(bucket.status).toBe('error');
      expect(bucket.durationMs).toBe(7);
    });

    it('markSubagentFinished records status and duration; resetSubagents clears everything', () => {
      const store = useChatStore.getState();
      store.pushSubagentEvent('s-a', {
        time: 1,
        type: 'user_message',
        data: { agentDepth: 1, childSessionId: 's-a' },
      } as never);
      store.markSubagentFinished('s-a', false, 123);
      expect(useChatStore.getState().subagents['s-a']).toMatchObject({
        status: 'done',
        durationMs: 123,
      });
      store.resetSubagents();
      const state = useChatStore.getState();
      expect(state.subagents).toEqual({});
    });

    it('markSubagentFinished on a missing bucket creates an empty error bucket', () => {
      useChatStore.getState().markSubagentFinished('s-crash', true, 42);
      const bucket = useChatStore.getState().subagents['s-crash']!;
      expect(bucket.status).toBe('error');
      expect(bucket.durationMs).toBe(42);
      expect(bucket.events).toEqual([]);
      expect(bucket.deltas).toEqual([]);
    });

    it('tagged assistant_message clears the bucket streaming tail', () => {
      const store = useChatStore.getState();
      store.pushSubagentDelta('s-b', {
        kind: 'text',
        text: 'partial',
        agentDepth: 1,
        childSessionId: 's-b',
      });
      store.pushSubagentEvent('s-b', {
        time: 1,
        type: 'assistant_message',
        data: { agentDepth: 1, childSessionId: 's-b', durationMs: 9 },
      } as never);
      const bucket = useChatStore.getState().subagents['s-b']!;
      expect(bucket.events).toHaveLength(1);
      expect(bucket.deltas).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // setSubagentGenerating — per-child streaming flag, independent of the
  // global isGenerating (main-chat turn) flag.
  // -----------------------------------------------------------------------

  describe('setSubagentGenerating', () => {
    it('tracks child generating independently of global isGenerating', () => {
      const store = useChatStore.getState();
      store.pushSubagentEvent('c1', { time: 1, type: 'user_message', data: { content: 'hi' } } as never);
      store.setSubagentGenerating('c1', true);
      expect(useChatStore.getState().subagents.c1?.isGenerating).toBe(true);
      expect(useChatStore.getState().isGenerating).toBe(false);
      store.setSubagentGenerating('c1', false);
      expect(useChatStore.getState().subagents.c1?.isGenerating).toBe(false);
    });
  });
});
