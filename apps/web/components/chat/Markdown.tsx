'use client';

import { isValidElement, memo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseLinkRef, resolveFileRef, type RefAnnotation } from '@volto/sdk/file-refs';
import { FileRefChip } from './FileRefChip';

/**
 * One fenced code block, with a language chip and a copy button.
 *
 * No token-level syntax highlighting: this app is a local dev tool where the
 * agent's own output already comes back through the monospace terminal-log
 * aesthetic, and pulling in a highlighter (shiki/highlight.js) is a
 * meaningfully heavier, harder-to-verify dependency than the plain, legible
 * block this renders. Revisit if that trade stops being the right one.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const t = useTranslations('chat');
  const [copied, setCopied] = useState(false);

  const codeElement = Array.isArray(children) ? children[0] : children;
  const codeProps = isValidElement<{
    className?: string;
    children?: ReactNode;
  }>(codeElement)
    ? codeElement.props
    : undefined;
  const language = codeProps?.className?.match(/language-(\w+)/)?.[1];
  const text =
    typeof codeProps?.children === 'string'
      ? codeProps.children.replace(/\n$/, '')
      : '';

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="bg-card my-2 overflow-hidden rounded-lg border">
      <div className="bg-muted/50 flex items-center justify-between border-b px-3 py-1">
        <span className="text-muted-foreground font-mono text-[11px] tracking-wide">
          {language ?? 'text'}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors"
        >
          {copied ? (
            <>
              <Check className="text-success h-3 w-3" /> {t('common.copied')}
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> {t('common.copy')}
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3">{children}</pre>
    </div>
  );
}

interface FileLinkContext {
  /**
   * Project the content belongs to. `undefined` resolves to the current
   * session at click time (main chat feed); `null` means the owner is
   * unknown — refs render inert instead of guessing a project.
   */
  projectId?: string | null;
  /** Directory (project-relative) that link hrefs resolve against. */
  linkBase: string;
  /** Host-confirmed ref annotations for this block (character offsets). */
  refs?: RefAnnotation[];
  /** The block's own text — offsets in `refs` index into it. */
  text: string;
}

const baseComponents: Components = {
  ul: ({ className, ...props }) => (
    <ul className={cn('my-1 ml-4 list-disc space-y-0.5', className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn('my-1 ml-4 list-decimal space-y-0.5', className)} {...props} />
  ),
  p: ({ className, ...props }) => (
    <p className={cn('leading-relaxed [&:not(:first-child)]:mt-2', className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className="my-2 overflow-x-auto rounded-md border">
      <table
        className={cn('w-full border-collapse text-sm', className)}
        {...props}
      />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        'bg-muted/50 border-b px-2 py-1 text-left font-medium',
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn('border-b px-2 py-1 last:border-0', className)}
      {...props}
    />
  ),
};

function buildComponents(ctx: FileLinkContext): Components {
  return {
    ...baseComponents,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    code: ({ node, className, children, ...props }) => {
      const text = typeof children === 'string' ? children : '';
      // Fenced blocks carry a `language-*` class or span multiple lines;
      // anything else is inline code. Prose refs are annotation-driven: a
      // chip exists only where the host confirmed a file identity — the
      // renderer never guesses from the code text itself.
      const inline = className === undefined && !text.includes('\n');
      let target: RefAnnotation | undefined;
      if (inline && ctx.refs !== undefined && node?.position != null) {
        const { start, end } = node.position;
        const from = start.offset ?? 0;
        const to = end.offset ?? 0;
        // mdast inlineCode positions include the backtick delimiters; the
        // annotations delimit the content, so trim the delimiter run.
        const raw = ctx.text.slice(from, to);
        const delim = raw.length - raw.replace(/^`+/, '').length;
        target = ctx.refs.find((r) => r.start === from + delim && r.end === to - delim);
      }
      if (target !== undefined && ctx.projectId !== null) {
        return (
          <FileRefChip target={target} projectId={ctx.projectId} variant="code">
            {children}
          </FileRefChip>
        );
      }
      return (
        <code
          className={cn(
            'bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]',
            className,
          )}
          {...props}
        >
          {children}
        </code>
      );
    },
    a: ({ className, href, children, ...props }) => {
      const parsed = typeof href === 'string' ? parseLinkRef(href) : null;
      const target = parsed === null ? null : resolveFileRef(ctx.linkBase, parsed);
      if (target !== null) {
        // Never fall through to <a>: a project path opened as a browser
        // navigation is a 404, not a link.
        return ctx.projectId !== null ? (
          <FileRefChip target={target} projectId={ctx.projectId} variant="link">
            {children}
          </FileRefChip>
        ) : (
          <span className={className}>{children}</span>
        );
      }
      // A local non-file href is inert text: an anchor would navigate to a
      // 404. Only real URLs keep anchor behavior.
      const external =
        typeof href === 'string' && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href);
      if (!external) return <span className={className}>{children}</span>;
      return (
        <a
          className={cn(
            'text-primary underline-offset-2 hover:underline',
            className,
          )}
          target="_blank"
          rel="noreferrer noopener"
          href={href}
          {...props}
        >
          {children}
        </a>
      );
    },
  };
}

interface MarkdownProps {
  content: string;
  className?: string;
  /** Project the content belongs to; omitted → current session at click time. */
  projectId?: string | null;
  /** Base directory (project-relative) for resolving link hrefs. */
  linkBase?: string;
  /** Host-confirmed file ref annotations for this block; absent = no chips. */
  refs?: RefAnnotation[];
}

export const Markdown = memo(function Markdown({
  content,
  className,
  projectId,
  linkBase = '',
  refs,
}: MarkdownProps) {
  return (
    <div className={cn('text-sm', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={buildComponents({ projectId, linkBase, refs, text: content })}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
