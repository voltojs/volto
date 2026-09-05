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

import {
  projectTrajectory,
  mergeStoredAndLiveRows,
} from '@/lib/projection';
import type { TrajectoryRow } from '@volto/sdk/sse';

function ev(
  time: number,
  type: string,
  data: Record<string, unknown>,
  turn?: number,
  step?: number,
): TranscriptEventInput {
  return {
    time,
    type: type as TranscriptEventInput['type'],
    data,
    ...(turn !== undefined ? { turn } : {}),
    ...(step !== undefined ? { step } : {}),
  } as TranscriptEventInput;
}

/** 两步轮次：step1 工具调用 → step2 纯文本收尾。 */
const TOOL_LOG: TranscriptEventInput[] = [
  ev(100, 'turn_start', { turn: 1 }, 1),
  ev(110, 'user_message', { content: 'go' }, 1),
  ev(120, 'model_call_start', { headerHash: 'h1' }, 1, 1),
  ev(130, 'assistant_message', {
    content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.txt' } }],
    stopReason: 'tool_use',
    durationMs: 10,
  }, 1, 1),
  ev(140, 'tool_call', { callId: 'c1', name: 'read_file', input: { path: 'a.txt' } }, 1, 1),
  ev(180, 'tool_result', { callId: 'c1', content: 'file body', isError: false, orderInBatch: 0, durationMs: 40 }, 1, 1),
  ev(190, 'model_call_start', { headerHash: 'h1' }, 1, 2),
  ev(200, 'assistant_message', {
    content: [{ type: 'text', text: 'done' }],
    stopReason: 'end_turn',
    durationMs: 10,
  }, 1, 2),
  ev(210, 'turn_end', { turn: 1, reason: 'done' }, 1),
];

describe('projectTrajectory', () => {
  it('derives the full row set: user / assistant / tool / assistant with stable ids', () => {
    const { rows, streamingRowId } = projectTrajectory(TOOL_LOG, []);
    expect(streamingRowId).toBeNull();
    expect(rows.map((r) => [r.id, r.kind])).toEqual([
      ['1:u0', 'user'],
      ['1:1', 'assistant'],
      ['c1', 'tool'],
      ['1:2', 'assistant'],
    ]);
    expect(rows[0]!.summary).toBe('go');
    expect(rows[2]!.inputDetail).toContain('read_file');
    expect(rows[2]!.outputDetail).toBe('file body');
    expect(rows[2]!.durationMs).toBe(40);
  });

  it('folds deltas into the open assistant row and reports it as streaming', () => {
    const openLog = TOOL_LOG.slice(0, 7); // 截到 model_call_start(step2)，step2 无 assistant_message
    const deltas = [
      { kind: 'text', text: 'hel' },
      { kind: 'text', text: 'lo' },
    ] as TranscriptDelta[];

    const { rows, streamingRowId } = projectTrajectory(openLog, deltas);
    const streaming = rows.find((r) => r.id === '1:2');
    expect(streamingRowId).toBe('1:2');
    expect(streaming!.outputDetail).toBe('hello');
  });

  it('self-heals: the authoritative assistant_message replaces the partial wholesale', () => {
    const openLog = TOOL_LOG.slice(0, 7);
    const deltas = [{ kind: 'text', text: 'partial text' }] as TranscriptDelta[];

    // 带着过期 deltas 投影完整日志——权威事件必须整体替换 partial
    const { rows, streamingRowId } = projectTrajectory(TOOL_LOG, deltas);
    expect(streamingRowId).toBeNull();
    expect(rows.find((r) => r.id === '1:2')!.outputDetail).toBe('done');
    // 且与无 deltas 的结果深相等
    expect(rows).toEqual(projectTrajectory(TOOL_LOG, []).rows);
  });
});

describe('mergeStoredAndLiveRows', () => {
  const row = (id: string, startedAt: number, summary: string): TrajectoryRow => ({
    index: 0,
    id,
    kind: 'assistant',
    turn: 1,
    summary,
    startedAt,
  });

  it('returns stored as-is when nothing is live', () => {
    const stored = [row('1:1', 100, 'a'), row('c1', 140, 't')];
    expect(mergeStoredAndLiveRows(stored, [])).toEqual(stored);
  });

  it('returns live (reindexed) when nothing is stored', () => {
    const live = [row('2:1', 300, 'x'), row('2:u0', 290, 'u')];
    const merged = mergeStoredAndLiveRows([], live);
    expect(merged.map((r) => r.id)).toEqual(['2:u0', '2:1']);
    expect(merged.map((r) => r.index)).toEqual([1, 2]);
  });

  it('lets live win on id collision and re-sorts + reindexes the union', () => {
    const stored = [row('1:1', 100, 'stale'), row('c1', 140, 'tool')];
    const live = [row('1:1', 100, 'fresh'), row('1:2', 200, 'next')];
    const merged = mergeStoredAndLiveRows(stored, live);
    expect(merged.map((r) => [r.id, r.summary])).toEqual([
      ['1:1', 'fresh'],
      ['c1', 'tool'],
      ['1:2', 'next'],
    ]);
    expect(merged.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it('merges a recovered mid-turn session: stored turn-1 rows + live turn-1 tail by id, live wins', () => {
    // 恢复会话：盘上已有 step1 的 assistant 行；实时流随后重放了同一轮的行（带 partial 更新）
    const stored = [row('1:u0', 90, 'go'), row('1:1', 100, 'stale')];
    const live = [row('1:1', 100, 'fresh partial')];
    const merged = mergeStoredAndLiveRows(stored, live);
    expect(merged.map((r) => [r.id, r.summary])).toEqual([
      ['1:u0', 'go'],
      ['1:1', 'fresh partial'],
    ]);
  });
});
