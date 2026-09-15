'use client';

import type { PaneTab } from '@/stores/pane-store';

/**
 * Temporary until Task 4 replaces the body; keeps the registry type-complete.
 */
export function BackgroundTasksTab({ tab }: { tab: PaneTab }) {
  if (tab.kind !== 'tasks') return null;
  return <div className="p-4 text-sm text-muted-foreground">任务列表施工中</div>;
}
