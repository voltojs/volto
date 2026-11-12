import { expect, it } from 'vitest';
import { MESSAGES, resolveInitialLocale } from '../messages';

it('ships identical namespaces and keys in both locales', () => {
  const keys = (o: object, p = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      typeof v === 'object' && v !== null
        ? keys(v as object, `${p}${k}.`)
        : [`${p}${k}`],
    );
  expect(keys(MESSAGES.zh).sort()).toEqual(keys(MESSAGES.en).sort());
});

it('prefers the cookie over the browser languages', () => {
  expect(resolveInitialLocale({ cookie: 'en', languages: ['zh-CN'] })).toBe(
    'en',
  );
  expect(resolveInitialLocale({ cookie: 'bogus', languages: ['en-US'] })).toBe(
    'en',
  );
  expect(resolveInitialLocale({})).toBe('zh');
});
