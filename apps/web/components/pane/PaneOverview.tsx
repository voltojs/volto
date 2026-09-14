'use client';

import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { FolderTree, GitBranch } from 'lucide-react';
import { fetchGitSummary, type GitSummary } from '@/lib/git-api';
import { usePaneStore } from '@/stores/pane-store';

/**
 * Open a project-scoped category tab. Ids follow `kind:projectId` so re-open
 * dedupes inside the pane store instead of stacking duplicates.
 */
export function openPaneCategory(
  projectId: string,
  category: 'files' | 'git-graph',
): void {
  usePaneStore.getState().openTab({
    kind: category,
    id: `${category}:${projectId}`,
    projectId,
  });
}

/**
 * Shared category entry list for the empty-pane overview and the "+" menu.
 * Files is always listed; Git appears only when the workspace summary reports
 * a repository. A pending or failed summary must never hide the files entry.
 * Keyed by projectId so a workspace switch remounts and drops stale summary.
 */
export function PaneCategoryItems({
  projectId,
  onSelected,
}: {
  projectId: string;
  onSelected?: () => void;
}) {
  return (
    <PaneCategoryItemsInner
      key={projectId}
      projectId={projectId}
      onSelected={onSelected}
    />
  );
}

function PaneCategoryItemsInner({
  projectId,
  onSelected,
}: {
  projectId: string;
  onSelected?: () => void;
}) {
  const [summary, setSummary] = useState<GitSummary | null>(null);

  // No synchronous setState in the effect body (react-hooks/set-state-in-effect);
  // projectId is fixed for this mount, so the probe runs once and cancelled
  // only guards unmount.
  useEffect(() => {
    let cancelled = false;
    fetchGitSummary(projectId)
      .then((next) => {
        if (cancelled) return;
        setSummary(next);
      })
      .catch(() => {
        // Probe failure is treated as "not a git repo": only files remains.
        if (cancelled) return;
        setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="flex flex-col gap-0.5">
      <CategoryButton
        icon={FolderTree}
        label="文件"
        onClick={() => {
          openPaneCategory(projectId, 'files');
          onSelected?.();
        }}
      />
      {summary?.isGit === true && (
        <CategoryButton
          icon={GitBranch}
          label="Git 图谱"
          onClick={() => {
            openPaneCategory(projectId, 'git-graph');
            onSelected?.();
          }}
        />
      )}
    </div>
  );
}

function CategoryButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
    >
      <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Empty-state body shown when the pane is open with zero tabs. Lists the
 * same categories as the "+" menu so the user can pick a first panel.
 */
export function PaneOverview({ projectId }: { projectId: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
      <p className="text-muted-foreground text-xs">打开一个面板</p>
      <PaneCategoryItems projectId={projectId} />
    </div>
  );
}
