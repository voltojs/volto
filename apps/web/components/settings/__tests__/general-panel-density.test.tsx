import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

import { GeneralPanel } from '../GeneralPanel';
import { usePreferencesStore } from '@/stores/preferences-store';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe('GeneralPanel', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    usePreferencesStore.setState({ preferences: {}, loaded: true });
    vi.restoreAllMocks();
  });

  it('writes the chosen density', async () => {
    const user = userEvent.setup();
    render(<GeneralPanel />);
    expect(screen.getByText('显示模式')).toBeInTheDocument();

    // Language, theme, density, default permission — density is the third.
    const selects = screen.getAllByRole('combobox');
    await user.click(selects[2]!);
    await user.click(await screen.findByRole('option', { name: '简约' }));

    expect(usePreferencesStore.getState().preferences.streamDensity).toBe('concise');
  });

  it('persists the default permission for new sessions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ defaultPermissionMode: 'auto' }), { status: 200 }),
    );
    const user = userEvent.setup();
    render(<GeneralPanel />);
    expect(screen.getByText('新会话默认权限')).toBeInTheDocument();

    const selects = screen.getAllByRole('combobox');
    await user.click(selects[3]!);
    await user.click(await screen.findByRole('option', { name: /自动/ }));

    expect(usePreferencesStore.getState().preferences.defaultPermissionMode).toBe('auto');
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/preferences'),
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});
