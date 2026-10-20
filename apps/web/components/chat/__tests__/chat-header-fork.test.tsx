import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatHeader } from '../ChatHeader';

describe('ChatHeader fork/rewind actions', () => {
  it('renders and invokes the fork and rewind entries', () => {
    const onFork = vi.fn();
    const onRewind = vi.fn();
    render(
      <ChatHeader
        title="session"
        forkAction={{ disabled: false, onFork }}
        rewindAction={{ disabled: false, onRewind }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '分支会话' }));
    fireEvent.click(screen.getByRole('button', { name: '从某一轮重新开始' }));
    expect(onFork).toHaveBeenCalledOnce();
    expect(onRewind).toHaveBeenCalledOnce();
  });

  it('disables both entries while the session is generating', () => {
    render(
      <ChatHeader
        title="session"
        forkAction={{ disabled: true, onFork: vi.fn() }}
        rewindAction={{ disabled: true, onRewind: vi.fn() }}
      />,
    );
    expect(screen.getByRole('button', { name: '分支会话' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '从某一轮重新开始' })).toBeDisabled();
  });
});
