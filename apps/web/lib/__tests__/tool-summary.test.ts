import { describe, expect, it } from 'vitest';
import { toolCallSummary } from '../tool-summary';

describe('toolCallSummary', () => {
  it('labels the known tools', () => {
    expect(toolCallSummary('bash', { command: 'pnpm test\nmore' })).toBe('pnpm test');
    expect(toolCallSummary('edit_file', { path: 'src/a.ts' })).toBe('src/a.ts');
    expect(toolCallSummary('grep', { pattern: 'TODO', path: 'packages' })).toBe('TODO in packages');
    expect(toolCallSummary('web_fetch', { url: 'https://x.dev' })).toBe('https://x.dev');
    expect(toolCallSummary('task', { description: 'review PR' })).toBe('review PR');
  });

  it('falls back to the tool name and never throws', () => {
    expect(toolCallSummary('mystery', {})).toBe('mystery');
    expect(toolCallSummary('bash', {})).toBe('bash');
    expect(toolCallSummary('read_file', { path: 42 })).toBe('read_file');
  });

  it('labels a web search with its source and hit count', () => {
    const t = (key: string, params?: Record<string, string | number>): string =>
      key === 'tool.webSearchHits' ? `${String(params?.['count'])} 条` : key;
    expect(
      toolCallSummary('web_search', { query: 'q' }, t, { sourceLabel: 'GLM', count: 5 }),
    ).toBe('GLM · q · 5 条');
    expect(toolCallSummary('web_search', { query: 'q' })).toBe('q');
  });

  it('truncates by code point without splitting a surrogate pair', () => {
    const label = toolCallSummary('bash', { command: '🚀'.repeat(100) });
    expect(Array.from(label).length).toBeLessThanOrEqual(80);
    expect(label).not.toContain('\uFFFD');
  });
});
