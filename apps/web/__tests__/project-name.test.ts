/**
 * `deriveProjectName` lives in its own module (rather than inline in a
 * component) specifically so it can be tested here without rendering —
 * `apps/web`'s vitest setup has no jsdom.
 */

import { describe, it, expect } from 'vitest';
import { deriveProjectName } from '../lib/project-name.js';

describe('deriveProjectName', () => {
  it('takes the basename of a POSIX path', () => {
    expect(deriveProjectName('/Users/leo/code/demo')).toBe('demo');
  });

  it('takes the basename of a Windows path', () => {
    expect(deriveProjectName('C:\\Users\\leo\\code\\demo')).toBe('demo');
  });

  it('ignores a trailing POSIX separator', () => {
    expect(deriveProjectName('/Users/leo/code/demo/')).toBe('demo');
  });

  it('ignores a trailing Windows separator', () => {
    expect(deriveProjectName('C:\\Users\\leo\\code\\demo\\')).toBe('demo');
  });

  it('falls back to the path itself for the POSIX root', () => {
    expect(deriveProjectName('/')).toBe('/');
  });

  it('uses the drive letter for a bare Windows drive root', () => {
    expect(deriveProjectName('C:\\')).toBe('C:');
  });
});
