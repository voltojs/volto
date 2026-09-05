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
import type { TranscriptDelta, TranscriptEventInput } from '@volto/sdk/sse';

function resetStore(): void {
  useChatStore.setState({
    events: [],
    deltas: [],
    isGenerating: false,
    currentSessionId: null,
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
});
