import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderShell } from '../ProviderShell';

function renderShell(overrides: Partial<Parameters<typeof ProviderShell>[0]> = {}) {
  const onToggle = vi.fn();
  const onRemove = vi.fn();
  render(
    <ProviderShell
      name="Xiaomi"
      expanded={false}
      onToggle={onToggle}
      onRemove={onRemove}
      {...overrides}
    >
      <div>body</div>
    </ProviderShell>,
  );
  return { onToggle, onRemove };
}

describe('ProviderShell', () => {
  it('expands from the row itself', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderShell();

    await user.click(screen.getByRole('button', { name: '编辑供应商' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation before deleting', async () => {
    const user = userEvent.setup();
    const { onRemove } = renderShell();

    await user.click(screen.getByRole('button', { name: '删除供应商' }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('删除「Xiaomi」？')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('cancel keeps the provider', async () => {
    const user = userEvent.setup();
    const { onRemove } = renderShell();

    await user.click(screen.getByRole('button', { name: '删除供应商' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
