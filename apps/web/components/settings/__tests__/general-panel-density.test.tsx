import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

import { GeneralPanel } from '../GeneralPanel';
import { readStreamDensity } from '@/lib/stream-density';
import { usePreferencesStore } from '@/stores/preferences-store';

describe('GeneralPanel', () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePreferencesStore.setState({ preferences: {}, loaded: true });
    vi.restoreAllMocks();
  });

  it('writes the chosen density', async () => {
    const user = userEvent.setup();
    render(<GeneralPanel />);
    expect(screen.getByText('显示模式')).toBeInTheDocument();

    // Theme, density, default permission — density is the second one.
    const selects = screen.getAllByRole('combobox');
    await user.click(selects[1]!);
    await user.click(await screen.findByRole('option', { name: '简约' }));

    expect(readStreamDensity()).toBe('concise');
  });

  it('persists the default permission for new sessions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ defaultPermissionMode: 'auto' }), { status: 200 }),
    );
    const user = userEvent.setup();
    render(<GeneralPanel />);
    expect(screen.getByText('新会话默认权限')).toBeInTheDocument();

    const selects = screen.getAllByRole('combobox');
    await user.click(selects[2]!);
    await user.click(await screen.findByRole('option', { name: '自动' }));

    expect(usePreferencesStore.getState().preferences.defaultPermissionMode).toBe('auto');
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/preferences'),
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});
