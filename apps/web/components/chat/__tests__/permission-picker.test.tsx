import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PermissionPicker } from '../PermissionPicker';

describe('PermissionPicker', () => {
  it('plan 态渲染禁用徽标"计划中"，不渲染四档选择器', () => {
    render(<PermissionPicker value="plan" onChange={vi.fn()} />);
    const badge = screen.getByTitle('计划模式：批准计划后执行，悬停可手动退出');
    expect(badge).toHaveTextContent('计划中');
    // 徽标不挂 aria-disabled：内含可交互的退出按钮，禁用语义会连带波及它。
    expect(badge).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('非 plan 态仍是四档选择器', () => {
    render(<PermissionPicker value="ask" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.queryByText('计划中')).toBeNull();
  });

  it('plan 态 hover 显示 × 退出按钮，点击调用 onExitPlan', () => {
    const onExitPlan = vi.fn();
    render(<PermissionPicker value="plan" onChange={vi.fn()} onExitPlan={onExitPlan} />);
    const badge = screen.getByText('计划中').closest('span')!;
    const exit = screen.getByRole('button', { name: '退出计划模式' });
    // hover 前隐藏，悬停后经 group-hover 显形
    expect(exit).toHaveClass('opacity-0');
    fireEvent.mouseEnter(badge);
    expect(exit).toHaveClass('group-hover:opacity-100');
    fireEvent.click(exit);
    expect(onExitPlan).toHaveBeenCalledOnce();
  });

  it('未传 onExitPlan 时不渲染退出入口', () => {
    render(<PermissionPicker value="plan" onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '退出计划模式' })).not.toBeInTheDocument();
  });
});
