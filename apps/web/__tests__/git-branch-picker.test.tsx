/**
 * Welcome-page Git branch picker: shows the workspace's real HEAD branch,
 * searches local/remote branches, checks out, and creates. A failed
 * mutation must keep the previous branch label and surface the API error.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GitBranchPicker } from '@/components/chat/GitBranchPicker';
import {
  fetchGitSummary,
  searchGitBranches,
  checkoutGitBranch,
  createGitBranch,
  type GitSummary,
} from '@/lib/git-api';

vi.mock('@/lib/git-api', () => ({
  fetchGitSummary: vi.fn(),
  searchGitBranches: vi.fn(),
  checkoutGitBranch: vi.fn(),
  createGitBranch: vi.fn(),
  fetchGitGraph: vi.fn(),
  fetchGitCommit: vi.fn(),
}));

const summary = vi.mocked(fetchGitSummary);
const search = vi.mocked(searchGitBranches);
const checkout = vi.mocked(checkoutGitBranch);
const create = vi.mocked(createGitBranch);

// jsdom does not implement the pointer-capture APIs Base UI uses internally.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const GIT_SUMMARY = { isGit: true, branch: 'main', head: 'abc123' } as const;

function user() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

beforeEach(() => {
  summary.mockReset();
  search.mockReset();
  checkout.mockReset();
  create.mockReset();
  summary.mockResolvedValue({ ...GIT_SUMMARY });
  search.mockResolvedValue({ branches: [], truncated: false });
});

describe('GitBranchPicker', () => {
  it('does not render for a non-git workspace', async () => {
    summary.mockResolvedValue({ isGit: false, branch: null, head: null });
    const { container } = render(<GitBranchPicker projectId="plain" />);
    await waitFor(() => expect(summary).toHaveBeenCalledWith('plain'));
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="git-branch-picker"]'),
      ).toBeNull(),
    );
  });

  it('shows the current branch for a git workspace', async () => {
    render(<GitBranchPicker projectId="p1" />);
    const root = await screen.findByTestId('git-branch-picker');
    expect(root).toHaveTextContent('main');
    expect(summary).toHaveBeenCalledWith('p1');
  });

  it('searches on query and groups local vs remote branches', async () => {
    search.mockResolvedValue({
      branches: [
        { name: 'main', kind: 'local' },
        { name: 'feature/x', kind: 'local' },
        { name: 'origin/feature/x', kind: 'remote', remote: 'origin' },
      ],
      truncated: false,
    });
    const u = user();
    render(<GitBranchPicker projectId="p1" />);
    await screen.findByTestId('git-branch-picker');

    await u.click(screen.getByRole('button', { name: /当前分支/ }));
    await u.type(
      await screen.findByPlaceholderText('搜索分支'),
      'feature',
    );

    await waitFor(() => expect(search).toHaveBeenCalledWith('p1', 'feature'));
    expect(await screen.findByText('本地分支')).toBeInTheDocument();
    expect(screen.getByText('远端分支')).toBeInTheDocument();
    expect(screen.getByText('feature/x')).toBeInTheDocument();
    expect(screen.getByText('origin/feature/x')).toBeInTheDocument();
  });

  it('checks out a remote branch with kind remote and updates the label', async () => {
    search.mockResolvedValue({
      branches: [
        { name: 'main', kind: 'local' },
        { name: 'origin/feature/x', kind: 'remote', remote: 'origin' },
      ],
      truncated: false,
    });
    checkout.mockResolvedValue({
      isGit: true,
      branch: 'feature/x',
      head: 'def456',
    });
    const u = user();
    render(<GitBranchPicker projectId="p1" />);
    const root = await screen.findByTestId('git-branch-picker');
    expect(root).toHaveTextContent('main');

    await u.click(screen.getByRole('button', { name: /当前分支/ }));
    await u.click(await screen.findByText('origin/feature/x'));

    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith({
        projectId: 'p1',
        name: 'origin/feature/x',
        kind: 'remote',
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('git-branch-picker')).toHaveTextContent(
        'feature/x',
      ),
    );
  });

  it('creates a branch from the create row', async () => {
    create.mockResolvedValue({
      isGit: true,
      branch: 'new-ui',
      head: 'aaa111',
    });
    const u = user();
    render(<GitBranchPicker projectId="p1" />);
    await screen.findByTestId('git-branch-picker');

    await u.click(screen.getByRole('button', { name: /当前分支/ }));
    await u.type(await screen.findByPlaceholderText('搜索分支'), 'new-ui');
    await u.click(await screen.findByRole('button', { name: /创建/ }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ projectId: 'p1', name: 'new-ui' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('git-branch-picker')).toHaveTextContent(
        'new-ui',
      ),
    );
  });

  it('keeps the previous branch and shows the API error when checkout fails', async () => {
    search.mockResolvedValue({
      branches: [
        { name: 'main', kind: 'local' },
        { name: 'origin/feature/x', kind: 'remote', remote: 'origin' },
      ],
      truncated: false,
    });
    checkout.mockRejectedValue(new Error('working tree has uncommitted changes'));
    const u = user();
    render(<GitBranchPicker projectId="p1" />);
    await screen.findByTestId('git-branch-picker');

    await u.click(screen.getByRole('button', { name: /当前分支/ }));
    await u.click(await screen.findByText('origin/feature/x'));

    expect(
      await screen.findByText('working tree has uncommitted changes'),
    ).toBeInTheDocument();
    // Failure must not replace the branch label with the rejected target.
    expect(screen.getByTestId('git-branch-picker')).toHaveTextContent('main');
    expect(screen.getByTestId('git-branch-picker')).not.toHaveTextContent(
      'feature/x',
    );
  });

  it('clears stale summary/query when projectId changes', async () => {
    summary.mockImplementation(async (projectId: string) =>
      projectId === 'p1'
        ? { isGit: true, branch: 'main', head: 'abc' }
        : { isGit: true, branch: 'develop', head: 'def' },
    );
    const u = user();
    const { rerender } = render(<GitBranchPicker projectId="p1" />);
    const root = await screen.findByTestId('git-branch-picker');
    expect(root).toHaveTextContent('main');

    await u.click(screen.getByRole('button', { name: /当前分支/ }));
    await u.type(await screen.findByPlaceholderText('搜索分支'), 'feature');
    await waitFor(() => expect(search).toHaveBeenCalledWith('p1', 'feature'));

    rerender(<GitBranchPicker projectId="p2" />);
    await waitFor(() => expect(summary).toHaveBeenCalledWith('p2'));
    await waitFor(() =>
      expect(screen.getByTestId('git-branch-picker')).toHaveTextContent(
        'develop',
      ),
    );
  });

  it('ignores a slow checkout response that resolves after projectId changes', async () => {
    summary.mockImplementation(async (projectId: string) =>
      projectId === 'p1'
        ? { isGit: true, branch: 'main', head: 'abc' }
        : { isGit: true, branch: 'develop', head: 'def' },
    );
    search.mockResolvedValue({
      branches: [
        { name: 'main', kind: 'local' },
        { name: 'origin/feature/x', kind: 'remote', remote: 'origin' },
      ],
      truncated: false,
    });
    // Controllable checkout: stays pending until the test resolves it, so
    // the workspace can switch while the mutation is still in flight.
    let resolveOldCheckout!: (value: GitSummary) => void;
    checkout.mockReturnValueOnce(
      new Promise<GitSummary>((resolve) => {
        resolveOldCheckout = resolve;
      }),
    );

    const u = user();
    const { rerender } = render(<GitBranchPicker projectId="p1" />);
    await screen.findByTestId('git-branch-picker');
    expect(screen.getByTestId('git-branch-picker')).toHaveTextContent('main');

    await u.click(screen.getByRole('button', { name: /当前分支/ }));
    await u.click(await screen.findByText('origin/feature/x'));
    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith({
        projectId: 'p1',
        name: 'origin/feature/x',
        kind: 'remote',
      }),
    );

    // Switch workspaces before the p1 checkout HTTP returns.
    rerender(<GitBranchPicker projectId="p2" />);
    await waitFor(() => expect(summary).toHaveBeenCalledWith('p2'));
    await waitFor(() =>
      expect(screen.getByTestId('git-branch-picker')).toHaveTextContent(
        'develop',
      ),
    );

    const searchesBeforeStaleResolve = search.mock.calls.length;

    // Stale p1 mutation now resolves with p1's post-checkout HEAD. It must
    // not overwrite p2's summary label or refresh p1's branch list.
    await act(async () => {
      resolveOldCheckout({ isGit: true, branch: 'feature/x', head: 'stale' });
    });

    expect(screen.getByTestId('git-branch-picker')).toHaveTextContent('develop');
    expect(screen.getByTestId('git-branch-picker')).not.toHaveTextContent(
      'feature/x',
    );
    expect(search.mock.calls.length).toBe(searchesBeforeStaleResolve);
  });

  it('ignores a slow create response that resolves after projectId changes', async () => {
    summary.mockImplementation(async (projectId: string) =>
      projectId === 'p1'
        ? { isGit: true, branch: 'main', head: 'abc' }
        : { isGit: true, branch: 'develop', head: 'def' },
    );
    let resolveOldCreate!: (value: GitSummary) => void;
    create.mockReturnValueOnce(
      new Promise<GitSummary>((resolve) => {
        resolveOldCreate = resolve;
      }),
    );

    const u = user();
    const { rerender } = render(<GitBranchPicker projectId="p1" />);
    await screen.findByTestId('git-branch-picker');

    await u.click(screen.getByRole('button', { name: /当前分支/ }));
    await u.type(await screen.findByPlaceholderText('搜索分支'), 'new-ui');
    await u.click(await screen.findByRole('button', { name: /创建/ }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ projectId: 'p1', name: 'new-ui' }),
    );

    rerender(<GitBranchPicker projectId="p2" />);
    await waitFor(() => expect(summary).toHaveBeenCalledWith('p2'));
    await waitFor(() =>
      expect(screen.getByTestId('git-branch-picker')).toHaveTextContent(
        'develop',
      ),
    );

    const searchesBeforeStaleResolve = search.mock.calls.length;

    await act(async () => {
      resolveOldCreate({ isGit: true, branch: 'new-ui', head: 'stale' });
    });

    expect(screen.getByTestId('git-branch-picker')).toHaveTextContent('develop');
    expect(screen.getByTestId('git-branch-picker')).not.toHaveTextContent(
      'new-ui',
    );
    expect(search.mock.calls.length).toBe(searchesBeforeStaleResolve);
  });

  it('reports git availability through onGitAvailabilityChange', async () => {
    const onGitAvailabilityChange = vi.fn();
    summary.mockResolvedValue({ isGit: false, branch: null, head: null });
    render(
      <GitBranchPicker
        projectId="plain"
        onGitAvailabilityChange={onGitAvailabilityChange}
      />,
    );
    await waitFor(() =>
      expect(onGitAvailabilityChange).toHaveBeenCalledWith(false),
    );
  });
});
