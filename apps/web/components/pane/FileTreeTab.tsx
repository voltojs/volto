'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { fetchFsTree, searchFsFiles, type FsEntry } from '@/lib/fs-api';
import { usePaneStore } from '@/stores/pane-store';
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
  return <FileTree projectId={tab.projectId} />;
}

function FileTree({ projectId }: { projectId: string }) {
  const [tree, setTree] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [matches, setMatches] = useState<string[] | null>(null);
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
  useEffect(() => {
    const q = filter.trim();
    if (q === '') return;
    const timer = setTimeout(() => {
      searchFsFiles(projectId, q)
        .then((r) => {
          setMatches(r.matches);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
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
    usePaneStore.getState().openTab({
      kind: 'file-preview',
      id: `preview:${projectId}:${path}`,
      projectId,
      path,
    });
  }, [projectId]);

  if (error !== null) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-destructive text-sm">{error}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          重试
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
          placeholder="搜索文件名"
          className="h-7 text-xs"
        />
        <Button variant="ghost" size="icon" aria-label="刷新" className="h-7 w-7 shrink-0"
          onClick={reload}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1 text-sm">
        {matches !== null ? (
          searching ? (
            <p className="text-muted-foreground p-2 text-xs">搜索中…</p>
          ) : matches.length === 0 ? (
            <p className="text-muted-foreground p-2 text-xs">无匹配文件</p>
          ) : (
            matches.map((rel) => (
              <button key={rel} type="button" onClick={() => openPreview(rel)}
                className="hover:bg-muted block w-full truncate rounded px-2 py-1 text-left font-mono text-xs">
                {rel}
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
  if (entries === undefined) {
    return <p className="text-muted-foreground p-2 text-xs">加载中…</p>;
  }
  if (entries.length === 0) {
    return <p className="text-muted-foreground p-2 text-xs">空目录</p>;
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
