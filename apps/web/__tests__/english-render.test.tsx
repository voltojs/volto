/**
 * English smoke gate: the components must render English copy from the `en`
 * catalog, not fall back to zh or to raw keys. The rest of the suite runs with
 * the zh mock, so without this file the en catalogue is never exercised.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.unmock('next-intl');

import { NextIntlClientProvider } from 'next-intl';
import enChat from '../messages/en/chat.json';
import { PermissionPicker } from '@/components/chat/PermissionPicker';

describe('English rendering', () => {
  it('renders the permission picker in English', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ chat: enChat }}>
        <PermissionPicker value="ask" onChange={() => {}} />
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole('combobox')).toHaveTextContent('Ask');
  });
});
