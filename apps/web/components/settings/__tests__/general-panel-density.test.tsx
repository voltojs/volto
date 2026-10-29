import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

import { GeneralPanel } from '../GeneralPanel';
import { readStreamDensity } from '@/lib/stream-density';

describe('GeneralPanel density', () => {
  beforeEach(() => window.localStorage.clear());

  it('writes the chosen density', async () => {
    const user = userEvent.setup();
    render(<GeneralPanel />);
    expect(screen.getByText('显示模式')).toBeInTheDocument();

    const selects = screen.getAllByRole('combobox');
    await user.click(selects[selects.length - 1]!);
    await user.click(await screen.findByRole('option', { name: '简约' }));

    expect(readStreamDensity()).toBe('concise');
  });
});
