import { describe, it, expect } from 'vitest';
import {
  projectConversation,
  composeChatEntries,
  selectQueuedSeed,
} from '@/lib/projection';
import type { ChatEntry, FeedMessage } from '@/lib/projection';
import type { ConversationMessage, TranscriptEventInput } from '@volto/sdk/sse';

/**
 * Steering queue fold (spec 2026-11-04 §4.6): the web feed keeps queued
 * bubbles at their SEND position with a `queued` badge flag, deliberately
 * differing from core's view-projection (delivery point). Live SSE delivery
 * and replay of the stored log run through this exact same fold.
 */

/** Composes the feed the way the chat hooks do: project, then compose. */
function feed(events: readonly TranscriptEventInput[]): ChatEntry[] {
  const { view, records } = projectConversation(events, []);
  return composeChatEntries(view.messages, records);
}

function messageIds(entries: readonly ChatEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === 'message' ? [e.message.id] : []));
}

function findEntry(
  entries: readonly ChatEntry[],
  id: string,
): { entry: Extract<ChatEntry, { kind: 'message' }>; index: number } | null {
  const index = entries.findIndex(
    (e) => e.kind === 'message' && e.message.id === id,
  );
  return index >= 0
    ? { entry: entries[index] as Extract<ChatEntry, { kind: 'message' }>, index }
    : null;
}

/** Turn 1: a message queued mid-turn while step 1 streams, then a second step. */
const TURN_ONE: TranscriptEventInput[] = [
  { time: 100, type: 'turn_start', data: { turn: 1 }, turn: 1 },
  { time: 110, type: 'user_message', data: { content: 'first' }, turn: 1 },
  {
    time: 120,
    type: 'model_call_start',
    data: { headerHash: 'h1' },
    turn: 1,
    step: 1,
  },
  {
    time: 130,
    type: 'steering_queued',
    data: { id: 's1', content: 'second' },
    turn: 1,
  },
  {
    time: 140,
    type: 'assistant_message',
    data: {
      content: [{ type: 'text', text: 'working on it' }],
      stopReason: 'tool_use',
      durationMs: 50,
    },
    turn: 1,
    step: 1,
  },
  {
    time: 160,
    type: 'model_call_start',
    data: { headerHash: 'h2' },
    turn: 1,
    step: 2,
  },
  {
    time: 180,
    type: 'assistant_message',
    data: {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      durationMs: 40,
    },
    turn: 1,
    step: 2,
  },
  { time: 190, type: 'turn_end', data: { turn: 1, reason: 'done' }, turn: 1 },
];

/** Turn 2 opens with a flush that delivers s1 — a cross-turn delivery. */
const DELIVERED: TranscriptEventInput[] = [
  ...TURN_ONE,
  { time: 200, type: 'turn_start', data: { turn: 2 }, turn: 2 },
  { time: 210, type: 'steering_delivered', data: { ids: ['s1'] }, turn: 2 },
  {
    time: 220,
    type: 'model_call_start',
    data: { headerHash: 'h3' },
    turn: 2,
    step: 1,
  },
  {
    time: 230,
    type: 'assistant_message',
    data: {
      content: [{ type: 'text', text: 'flushed' }],
      stopReason: 'end_turn',
      durationMs: 30,
    },
    turn: 2,
    step: 1,
  },
  { time: 240, type: 'turn_end', data: { turn: 2, reason: 'done' }, turn: 2 },
];

describe('steering queue fold', () => {
  it('a steering_queued event renders a user bubble with a queued badge at send position', () => {
    const entries = feed(TURN_ONE);

    const bubbles = entries.flatMap((e) =>
      e.kind === 'message' && e.message.content === 'second' ? [e] : [],
    );
    expect(bubbles).toHaveLength(1);
    const bubble = bubbles[0]!;
    // The React key derives from the steering id, never a position ordinal.
    expect(bubble.message.id).toBe('s1');
    expect(bubble.message.queued).toBe(true);
    // Send position: everything that had arrived when it was queued renders
    // above it; the later step renders below it.
    expect(messageIds(entries)).toEqual(['1:u0', '1:1', 's1', '1:2']);
  });

  it('steering_edited updates the bubble content in place', () => {
    const before = feed(TURN_ONE);
    const beforeAt = findEntry(before, 's1');
    expect(beforeAt).not.toBeNull();
    expect(beforeAt!.entry.message.queued).toBe(true);

    const edited = feed([
      ...TURN_ONE,
      {
        time: 170,
        type: 'steering_edited',
        data: { id: 's1', content: 'second thoughts' },
        turn: 1,
      },
    ]);

    const afterAt = findEntry(edited, 's1');
    expect(afterAt).not.toBeNull();
    // Same entry, same id, same position — only the content changes.
    expect(afterAt!.index).toBe(beforeAt!.index);
    expect(afterAt!.entry.message.content).toBe('second thoughts');
    expect(afterAt!.entry.message.queued).toBe(true);
    expect(messageIds(edited)).toEqual(['1:u0', '1:1', 's1', '1:2']);
  });

  it('steering_removed drops the bubble entirely', () => {
    const before = feed(TURN_ONE);
    expect(findEntry(before, 's1')).not.toBeNull();

    const after = feed([
      ...TURN_ONE,
      { time: 170, type: 'steering_removed', data: { id: 's1' }, turn: 1 },
    ]);

    expect(findEntry(after, 's1')).toBeNull();
    expect(messageIds(after)).toEqual(['1:u0', '1:1', '1:2']);
  });

  it('steering_delivered clears the badge and keeps the bubble where it was', () => {
    const before = feed(TURN_ONE);
    const beforeAt = findEntry(before, 's1');
    expect(beforeAt).not.toBeNull();
    expect(beforeAt!.entry.message.queued).toBe(true);
    const beforeIndex = beforeAt!.index;

    const after = feed(DELIVERED);
    const afterAt = findEntry(after, 's1');
    expect(afterAt).not.toBeNull();
    // Delivery flips the badge; it must not move the bubble to the delivery
    // point (core's view-projection would splice it into turn 2 here).
    expect(afterAt!.entry.message.queued).toBe(false);
    expect(afterAt!.index).toBe(beforeIndex);
    expect(afterAt!.entry.message.content).toBe('second');
    expect(messageIds(after)).toEqual(['1:u0', '1:1', 's1', '1:2', '2:1']);
  });

  it('keeps multiple queued messages in FIFO send order', () => {
    const entries = feed([
      { time: 100, type: 'turn_start', data: { turn: 1 }, turn: 1 },
      { time: 110, type: 'user_message', data: { content: 'first' }, turn: 1 },
      {
        time: 120,
        type: 'model_call_start',
        data: { headerHash: 'h1' },
        turn: 1,
        step: 1,
      },
      {
        time: 130,
        type: 'steering_queued',
        data: { id: 's1', content: 'one' },
        turn: 1,
      },
      {
        time: 140,
        type: 'steering_queued',
        data: { id: 's2', content: 'two' },
        turn: 1,
      },
      {
        time: 150,
        type: 'assistant_message',
        data: {
          content: [{ type: 'text', text: 'working on it' }],
          stopReason: 'tool_use',
          durationMs: 50,
        },
        turn: 1,
        step: 1,
      },
      {
        time: 180,
        type: 'assistant_message',
        data: {
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          durationMs: 40,
        },
        turn: 1,
        step: 2,
      },
      { time: 190, type: 'turn_end', data: { turn: 1, reason: 'done' }, turn: 1 },
    ]);

    expect(messageIds(entries)).toEqual(['1:u0', '1:1', 's1', 's2', '1:2']);
    const s1 = findEntry(entries, 's1')!;
    const s2 = findEntry(entries, 's2')!;
    expect(s1.entry.message.content).toBe('one');
    expect(s1.entry.message.queued).toBe(true);
    expect(s2.entry.message.content).toBe('two');
    expect(s2.entry.message.queued).toBe(true);
    expect(s1.index).toBeLessThan(s2.index);
  });

  it('replaying stored events produces the same fold as live delivery', () => {
    // Live: frames pushed into the chat store one at a time as they arrive.
    const live: TranscriptEventInput[] = [];
    for (const event of DELIVERED) live.push(structuredClone(event));

    // Replay: the same durable log re-read from GET /sessions/:id/events.
    const replayed = structuredClone(DELIVERED) as TranscriptEventInput[];

    const liveFold = feed(live);
    // An unrelated fold in between proves no fold state leaks across calls.
    feed([
      { time: 1, type: 'turn_start', data: { turn: 9 }, turn: 9 },
      { time: 2, type: 'turn_end', data: { turn: 9, reason: 'done' }, turn: 9 },
    ]);
    const replayFold = feed(replayed);

    expect(replayFold).toEqual(liveFold);

    const bubble = findEntry(liveFold, 's1');
    expect(bubble).not.toBeNull();
    expect(bubble!.entry.message.queued).toBe(false);
    expect(bubble!.entry.message.content).toBe('second');
  });
});

/**
 * Seeding the fold from `GET /sessions/:id`'s `queuedMessages` (Task 4): a
 * cold load has no `steering_queued` event to fold — the SSE channel only
 * carries events from the moment it connects — so the server's pending queue
 * is the entry's only source until live receipts arrive.
 */
describe('steering queue seed', () => {
  it('renders a seeded queued entry at its send position and realizes it on delivery', () => {
    const events = [
      { time: 100, type: 'turn_start', data: { turn: 1 }, turn: 1 },
      { time: 110, type: 'user_message', data: { content: 'first' }, turn: 1 },
      { time: 200, type: 'steering_delivered', data: { ids: ['q1'] }, turn: 1 },
      { time: 300, type: 'turn_start', data: { turn: 2 }, turn: 2 },
    ] as TranscriptEventInput[];
    const seed = [{ id: 'q1', content: 'seeded', time: 130 }];
    const { view } = projectConversation(events, [], undefined, (k) => k, seed);
    const ids = view.messages.map((m) => m.id);
    expect(ids.filter((id) => id === 'q1')).toHaveLength(1);
    // Send position: after the message that had arrived when it was queued.
    expect(ids[0]).not.toBe('q1');
    const entry = view.messages.find((m) => m.id === 'q1')!;
    expect(entry.content).toBe('seeded');
    // The live `steering_delivered` receipt flipped the seeded badge without
    // moving the entry.
    expect((entry as FeedMessage).queued).toBe(false);
  });

  it('does not duplicate a seeded entry when its steering_queued event also arrives', () => {
    const events = [
      { time: 100, type: 'turn_start', data: { turn: 1 }, turn: 1 },
      { time: 110, type: 'user_message', data: { content: 'first' }, turn: 1 },
      {
        time: 130,
        type: 'steering_queued',
        data: { id: 'q1', content: 'seeded' },
        turn: 1,
      },
    ] as TranscriptEventInput[];
    const { view } = projectConversation(events, [], undefined, (k) => k, [
      { id: 'q1', content: 'seeded', time: 130 },
    ]);
    const ids = view.messages.map((m) => m.id);
    expect(ids.filter((id) => id === 'q1')).toHaveLength(1);
    expect(ids).toEqual(['1:u0', 'q1']);
  });

  it('applies edit and removal receipts to a seeded entry', () => {
    const events = [
      { time: 100, type: 'turn_start', data: { turn: 1 }, turn: 1 },
      { time: 110, type: 'user_message', data: { content: 'first' }, turn: 1 },
      {
        time: 150,
        type: 'steering_edited',
        data: { id: 'q1', content: 'rewritten' },
        turn: 1,
      },
      { time: 160, type: 'steering_removed', data: { id: 'q2' }, turn: 1 },
      { time: 170, type: 'turn_end', data: { turn: 1, reason: 'done' }, turn: 1 },
    ] as TranscriptEventInput[];
    const seed = [
      { id: 'q1', content: 'seeded', time: 120 },
      { id: 'q2', content: 'doomed', time: 130 },
    ];
    const { view } = projectConversation(events, [], undefined, (k) => k, seed);
    const ids = view.messages.map((m) => m.id);
    expect(ids.filter((id) => id === 'q1')).toHaveLength(1);
    const entry = view.messages.find((m) => m.id === 'q1')!;
    // The edit receipt rewrote the seeded content in place.
    expect(entry.content).toBe('rewritten');
    expect((entry as FeedMessage).queued).toBe(true);
    // The removal receipt dropped the other seeded entry entirely.
    expect(ids).not.toContain('q2');
  });
});

describe('selectQueuedSeed', () => {
  it('drops seeds already present in the stored feed', () => {
    expect(
      selectQueuedSeed(
        [{ id: 'q1', content: 'x', time: 1 }],
        [{ id: 'q1' } as ConversationMessage],
      ),
    ).toEqual([]);
  });

  it('keeps seeds the stored feed does not hold', () => {
    const seed = [{ id: 'q1', content: 'x', time: 1 }];
    const stored = [{ id: 'm1' } as ConversationMessage];
    expect(selectQueuedSeed(seed, stored)).toEqual(seed);
  });
});
