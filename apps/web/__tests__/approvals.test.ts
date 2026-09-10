import { describe, it, expect } from 'vitest';
import { selectPendingApprovals } from '@/lib/approvals';
import type { TranscriptEventInput } from '@volto/core';

const asked = (callId: string, name = 'bash'): TranscriptEventInput => ({
  time: 1,
  type: 'approval_asked',
  data: { callId, name, riskTier: 'WRITE_HIGH' },
});

const decided = (
  callId: string,
  decision: 'allow' | 'deny' = 'allow',
): TranscriptEventInput => ({
  time: 2,
  type: 'approval_decision',
  data: { callId, decision },
});

describe('selectPendingApprovals', () => {
  it('returns nothing for an empty stream', () => {
    expect(selectPendingApprovals([])).toEqual([]);
  });

  it('surfaces an asked approval that has no decision yet', () => {
    expect(selectPendingApprovals([asked('c1', 'write_file')])).toEqual([
      { callId: 'c1', toolName: 'write_file', riskTier: 'WRITE_HIGH' },
    ]);
  });

  it('drops an approval once its decision arrives', () => {
    expect(selectPendingApprovals([asked('c1'), decided('c1')])).toEqual([]);
  });

  it('drops it on a deny too', () => {
    expect(
      selectPendingApprovals([asked('c1'), decided('c1', 'deny')]),
    ).toEqual([]);
  });

  it('keeps several approvals pending in ask order', () => {
    const pending = selectPendingApprovals([
      asked('c1', 'bash'),
      asked('c2', 'write_file'),
      decided('c1'),
      asked('c3', 'git_push'),
    ]);

    expect(pending.map((p) => p.callId)).toEqual(['c2', 'c3']);
  });

  it('ignores unrelated events', () => {
    const pending = selectPendingApprovals([
      { time: 0, type: 'user_message', data: { content: 'hi' } },
      asked('c1'),
      { time: 3, type: 'turn_end', data: { turn: 1, reason: 'done' } },
    ]);

    expect(pending).toHaveLength(1);
  });

  it('tolerates a decision for a callId never asked about', () => {
    // A reconnect can replay a decision whose ask fell outside the buffer.
    expect(selectPendingApprovals([decided('ghost')])).toEqual([]);
  });

  it('carries the tool input from the already-streamed tool call', () => {
    // The approval event deliberately does NOT carry arguments (that is how
    // drift between "what was approved" and "what runs" is avoided). They are
    // recovered from the tool_use block that was already streamed.
    const events: TranscriptEventInput[] = [
      {
        time: 1,
        type: 'assistant_message',
        data: {
          content: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'bash',
              input: { command: 'rm -rf build' },
            },
          ],
        },
      },
      {
        time: 2,
        type: 'approval_asked',
        data: { callId: 'call-1', name: 'bash', riskTier: 'WRITE_HIGH' },
      },
    ] as TranscriptEventInput[];

    const pending = selectPendingApprovals(events);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.input).toEqual({ command: 'rm -rf build' });
  });

  it('still returns the approval when no tool_use block is in the buffer', () => {
    // A reconnect can replay a buffer whose tool_use fell off the front. The
    // approval must still render -- without arguments, but never suppressed.
    const events: TranscriptEventInput[] = [
      {
        time: 1,
        type: 'approval_asked',
        data: { callId: 'call-1', name: 'bash', riskTier: 'WRITE_HIGH' },
      },
    ] as TranscriptEventInput[];

    const pending = selectPendingApprovals(events);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.input).toBeUndefined();
  });
});
