import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';

const LONG_TITLE = 'a very long session title that must never wrap across lines in the header';

function renderHeader() {
  const onFork = vi.fn();
  const onRewind = vi.fn();
  const onExport = vi.fn();
  const onCompact = vi.fn();
  const onToggle = vi.fn();
  render(
    <ChatHeader
      title={LONG_TITLE}
      paneToggle={{ visible: true, disabled: false, onToggle }}
      compactAction={{ disabled: false, onCompact }}
      forkAction={{ disabled: false, onFork }}
      rewindAction={{ disabled: true, onRewind }}
      exportAction={{ onExport }}
    />,
  );
  return { onFork, onRewind, onExport, onCompact, onToggle };
}

describe('ChatHeader actions menu', () => {
  it('collapses secondary actions into an ellipsis menu', () => {
    renderHeader();
    expect(screen.queryByRole('button', { name: '分支会话' })).toBeNull();
    expect(screen.queryByRole('button', { name: '从某一轮重新开始' })).toBeNull();
    expect(screen.queryByRole('button', { name: '导出会话' })).toBeNull();
    expect(screen.queryByRole('button', { name: '压缩上下文' })).toBeNull();
    expect(screen.getByRole('button', { name: '更多操作' })).toBeDefined();
    // The pane toggle stays outside the menu.
    expect(screen.getByRole('button', { name: '收起面板' })).toBeDefined();
  });

  it('opens the menu with the secondary actions and their disabled states', () => {
    const { onExport, onRewind } = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByText('从此会话创建分支')).toBeDefined();
    expect(screen.getByText('从某一轮重新开始（创建分支）')).toBeDefined();
    expect(screen.getByText('导出为 Markdown')).toBeDefined();
    expect(screen.getByText('压缩上下文（摘要旧消息，释放 token）')).toBeDefined();
    // A disabled action must not fire.
    fireEvent.click(screen.getByText('从某一轮重新开始（创建分支）'));
    expect(onRewind).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('导出为 Markdown'));
    expect(onExport).toHaveBeenCalledTimes(1);
  });
});

describe('ChatHeader title', () => {
  it('truncates on one line and keeps the full text for the tooltip', () => {
    renderHeader();
    const title = screen.getByText(LONG_TITLE);
    expect(title.className).toContain('truncate');
    // Hover tooltip target carries the full text as its content.
    expect(title.closest('[data-slot="tooltip-trigger"]')).not.toBeNull();
  });
});

describe('ChatHeader sidebar affordances', () => {
  it('shows no left buttons while the sidebar is open', () => {
    useSessionStore.setState({ sidebarOpen: true });
    renderHeader();
    expect(screen.queryByRole('button', { name: '展开侧栏' })).toBeNull();
    expect(screen.queryByRole('button', { name: '新建对话' })).toBeNull();
  });

  it('shows expand and new-conversation buttons when the sidebar is collapsed', () => {
    useSessionStore.setState({ sidebarOpen: false, currentSessionId: 's9' });
    useChatStore.setState({ events: [{ time: 1, type: 'turn_end', data: { turn: 1, reason: 'end_turn' } }] });
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));
    expect(useSessionStore.getState().currentSessionId).toBeNull();
    expect(useChatStore.getState().events).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '展开侧栏' }));
    expect(useSessionStore.getState().sidebarOpen).toBe(true);
  });
});
