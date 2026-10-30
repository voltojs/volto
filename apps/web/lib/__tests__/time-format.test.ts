import { describe, expect, it } from 'vitest';
import { formatTimestamp } from '../time-format';

describe('formatTimestamp', () => {
  it('renders a zero-padded, locale-independent date-time', () => {
    const ms = new Date(2026, 0, 5, 9, 7, 3).getTime();
    expect(formatTimestamp(ms)).toBe('2026-01-05 09:07:03');
  });

  it('stays sortable across months and days', () => {
    expect(formatTimestamp(new Date(2026, 11, 31, 23, 59, 59).getTime())).toBe(
      '2026-12-31 23:59:59',
    );
  });
});
