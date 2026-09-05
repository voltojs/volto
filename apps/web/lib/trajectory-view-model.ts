/**
 * 轨迹视图的纯展示模型：kind → 中文标签 / 徽章配色、时长格式化、
 * 详情抽屉的 per-kind tab 结构。无 React、无副作用，独立可测。
 */

import type { TrajectoryRow } from '@volto/sdk/sse';

export const EMPTY_CELL = '（无）';

export const KIND_LABELS: Record<TrajectoryRow['kind'], string> = {
  user: '用户',
  context: '上下文',
  assistant: '助手',
  tool: '工具',
  subagent: '子agent',
  compaction: '压缩',
  error: '错误',
};

export const KIND_BADGE_CLASS: Record<TrajectoryRow['kind'], string> = {
  user: 'border-border bg-muted text-muted-foreground',
  context: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  assistant: 'border-primary/30 bg-primary/10 text-primary',
  tool: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  subagent: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  compaction: 'border-border bg-muted text-muted-foreground',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
};

/** 无耗时返回 null（调用方渲染 EMPTY_CELL）；<1s 用 ms，其余一位小数秒。 */
export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export type DrawerTabKey =
  | 'overview'
  | 'input'
  | 'output'
  | 'schema'
  | 'thinking'
  | 'layers'
  | 'timing';

export const TAB_LABELS: Record<DrawerTabKey, string> = {
  overview: '概述',
  input: '参数',
  output: '结果',
  schema: 'Schema',
  thinking: '思考',
  layers: '系统层',
  timing: '计时',
};

const TOOL_TABS: readonly DrawerTabKey[] = ['overview', 'input', 'output', 'schema', 'timing'];
const ASSISTANT_TABS: readonly DrawerTabKey[] = ['overview', 'output', 'thinking', 'timing'];
const CONTEXT_TABS: readonly DrawerTabKey[] = ['overview', 'layers', 'schema'];
const INFO_TABS: readonly DrawerTabKey[] = ['overview'];

/** 抽屉 tab 结构按行类型裁剪（spec §四 表格的唯一实现处）。 */
export function drawerTabsFor(kind: TrajectoryRow['kind']): readonly DrawerTabKey[] {
  switch (kind) {
    case 'tool':
    case 'subagent':
      return TOOL_TABS;
    case 'assistant':
      return ASSISTANT_TABS;
    case 'context':
      return CONTEXT_TABS;
    default:
      return INFO_TABS;
  }
}
