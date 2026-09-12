import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RightPane } from '@/components/pane/RightPane';
import { usePaneStore, PANE_WIDTH_DEFAULT } from '@/stores/pane-store';
import { useChatStore } from '@/stores/chat-store';

vi.mock('@/lib/sessions-api', () => ({
  fetchSessionEvents: vi.fn().mockResolvedValue({ sessionId: 'x', events: [] }),
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

beforeEach(() => {
  usePaneStore.setState({
    tabs: [],
    activeTabId: null,
    width: PANE_WIDTH_DEFAULT,
  });
  useChatStore.setState({ subagents: {} });
});

describe('RightPane', () => {
  it('renders nothing when no tabs are open', () => {
    const { container } = render(<RightPane />);
    expect(container.querySelector('[data-testid="right-pane"]')).toBeNull();
  });

  it('renders the active tab body and switches on click', () => {
    usePaneStore.setState({
      tabs: [subagentTab('a'), subagentTab('b')],
      activeTabId: 'subagent:a',
    });
    render(<RightPane />);
    expect(screen.getByText(/…a$/)).toBeDefined();
    fireEvent.click(screen.getByText(/…b$/));
    expect(usePaneStore.getState().activeTabId).toBe('subagent:b');
  });

  it('closes a tab via its close button', () => {
    usePaneStore.setState({
      tabs: [subagentTab('a')],
      activeTabId: 'subagent:a',
    });
    render(<RightPane />);
    fireEvent.click(screen.getByRole('button', { name: /关闭 子代理/ }));
    expect(usePaneStore.getState().tabs).toHaveLength(0);
  });

  it('resets drag state on pointercancel so later moves cannot jump the width', () => {
    usePaneStore.setState({
      tabs: [subagentTab('a')],
      activeTabId: 'subagent:a',
      width: 500,
    });
    render(<RightPane />);
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

  it('exposes a resize handle that persists a new width', () => {
    // 开一个标签让 shell 真正渲染（空 tabs 时 RightPane 返回 null，见上例）；
    // 先给非默认宽度，双击复位才有「复位」可言。
    usePaneStore.setState({
      tabs: [subagentTab('a')],
      activeTabId: 'subagent:a',
      width: 600,
    });
    render(<RightPane />);
    const handle = screen.getByRole('separator');
    fireEvent.doubleClick(handle); // 复位路径可点
    expect(usePaneStore.getState().width).toBe(PANE_WIDTH_DEFAULT);
    // React 把数值 width 序列化成带 px 的内联样式。
    expect(screen.getByTestId('right-pane').style.width).toBe(
      `${PANE_WIDTH_DEFAULT}px`,
    );
  });
});
