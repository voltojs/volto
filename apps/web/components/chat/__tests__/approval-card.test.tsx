import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// ── remember (Task 4) ──────────────────────────────────────────────────────

function bashApproval(command: string): PendingApproval {
  return {
    callId: 'c1',
    toolName: 'bash',
    riskTier: 'WRITE_HIGH',
    input: { command },
  };
}

describe('ApprovalCard remember 功能', () => {
  let onDecide: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onDecide = vi.fn().mockResolvedValue(undefined);
  });

  it('为简单 bash 命令展示前缀选择器，默认选中完整 argv', () => {
    render(<ApprovalCard approval={bashApproval('pnpm test --filter x')} onDecide={onDecide} />);
    expect(screen.getByText('始终允许…')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'pnpm test --filter x' })).toBeChecked();
  });

  it('复合命令不展示 remember 入口', () => {
    render(<ApprovalCard approval={bashApproval('pnpm test; rm -rf /tmp/x')} onDecide={onDecide} />);
    expect(screen.queryByText('始终允许…')).toBeNull();
  });

  it('发送选中的前缀 token 数并渲染回执', async () => {
    const user = userEvent.setup();
    onDecide.mockResolvedValue({
      remembered: { rule: { toolName: 'bash', commandPrefix: ['pnpm'], decision: 'allow' }, outcome: 'saved', effectiveFrom: 'next_turn' },
    });
    render(<ApprovalCard approval={bashApproval('pnpm test')} onDecide={onDecide} />);
    await user.click(screen.getByRole('radio', { name: 'pnpm' }));
    await user.click(screen.getByRole('button', { name: '记住并允许' }));
    expect(onDecide).toHaveBeenCalledWith('c1', 'allow', undefined, { prefixTokens: 1 });
    expect(await screen.findByText(/已保存/)).toBeInTheDocument();
  });

  it('规则保存失败时如实展示，不显示"已保存"文本', async () => {
    const user = userEvent.setup();
    onDecide.mockResolvedValue({ rememberError: 'permissions.json: rules[0] …' });
    render(<ApprovalCard approval={bashApproval('pnpm test')} onDecide={onDecide} />);
    await user.click(screen.getByRole('button', { name: '记住并允许' }));
    expect(await screen.findByText(/未能保存规则/)).toBeInTheDocument();
    expect(screen.queryByText(/已保存/)).toBeNull();
  });

  it('covered 结果展示已覆盖提示', async () => {
    const user = userEvent.setup();
    onDecide.mockResolvedValue({
      remembered: { rule: { toolName: 'bash', commandPrefix: ['pnpm'], decision: 'allow' }, outcome: 'covered', effectiveFrom: 'next_turn' },
    });
    render(<ApprovalCard approval={bashApproval('pnpm test')} onDecide={onDecide} />);
    await user.click(screen.getByRole('button', { name: '记住并允许' }));
    expect(await screen.findByText(/已被现有更宽规则覆盖/)).toBeInTheDocument();
  });

  it('记住规则的提示指向 config.json 的 permissions 分区，而不是已迁移的旧文件', () => {
    render(<ApprovalCard approval={bashApproval('pnpm test')} onDecide={onDecide} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('~/.volto/config.json');
    expect(text).toContain('permissions.rules');
    expect(text).not.toContain('permissions.json');
  });

  it('非 bash 工具不展示 remember 入口', () => {
    render(
      <ApprovalCard
        approval={{ callId: 'c2', toolName: 'write_file', riskTier: 'WRITE_HIGH', input: { path: 'a.ts' } }}
        onDecide={onDecide}
      />,
    );
    expect(screen.queryByText('始终允许…')).toBeNull();
  });
});

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
    expect(onDecide.mock.calls[0]?.[0]).toBe('ask-1');
    expect(onDecide.mock.calls[0]?.[1]).toBe('allow');
    expect(onDecide.mock.calls[0]?.[2]).toEqual([
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
    expect(onDecide.mock.calls[0]?.[0]).toBe('ask-1');
    expect(onDecide.mock.calls[0]?.[1]).toBe('allow');
    expect(onDecide.mock.calls[0]?.[2]).toEqual(['方案 A']);
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
