import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatHeader } from '../ChatHeader';

describe('ChatHeader fork/rewind actions', () => {
  it('renders and invokes the fork and rewind menu entries', () => {
    const onFork = vi.fn();
    const onRewind = vi.fn();
    const onExport = vi.fn();
    render(
      <ChatHeader
        title="session"
        forkAction={{ disabled: false, onFork }}
        rewindAction={{ disabled: false, onRewind }}
        exportAction={{ onExport }}
      />,
    );
    // Each selection closes the menu — reopen for the next entry.
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('从此会话创建分支'));
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('从某一轮重新开始（创建分支）'));
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('导出为 Markdown'));
    expect(onFork).toHaveBeenCalledOnce();
    expect(onRewind).toHaveBeenCalledOnce();
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('disables both entries while the session is generating', () => {
    const onFork = vi.fn();
    const onRewind = vi.fn();
    render(
      <ChatHeader
        title="session"
        forkAction={{ disabled: true, onFork }}
        rewindAction={{ disabled: true, onRewind }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('从此会话创建分支'));
    fireEvent.click(screen.getByText('从某一轮重新开始（创建分支）'));
    expect(onFork).not.toHaveBeenCalled();
    expect(onRewind).not.toHaveBeenCalled();
  });
});
