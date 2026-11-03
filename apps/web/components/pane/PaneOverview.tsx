'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ComponentType } from 'react';
import { ClipboardList, FolderTree, GitBranch, ListTodo } from 'lucide-react';
import { fetchGitSummary, type GitSummary } from '@/lib/git-api';
import { fetchPlan } from '@/lib/sessions-api';
import { useSessionStore } from '@/stores/session-store';
import { openTasksTab, usePaneStore } from '@/stores/pane-store';

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
  const t = useTranslations('pane');
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const [hasPlan, setHasPlan] = useState(false);

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

  // 计划存在性探测：仅活动会话有计划时露出「计划」入口。失败按"无计划"
  // 处理（与 git 探测的探测失败语义一致）。
  useEffect(() => {
    if (currentSessionId === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 会话切换时同步收起入口
      setHasPlan(false);
      return;
    }
    let cancelled = false;
    fetchPlan(currentSessionId)
      .then((plan) => {
        if (!cancelled) setHasPlan(plan !== null);
      })
      .catch(() => {
        if (!cancelled) setHasPlan(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentSessionId]);

  return (
    <div className="flex flex-col gap-0.5">
      <CategoryButton
        icon={FolderTree}
        label={t('tabs.files')}
        onClick={() => {
          openPaneCategory(projectId, 'files');
          onSelected?.();
        }}
      />
      <CategoryButton
        icon={ListTodo}
        label={t('tabs.tasks')}
        onClick={() => {
          openTasksTab();
          onSelected?.();
        }}
      />
      {summary?.isGit === true && (
        <CategoryButton
          icon={GitBranch}
          label={t('tabs.gitGraph')}
          onClick={() => {
            openPaneCategory(projectId, 'git-graph');
            onSelected?.();
          }}
        />
      )}
      {hasPlan && currentSessionId !== null && (
        // 关闭计划标签后的重开入口：id 取 sessionId，与 turn-end 自动打开
        // 的标签同 id（openTab 按 id 去重，重开等于激活）。
        <CategoryButton
          icon={ClipboardList}
          label={t('tabs.plan')}
          onClick={() => {
            usePaneStore.getState().openTab({
              kind: 'plan',
              id: currentSessionId,
              sessionId: currentSessionId,
            });
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
  const t = useTranslations('pane');
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
      <p className="text-muted-foreground text-xs">{t('overview.open')}</p>
      <PaneCategoryItems projectId={projectId} />
    </div>
  );
}
