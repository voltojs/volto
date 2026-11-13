import { describe, expect, it } from 'vitest';
import {
  parseAnnotationRef,
  parentDir,
  parseFileRef,
  parseLinkRef,
  resolveFileRef,
  toolCallFileRef,
} from '../parse.js';

describe('parseFileRef', () => {
  it('parses a plain project-relative path', () => {
    expect(parseFileRef('src/foo.ts')).toEqual({ path: 'src/foo.ts' });
  });

  it('parses a single-segment filename with a real extension', () => {
    expect(parseFileRef('README.md')).toEqual({ path: 'README.md' });
  });

  it('parses dotfiles', () => {
    expect(parseFileRef('.gitignore')).toEqual({ path: '.gitignore' });
    expect(parseFileRef('.env.local')).toEqual({ path: '.env.local' });
  });

  it('parses path:line', () => {
    expect(parseFileRef('packages/core/src/step.ts:42')).toEqual({
      path: 'packages/core/src/step.ts',
      line: 42,
    });
  });

  it('parses path:line:col keeping the line and dropping the column', () => {
    expect(parseFileRef('src/foo.ts:42:7')).toEqual({ path: 'src/foo.ts', line: 42 });
  });

  it('parses path:start-end as a line range', () => {
    expect(parseFileRef('src/foo.ts:10-20')).toEqual({
      path: 'src/foo.ts',
      line: 10,
      endLine: 20,
    });
  });

  it('parses path#L42 and path#L42-L50', () => {
    expect(parseFileRef('src/foo.ts#L42')).toEqual({ path: 'src/foo.ts', line: 42 });
    expect(parseFileRef('src/foo.ts#L42-L50')).toEqual({
      path: 'src/foo.ts',
      line: 42,
      endLine: 50,
    });
  });

  it('strips wrapping backticks, quotes and brackets', () => {
    expect(parseFileRef('`src/foo.ts`')).toEqual({ path: 'src/foo.ts' });
    expect(parseFileRef('"src/foo.ts"')).toEqual({ path: 'src/foo.ts' });
    expect(parseFileRef('(src/foo.ts)')).toEqual({ path: 'src/foo.ts' });
    expect(parseFileRef('[src/foo.ts]')).toEqual({ path: 'src/foo.ts' });
  });

  it('strips trailing sentence punctuation', () => {
    expect(parseFileRef('src/foo.ts.')).toEqual({ path: 'src/foo.ts' });
    expect(parseFileRef('src/foo.ts:42,')).toEqual({ path: 'src/foo.ts', line: 42 });
    expect(parseFileRef('src/foo.ts:42.')).toEqual({ path: 'src/foo.ts', line: 42 });
    expect(parseFileRef('src/foo.ts:')).toEqual({ path: 'src/foo.ts' });
  });

  it('normalizes a leading ./', () => {
    expect(parseFileRef('./src/foo.ts')).toEqual({ path: 'src/foo.ts' });
  });

  it('accepts unicode path segments', () => {
    expect(parseFileRef('文档/说明.md')).toEqual({ path: '文档/说明.md' });
  });

  it('rejects common abbreviations and extensionless words', () => {
    expect(parseFileRef('e.g.')).toBeNull();
    expect(parseFileRef('i.e.')).toBeNull();
    expect(parseFileRef('etc.')).toBeNull();
    expect(parseFileRef('foo')).toBeNull();
    expect(parseFileRef('a.b')).toBeNull();
  });

  it('rejects URLs and network-looking strings', () => {
    expect(parseFileRef('http://example.com/a.ts')).toBeNull();
    expect(parseFileRef('https://example.com')).toBeNull();
    expect(parseFileRef('www.example.com')).toBeNull();
  });

  it('rejects absolute, home and escaping paths', () => {
    expect(parseFileRef('/abs/path.ts')).toBeNull();
    expect(parseFileRef('~/x.ts')).toBeNull();
    expect(parseFileRef('../up.ts')).toBeNull();
    expect(parseFileRef('src/../x.ts')).toBeNull();
    expect(parseFileRef('C:\\win\\x.ts')).toBeNull();
  });

  it('rejects strings with whitespace or multi-line text', () => {
    expect(parseFileRef('a b.ts')).toBeNull();
    expect(parseFileRef('src/foo.ts\nsrc/bar.ts')).toBeNull();
  });

  it('rejects invalid or absurd line suffixes', () => {
    expect(parseFileRef('src/foo.ts:0')).toBeNull();
    expect(parseFileRef('src/foo.ts:20-10')).toBeNull();
    expect(parseFileRef('src/foo.ts:99999999')).toBeNull();
  });

  it('rejects empty and whitespace-only input', () => {
    expect(parseFileRef('')).toBeNull();
    expect(parseFileRef('   ')).toBeNull();
  });
});

describe('toolCallFileRef', () => {
  it('extracts a ref for the fs tools', () => {
    expect(toolCallFileRef('read_file', { path: 'src/a.ts' })).toEqual({ path: 'src/a.ts' });
    expect(toolCallFileRef('write_file', { file_path: 'x/y.md' })).toEqual({ path: 'x/y.md' });
    expect(toolCallFileRef('edit_file', { path: 'a/b.ts' })).toEqual({ path: 'a/b.ts' });
  });

  it('rejects non-project paths for the fs tools', () => {
    expect(toolCallFileRef('read_file', { path: '/abs/x.ts' })).toBeNull();
    expect(toolCallFileRef('read_file', { path: '' })).toBeNull();
    expect(toolCallFileRef('read_file', {})).toBeNull();
  });

  it('returns null for tools that do not reference one file', () => {
    expect(toolCallFileRef('bash', { command: 'cat src/a.ts' })).toBeNull();
    expect(toolCallFileRef('grep', { pattern: 'foo', path: 'src' })).toBeNull();
    expect(toolCallFileRef('glob', { pattern: 'src/**/*.ts' })).toBeNull();
  });
});

describe('parseLinkRef', () => {
  it('accepts relative file forms that parseFileRef rejects', () => {
    expect(parseLinkRef('./other.md')).toEqual({ path: './other.md' });
    expect(parseLinkRef('../x.md')).toEqual({ path: '../x.md' });
    // Links share the file-shape gate: extensionless targets stay inert.
    expect(parseLinkRef('other')).toBeNull();
  });

  it('keeps line suffixes and the rejection rules', () => {
    expect(parseLinkRef('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', line: 42 });
    expect(parseLinkRef('https://example.com')).toBeNull();
    expect(parseLinkRef('#anchor')).toBeNull();
    expect(parseLinkRef('a b.md')).toBeNull();
  });
});

describe('resolveFileRef', () => {
  it('resolves against the base directory', () => {
    expect(resolveFileRef('docs', { path: './other.md' })).toEqual({ path: 'docs/other.md' });
    expect(resolveFileRef('docs', { path: '../root.ts' })).toEqual({ path: 'root.ts' });
    expect(resolveFileRef('', { path: 'src/a.ts' })).toEqual({ path: 'src/a.ts' });
    expect(resolveFileRef('', { path: './a.ts' })).toEqual({ path: 'a.ts' });
  });

  it('normalizes inner dot segments', () => {
    expect(resolveFileRef('docs', { path: 'a/./b/../c.ts' })).toEqual({ path: 'docs/a/c.ts' });
  });

  it('rejects paths that escape the project root', () => {
    expect(resolveFileRef('', { path: '../up.ts' })).toBeNull();
    expect(resolveFileRef('docs', { path: '../../up.ts' })).toBeNull();
    expect(resolveFileRef('docs', { path: '../' })).toBeNull();
  });

  it('keeps line targets', () => {
    expect(resolveFileRef('docs', { path: 'x.md', line: 3, endLine: 4 })).toEqual({
      path: 'docs/x.md',
      line: 3,
      endLine: 4,
    });
  });
});

describe('parentDir', () => {
  it('returns the containing directory', () => {
    expect(parentDir('docs/guide.md')).toBe('docs');
    expect(parentDir('docs/a/b.md')).toBe('docs/a');
    expect(parentDir('README.md')).toBe('');
  });
});

describe('package-name and directory refs stay plain text', () => {
  it('rejects npm-scope and alias refs — they name packages, not files', () => {
    expect(parseFileRef('@voltojs/core')).toBeNull();
    expect(parseFileRef('`@/lib/utils`'.slice(1, -1))).toBeNull();
    expect(parseLinkRef('@voltojs/core')).toBeNull();
  });

  it('rejects trailing-slash directory refs — only files are judged', () => {
    expect(parseFileRef('packages/tools/')).toBeNull();
    expect(parseFileRef('providers/')).toBeNull();
  });

  it('keeps ordinary file refs clickable', () => {
    expect(parseFileRef('src/foo.ts')).toEqual({ path: 'src/foo.ts' });
  });
});

describe('parseAnnotationRef', () => {
  it('accepts extensionless project files the prompt contract produces', () => {
    expect(parseAnnotationRef('Makefile')).toEqual({ path: 'Makefile' });
    expect(parseAnnotationRef('go.mod')).toEqual({ path: 'go.mod' });
    expect(parseAnnotationRef('src/step.ts:42')).toEqual({ path: 'src/step.ts', line: 42 });
  });

  it('still rejects non-paths', () => {
    expect(parseAnnotationRef('@voltojs/core')).toBeNull();
    expect(parseAnnotationRef('main...88b0e98')).toBeNull();
    expect(parseAnnotationRef('/abs/x.ts')).toBeNull();
  });
});
