import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const setTheme = vi.fn();
const refresh = vi.fn();

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

import { GeneralPanel } from '../GeneralPanel';
import { usePreferencesStore } from '@/stores/preferences-store';

const save = vi.fn();

describe('GeneralPanel appearance preferences', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setTheme.mockClear();
    refresh.mockClear();
    usePreferencesStore.setState({
      preferences: {},
      loaded: true,
      save: save as never,
    });
    save.mockClear();
  });

  it('stores the chosen theme in the gateway preferences', async () => {
    const user = userEvent.setup();
    render(<GeneralPanel />);

    const selects = screen.getAllByRole('combobox');
    await user.click(selects[1]!);
    await user.click(await screen.findByRole('option', { name: '深色' }));

    expect(setTheme).toHaveBeenCalledWith('dark');
    expect(save).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('stores the language and refreshes the server render', async () => {
    const user = userEvent.setup();
    render(<GeneralPanel />);

    const selects = screen.getAllByRole('combobox');
    await user.click(selects[0]!);
    await user.click(await screen.findByRole('option', { name: 'English' }));

    expect(save).toHaveBeenCalledWith({ locale: 'en' });
    expect(document.cookie).toContain('volto_locale=en');
    expect(refresh).toHaveBeenCalled();
  });
});
