import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '@/lib/diff-view';

describe('parseUnifiedDiff', () => {
  it('numbers both sides across a replacement hunk', () => {
    const rows = parseUnifiedDiff(
      ['@@ -2,3 +2,3 @@', ' keep', '-old', '+new', ' keep2', ' keep3'].join('\n'),
    );
    expect(rows[0]).toEqual({ kind: 'hunk', text: '@@ -2,3 +2,3 @@' });
    expect(rows[1]).toEqual({ kind: 'context', text: 'keep', oldLine: 2, newLine: 2 });
    expect(rows[2]).toEqual({ kind: 'remove', text: 'old', oldLine: 3 });
    expect(rows[3]).toEqual({ kind: 'add', text: 'new', newLine: 3 });
    expect(rows[4]).toEqual({ kind: 'context', text: 'keep2', oldLine: 4, newLine: 4 });
    expect(rows[5]).toEqual({ kind: 'context', text: 'keep3', oldLine: 5, newLine: 5 });
  });

  it('restarts numbering at each hunk header', () => {
    const rows = parseUnifiedDiff(
      ['@@ -1,1 +1,1 @@', '-a', '+b', '@@ -40,1 +40,1 @@', '-c', '+d'].join('\n'),
    );
    expect(rows[3]).toEqual({ kind: 'hunk', text: '@@ -40,1 +40,1 @@' });
    expect(rows[4]).toEqual({ kind: 'remove', text: 'c', oldLine: 40 });
    expect(rows[5]).toEqual({ kind: 'add', text: 'd', newLine: 40 });
  });

  it('renders a creation hunk from -0,0', () => {
    const rows = parseUnifiedDiff(['@@ -0,0 +1,2 @@', '+one', '+two'].join('\n'));
    expect(rows[1]).toEqual({ kind: 'add', text: 'one', newLine: 1 });
    expect(rows[2]).toEqual({ kind: 'add', text: 'two', newLine: 2 });
  });

  it('skips unknown lines instead of fabricating context', () => {
    const rows = parseUnifiedDiff(['@@ -1,1 +1,1 @@', 'not a diff line', '-a', '+b'].join('\n'));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ kind: 'remove', text: 'a' });
  });

  it('returns no rows for an empty body', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});