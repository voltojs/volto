import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatHeader } from '@/components/chat/ChatHeader';

describe('ChatHeader 面板切换按钮', () => {
  it('renders the collapse affordance and calls onToggle when visible', () => {
    const onToggle = vi.fn();
    render(
      <ChatHeader title="会话标题" paneToggle={{ visible: true, disabled: false, onToggle }} />,
    );
    expect(screen.getByText('会话标题')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起面板' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders the open affordance when the pane is hidden', () => {
    const onToggle = vi.fn();
    render(
      <ChatHeader title="会话标题" paneToggle={{ visible: false, disabled: false, onToggle }} />,
    );
    expect(screen.getByRole('button', { name: '展开面板' })).toBeDefined();
  });

  it('is disabled when there is nothing to show or reopen', () => {
    render(
      <ChatHeader title="探索未至之境" paneToggle={{ visible: false, disabled: true, onToggle: () => {} }} />,
    );
    expect((screen.getByRole('button', { name: '展开面板' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('renders no toggle button without paneToggle props', () => {
    render(<ChatHeader title="欢迎" />);
    expect(screen.queryByRole('button', { name: '展开面板' })).toBeNull();
    expect(screen.queryByRole('button', { name: '收起面板' })).toBeNull();
  });
});
