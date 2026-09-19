import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalCard } from '../ApprovalCard';
import type { PendingApproval } from '@/lib/approvals';

const askApproval: PendingApproval = {
  callId: 'ask-1',
  toolName: 'ask_user',
  riskTier: 'READ_ONLY',
  question: '选择一个方案',
  options: [{ label: '方案 A', description: '改动最小' }, { label: '方案 B' }],
};

describe('ApprovalCard ask_user 分支', () => {
  it('单选渲染 radio 与"其他"自由输入框', () => {
    render(<ApprovalCard approval={askApproval} onDecide={vi.fn()} />);
    expect(screen.getByText('选择一个方案')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByPlaceholderText(/其他/)).toBeInTheDocument();
  });

  it('multiSelect 渲染 checkbox', () => {
    render(
      <ApprovalCard
        approval={{ ...askApproval, multiSelect: true }}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('无 options 时渲染纯文本框', () => {
    render(
      <ApprovalCard
        approval={{
          callId: 'ask-2',
          toolName: 'ask_user',
          riskTier: 'READ_ONLY',
          question: '继续吗？',
        }}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText('继续吗？')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/其他/)).toBeInTheDocument();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('什么都没选时提交按钮禁用', () => {
    render(<ApprovalCard approval={askApproval} onDecide={vi.fn()} />);
    expect(screen.getByRole('button', { name: '提交回答' })).toBeDisabled();
  });

  it('多选 + 自由输入提交 → allow + answer（用户选择顺序，自由输入追加）', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <ApprovalCard
        approval={{ ...askApproval, multiSelect: true }}
        onDecide={onDecide}
      />,
    );
    // 先选 B 再选 A：answer 必须按用户的点击顺序，而非展示顺序。
    await user.click(screen.getByRole('checkbox', { name: /方案 B/ }));
    await user.click(screen.getByRole('checkbox', { name: /方案 A/ }));
    await user.type(screen.getByPlaceholderText(/其他/), '补充说明');
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith('ask-1', 'allow', [
      '方案 B',
      '方案 A',
      '补充说明',
    ]);
  });

  it('单选 + 提交 → allow + 单个选择', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<ApprovalCard approval={askApproval} onDecide={onDecide} />);
    await user.click(screen.getByRole('radio', { name: /方案 A/ }));
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith('ask-1', 'allow', ['方案 A']);
  });

  it('跳过 → deny 且不带 answer', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<ApprovalCard approval={askApproval} onDecide={onDecide} />);
    await user.click(screen.getByRole('button', { name: '跳过' }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]?.[0]).toBe('ask-1');
    expect(onDecide.mock.calls[0]?.[1]).toBe('deny');
    expect(onDecide.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('非 ask_user 审批卡保持原样：允许一次 → allow 无 answer', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <ApprovalCard
        approval={{
          callId: 'call-1',
          toolName: 'bash',
          riskTier: 'WORKSPACE_WRITE',
          input: { command: 'ls' },
        }}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByRole('button', { name: '允许一次' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '跳过' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '允许一次' }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]?.[1]).toBe('allow');
    expect(onDecide.mock.calls[0]?.[2]).toBeUndefined();
  });
});
