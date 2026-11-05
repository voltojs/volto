/**
 * plain（非 sub-agent）工具调用卡片：ToolCallCard 保持原有折叠渲染，
 * 不含任何 subagent 分支（sub-agent 调用改由 SubagentCard 渲染，
 * 见 subagent-card.test.tsx）。
 */

import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { usePaneStore } from '@/stores/pane-store';
import { ActivitySteps } from '@/components/chat/ActivitySteps';
import { ToolCallCard } from '@/components/chat/ToolCallCard';

describe('ToolCallCard', () => {
  it('plain tool calls keep the existing rendering (no open button, no 运行中)', () => {
    render(<ToolCallCard call={{ id: 'c2', name: 'read_file', args: {} }} />);
    expect(screen.getByText('read_file')).toBeDefined();
    expect(screen.queryByRole('button', { name: /查看执行过程/ })).toBeNull();
    expect(screen.queryByText('运行中')).toBeNull();
  });

  it('renders even a child-bearing call as a plain card (no sub-agent branch)', () => {
    render(
      <ToolCallCard
        call={{
          id: 'c3',
          name: 'task',
          args: { message: 'go' },
          childSessionId: 's-sub-0',
          startedAt: Date.now() - 3000,
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: /查看执行过程/ })).toBeNull();
    expect(screen.queryByText('运行中')).toBeNull();
  });
});

describe('ToolCallCard file ref chip', () => {
  const call = { id: 'c1', name: 'read_file', args: { path: 'src/a.ts' } };

  it('opens the owning project preview when the path chip is clicked', () => {
    usePaneStore.setState({ tabs: [], activeTabId: null, open: false, hidden: true });
    render(<ToolCallCard call={call} label="src/a.ts" fileProjectId="pOwned" />);
    fireEvent.click(screen.getByRole('button', { name: '在右侧面板打开 src/a.ts' }));
    expect(usePaneStore.getState().tabs[0]).toMatchObject({
      kind: 'file-preview',
      projectId: 'pOwned',
      path: 'src/a.ts',
    });
  });

  it('clicking the chip does not toggle the row body', () => {
    render(<ToolCallCard call={call} label="src/a.ts" fileProjectId="pOwned" />);
    fireEvent.click(screen.getByRole('button', { name: '在右侧面板打开 src/a.ts' }));
    expect(screen.queryByText(/"path": "src\/a\.ts"/)).toBeNull();
  });

  it('renders no chip for tools that do not reference one file', () => {
    render(
      <ToolCallCard
        call={{ id: 'c4', name: 'bash', args: { command: 'ls' } }}
        label="ls"
        fileProjectId="p1"
      />,
    );
    expect(screen.queryByRole('button', { name: /在右侧面板打开/ })).toBeNull();
  });

  it('renders no chip when the owning project is unknown', () => {
    render(<ToolCallCard call={call} label="src/a.ts" fileProjectId={null} />);
    expect(screen.queryByRole('button', { name: /在右侧面板打开/ })).toBeNull();
    expect(screen.getByText('src/a.ts')).toBeDefined();
  });
});

describe('ActivitySteps file ref binding', () => {
  it('threads the owning project from the feed into tool cards', () => {
    usePaneStore.setState({ tabs: [], activeTabId: null, open: false, hidden: true });
    render(
      <ActivitySteps
        blocks={[
          { type: 'tool_call', call: { id: 'c9', name: 'read_file', args: { path: 'src/b.ts' } } },
        ]}
        density="detailed"
        fileProjectId="pFeed"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '在右侧面板打开 src/b.ts' }));
    expect(usePaneStore.getState().tabs[0]).toMatchObject({ projectId: 'pFeed', path: 'src/b.ts' });
  });
});
