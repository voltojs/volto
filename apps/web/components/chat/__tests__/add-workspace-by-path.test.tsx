// @vitest-environment jsdom
/**
 * The typed-path fallback itself: one field, and it submits what was typed.
 * The DECISION to show it at all is covered by `use-add-project.test.tsx`.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AddWorkspaceByPathDialog } from '../AddWorkspaceByPathDialog';

describe('AddWorkspaceByPathDialog', () => {
  it('submits the trimmed typed path', async () => {
    const onSubmit = vi.fn(async () => ({ id: 'p1' }));
    render(
      <AddWorkspaceByPathDialog
        open
        onOpenChange={() => {}}
        onSubmit={onSubmit}
        pending={false}
      />,
    );

    const field = screen.getByLabelText('目录路径') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '  /srv/myrepo  ' } });
    fireEvent.click(screen.getByRole('button', { name: '添加工作区' }));

    expect(onSubmit).toHaveBeenCalledWith('/srv/myrepo');
    expect(field.value).toBe('  /srv/myrepo  ');
  });

  it('cannot submit an empty path', () => {
    const onSubmit = vi.fn(async () => null);
    render(
      <AddWorkspaceByPathDialog
        open
        onOpenChange={() => {}}
        onSubmit={onSubmit}
        pending={false}
      />,
    );

    const submit = screen.getByRole('button', {
      name: '添加工作区',
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
