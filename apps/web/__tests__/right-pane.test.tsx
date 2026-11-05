import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RightPane } from '@/components/pane/RightPane';
import { usePaneStore, PANE_WIDTH_DEFAULT } from '@/stores/pane-store';
import { useChatStore } from '@/stores/chat-store';
import { fetchGitSummary, type GitSummary } from '@/lib/git-api';

vi.mock('@/lib/sessions-api', () => ({
  fetchSessionEvents: vi.fn().mockResolvedValue({ sessionId: 'x', events: [] }),
}));
vi.mock('@/lib/git-api', () => ({
  fetchGitSummary: vi.fn(),
}));
Element.prototype.scrollIntoView ??= () => {};
// jsdom 30 尚未实现 pointer capture；拖拽测试只需要事件派发路径。
Element.prototype.setPointerCapture ??= () => {};

const subagentTab = (childId: string) =>
  ({
    kind: 'subagent',
    id: `subagent:${childId}`,
    childSessionId: childId,
    view: 'chat',
  }) as const;

const gitSummary = (isGit: boolean): GitSummary => ({
  isGit,
  branch: isGit ? 'main' : null,
  head: isGit ? 'abc123' : null,
});

beforeEach(() => {
  vi.mocked(fetchGitSummary).mockReset();
  vi.mocked(fetchGitSummary).mockResolvedValue(gitSummary(true));
  usePaneStore.setState({
    tabs: [],
    activeTabId: null,
    width: PANE_WIDTH_DEFAULT,
    open: false,
    hidden: false,
  });
  useChatStore.setState({ subagents: {} });
});

describe('RightPane', () => {
  it('renders nothing when the pane was never opened', () => {
    const { container } = render(<RightPane projectId="p1" />);
    expect(container.querySelector('[data-testid="right-pane"]')).toBeNull();
  });

  it('renders the active tab body and switches on click', () => {
    usePaneStore.setState({
      tabs: [subagentTab('a'), subagentTab('b')],
      activeTabId: 'subagent:a',
      open: true,
    });
    render(<RightPane projectId="p1" />);
    expect(screen.getByText(/…a$/)).toBeDefined();
    fireEvent.click(screen.getByText(/…b$/));
    expect(usePaneStore.getState().activeTabId).toBe('subagent:b');
  });

  it('closes a tab via its close button', () => {
    usePaneStore.setState({
      tabs: [subagentTab('a')],
      activeTabId: 'subagent:a',
      open: true,
    });
    render(<RightPane projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: /关闭 子代理/ }));
    expect(usePaneStore.getState().tabs).toHaveLength(0);
  });

  it('resets drag state on pointercancel so later moves cannot jump the width', () => {
    usePaneStore.setState({
      tabs: [subagentTab('a')],
      activeTabId: 'subagent:a',
      width: 500,
      open: true,
    });
    render(<RightPane projectId="p1" />);
    const handle = screen.getByRole('separator');
    // 先证明拖拽路径本身有效：下压后移动 50px → 宽度 450。
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 150 });
    expect(usePaneStore.getState().width).toBe(450);
    // 取消后（触摸/笔接管、强制释放 capture），后续无按键 move 不得再改宽。
    fireEvent.pointerCancel(handle);
    fireEvent.pointerMove(handle, { clientX: 200 });
    expect(usePaneStore.getState().width).toBe(450);
  });

  it('renders nothing while hidden and returns after setHidden(false)', () => {
    usePaneStore.setState({
      tabs: [subagentTab('a')],
      activeTabId: 'subagent:a',
      hidden: true,
      open: true,
    });
    const view = render(<RightPane projectId="p1" />);
    expect(view.container.querySelector('[data-testid="right-pane"]')).toBeNull();
    usePaneStore.getState().setHidden(false);
    // 外部 store 更新不经过 act；rerender 强制一次读取最新 store 的渲染。
    view.rerender(<RightPane projectId="p1" />);
    expect(view.container.querySelector('[data-testid="right-pane"]')).not.toBeNull();
  });

  it('exposes a resize handle that persists a new width', () => {
    // 开一个标签让 shell 真正渲染；先给非默认宽度，双击复位才有「复位」可言。
    usePaneStore.setState({
      tabs: [subagentTab('a')],
      activeTabId: 'subagent:a',
      width: 600,
      open: true,
    });
    render(<RightPane projectId="p1" />);
    const handle = screen.getByRole('separator');
    fireEvent.doubleClick(handle); // 复位路径可点
    expect(usePaneStore.getState().width).toBe(PANE_WIDTH_DEFAULT);
    // React 把数值 width 序列化成带 px 的内联样式。
    expect(screen.getByTestId('right-pane').style.width).toBe(
      `${PANE_WIDTH_DEFAULT}px`,
    );
  });
});

describe('RightPane overview', () => {
  it('shows 文件 and Git 图谱 when open with zero tabs on a git project', async () => {
    usePaneStore.setState({ open: true, hidden: false, tabs: [] });
    render(<RightPane projectId="p1" />);
    expect(await screen.findByRole('button', { name: '文件' })).toBeDefined();
    expect(
      await screen.findByRole('button', { name: 'Git 图谱' }),
    ).toBeDefined();
  });

  it('omits the Git category for a non-git project', async () => {
    vi.mocked(fetchGitSummary).mockResolvedValue(gitSummary(false));
    usePaneStore.setState({ open: true, hidden: false, tabs: [] });
    render(<RightPane projectId="p1" />);
    expect(await screen.findByRole('button', { name: '文件' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Git 图谱' })).toBeNull();
  });

  it('keeps the files entry when the git summary probe fails', async () => {
    vi.mocked(fetchGitSummary).mockRejectedValue(new Error('boom'));
    usePaneStore.setState({ open: true, hidden: false, tabs: [] });
    render(<RightPane projectId="p1" />);
    expect(await screen.findByRole('button', { name: '文件' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Git 图谱' })).toBeNull();
  });

  it('shows both categories after clicking the plus button', async () => {
    usePaneStore.setState({
      open: true,
      hidden: false,
      tabs: [subagentTab('a')],
      activeTabId: 'subagent:a',
    });
    render(<RightPane projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: '添加面板' }));
    expect(await screen.findByRole('button', { name: '文件' })).toBeDefined();
    expect(
      await screen.findByRole('button', { name: 'Git 图谱' }),
    ).toBeDefined();
  });

  it('opens a files:p1 tab from the overview', async () => {
    usePaneStore.setState({ open: true, hidden: false, tabs: [] });
    render(<RightPane projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: '文件' }));
    expect(usePaneStore.getState().tabs).toEqual([
      { kind: 'files', id: 'files:p1', projectId: 'p1' },
    ]);
    expect(usePaneStore.getState().activeTabId).toBe('files:p1');
  });

  it('returns to the overview after closing the last tab', async () => {
    usePaneStore.setState({
      open: true,
      hidden: false,
      tabs: [subagentTab('a')],
      activeTabId: 'subagent:a',
    });
    const view = render(<RightPane projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: /关闭 子代理/ }));
    view.rerender(<RightPane projectId="p1" />);
    expect(
      await screen.findByRole('button', { name: '文件' }),
    ).toBeDefined();
    expect(
      view.container.querySelector('[data-testid="right-pane"]'),
    ).not.toBeNull();
  });
});

describe('RightPane tab strip', () => {
  it('scrolls the active tab into view on open and on switch', async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const fileTab = (path: string) =>
      ({ kind: 'file-preview', id: `preview:p1:${path}`, projectId: 'p1', path }) as const;
    usePaneStore.setState({
      tabs: [fileTab('a.ts'), fileTab('b.ts')],
      activeTabId: 'preview:p1:b.ts',
      open: true,
    });
    render(<RightPane projectId="p1" />);
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    const first = scrollSpy.mock.contexts[0] as Element;
    expect(first.getAttribute('data-tab-id')).toBe('preview:p1:b.ts');
    act(() => {
      usePaneStore.getState().setActive('preview:p1:a.ts');
    });
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(2));
    const second = scrollSpy.mock.contexts[1] as Element;
    expect(second.getAttribute('data-tab-id')).toBe('preview:p1:a.ts');
  });
});
