import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { usePaneStore, PANE_WIDTH_DEFAULT } from '@/stores/pane-store';

beforeEach(() => {
  usePaneStore.setState({ tabs: [], activeTabId: null, width: PANE_WIDTH_DEFAULT });
});

describe('ChatHeader 文件按钮', () => {
  it('opens a files pane tab for the project when enabled', () => {
    render(<ChatHeader projectName="proj" onOpenFiles={() => usePaneStore.getState().openTab({ kind: 'files', id: 'files:p1', projectId: 'p1' })} filesEnabled />);
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    expect(usePaneStore.getState().activeTabId).toBe('files:p1');
  });

  it('is disabled without a bound project', () => {
    render(<ChatHeader filesEnabled={false} />);
    expect((screen.getByRole('button', { name: '文件' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
