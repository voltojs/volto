/**
 * The sidebar theme button must write the preference, not only flip
 * next-themes' class: the preference sync puts the stored value back, which
 * made the toggle visibly snap back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const setTheme = vi.fn();
const resolvedTheme = vi.fn(() => 'light');

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'light', resolvedTheme: resolvedTheme(), setTheme }),
}));

import { ThemeToggle } from '@/components/theme-toggle';
import { usePreferencesStore } from '@/stores/preferences-store';

const save = vi.fn();

beforeEach(() => {
  setTheme.mockClear();
  save.mockClear();
  resolvedTheme.mockReturnValue('light');
  document.cookie = 'volto_theme=; path=/; max-age=0';
  usePreferencesStore.setState({ preferences: {}, loaded: true, save: save as never });
});

describe('ThemeToggle', () => {
  it('flips the theme and stores it as a preference', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: /切换主题|Toggle theme/ }));

    expect(setTheme).toHaveBeenCalledWith('dark');
    expect(save).toHaveBeenCalledWith({ theme: 'dark' });
    expect(document.cookie).toContain('volto_theme=dark');
  });
});
