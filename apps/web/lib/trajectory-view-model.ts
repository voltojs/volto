/**
 * 轨迹视图的纯展示模型：kind → 中文标签 / 徽章配色、时长格式化、
 * 详情抽屉的 per-kind tab 结构。无 React、无副作用，独立可测。
 */

import type { TrajectoryRow, ContextReminderKind, UserMessageSource } from '@volto/sdk/sse';

/** Catalog key per row kind; components translate it with the `trajectory`
 * namespace. Keeping keys here (not rendered text) lets the label follow the
 * UI language without the projection depending on i18n. */
export const KIND_LABEL_KEYS: Record<TrajectoryRow['kind'], string> = {
  user: 'kind.user',
  context: 'kind.context',
  assistant: 'kind.assistant',
  tool: 'kind.tool',
  subagent: 'kind.subagent',
  compaction: 'kind.compaction',
  error: 'kind.error',
  reminder: 'kind.reminder',
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

/** Catalog key for the non-human producer of a user row. */
export const USER_SOURCE_LABEL_KEYS: Record<UserMessageSource['kind'], string> = {
  'subagent-task': 'source.subagentTask',
  'host-continuation': 'source.hostContinuation',
};

export const REMINDER_KIND_LABEL_KEYS: Record<ContextReminderKind, string> = {
  permission_boundary: 'reminder.permission_boundary',
  self_correction: 'reminder.self_correction',
  loop_reminder: 'reminder.loop_reminder',
  loop_intervention: 'reminder.loop_intervention',
  retrieval: 'reminder.retrieval',
  todo_list: 'reminder.todo_list',
  background_task: 'reminder.background_task',
  workflow_mode: 'reminder.workflow_mode',
};

/** 无耗时返回 null（调用方渲染 EMPTY_CELL）；<1s 用 ms，其余一位小数秒。 */
export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Row location as a catalog key plus its parameters; list and drawer share it. */
export function locationTextRef(row: TrajectoryRow): {
  key: string;
  params: Record<string, number>;
} {
  return row.step !== undefined
    ? { key: 'location.step', params: { turn: row.turn, step: row.step } }
    : { key: 'location.turn', params: { turn: row.turn } };
}

export type DrawerTabKey =
  | 'overview'
  | 'input'
  | 'output'
  | 'schema'
  | 'thinking'
  | 'layers'
  | 'timing';

export const TAB_LABEL_KEYS: Record<DrawerTabKey, string> = {
  overview: 'tab.overview',
  input: 'tab.input',
  output: 'tab.output',
  schema: 'tab.schema',
  thinking: 'tab.thinking',
  layers: 'tab.layers',
  timing: 'tab.timing',
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
