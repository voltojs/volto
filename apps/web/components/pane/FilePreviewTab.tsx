'use client';

import { useEffect, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/chat/Markdown';
import { fetchFsFile, type FsFilePayload } from '@/lib/fs-api';
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
 * RightPane 的文件预览标签：图片 base64、Markdown 渲染（可切原文）、
 * highlight.js 高亮文本；truncated 声明与二进制占位。只读。
 */
export function FilePreviewTab({ tab }: { tab: PaneTab }) {
  if (tab.kind !== 'file-preview') return null;
  // key=projectId:path：切换两个已打开的 file-preview 标签时重挂载，旧文件的
  // payload / error / 重试视图不得残留到新文件的加载期（同 FileTreeTab 的 key 模式）。
  return <FilePreview key={`${tab.projectId}:${tab.path}`} projectId={tab.projectId} path={tab.path} />;
}

function FilePreview({ projectId, path }: { projectId: string; path: string }) {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ payload: FsFilePayload | null; error: string | null }>({
    payload: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetchFsFile(projectId, path).then(
      (payload) => {
        if (!cancelled) setState({ payload, error: null });
      },
      (err: unknown) => {
        if (!cancelled) setState({ payload: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, path, nonce]);

  if (state.error !== null) {
    return (
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
          重试
        </Button>
      </div>
    );
  }
  const payload = state.payload;
  if (payload === null) {
    return <div className="text-muted-foreground p-4 text-sm">加载文件…</div>;
  }
  if (payload.kind === 'binary') {
    return (
      <div className="text-muted-foreground p-4 text-sm">
        不支持预览二进制文件（{payload.size} 字节）
      </div>
    );
  }
  if (payload.kind === 'image') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img src={`data:${payload.mediaType};base64,${payload.base64}`} alt={path} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {payload.truncated && (
        <div className="bg-muted/60 text-muted-foreground border-b px-3 py-1.5 text-xs">
          文件过大，仅显示前 512 KB（完整 {payload.size} 字节）
        </div>
      )}
      {isMarkdown ? (
        <MarkdownBody content={payload.content} />
      ) : (
        <CodeBody code={payload.content} ext={ext} />
      )}
    </div>
  );
}

function MarkdownBody({ content }: { content: string }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 justify-end border-b px-3 py-1">
        <Button variant="ghost" size="sm" onClick={() => setRaw((r) => !r)}>
          {raw ? '渲染' : '原文'}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {raw ? (
          <pre className="text-foreground/90 whitespace-pre-wrap break-words font-mono text-xs">{content}</pre>
        ) : (
          <Markdown content={content} />
        )}
      </div>
    </div>
  );
}

function CodeBody({ code, ext }: { code: string; ext: string }) {
  const html = highlight(code, ext);
  const lines = code.split('\n');
  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <pre aria-hidden className="bg-muted/40 text-muted-foreground/60 select-none px-2 py-2 text-right font-mono text-[11px] leading-5">
        {lines.map((_, i) => `${i + 1}\n`).join('')}
      </pre>
      <pre className="flex-1 overflow-x-auto px-2 py-2 font-mono text-xs leading-5">
        {html === null ? (
          <code>{code}</code>
        ) : (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
}
