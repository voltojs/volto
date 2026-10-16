/**
 * 轨迹视图的纯展示模型：kind → 中文标签 / 徽章配色、时长格式化、
 * 详情抽屉的 per-kind tab 结构。无 React、无副作用，独立可测。
 */

import type { TrajectoryRow, ContextReminderKind } from '@volto/sdk/sse';

export const EMPTY_CELL = '（无）';

export const KIND_LABELS: Record<TrajectoryRow['kind'], string> = {
  user: '用户',
  context: '上下文',
  assistant: '助手',
  tool: '工具',
  subagent: '子agent',
  compaction: '压缩',
  error: '错误',
  reminder: '提醒',
};

export const KIND_BADGE_CLASS: Record<TrajectoryRow['kind'], string> = {
  user: 'border-border bg-muted text-muted-foreground',
  context: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  assistant: 'border-primary/30 bg-primary/10 text-primary',
  tool: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  subagent: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  compaction: 'border-border bg-muted text-muted-foreground',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  reminder: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};

export const REMINDER_KIND_LABELS: Record<ContextReminderKind, string> = {
  permission_boundary: '权限边界',
  self_correction: '自我纠正',
  loop_reminder: '循环提醒',
  loop_intervention: '循环干预',
  retrieval: '检索片段',
  todo_list: '任务清单',
  background_task: '后台任务',
  workflow_mode: '工作流模式',
};

/** 无耗时返回 null（调用方渲染 EMPTY_CELL）；<1s 用 ms，其余一位小数秒。 */
export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 行的轮次/步骤定位标签；列表行与详情抽屉共用同一实现。 */
export function locationLabel(row: TrajectoryRow): string {
  return row.step !== undefined ? `第${row.turn}轮 · 步骤${row.step}` : `第${row.turn}轮`;
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
const REMINDER_TABS: readonly DrawerTabKey[] = ['overview', 'output'];

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
    case 'reminder':
    case 'compaction':
      return REMINDER_TABS;
    default:
      return INFO_TABS;
  }
}

export interface ParsedSystemLayer {
  id: string;
  text: string;
}

const LAYER_SENTINEL = /^<<<layer id="([^"]+)" bytes="(\d+)">>>$/;

/**
 * Splits the context row's sentinel-framed inputDetail into layers. Returns []
 * for anything that does not match (legacy transcripts keep rendering as one
 * plain block).
 */
export function parseSystemLayers(inputDetail: string): ParsedSystemLayer[] {
  if (inputDetail.length === 0) return [];
  const layers: ParsedSystemLayer[] = [];
  const bytes = new TextEncoder().encode(inputDetail);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < bytes.length) {
    // \n (0x0A) never occurs inside multi-byte UTF-8 sequences, so byte-level
    // line scanning is safe.
    let lineEnd = offset;
    while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0a) lineEnd += 1;
    const line = decoder.decode(bytes.slice(offset, lineEnd));
    const match = LAYER_SENTINEL.exec(line);
    if (match === null) return [];
    const declared = Number(match[2]);
    const contentStart = lineEnd + 1;
    const text = decoder.decode(bytes.slice(contentStart, contentStart + declared));
    const after = contentStart + declared;
    if (after < bytes.length) {
      // Core joins sections with exactly "\n\n" — anything else is malformed.
      if (bytes[after] !== 0x0a || bytes[after + 1] !== 0x0a) return [];
      offset = after + 2;
    } else {
      offset = after;
    }
    layers.push({ id: match[1]!, text });
  }
  return layers;
}
