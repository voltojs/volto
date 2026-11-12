import { describe, expect, it } from 'vitest';
import { resolveInitialLocale } from '../messages';

describe('resolveInitialLocale', () => {
  it('prefers the stored cookie over the browser languages', () => {
    expect(resolveInitialLocale({ cookie: 'en', languages: ['zh-CN'] })).toBe(
      'en',
    );
    expect(resolveInitialLocale({ cookie: 'zh', languages: ['en-US'] })).toBe(
      'zh',
    );
  });

  it('falls back to the first shipped browser language', () => {
    expect(resolveInitialLocale({ languages: ['en-US', 'en'] })).toBe('en');
    expect(resolveInitialLocale({ languages: ['zh-CN', 'zh'] })).toBe('zh');
    expect(resolveInitialLocale({ languages: ['fr-FR', 'en-GB'] })).toBe('en');
  });

  it('defaults to Chinese when nothing decides', () => {
    expect(resolveInitialLocale({})).toBe('zh');
    expect(resolveInitialLocale({ languages: [] })).toBe('zh');
    expect(resolveInitialLocale({ languages: ['fr-FR'] })).toBe('zh');
  });

  it('ignores values the product does not ship', () => {
    expect(resolveInitialLocale({ cookie: 'fr', languages: ['de'] })).toBe(
      'zh',
    );
  });
});
