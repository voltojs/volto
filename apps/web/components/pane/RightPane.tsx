'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ComponentType, PointerEvent as ReactPointerEvent } from 'react';
import {
  Bot,
  FileImage,
  FileText,
  FolderTree,
  GitGraph,
  ListTodo,
  Plus,
  ScrollText,
  X,
} from 'lucide-react';
import {
  usePaneStore,
  PANE_WIDTH_DEFAULT,
  type PaneTab,
} from '@/stores/pane-store';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { BackgroundTasksTab } from './BackgroundTasksTab';
import { FilePreviewTab } from './FilePreviewTab';
import { FileTreeTab } from './FileTreeTab';
import { GitGraphTab } from './GitGraphTab';
import { PlanTab } from './PlanPane';
import { SubagentTab } from './SubagentTab';
import { PaneCategoryItems, PaneOverview } from './PaneOverview';

/**
 * 标签体渲染入参：tab 载荷 + 跨标签共享的可选回调。现有多数标签体只吃
 * `tab`——组件以 `{ tab }` 入参声明即满足本类型（结构化 assignable），用到
 * 回调的标签（plan）自行从入参取。
 */
interface PaneTabBodyProps {
  tab: PaneTab;
  /** 「按计划执行」派发（ChatPanel：切回 planPreviousMode ?? 'ask' + 发消息）。 */
  onExecutePlan?: (sessionId: string) => void;
}

/**
 * RightPane shell：顶部标签栏 + 内容区分发。shell 对标签类型零感知——
 * 新增类型只需（1）PaneTab 加成员（2）下面注册表加一条（3）标签体组件自窄化。
 * 注册表值类型带 undefined（Partial），未注册的 kind 渲染空白而不是崩溃。
 */
const PANE_TAB_RENDERERS: {
  readonly [K in PaneTab['kind']]: ComponentType<PaneTabBodyProps> | undefined;
} = {
  subagent: SubagentTab,
  files: FileTreeTab,
  'file-preview': FilePreviewTab,
  'git-graph': GitGraphTab,
  tasks: BackgroundTasksTab,
  plan: PlanTab,
};

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
  '.avif',
]);

function tabIcon(tab: PaneTab): ComponentType<{ className?: string }> {
  switch (tab.kind) {
    case 'subagent':
      return Bot;
    case 'files':
      return FolderTree;
    case 'git-graph':
      return GitGraph;
    case 'tasks':
      return ListTodo;
    case 'plan':
      return ScrollText;
    case 'file-preview':
      return IMAGE_EXTS.has(
        tab.path.slice(tab.path.lastIndexOf('.')).toLowerCase(),
      )
        ? FileImage
        : FileText;
  }
}

/** Catalog key for a pane tab's label; file previews show the file name. */
function tabTitleKey(tab: PaneTab): string {
  switch (tab.kind) {
    case 'subagent':
      return 'tabs.subagent';
    case 'files':
      return 'tabs.files';
    case 'git-graph':
      return 'tabs.gitGraph';
    case 'tasks':
      return 'tabs.tasks';
    case 'plan':
      return 'tabs.plan';
    case 'file-preview':
      return '';
  }
}

function ActiveTabBody({
  tab,
  onExecutePlan,
}: PaneTabBodyProps) {
  const Renderer = PANE_TAB_RENDERERS[tab.kind];
  if (Renderer === undefined) return null;
  return <Renderer tab={tab} onExecutePlan={onExecutePlan} />;
}

function PlusMenu({ projectId }: { projectId: string }) {
  const t = useTranslations('pane');
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
      }}
    >
      <PopoverTrigger
        aria-label={t('tabs.add')}
        className="hover:bg-muted text-muted-foreground hover:text-foreground ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded"
      >
        <Plus className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="start">
        <PaneCategoryItems
          projectId={projectId}
          onSelected={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

interface RightPaneProps {
  /** Current workspace; required to open project-scoped categories / overview. */
  projectId: string | null;
  /**
   * 「按计划执行」派发回调，透传给 plan 标签体。可选：欢迎屏没有可派发的
   * 会话（plan 标签也不可能在无会话时出现）。
   */
  onExecutePlan?: (sessionId: string) => void;
}

export function RightPane({ projectId, onExecutePlan }: RightPaneProps) {
  const t = useTranslations('pane');
  const tabs = usePaneStore((s) => s.tabs);
  const activeTabId = usePaneStore((s) => s.activeTabId);
  const open = usePaneStore((s) => s.open);
  const hidden = usePaneStore((s) => s.hidden);
  const width = usePaneStore((s) => s.width);
  const setActive = usePaneStore((s) => s.setActive);
  const closeTab = usePaneStore((s) => s.closeTab);
  const setWidth = usePaneStore((s) => s.setWidth);

  // Keep the active tab visible: openings land at the strip's end and a
  // switch can target a tab outside the horizontally scrolled viewport.
  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeTabId === null) return;
    const el = stripRef.current?.querySelector(`[data-tab-id="${activeTabId}"]`);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = {
      startX: e.clientX,
      startWidth: usePaneStore.getState().width,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (drag.current === null) return;
      setWidth(drag.current.startWidth - (e.clientX - drag.current.startX));
    },
    [setWidth],
  );
  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  // Render only when the pane shell is open and not collapsed. Zero tabs with
  // a valid project shows the overview — never a bare `null` just because
  // tabs ran out. Collapse (`hidden`) keeps tabs and only unmounts the view.
  if (!open || hidden) return null;
  if (tabs.length === 0 && projectId === null) return null;

  const activeTab =
    tabs.length === 0
      ? null
      : (tabs.find((t) => t.id === activeTabId) ?? tabs[tabs.length - 1]!);

  return (
    <div
      className="flex h-full min-h-0 shrink-0"
      style={{ width }}
      data-testid="right-pane"
    >
      {/* 左缘拖拽手柄：拖动调宽，双击复位。 */}
      <div
        role="separator"
        aria-orientation="vertical"
        className="hover:bg-primary/20 w-1 shrink-0 cursor-col-resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setWidth(PANE_WIDTH_DEFAULT)}
      />
      <div className="flex min-w-0 flex-1 flex-col border-l">
        {activeTab !== null && (
          <div ref={stripRef} className="flex min-h-12 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5">
            {tabs.map((tab) => {
              const Icon = tabIcon(tab);
              const title =
                tab.kind === 'file-preview'
                  ? (tab.path.split('/').at(-1) ?? tab.path)
                  : t(tabTitleKey(tab), { suffix: tab.kind === 'subagent' ? tab.childSessionId.slice(-6) : '' });
              const active = tab.id === activeTab.id;
              return (
                <div
                  key={tab.id}
                  data-tab-id={tab.id}
                  className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-xs ${
                    active
                      ? 'border-primary text-foreground'
                      : 'text-muted-foreground hover:text-foreground border-transparent'
                  }`}
                >
                  <button
                    type="button"
                    title={tab.kind === 'file-preview' ? tab.path : undefined}
                    onClick={() => setActive(tab.id)}
                    className="flex min-w-0 items-center gap-1.5"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="max-w-40 truncate">{title}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('tabs.close', { title })}
                    onClick={() => closeTab(tab.id)}
                    className="hover:bg-muted hover:text-foreground rounded p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            {projectId !== null && <PlusMenu projectId={projectId} />}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          {activeTab !== null ? (
            <ActiveTabBody tab={activeTab} onExecutePlan={onExecutePlan} />
          ) : (
            projectId !== null && <PaneOverview projectId={projectId} />
          )}
        </div>
      </div>
    </div>
  );
}
