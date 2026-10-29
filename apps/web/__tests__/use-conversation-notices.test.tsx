/**
 * Feed-wiring gate for the model-tier fallback notice (routing tiers, D5).
 *
 * The pure layers (projection / store / event mapping) live in
 * tier-notice.test.ts and the onEvent→pushNotice routing in
 * use-chat-agent-routing.test.tsx. This closes the remaining link: the main
 * feed's `composeChatEntries` call site must thread the store's session
 * notices into the rendered feed. Without this gate every pure layer passes
 * while the notice never reaches the screen — the exact two-of-three-links
 * gap AGENTS.md §2.1 forbids (why use-chat-agent-routing.test.tsx exists).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import { useConversation } from '../hooks/use-conversation.js';
import { useChatStore } from '../stores/chat-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { MessageList } from '../components/chat/MessageList.js';
import { summary } from './helpers/session.js';
import type { ChatNotice } from '@/lib/projection';

// jsdom implements no scrollIntoView; MessageList scrolls on every update.
Element.prototype.scrollIntoView ??= () => {};

const TIER_NOTICE: ChatNotice = {
  key: 'tier-notice:ghost:500:w-sub-1',
  text: '模型档位 "ghost" 未配置或已失效，本次子代理已回退使用主对话模型',
  time: 500,
};

beforeEach(() => {
  useSessionStore.setState({
    sessions: [
      { ...summary('s1'), projectId: 'p1', providerId: 'v1', modelId: 'm1' },
    ],
    currentSessionId: 's1',
  });
  useChatStore.setState({
    events: [],
    deltas: [],
    isGenerating: false,
    // Matching ids: the session-switch bookkeeping must not wipe the seeded
    // state — the switch cleanup path is covered in tier-notice.test.ts.
    currentSessionId: 's1',
    subagents: {},
    notices: [TIER_NOTICE],
  });
});

describe('useConversation session notices', () => {
  it('threads store notices into the rendered feed as trailing notice rows', () => {
    const { result } = renderHook(() => useConversation());

    expect(result.current.entries).toEqual([
      { kind: 'notice', ...TIER_NOTICE },
    ]);

    render(<MessageList entries={result.current.entries} />);
    expect(screen.getByText(TIER_NOTICE.text)).toBeInTheDocument();
  });
});
