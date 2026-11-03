/**
 * Model-tier fallback notice (routing tiers, D5): the conversation renders
 * the SDK's loosely-typed `subagent_model_tier_unresolved` event as a
 * session-level notice row. Covered here at the three pure layers the brief
 * names — the feed projection (session notices trail the feed), the chat
 * store (accumulation and cleanup), and the event→notice mapping extracted
 * out of the hook. The wiring gates live beside the code that does the
 * routing: onEvent → pushNotice in use-chat-agent-routing.test.tsx and the
 * store → feed threading in use-conversation-notices.test.tsx.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { composeChatEntries, type ChatNotice } from '@/lib/projection';
import { tierNoticeFromEvent } from '@/lib/tier-notice';
import { useChatStore } from '../stores/chat-store.js';
import type { ConversationMessage } from '@volto/sdk/sse';

/** The notice a `{ tierId: "ghost" }` degradation produces (copy is verbatim). */
const TIER_NOTICE: ChatNotice = {
  key: 'tier-notice:ghost:500:unknown',
  text: 'tier.fallback',
  time: 500,
};

const userMessage = (id: string, content: string): ConversationMessage => ({
  id,
  role: 'user',
  blocks: [{ type: 'text', text: content }],
  content,
  timestamp: 100,
});

describe('composeChatEntries session notices', () => {
  it('appends session notices at the very end of the feed', () => {
    const entries = composeChatEntries([userMessage('1:u0', 'hi')], [], [
      TIER_NOTICE,
    ]);

    expect(entries.at(-1)).toEqual({ kind: 'notice', ...TIER_NOTICE });
    expect(entries[0]).toEqual({
      kind: 'message',
      message: userMessage('1:u0', 'hi'),
    });
  });

  it('keeps session notices trailing turn-anchored cancel notices', () => {
    const records = [
      {
        turn: 1,
        startedAt: 100,
        endedAt: 300,
        reason: 'cancelled' as const,
        userInput: [],
        steps: [],
      },
      { turn: 2, startedAt: 400, userInput: [], steps: [] },
    ];
    const entries = composeChatEntries(
      [userMessage('1:u0', 'hi'), userMessage('2:u0', 'again')],
      records,
      [TIER_NOTICE],
    );

    // The cancel notice stays anchored to its own turn; the session-level
    // tier notice trails the whole feed instead of being spliced into a turn.
    expect(
      entries.map((e) => (e.kind === 'message' ? e.message.id : e.key)),
    ).toEqual(['1:u0', '1:cancelled:0', '2:u0', TIER_NOTICE.key]);
  });

  it('renders no notice rows when none are passed', () => {
    const entries = composeChatEntries([userMessage('1:u0', 'hi')], []);

    expect(entries).toEqual([
      { kind: 'message', message: userMessage('1:u0', 'hi') },
    ]);
  });
});

describe('chat store notices', () => {
  beforeEach(() => {
    useChatStore.setState({ events: [], deltas: [], notices: [] });
  });

  it('appends pushed notices in arrival order', () => {
    const second: ChatNotice = {
      key: 'tier-notice:economy:600:w-sub-2',
      text: 'tier.fallback',
      time: 600,
    };
    useChatStore.getState().pushNotice(TIER_NOTICE);
    useChatStore.getState().pushNotice(second);

    expect(useChatStore.getState().notices).toEqual([TIER_NOTICE, second]);
  });

  it('clears notices along with the buffers on clear()', () => {
    useChatStore.getState().pushNotice(TIER_NOTICE);
    useChatStore.getState().clear();

    expect(useChatStore.getState().notices).toEqual([]);
  });

  it('clears notices when the log is replaced on a session switch', () => {
    useChatStore.getState().pushNotice(TIER_NOTICE);
    // The exact call use-conversation's session-switch bookkeeping makes.
    useChatStore.getState().setEvents([]);

    expect(useChatStore.getState().notices).toEqual([]);
  });
});

describe('tierNoticeFromEvent', () => {
  it('maps a tier-unresolved event to the notice triple', () => {
    const notice = tierNoticeFromEvent({
      type: 'subagent_model_tier_unresolved',
      time: 500,
      data: { tierId: 'ghost' },
    });

    // Exactly the triple the projection and store tests above consume.
    expect(notice).toEqual(TIER_NOTICE);
  });

  it('reads the event leniently, ignoring optional and unknown fields', () => {
    const notice = tierNoticeFromEvent({
      type: 'subagent_model_tier_unresolved',
      time: 500,
      data: {
        subagentType: 'researcher',
        tierId: 'ghost',
        turn: 3,
        childSessionId: 'w-sub-1',
        target: { providerId: 'openai', modelId: 'gpt-5' },
        futureField: { anything: true },
      },
    });

    // The wide shape (Task 1's real data contract) must not be rejected:
    // only tierId is read, childSessionId merely refines the key.
    expect(notice).toEqual({
      key: 'tier-notice:ghost:500:w-sub-1',
      text: 'tier.fallback',
      time: 500,
    });
  });

  it('returns null for unrelated events', () => {
    expect(
      tierNoticeFromEvent({ type: 'turn_end', time: 1, data: { turn: 1 } }),
    ).toBeNull();
    expect(
      tierNoticeFromEvent({ type: 'subagent_finished', time: 2, data: {} }),
    ).toBeNull();
  });

  it('returns null when tierId is missing or not a string', () => {
    expect(
      tierNoticeFromEvent({
        type: 'subagent_model_tier_unresolved',
        time: 500,
        data: {},
      }),
    ).toBeNull();
    expect(
      tierNoticeFromEvent({
        type: 'subagent_model_tier_unresolved',
        time: 500,
        data: null,
      }),
    ).toBeNull();
  });
});
