import { describe, it, expect } from 'vitest';
import {
  projectConversation,
  composeChatEntries,
  mergeStoredAndLive,
} from '@/lib/projection';
import type {
  ConversationMessage,
  TranscriptDelta,
  TranscriptEventInput,
} from '@volto/sdk/sse';

const EVENTS: TranscriptEventInput[] = [
  { time: 100, type: 'turn_start', data: { turn: 1 }, turn: 1 },
  { time: 110, type: 'user_message', data: { content: 'hi' }, turn: 1 },
  {
    time: 120,
    type: 'model_call_start',
    data: { headerHash: 'h1' },
    turn: 1,
    step: 1,
  },
];

describe('projectConversation', () => {
  it('renders a streaming assistant message from deltas alone', () => {
    const { view } = projectConversation(EVENTS, [
      { kind: 'text', text: 'he' },
      { kind: 'text', text: 'llo' },
    ]);

    const assistant = view.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('hello');
    expect(assistant.isStreaming).toBe(true);
  });

  it('replaces the partial once the authoritative event lands', () => {
    const completed: TranscriptEventInput[] = [
      ...EVENTS,
      {
        time: 200,
        type: 'assistant_message',
        data: {
          content: [{ type: 'text', text: 'hello' }],
          stopReason: 'end_turn',
          durationMs: 80,
        },
        turn: 1,
        step: 1,
      },
    ];

    const { view } = projectConversation(completed, []);
    const assistant = view.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('hello');
    expect(assistant.isStreaming).toBeUndefined();
  });

  it('keeps message ids stable as events accumulate', () => {
    const { view: before } = projectConversation(EVENTS, []);
    const idsBefore = before.messages.map((m) => m.id);
    const { view: after } = projectConversation(
      [
        ...EVENTS,
        {
          time: 300,
          type: 'turn_end',
          data: { turn: 1, reason: 'done' },
          turn: 1,
        },
      ],
      [],
    );
    const idsAfter = after.messages.map((m) => m.id);

    expect(idsAfter.slice(0, idsBefore.length)).toEqual(idsBefore);
  });

  it('exposes the intermediate records for prev feedback', () => {
    const { records } = projectConversation(EVENTS, []);
    expect(records).toHaveLength(1);
    expect(records[0]?.turn).toBe(1);
  });

  it('surfaces turn-level and step-level errors through the records', () => {
    const errored: TranscriptEventInput[] = [
      { time: 100, type: 'turn_start', data: { turn: 1 }, turn: 1 },
      { time: 110, type: 'user_message', data: { content: 'hi' }, turn: 1 },
      {
        time: 120,
        type: 'model_call_start',
        data: { headerHash: 'h1' },
        turn: 1,
        step: 1,
      },
      {
        time: 200,
        type: 'model_error',
        data: { error: 'provider down', retriable: true },
        turn: 1,
        step: 1,
      },
    ];

    const { view, records } = projectConversation(errored, []);
    expect(records[0]?.steps[0]?.error?.message).toBe('provider down');
    // The closed step has no content; the empty assistant bubble is dropped
    // at render time in favour of an error notice.
    const assistant = view.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('');
  });
});

describe('composeChatEntries', () => {
  const userMessage = (id: string, content: string): ConversationMessage => ({
    id,
    role: 'user',
    blocks: [{ type: 'text', text: content }],
    content,
    timestamp: 100,
  });
  const emptyAssistant = (
    id: string,
    isStreaming?: boolean,
  ): ConversationMessage => ({
    id,
    role: 'assistant',
    blocks: [],
    content: '',
    timestamp: 200,
    ...(isStreaming ? { isStreaming: true } : {}),
  });

  it('keeps ordinary messages as message entries', () => {
    const entries = composeChatEntries([userMessage('1:u0', 'hi')], []);
    expect(entries).toEqual([
      {
        kind: 'message',
        message: {
          id: '1:u0',
          role: 'user',
          content: 'hi',
          timestamp: 100,
          blocks: [{ type: 'text', text: 'hi' }],
        },
      },
    ]);
  });

  it('replaces an empty assistant bubble with an error notice when its step errored', () => {
    const records = [
      {
        turn: 1,
        startedAt: 100,
        userInput: [],
        steps: [
          {
            step: 1,
            startedAt: 120,
            headerHash: 'h1',
            toolCalls: [],
            retries: [],
            error: { message: 'provider down', retriable: true },
          },
        ],
      },
    ];

    const entries = composeChatEntries([emptyAssistant('1:1')], records);
    expect(entries).toEqual([
      { kind: 'error', key: '1:1:error', text: 'provider down', time: 200 },
    ]);
  });

  it('drops closed empty assistant bubbles that never errored', () => {
    const entries = composeChatEntries([emptyAssistant('1:1')], []);
    expect(entries).toEqual([]);
  });

  it('keeps an empty assistant bubble while it is still streaming', () => {
    const entries = composeChatEntries([emptyAssistant('1:1', true)], []);
    expect(entries).toEqual([
      { kind: 'message', message: emptyAssistant('1:1', true) },
    ]);
  });

  // A turn that streams a reply and then fails mid-stream (model_error, no
  // assistant_message) mirrors the real provider-error path: text deltas are
  // buffered while the turn is open, and chat-store only clears them on
  // assistant_message, so the step's streaming partial stays alive. Without
  // the terminal-error rule below that partial would keep blinking forever.
  const erroredTurnEvents = (withTurnEnd: boolean): TranscriptEventInput[] => [
    { time: 100, type: 'turn_start', data: { turn: 1 }, turn: 1 },
    { time: 110, type: 'user_message', data: { content: 'hi' }, turn: 1 },
    {
      time: 120,
      type: 'model_call_start',
      data: { headerHash: 'h1' },
      turn: 1,
      step: 1,
    },
    {
      time: 200,
      type: 'model_error',
      data: { error: 'provider down', errorKind: 'provider', retriable: false },
      turn: 1,
      step: 1,
    },
    ...(withTurnEnd
      ? [
          {
            time: 300,
            type: 'turn_end' as const,
            data: { turn: 1, reason: 'error' as const },
            turn: 1,
          },
        ]
      : []),
  ];
  const TEXT_DELTAS: TranscriptDelta[] = [
    { kind: 'text', text: 'he' },
    { kind: 'text', text: 'llo' },
  ];

  it('stops the perpetual streaming caret when an open step errored mid-stream', () => {
    // No closing turn_end in the buffer yet — the delta partial lives on and
    // would previously render as a permanent caret with no error notice.
    const { view, records } = projectConversation(
      erroredTurnEvents(false),
      TEXT_DELTAS,
    );
    const assistant = view.messages.find((m) => m.role === 'assistant')!;
    // Precondition: the partial text is present and still flagged streaming.
    expect(assistant.content).toBe('hello');
    expect(assistant.isStreaming).toBe(true);

    const entries = composeChatEntries(view.messages, records);
    const messageEntries = entries.filter(
      (e): e is { kind: 'message'; message: ConversationMessage } =>
        e.kind === 'message',
    );
    const erroredText = messageEntries.find(
      (e) => e.message.role === 'assistant',
    );
    // The streamed text stays visible but is no longer presented as streaming.
    expect(erroredText?.message.content).toBe('hello');
    expect(erroredText?.message.isStreaming).not.toBe(true);
    // The failure surfaces as an error notice right after the text.
    expect(
      entries.some(
        (e) =>
          e.kind === 'error' &&
          e.text === 'provider down' &&
          e.key === '1:1:error',
      ),
    ).toBe(true);
  });

  it('shows no streaming entries and an error notice once the errored turn closes', () => {
    const { view, records } = projectConversation(
      erroredTurnEvents(true),
      TEXT_DELTAS,
    );
    const entries = composeChatEntries(view.messages, records);
    // Nothing in the rendered feed is still flagged as streaming.
    for (const entry of entries) {
      if (entry.kind === 'message') {
        expect(entry.message.isStreaming).not.toBe(true);
      }
    }
    // The user message survives and the failure is visible.
    expect(
      entries.some((e) => e.kind === 'message' && e.message.role === 'user'),
    ).toBe(true);
    expect(
      entries.some(
        (e) =>
          e.kind === 'error' &&
          e.text === 'provider down' &&
          e.key === '1:1:error',
      ),
    ).toBe(true);
  });

  it('appends a trailing notice for a turn-level error with no message', () => {
    const records = [
      {
        turn: 0,
        startedAt: 500,
        userInput: [],
        steps: [],
        error: 'send failed',
      },
    ];
    const entries = composeChatEntries([], records);
    expect(entries).toEqual([
      { kind: 'error', key: '0:error', text: 'send failed', time: 500 },
    ]);
  });

  it('does not duplicate a turn error already surfaced by a step notice', () => {
    const records = [
      {
        turn: 1,
        startedAt: 100,
        userInput: [],
        error: 'same failure',
        steps: [
          {
            step: 1,
            startedAt: 120,
            headerHash: 'h1',
            toolCalls: [],
            retries: [],
            error: { message: 'same failure', retriable: true },
          },
        ],
      },
    ];

    const entries = composeChatEntries([emptyAssistant('1:1')], records);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: 'error',
      key: '1:1:error',
      text: 'same failure',
      time: 200,
    });
  });
});

describe('mergeStoredAndLive', () => {
  const message = (
    id: string,
    role: 'user' | 'assistant',
    content: string,
  ): ConversationMessage => ({
    id,
    role,
    content,
    timestamp: 100,
    blocks: content ? [{ type: 'text', text: content }] : [],
  });

  it('concatenates disjoint history and live feeds', () => {
    const stored = [message('1:u0', 'user', 'hi')];
    const live = [message('2:u0', 'user', 'again')];
    expect(mergeStoredAndLive(stored, live).map((m) => m.id)).toEqual([
      '1:u0',
      '2:u0',
    ]);
  });

  it('lets the live feed supersede overlapping snapshot ids', () => {
    const stored = [
      message('1:u0', 'user', 'hi'),
      { ...message('1:1', 'assistant', 'partial'), isStreaming: true },
    ];
    const live = [message('1:1', 'assistant', 'full')];
    expect(mergeStoredAndLive(stored, live).map((m) => m.content)).toEqual([
      'hi',
      'full',
    ]);
  });

  it('returns the live feed when there is no stored history', () => {
    const live = [message('1:u0', 'user', 'hi')];
    expect(mergeStoredAndLive([], live)).toEqual(live);
  });

  it('returns the stored history when nothing is live yet', () => {
    const stored = [message('1:u0', 'user', 'hi')];
    expect(mergeStoredAndLive(stored, [])).toEqual(stored);
  });
});
