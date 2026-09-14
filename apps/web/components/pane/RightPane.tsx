'use client';

import { useCallback, useRef, useState } from 'react';
import type { ComponentType, PointerEvent as ReactPointerEvent } from 'react';
import {
  Bot,
  FileImage,
  FileText,
  FolderTree,
  GitGraph,
  Plus,
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
import { FilePreviewTab } from './FilePreviewTab';
import { FileTreeTab } from './FileTreeTab';
import { GitGraphTab } from './GitGraphTab';
import { SubagentTab } from './SubagentTab';
import { PaneCategoryItems, PaneOverview } from './PaneOverview';

/**
 * RightPane shell：顶部标签栏 + 内容区分发。shell 对标签类型零感知——
 * 新增类型只需（1）PaneTab 加成员（2）下面注册表加一条（3）标签体组件自窄化。
 * 注册表值类型带 undefined（Partial），未注册的 kind 渲染空白而不是崩溃。
 */
const PANE_TAB_RENDERERS: {
  readonly [K in PaneTab['kind']]: ComponentType<{ tab: PaneTab }> | undefined;
} = {
  subagent: SubagentTab,
  files: FileTreeTab,
  'file-preview': FilePreviewTab,
  'git-graph': GitGraphTab,
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
    case 'file-preview':
      return IMAGE_EXTS.has(
        tab.path.slice(tab.path.lastIndexOf('.')).toLowerCase(),
      )
        ? FileImage
        : FileText;
  }
}

function tabTitle(tab: PaneTab): string {
  switch (tab.kind) {
    case 'subagent':
      return `子代理 …${tab.childSessionId.slice(-6)}`;
    case 'files':
      return '文件';
    case 'git-graph':
      return 'Git 图谱';
    case 'file-preview':
      return tab.path.split('/').at(-1) ?? tab.path;
  }
}

function ActiveTabBody({ tab }: { tab: PaneTab }) {
  const Renderer = PANE_TAB_RENDERERS[tab.kind];
  if (Renderer === undefined) return null;
  return <Renderer tab={tab} />;
}

function PlusMenu({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
      }}
    >
      <PopoverTrigger
        aria-label="添加面板"
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
}

export function RightPane({ projectId }: RightPaneProps) {
  const tabs = usePaneStore((s) => s.tabs);
  const activeTabId = usePaneStore((s) => s.activeTabId);
  const open = usePaneStore((s) => s.open);
  const hidden = usePaneStore((s) => s.hidden);
  const width = usePaneStore((s) => s.width);
  const setActive = usePaneStore((s) => s.setActive);
  const closeTab = usePaneStore((s) => s.closeTab);
  const setWidth = usePaneStore((s) => s.setWidth);

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
          <div className="flex shrink-0 items-center overflow-x-auto border-b">
            {tabs.map((tab) => {
              const Icon = tabIcon(tab);
              const title = tabTitle(tab);
              const active = tab.id === activeTab.id;
              return (
                <div
                  key={tab.id}
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
                    aria-label={`关闭 ${title}`}
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
            <ActiveTabBody tab={activeTab} />
          ) : (
            projectId !== null && <PaneOverview projectId={projectId} />
          )}
        </div>
      </div>
    </div>
  );
}
