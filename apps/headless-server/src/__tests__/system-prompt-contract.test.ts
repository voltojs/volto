import { describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from '../wiring.js';

describe('DEFAULT_SYSTEM_PROMPT file-reference contract', () => {
  it('spells the file-reference output contract', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('full path from the project root');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Never use bare file names');
  });
});
