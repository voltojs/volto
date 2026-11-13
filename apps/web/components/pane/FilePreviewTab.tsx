'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import hljs from 'highlight.js/lib/common';
import { Check, ClipboardCopy, Code, Copy, Eye, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Markdown } from '@/components/chat/Markdown';
import { fetchFsFile, type FsFilePayload } from '@/lib/fs-api';
import { revealPath } from '@/lib/config-api';
import { useConfigStore } from '@/stores/config-store';
import { parentDir } from '@voltojs/sdk/file-refs';
import { splitHighlightedLines } from '@/lib/split-code-lines';
import { cn } from '@/lib/utils';
import type { PaneTab } from '@/stores/pane-store';

const LANG_BY_EXT: Readonly<Record<string, string>> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.json': 'json', '.css': 'css',
  '.scss': 'scss', '.less': 'less', '.html': 'xml', '.xml': 'xml', '.vue': 'xml',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.sql': 'sql', '.yml': 'yaml',
  '.yaml': 'yaml', '.toml': 'ini', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin',
};

function highlight(code: string, ext: string): string | null {
  const lang = LANG_BY_EXT[ext];
  try {
    if (lang !== undefined && hljs.getLanguage(lang) !== undefined) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return null; // 高亮失败退化为纯文本——预览不该因装饰失败而失败
  }
}

const MARKDOWN_EXTS = new Set(['.md', '.mdx']);

/**
 * One shared header row for every preview: the file's full project path on
 * the left, kind-specific actions (the markdown raw toggle) on the right.
 */
function PreviewHeader({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1">
      <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]" title={path}>
        {path}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">{children}</div>
    </div>
  );
}

/** Small icon action with a hover tooltip (title kept as the native fallback). */
function ActionButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-6 w-6', className)}
            aria-label={label}
            title={label}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * RightPane 的文件预览标签：图片 base64、Markdown 渲染（可切原文）、
 * highlight.js 高亮文本；truncated 声明与二进制占位。只读。
 */
export function FilePreviewTab({ tab }: { tab: PaneTab }) {
  if (tab.kind !== 'file-preview') return null;
  // key=projectId:path：切换两个已打开的 file-preview 标签时重挂载，旧文件的
  // payload / error / 重试视图不得残留到新文件的加载期（同 FileTreeTab 的 key 模式）。
  // line/endLine 不进 key：同行号切换只改目标行，不重挂载。
  return (
    <FilePreview
      key={`${tab.projectId}:${tab.path}`}
      projectId={tab.projectId}
      path={tab.path}
      line={tab.line}
      endLine={tab.endLine}
    />
  );
}

function FilePreview({
  projectId,
  path,
  line,
  endLine,
}: {
  projectId: string;
  path: string;
  line?: number;
  endLine?: number;
}) {
  const t = useTranslations('pane');
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ payload: FsFilePayload | null; error: string | null }>({
    payload: null,
    error: null,
  });
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Bring the line target into view once the file is loaded, and again when a
  // new click re-targets another line of the same open file. Anchors live in
  // the code rows (`data-line`); markdown previews and images have none and
  // simply stay put.
  useEffect(() => {
    if (state.payload === null || line === undefined) return;
    const el = bodyRef.current?.querySelector(`[data-line="${line}"]`);
    el?.scrollIntoView?.({ block: 'center' });
  }, [state.payload, line, endLine]);

  useEffect(() => {
    let cancelled = false;
    fetchFsFile(projectId, path).then(
      (payload) => {
        if (!cancelled) setState({ payload, error: null });
      },
      (err: unknown) => {
        // A failed preview stays a failed preview: the error state offers a
        // retry and never navigates to a guessed lookalike.
        if (!cancelled) setState({ payload: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, path, nonce]);

  const [raw, setRaw] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [contentCopied, setContentCopied] = useState(false);
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const copyContent = state.payload?.kind === 'text' ? state.payload.content : null;

  // Header actions: copy the full system path (project root + project-relative
  // path), reveal the file in the OS file manager, and the markdown raw/render
  // toggle. The file content copy lives at the display area's top-right.
  const copyFullPath = (): void => {
    const project = useConfigStore.getState().projects.find((p) => p.id === projectId);
    if (project === undefined) return;
    void navigator.clipboard.writeText(`${project.path}/${path}`).then(() => {
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 1500);
    });
  };
  const copyFileContent = (): void => {
    if (copyContent === null) return;
    void navigator.clipboard.writeText(copyContent).then(() => {
      setContentCopied(true);
      setTimeout(() => setContentCopied(false), 1500);
    });
  };
  const headerActions = (
    <>
      <ActionButton
        label={pathCopied ? t('filePreview.copied') : t('filePreview.copy')}
        onClick={copyFullPath}
      >
        {pathCopied ? <Check className="text-success h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </ActionButton>
      <ActionButton
        label={t('filePreview.reveal')}
        onClick={() => {
          const project = useConfigStore.getState().projects.find((p) => p.id === projectId);
          if (project !== undefined) void revealPath(`${project.path}/${path}`);
        }}
      >
        <FolderOpen className="h-3.5 w-3.5" />
      </ActionButton>
      {isMarkdown && (
        <ActionButton
          label={raw ? t('filePreview.render') : t('filePreview.raw')}
          onClick={() => setRaw((r) => !r)}
        >
          {raw ? <Eye className="h-3.5 w-3.5" /> : <Code className="h-3.5 w-3.5" />}
        </ActionButton>
      )}
    </>
  );

  if (state.error !== null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PreviewHeader path={path}>{headerActions}</PreviewHeader>
        <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-destructive text-sm">{state.error}</p>
        {/* 清空旧状态 + 重拉放在事件回调而非 nonce 触发的 effect——
            react-hooks/set-state-in-effect 禁止在 effect 体内同步 setState（同 FileTreeTab reload）。 */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setState({ payload: null, error: null });
            setNonce((n) => n + 1);
          }}
        >
          {t('filePreview.retry')}
        </Button>
        </div>
      </div>
    );
  }
  const payload = state.payload;
  if (payload === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PreviewHeader path={path}>{headerActions}</PreviewHeader>
        <div className="text-muted-foreground p-4 text-sm">{t('filePreview.loading')}</div>
      </div>
    );
  }
  if (payload.kind === 'binary') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PreviewHeader path={path}>{headerActions}</PreviewHeader>
        <div className="text-muted-foreground p-4 text-sm">
          {t('filePreview.binary', { size: payload.size })}
        </div>
      </div>
    );
  }
  if (payload.kind === 'image') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PreviewHeader path={path}>{headerActions}</PreviewHeader>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          <img src={`data:${payload.mediaType};base64,${payload.base64}`} alt={path} className="max-h-full max-w-full object-contain" />
        </div>
      </div>
    );
  }
  return (
    <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
      <PreviewHeader path={path}>{headerActions}</PreviewHeader>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {copyContent !== null && (
          <ActionButton
            label={contentCopied ? t('filePreview.copied') : t('filePreview.copyContent')}
            onClick={copyFileContent}
            className="absolute top-1.5 right-1.5 z-[1]"
          >
            {contentCopied ? (
              <Check className="text-success h-3.5 w-3.5" />
            ) : (
              <ClipboardCopy className="h-3.5 w-3.5" />
            )}
          </ActionButton>
        )}
        {payload.truncated && (
          <div className="bg-muted/60 text-muted-foreground border-b px-3 py-1.5 text-xs">
            {t('filePreview.tooLarge', { size: payload.size })}
          </div>
        )}
        {isMarkdown ? (
          <MarkdownBody
            content={payload.content}
            projectId={projectId}
            linkBase={parentDir(path)}
            raw={raw}
          />
        ) : (
          <CodeBody code={payload.content} ext={ext} line={line} endLine={endLine} />
        )}
      </div>
    </div>
  );
}

function MarkdownBody({
  content,
  projectId,
  linkBase,
  raw,
}: {
  content: string;
  projectId: string;
  linkBase: string;
  raw: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {raw ? (
          <pre className="text-foreground/90 whitespace-pre-wrap break-words font-mono text-xs">{content}</pre>
        ) : (
          <Markdown content={content} projectId={projectId} linkBase={linkBase} />
        )}
      </div>
    </div>
  );
}

function CodeBody({
  code,
  ext,
  line,
  endLine,
}: {
  code: string;
  ext: string;
  line?: number;
  endLine?: number;
}) {
  const html = highlight(code, ext);
  const lineHtml = html === null ? null : splitHighlightedLines(html);
  const rawLines = code.split('\n');
  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      {rawLines.map((raw, i) => {
        const n = i + 1;
        const highlighted = line !== undefined && n >= line && n <= (endLine ?? line);
        return (
          <div
            key={n}
            data-line={n}
            className={cn('flex w-max min-w-full', highlighted && 'bg-primary/10')}
          >
            <span
              aria-hidden
              className="text-muted-foreground/60 sticky left-0 z-[1] w-10 shrink-0 bg-inherit px-2 text-right font-mono text-[11px] leading-5 select-none"
            >
              {n}
            </span>
            {lineHtml === null ? (
              <code className="flex-1 px-2 font-mono text-xs leading-5 whitespace-pre">{raw}</code>
            ) : (
              <code
                className="hljs flex-1 px-2 font-mono text-xs leading-5 whitespace-pre"
                dangerouslySetInnerHTML={{ __html: lineHtml[i] ?? '' }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
