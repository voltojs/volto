import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GitGraphTab } from '@/components/pane/GitGraphTab';
import { RightPane } from '@/components/pane/RightPane';
import { usePaneStore, PANE_WIDTH_DEFAULT } from '@/stores/pane-store';
import {
  fetchGitGraph,
  fetchGitCommit,
  fetchGitSummary,
} from '@/lib/git-api';

vi.mock('@/lib/git-api', () => ({
  fetchGitGraph: vi.fn(),
  fetchGitCommit: vi.fn(),
  fetchGitSummary: vi.fn(),
}));
vi.mock('@/lib/sessions-api', () => ({
  fetchSessionEvents: vi.fn().mockResolvedValue({ sessionId: 'x', events: [] }),
}));

const graphMock = vi.mocked(fetchGitGraph);
const commitMock = vi.mocked(fetchGitCommit);
const summaryMock = vi.mocked(fetchGitSummary);

const tab = {
  kind: 'git-graph',
  id: 'git-graph:p1',
  projectId: 'p1',
} as const;

/** Newest first, as the gateway returns them: b's only parent is a. */
const twoNodes = {
  nodes: [
    {
      hash: 'b',
      parents: ['a'],
      subject: 'second commit',
      author: 'Ada',
      authoredAt: '2026-01-02T00:00:00Z',
      refs: ['main'],
    },
    {
      hash: 'a',
      parents: [],
      subject: 'first commit',
      author: 'Ada',
      authoredAt: '2026-01-01T00:00:00Z',
      refs: [],
    },
  ],
  truncated: false,
};

const commitB = {
  hash: 'b',
  parents: ['a'],
  subject: 'second commit',
  body: 'full commit body',
  author: 'Ada',
  authoredAt: '2026-01-02T00:00:00Z',
  files: [{ status: 'M', path: 'src/a.ts' }],
};

beforeEach(() => {
  graphMock.mockReset();
  commitMock.mockReset();
  summaryMock.mockReset();
  graphMock.mockResolvedValue(twoNodes);
  commitMock.mockResolvedValue(commitB);
  usePaneStore.setState({
    tabs: [],
    activeTabId: null,
    width: PANE_WIDTH_DEFAULT,
    open: false,
    hidden: false,
  });
});

describe('GitGraphTab', () => {
  it('loads nodes and fetches details only after a node is selected', async () => {
    render(<GitGraphTab tab={tab} />);
    expect(await screen.findByText('second commit')).toBeDefined();
    expect(commitMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /second commit/ }));
    expect(await screen.findByText('full commit body')).toBeDefined();
    expect(commitMock).toHaveBeenCalledWith('p1', 'b');
  });

  it('re-fetches the graph and clears stale detail on refresh', async () => {
    commitMock.mockResolvedValue(commitB);
    render(<GitGraphTab tab={tab} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /second commit/ }),
    );
    expect(await screen.findByText('full commit body')).toBeDefined();
    expect(graphMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(graphMock).toHaveBeenCalledTimes(2);
    // Refresh must drop the previous selection's detail, not leave it dangling.
    expect(screen.queryByText('full commit body')).toBeNull();
    // No automatic re-detail without a new click.
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('second commit')).toBeDefined();
  });

  it('offers retry when the graph fetch fails', async () => {
    graphMock.mockRejectedValueOnce(new Error('graph down'));
    render(<GitGraphTab tab={tab} />);
    expect(await screen.findByText('graph down')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('second commit')).toBeDefined();
  });

  it('keeps the loaded detail when the same node is clicked again', async () => {
    render(<GitGraphTab tab={tab} />);
    const nodeButton = await screen.findByRole('button', {
      name: /second commit/,
    });
    fireEvent.click(nodeButton);
    expect(await screen.findByText('full commit body')).toBeDefined();
    // Second click on the same node must not clear detail into a stuck
    // loading state (selectedHash is unchanged, so the effect will not re-run).
    fireEvent.click(nodeButton);
    expect(screen.getByText('full commit body')).toBeDefined();
    expect(screen.queryByText('加载详情…')).toBeNull();
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it('clips horizontal overflow so long refs do not open a hollow scrollbar', async () => {
    graphMock.mockResolvedValue({
      nodes: [
        {
          hash: 'c',
          parents: [],
          subject: 'feat: a very long subject that should ellipsize in a narrow pane',
          author: 'Ada',
          authoredAt: '2026-01-03T00:00:00Z',
          refs: ['origin/feat/very-long-remote-branch-name', 'origin/HEAD', 'dev'],
        },
      ],
      truncated: false,
    });
    const { container } = render(<GitGraphTab tab={tab} />);
    expect(
      await screen.findByRole('button', { name: /a very long subject/ }),
    ).toBeDefined();
    // Refs stay visible on the wrapping metadata line.
    expect(screen.getByText('origin/feat/very-long-remote-branch-name')).toBeDefined();
    const list = container.querySelector('ul');
    expect(list?.className).toContain('overflow-x-hidden');
  });

  it('keeps loaded nodes when the detail fetch fails', async () => {
    commitMock.mockRejectedValue(new Error('detail down'));
    render(<GitGraphTab tab={tab} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /second commit/ }),
    );
    expect(await screen.findByText('detail down')).toBeDefined();
    // Detail failure stays in the detail area; the graph list survives.
    expect(screen.getByText('second commit')).toBeDefined();
    expect(screen.getByText('first commit')).toBeDefined();
  });
});

describe('GitGraphTab via RightPane', () => {
  it('opens the tab from the overview Git 图谱 entry', async () => {
    summaryMock.mockResolvedValue({ isGit: true, branch: 'main', head: 'b' });
    usePaneStore.setState({ open: true, hidden: false, tabs: [] });
    render(<RightPane projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Git 图谱' }));
    expect(usePaneStore.getState().tabs).toEqual([
      { kind: 'git-graph', id: 'git-graph:p1', projectId: 'p1' },
    ]);
    // Renderer is wired: nodes appear inside the pane shell.
    expect(await screen.findByText('second commit')).toBeDefined();
  });
});
