import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RenameSessionDialog } from '../RenameSessionDialog';

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

describe('RenameSessionDialog', () => {
  it('prefills the title and selects it', async () => {
    render(
      <RenameSessionDialog open onOpenChange={vi.fn()} initialTitle="旧标题" onSubmit={vi.fn()} />,
    );
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('旧标题');
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('disables submit for an empty title and submits trimmed text', async () => {
    const onSubmit = vi.fn();
    render(
      <RenameSessionDialog open onOpenChange={vi.fn()} initialTitle="旧标题" onSubmit={onSubmit} />,
    );
    const input = screen.getByRole('textbox');
    await userEvent.clear(input);
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    await userEvent.type(input, '  新标题  ');
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('新标题');
  });

  it('closes without submitting on Escape', async () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <RenameSessionDialog open onOpenChange={onOpenChange} initialTitle="旧标题" onSubmit={onSubmit} />,
    );
    await userEvent.type(screen.getByRole('textbox'), 'x');
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit an unchanged empty title after trimming whitespace', async () => {
    const onSubmit = vi.fn();
    render(
      <RenameSessionDialog open onOpenChange={vi.fn()} initialTitle="旧标题" onSubmit={onSubmit} />,
    );
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), '   ');
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});