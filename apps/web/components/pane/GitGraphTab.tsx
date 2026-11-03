'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  fetchGitGraph,
  fetchGitCommit,
  type GitCommitDetail,
  type GitGraph,
  type GitGraphNode,
} from '@/lib/git-api';
import type { PaneTab } from '@/stores/pane-store';

/** Cap the client-side request so a huge history cannot flood the pane. */
const GRAPH_LIMIT = 100;

/**
 * RightPane 的只读 Git 图谱标签：纵向拓扑提交列表 + 点击后才拉取的详情面板。
 * 全部 GET；不渲染 checkout / commit / diff 动作。
 */
export function GitGraphTab({ tab }: { tab: PaneTab }) {
  if (tab.kind !== 'git-graph') return null;
  // key=projectId: switching workspaces remounts and drops stale nodes/detail.
  return <GitGraphView key={tab.projectId} projectId={tab.projectId} />;
}

function GitGraphView({ projectId }: { projectId: string }) {
  const t = useTranslations('pane');
  const [nonce, setNonce] = useState(0);
  const [graph, setGraph] = useState<{
    payload: GitGraph | null;
    error: string | null;
  }>({ payload: null, error: null });
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    payload: GitCommitDetail | null;
    error: string | null;
    loading: boolean;
  }>({ payload: null, error: null, loading: false });

  // Graph load. Cancellation guard: a late response from a previous nonce (or
  // a remount race) must not overwrite the current view. setState only lands
  // in the promise callbacks — never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    fetchGitGraph(projectId, GRAPH_LIMIT).then(
      (payload) => {
        if (!cancelled) setGraph({ payload, error: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        setGraph({
          payload: null,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, nonce]);

  // Detail load only after a node click (selectedHash is set from the event).
  // Independent of the graph effect so a detail failure never clears nodes.
  useEffect(() => {
    if (selectedHash === null) return;
    let cancelled = false;
    fetchGitCommit(projectId, selectedHash).then(
      (payload) => {
        if (!cancelled) setDetail({ payload, error: null, loading: false });
      },
      (err: unknown) => {
        if (cancelled) return;
        setDetail({
          payload: null,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedHash]);

  // Refresh / graph retry share one path: clear stale detail + selection in
  // the event callback, then bump nonce so the graph effect refetches.
  const reload = () => {
    setGraph({ payload: null, error: null });
    setSelectedHash(null);
    setDetail({ payload: null, error: null, loading: false });
    setNonce((n) => n + 1);
  };

  const selectNode = (hash: string) => {
    // Re-clicking the already-selected node must not clear detail: the effect
    // depends on selectedHash, so a no-op state change would leave loading=true
    // forever with nobody to write the payload back.
    if (hash === selectedHash) return;
    setSelectedHash(hash);
    setDetail({ payload: null, error: null, loading: true });
  };

  if (graph.error !== null) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-destructive text-sm">{graph.error}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          {t('gitGraph.retry')}
        </Button>
      </div>
    );
  }

  const payload = graph.payload;
  if (payload === null) {
    return <div className="text-muted-foreground p-4 text-sm">{t('gitGraph.loading')}</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <p className="text-muted-foreground text-xs">
          {t('gitGraph.commits', { count: payload.nodes.length })}
          {payload.truncated ? t('gitGraph.truncated') : ''}
        </p>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('gitGraph.refresh')}
          className="h-7 w-7 shrink-0"
          onClick={reload}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      {payload.nodes.length === 0 ? (
        <p className="text-muted-foreground p-4 text-sm">{t('gitGraph.empty')}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* overflow-x-hidden: long ref badges must not create a horizontal
              scrollbar that scrolls into empty space beside the list. */}
          <ul className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1 md:w-1/2">
            {payload.nodes.map((node) => (
              <GraphNodeRow
                key={node.hash}
                node={node}
                selected={selectedHash === node.hash}
                onSelect={selectNode}
              />
            ))}
          </ul>
          <CommitDetail
            className="border-t md:border-t-0 md:border-l md:w-1/2"
            selectedHash={selectedHash}
            detail={detail}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Read-only topological row. A leading parent-edge glyph conveys ancestry
 * (◆ merge / ● linear / ○ root) without pulling in a graph library.
 */
function GraphNodeRow({
  node,
  selected,
  onSelect,
}: {
  node: GitGraphNode;
  selected: boolean;
  onSelect: (hash: string) => void;
}) {
  const marker = node.parents.length > 1 ? '◆' : node.parents.length === 1 ? '●' : '○';
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.hash)}
        aria-pressed={selected}
        className={`hover:bg-muted flex w-full min-w-0 items-start gap-1.5 overflow-hidden rounded px-2 py-1 text-left ${
          selected ? 'bg-muted' : ''
        }`}
      >
        <span aria-hidden className="mt-0.5 shrink-0 font-mono text-xs">
          {marker}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
              {node.hash.slice(0, 7)}
            </span>
            {/* min-w-0 so truncate can shrink against long subjects/refs. */}
            <span className="min-w-0 flex-1 truncate text-sm">
              {node.subject}
            </span>
          </span>
          {/* Refs wrap onto their own line: a long origin/* badge must not
              widen the row past the pane (that produced a hollow h-scrollbar). */}
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {node.refs.map((ref) => (
              <span
                key={ref}
                className="bg-muted text-muted-foreground max-w-full shrink-0 truncate rounded px-1 py-0.5 text-[10px]"
              >
                {ref}
              </span>
            ))}
            <span className="text-muted-foreground min-w-0 truncate text-[11px]">
              {node.author} · {node.authoredAt}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * Detail pane: empty until a node is selected, then full hash / body /
 * parents / name-status files. Failures stay here and never touch the list.
 */
function CommitDetail({
  className,
  selectedHash,
  detail,
}: {
  className: string;
  selectedHash: string | null;
  detail: {
    payload: GitCommitDetail | null;
    error: string | null;
    loading: boolean;
  };
}) {
  const t = useTranslations('pane');
  return (
    <div className={`min-h-0 overflow-y-auto p-3 ${className}`}>
      {selectedHash === null ? (
        <p className="text-muted-foreground text-sm">{t('gitGraph.selectCommit')}</p>
      ) : detail.error !== null ? (
        <p className="text-destructive text-sm">{detail.error}</p>
      ) : detail.loading || detail.payload === null ? (
        <p className="text-muted-foreground text-sm">{t('gitGraph.loadingDetail')}</p>
      ) : (
        <CommitDetailBody detail={detail.payload} />
      )}
    </div>
  );
}

function CommitDetailBody({ detail }: { detail: GitCommitDetail }) {
  const t = useTranslations('pane');
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-mono text-xs break-all">{detail.hash}</p>
      <p className="font-medium">{detail.subject}</p>
      <p className="text-muted-foreground text-xs">
        {detail.author} · {detail.authoredAt}
      </p>
      {detail.body.trim() !== '' && (
        <pre className="text-foreground/90 whitespace-pre-wrap break-words text-xs">
          {detail.body}
        </pre>
      )}
      {detail.parents.length > 0 && (
        <p className="text-muted-foreground font-mono text-[11px]">
          {t('gitGraph.parents', { parents: detail.parents.map((p) => p.slice(0, 7)).join(' ') })}
        </p>
      )}
      {detail.files.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {detail.files.map((f) => (
            <li
              key={`${f.status} ${f.path}`}
              className="flex items-start gap-2 font-mono text-[11px]"
            >
              <span className="text-muted-foreground w-3 shrink-0">
                {f.status}
              </span>
              <span className="truncate">{f.path}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
