import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PermissionPicker } from '../PermissionPicker';

describe('PermissionPicker', () => {
  it('plan 态渲染禁用徽标"计划中"，不渲染四档选择器', () => {
    render(<PermissionPicker value="plan" onChange={vi.fn()} />);
    const badge = screen.getByTitle('退出计划：批准计划或手动切换权限');
    expect(badge).toHaveTextContent('计划中');
    expect(badge).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('非 plan 态仍是四档选择器', () => {
    render(<PermissionPicker value="ask" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.queryByText('计划中')).toBeNull();
  });
});
