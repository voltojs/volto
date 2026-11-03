import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const refresh = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { LocalePreferenceSync } from '@/components/locale-sync';
import { usePreferencesStore } from '@/stores/preferences-store';

describe('LocalePreferenceSync', () => {
  beforeEach(() => {
    refresh.mockClear();
    document.cookie = 'volto_locale=; path=/; max-age=0';
    usePreferencesStore.setState({ preferences: {}, loaded: true });
  });

  it('rewrites the cookie and refreshes when the stored locale differs', () => {
    usePreferencesStore.setState({ preferences: { locale: 'en' }, loaded: true });
    render(<LocalePreferenceSync />);
    expect(document.cookie).toContain('volto_locale=en');
    expect(refresh).toHaveBeenCalled();
  });

  it('does nothing when the rendered locale already matches', () => {
    // The test harness renders with `zh` (vitest.setup mocks useLocale).
    usePreferencesStore.setState({ preferences: { locale: 'zh' }, loaded: true });
    render(<LocalePreferenceSync />);
    expect(refresh).not.toHaveBeenCalled();
  });
});
