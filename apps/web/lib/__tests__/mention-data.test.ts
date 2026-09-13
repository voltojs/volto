import { describe, it, expect } from 'vitest';
import {
  resolveMentionQuery,
  toMentionEntries,
  searchMatchesToEntries,
  filterEntries,
  drillPath,
} from '../mention-data';

describe('resolveMentionQuery', () => {
  it('空查询 → list 根目录', () => {
    expect(resolveMentionQuery('')).toEqual({ mode: 'list', dir: '' });
  });
  it('尾随 / → list 该目录', () => {
    expect(resolveMentionQuery('src/')).toEqual({ mode: 'list', dir: 'src/' });
  });
  it('含 / 不以 / 结尾 → filter', () => {
    expect(resolveMentionQuery('src/comp')).toEqual({ mode: 'filter', dir: 'src/', basename: 'comp' });
  });
  it('不含 / → search', () => {
    expect(resolveMentionQuery('store')).toEqual({ mode: 'search', term: 'store' });
  });
});

describe('entries 映射', () => {
  const listing = [
    { name: 'src', type: 'dir', size: 0 },
    { name: 'a.ts', type: 'file', size: 12 },
  ] as const;

  it('toMentionEntries 拼出相对路径', () => {
    expect(toMentionEntries('lib/', listing as never)).toEqual([
      { name: 'src', path: 'lib/src', type: 'dir' },
      { name: 'a.ts', path: 'lib/a.ts', type: 'file' },
    ]);
  });
  it('searchMatchesToEntries 用完整路径当 name', () => {
    expect(searchMatchesToEntries(['src/a.ts', 'b.md'])).toEqual([
      { name: 'src/a.ts', path: 'src/a.ts', type: 'file' },
      { name: 'b.md', path: 'b.md', type: 'file' },
    ]);
  });
  it('filterEntries 大小写不敏感前缀', () => {
    const mapped = toMentionEntries('', listing as never);
    expect(filterEntries(mapped, 'A').map((e) => e.name)).toEqual(['a.ts']);
    expect(filterEntries(mapped, 'zz')).toEqual([]);
  });
  it('drillPath 目录加尾斜杠、文件 undefined', () => {
    expect(drillPath({ name: 'src', path: 'src', type: 'dir' })).toBe('src/');
    expect(drillPath({ name: 'a.ts', path: 'a.ts', type: 'file' })).toBeUndefined();
  });
});
