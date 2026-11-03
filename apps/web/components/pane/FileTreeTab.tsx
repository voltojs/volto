'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { fetchFsTree, searchFsFiles, type FsEntry, type FsSearchMatch } from '@/lib/fs-api';
import { openFilePreview } from '@/stores/pane-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PaneTab } from '@/stores/pane-store';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * RightPane 的文件树标签：懒展开目录树 + 防抖文件名搜索 + 手动刷新。
 * 只读——点文件往 pane-store 开 file-preview 标签。
 */
export function FileTreeTab({ tab }: { tab: PaneTab }) {
  if (tab.kind !== 'files') return null;
  // key=projectId：项目变更即重挂载，expanded / 目录缓存 / 搜索状态全部丢弃——
  // 两个 files 标签切回时不得看到上一个项目的展开态与缓存子项。
  return <FileTree key={tab.projectId} projectId={tab.projectId} />;
}

function FileTree({ projectId }: { projectId: string }) {
  const t = useTranslations('pane');
  const [tree, setTree] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [matches, setMatches] = useState<FsSearchMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  // 目录加载统一走 promise 链：setState 只出现在 .then/.catch 回调里，
  // react-hooks/set-state-in-effect 才不会把 effect 体的调用链判为同步 setState。
  const loadDir = useCallback(
    (rel: string) =>
      fetchFsTree(projectId, rel)
        .then((result) => {
          setTree((t) => ({ ...t, [rel]: result.entries }));
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        }),
    [projectId],
  );

  // 刷新 / 重试共用：清空树状态并重拉根目录。放在事件回调里而非 nonce 触发的
  // effect——react-hooks/set-state-in-effect 禁止在 effect 体内同步 setState。
  const reload = useCallback(() => {
    setTree({});
    setExpanded(new Set());
    setMatches(null);
    setError(null);
    void loadDir('');
  }, [loadDir]);

  useEffect(() => {
    void loadDir('');
  }, [loadDir]);

  // 防抖搜索：effect 只负责计时器；搜索模式进出（setSearching / 清 matches）
  // 由 onChange 处理，避免 effect 体内同步 setState 触发级联渲染。
  // cancelled 最新写入保护：过期请求的响应不得覆盖新 matches / 提前清 searching
  // （与 use-subagent-conversation.ts 同一模式）。
  useEffect(() => {
    const q = filter.trim();
    if (q === '') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchFsFiles(projectId, q)
        .then((r) => {
          if (cancelled) return;
          setMatches(r.matches);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filter, projectId]);

  const toggle = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) {
          next.delete(rel);
        } else {
          next.add(rel);
          if (tree[rel] === undefined) void loadDir(rel);
        }
        return next;
      });
    },
    [loadDir, tree],
  );

  const openPreview = useCallback((path: string) => {
    openFilePreview(projectId, path);
  }, [projectId]);

  /** Exit search mode and reveal `dir` in the tree (expand every ancestor). */
  const revealDir = useCallback(
    (dir: string) => {
      setFilter('');
      setMatches(null);
      setSearching(false);
      const ancestors: string[] = [];
      let acc = '';
      for (const part of dir.split('/').filter(Boolean)) {
        acc = acc === '' ? part : `${acc}/${part}`;
        ancestors.push(acc);
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const a of ancestors) next.add(a);
        return next;
      });
      // Side effects stay out of the state updater (StrictMode double-invoke).
      for (const a of ancestors) {
        if (tree[a] === undefined) void loadDir(a);
      }
    },
    [loadDir, tree],
  );

  if (error !== null) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-destructive text-sm">{error}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          {t('fileTree.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Input
          value={filter}
          onChange={(e) => {
            const next = e.target.value;
            setFilter(next);
            if (next.trim() === '') {
              // 空输入回到树模式（树状态保留）。
              setMatches(null);
              setSearching(false);
            } else {
              setSearching(true);
            }
          }}
          placeholder={t('fileTree.search')}
          className="h-7 text-xs"
        />
        <Button variant="ghost" size="icon" aria-label={t('fileTree.refresh')} className="h-7 w-7 shrink-0"
          onClick={reload}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1 text-sm">
        {matches !== null ? (
          searching ? (
            <p className="text-muted-foreground p-2 text-xs">{t('fileTree.searching')}</p>
          ) : matches.length === 0 ? (
            <p className="text-muted-foreground p-2 text-xs">{t('fileTree.noMatch')}</p>
          ) : (
            matches.map((m) => (
              <button
                key={m.path}
                type="button"
                onClick={() => (m.type === 'dir' ? revealDir(m.path) : openPreview(m.path))}
                className="hover:bg-muted flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left font-mono text-xs"
              >
                {m.type === 'dir' ? (
                  <Folder className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                ) : (
                  <FileIcon className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                )}
                <span className="truncate">{m.path}</span>
              </button>
            ))
          )
        ) : (
          <TreeNodes
            rel=""
            entries={tree['']}
            tree={tree}
            expanded={expanded}
            onToggle={toggle}
            onOpen={openPreview}
          />
        )}
      </div>
    </div>
  );
}

interface TreeNodesProps {
  rel: string;
  entries: FsEntry[] | undefined;
  tree: Record<string, FsEntry[]>;
  expanded: Set<string>;
  onToggle: (rel: string) => void;
  onOpen: (path: string) => void;
}

function TreeNodes({ rel, entries, tree, expanded, onToggle, onOpen }: TreeNodesProps) {
  const t = useTranslations('pane');
  if (entries === undefined) {
    return <p className="text-muted-foreground p-2 text-xs">{t('fileTree.loading')}</p>;
  }
  if (entries.length === 0) {
    return <p className="text-muted-foreground p-2 text-xs">{t('fileTree.emptyDir')}</p>;
  }
  return (
    <ul>
      {entries.map((entry) => {
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.type === 'dir') {
          const isOpen = expanded.has(childRel);
          return (
            <li key={childRel}>
              <button type="button" onClick={() => onToggle(childRel)}
                className="hover:bg-muted flex w-full items-center gap-1 rounded px-2 py-1 text-left">
                {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                {isOpen ? <FolderOpen className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
                <span className="truncate">{entry.name}</span>
              </button>
              {isOpen && (
                <div className="pl-4">
                  <TreeNodes rel={childRel} entries={tree[childRel]} tree={tree}
                    expanded={expanded} onToggle={onToggle} onOpen={onOpen} />
                </div>
              )}
            </li>
          );
        }
        return (
          <li key={childRel}>
            <button type="button" onClick={() => onOpen(childRel)}
              className="hover:bg-muted flex w-full items-center gap-1 rounded px-2 py-1 pl-6 text-left">
              <FileIcon className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{entry.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
