'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Check, CircleAlert, LoaderCircle } from 'lucide-react';
import { useBackgroundTasks } from '@/hooks/use-background-tasks';
import { usePaneStore, type PaneTab } from '@/stores/pane-store';
import { formatDuration } from '@/lib/trajectory-view-model';
import { cn } from '@/lib/utils';
import type { BackgroundTaskItem } from '@/lib/background-tasks';

function openSubagentChat(childSessionId: string): void {
  usePaneStore.getState().openTab({
    kind: 'subagent',
    id: `subagent:${childSessionId}`,
    childSessionId,
    view: 'chat',
  });
}

function TaskRow({ item }: { item: BackgroundTaskItem }) {
  const t = useTranslations('pane');
  const isRunning = item.status === 'running';
  const [now, setNow] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);
  const elapsed =
    isRunning && item.startedAt !== undefined && now !== undefined
      ? formatDuration(now - item.startedAt)
      : null;
  const duration =
    typeof item.durationMs === 'number' ? formatDuration(item.durationMs) : null;
  const label = item.title || `…${item.childSessionId.slice(-6)}`;

  return (
    <button
      type="button"
      aria-label={item.title ? item.title : t('background.subagent', { suffix: item.childSessionId.slice(-6) })}
      onClick={() => openSubagentChat(item.childSessionId)}
      className={cn(
        'bg-card/60 hover:bg-muted/60 flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left text-xs',
        item.status === 'error' && 'border-destructive/30 bg-destructive/5',
      )}
    >
      <div className="flex w-full items-center gap-2">
        <Bot className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="text-muted-foreground/70 flex shrink-0 items-center gap-1 font-mono text-[10px]">
          {isRunning ? (
            <>
              <LoaderCircle className="h-3 w-3 animate-spin" />
              <span>{t('background.running')}</span>
              {elapsed && <span>{elapsed}</span>}
            </>
          ) : (
            <>
              {item.status === 'error' ? (
                <CircleAlert className="text-destructive h-3 w-3" />
              ) : (
                <Check className="text-success h-3 w-3" />
              )}
              {duration && <span>{duration}</span>}
            </>
          )}
        </span>
      </div>
      <div className="text-muted-foreground/60 pl-5 font-mono text-[10px]">
        {item.childSessionId.slice(-6)}
      </div>
    </button>
  );
}

export function BackgroundTasksTab({ tab }: { tab: PaneTab }) {
  const t = useTranslations('pane');
  const tasks = useBackgroundTasks();
  if (tab.kind !== 'tasks') return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-3">
      {tasks.length === 0 ? (
        <p className="text-muted-foreground p-2 text-sm">{t('background.empty')}</p>
      ) : (
        tasks.map((item) => <TaskRow key={item.id} item={item} />)
      )}
    </div>
  );
}
