import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { usePaneStore } from '@/stores/pane-store';
import { FileChangesCard } from '@/components/chat/FileChangesCard';
import { MessageList } from '@/components/chat/MessageList';
import type { ChatEntry } from '@/lib/projection';
import type { TurnFileChange } from '@/lib/turn-file-changes';

// jsdom implements no scrollIntoView; MessageList scrolls on every update.
Element.prototype.scrollIntoView ??= () => {};

const change = (path: string, additions: number, deletions: number): TurnFileChange => ({
  path,
  diff: '@@ -1,1 +1,1 @@\n-a\n+b',
  additions,
  deletions,
  edits: 1,
});

beforeEach(() => {
  usePaneStore.setState({ tabs: [], activeTabId: null, open: false, hidden: true });
});

describe('FileChangesCard', () => {
  it('summarises the turn: file count and summed additions/deletions', () => {
    render(
      <FileChangesCard
        turn="2"
        projectId="p1"
        changes={[change('apps/web/a.ts', 69, 0), change('apps/web/b.ts', 88, 2)]}
      />,
    );
    expect(screen.getByText('已编辑 2 个文件')).toBeDefined();
    expect(screen.getByText('apps/web/a.ts')).toBeDefined();
    expect(screen.getByText('apps/web/b.ts')).toBeDefined();
    const summary = within(screen.getByTestId('file-changes-summary'));
    expect(summary.getByText('+157')).toBeDefined();
    expect(summary.getByText('-2')).toBeDefined();
  });

  it('opens the file diff in the right pane when a row is clicked', () => {
    render(<FileChangesCard turn="2" projectId="p1" changes={[change('src/a.ts', 1, 1)]} />);
    fireEvent.click(screen.getByRole('button', { name: '查看 src/a.ts 的 diff' }));
    const [tab] = usePaneStore.getState().tabs;
    expect(tab).toMatchObject({
      kind: 'file-diff',
      projectId: 'p1',
      path: 'src/a.ts',
      turn: '2',
      additions: 1,
      deletions: 1,
      edits: 1,
    });
    expect(usePaneStore.getState().activeTabId).toBe(tab!.id);
  });

  it('declares a truncated body on the row', () => {
    render(
      <FileChangesCard
        turn="2"
        projectId="p1"
        changes={[{ ...change('src/a.ts', 1, 0), truncated: true }]}
      />,
    );
    expect(screen.getByText('内容已截断')).toBeDefined();
  });
});

function assistantEntry(turn: number, step: number, text: string, withChange: boolean): ChatEntry {
  return {
    kind: 'message',
    message: {
      id: `${turn}:${step}`,
      role: 'assistant',
      content: text,
      timestamp: turn * 100 + step,
      blocks: [
        { type: 'text', text },
        ...(withChange
          ? [
              {
                type: 'tool_call' as const,
                call: {
                  id: `c${turn}`,
                  name: 'edit_file',
                  args: { path: `src/t${turn}.ts` },
                  fileChange: {
                    path: `src/t${turn}.ts`,
                    diff: '@@ -1,1 +1,1 @@\n-a\n+b',
                    additions: 1,
                    deletions: 1,
                  },
                },
              },
            ]
          : []),
      ],
    },
  };
}

function userEntry(turn: number, text: string): ChatEntry {
  return {
    kind: 'message',
    message: {
      id: `${turn}:u0`,
      role: 'user',
      content: text,
      timestamp: turn * 100,
      blocks: [{ type: 'text', text }],
    },
  };
}

describe('MessageList turn summary placement', () => {
  const entries: ChatEntry[] = [
    userEntry(1, 'first'),
    assistantEntry(1, 1, 'one', true),
    userEntry(2, 'second'),
    assistantEntry(2, 1, 'two', false),
  ];

  it('renders one card per turn that changed files, anchored to its own turn', () => {
    render(<MessageList entries={entries} fileProjectId="p1" />);
    const cards = screen.getAllByTestId('file-changes-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute('data-turn')).toBe('1');
    expect(within(cards[0]!).getByText('src/t1.ts')).toBeDefined();
  });

  it('places the card before the next turn starts', () => {
    render(<MessageList entries={entries} fileProjectId="p1" />);
    const card = screen.getByTestId('file-changes-card');
    const nextUser = screen.getByText('second');
    expect(card.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders no card when no turn changed a file', () => {
    render(<MessageList entries={[userEntry(1, 'hi'), assistantEntry(1, 1, 'hello', false)]} />);
    expect(screen.queryByTestId('file-changes-card')).toBeNull();
  });
});