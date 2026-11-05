import { describe, expect, it } from 'vitest';
import { splitHighlightedLines } from '../split-code-lines';

describe('splitHighlightedLines', () => {
  it('splits plain text lines 1:1', () => {
    expect(splitHighlightedLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
    expect(splitHighlightedLines('')).toEqual(['']);
  });

  it('keeps the trailing empty line so line numbers stay aligned', () => {
    expect(splitHighlightedLines('a\n')).toEqual(['a', '']);
  });

  it('keeps single-line spans intact', () => {
    expect(splitHighlightedLines('<span class="hljs-keyword">const</span> x')).toEqual([
      '<span class="hljs-keyword">const</span> x',
    ]);
    expect(splitHighlightedLines('a\n<span class="hljs-keyword">b</span>')).toEqual([
      'a',
      '<span class="hljs-keyword">b</span>',
    ]);
  });

  it('reopens a span that crosses a line break on the next line', () => {
    const html = '<span class="hljs-comment">// a\n// b</span>';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="hljs-comment">// a</span>',
      '<span class="hljs-comment">// b</span>',
    ]);
  });

  it('reopens nested spans in the original order', () => {
    const html = '<span class="a"><span class="b">x\ny</span></span>';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="a"><span class="b">x</span></span>',
      '<span class="a"><span class="b">y</span></span>',
    ]);
  });

  it('handles several line breaks inside one span', () => {
    const html = '<span class="s">1\n2\n3</span>';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="s">1</span>',
      '<span class="s">2</span>',
      '<span class="s">3</span>',
    ]);
  });
});
