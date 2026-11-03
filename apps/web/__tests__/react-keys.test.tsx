/**
 * Duplicate-key regression gate. The running app logged React's "same key"
 * warning on the conversation page; these renderings cover the two surfaces
 * that page composes (the feed and the right pane's empty state) so a key
 * collision makes the suite fail with the offending element named.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MessageList } from '@/components/chat/MessageList';
import { RightPane } from '@/components/pane/RightPane';
import { usePaneStore, PANE_WIDTH_DEFAULT } from '@/stores/pane-store';
import { useChatStore } from '@/stores/chat-store';
import type { ChatEntry } from '@/lib/projection';

vi.mock('@/lib/git-api', () => ({
  fetchGitSummary: vi.fn().mockResolvedValue({ isGit: true, branch: 'main', head: 'abc' }),
}));
Element.prototype.scrollIntoView ??= () => {};

const message = (id: string, role: 'user' | 'assistant', text: string) =>
  ({
    id,
    role,
    blocks: [{ type: 'text', text }],
    content: text,
    timestamp: 0,
    isStreaming: false,
  }) as never;

const ENTRIES: ChatEntry[] = [
  { kind: 'message', message: message('1:0', 'user', '你好') },
  { kind: 'message', message: message('1:1', 'assistant', '读取项目结构') },
  { kind: 'message', message: message('1:2', 'assistant', '然后总结') },
  { kind: 'notice', key: '1:cancelled', text: '已中断本次生成', time: 300 },
  { kind: 'error', key: 'err-1', text: '出错了', time: 400 },
];

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useChatStore.setState({
    events: [],
    deltas: [],
    isGenerating: false,
    subagents: {},
    currentSessionId: 's1',
    connectionState: 'connected',
  });
  usePaneStore.setState({
    tabs: [],
    activeTabId: null,
    width: PANE_WIDTH_DEFAULT,
    open: true,
    hidden: false,
  });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

const duplicateKeyWarnings = (): string[] =>
  consoleError.mock.calls
    .map((args) => args.map(String).join(' '))
    .filter((text) => /same key|duplicate key|unique "key"/i.test(text));

describe('conversation page keys', () => {
  it('renders the feed without duplicate keys', () => {
    render(<MessageList entries={ENTRIES} />);
    expect(duplicateKeyWarnings()).toEqual([]);
  });

  it('renders the empty right pane without duplicate keys', () => {
    render(<RightPane projectId="p1" />);
    expect(duplicateKeyWarnings()).toEqual([]);
  });
});
