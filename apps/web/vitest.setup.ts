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
