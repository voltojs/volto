// Registers jest-dom's DOM matchers (toBeInTheDocument, toBeEmptyDOMElement,
// ...) for `.test.tsx` specs that render components with @testing-library/react.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// @testing-library/react's own auto-cleanup only registers itself when
// `afterEach` is already a global (i.e. `test.globals: true`), which this
// project doesn't set. Without this, a portal-rendered popup (like Base
// UI's Select) from one test leaks into the next test's DOM and query
// results.
afterEach(cleanup);

// Component specs render the Chinese UI, so `useTranslations` resolves against
// the shipped zh catalog instead of requiring a provider in every test file.
// The layout-level Provider wiring is covered by the RSC render itself.
import { vi } from 'vitest';
import zhChat from './messages/zh/chat.json';
import zhSidebar from './messages/zh/sidebar.json';
import zhPane from './messages/zh/pane.json';
import zhCommon from './messages/zh/common.json';

const CATALOGS: Record<string, unknown> = {
  chat: zhChat,
  common: zhCommon,
  sidebar: zhSidebar,
  pane: zhPane,
};

function lookup(namespace: string, key: string): unknown {
  let node: unknown = CATALOGS[namespace];
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function format(message: string, params?: Record<string, unknown>): string {
  return message.replace(/\{(\w+)(?:,\s*plural,[^}]*?one\s*\{[^}]*\}[^}]*?other\s*\{([^}]*)\})?\}/g, (all, name: string, other?: string) => {
    const value = params?.[name];
    if (value === undefined) return all;
    if (other !== undefined) return String(value) === '1' ? other : other;
    return String(value);
  });
}

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string, params?: Record<string, unknown>) => {
    const message = lookup(namespace, key);
    return typeof message === 'string' ? format(message, params) : namespace + '.' + key;
  },
  useLocale: () => 'zh',
}));
