import type { ConversationView, ConversationToolCall } from '@volto/sdk/sse';

export interface BackgroundTaskItem {
  id: string;
  childSessionId: string;
  title: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
  startedAt?: number;
}

/** Title = first line of args.message, truncated; empty when not a string. */
export function subagentTaskTitle(args: Record<string, unknown>): string {
  const message = args.message;
  if (typeof message !== 'string') return '';
  const firstLine = message.split('\n', 1)[0] ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

function toItem(call: ConversationToolCall): BackgroundTaskItem {
  const status: BackgroundTaskItem['status'] =
    call.result === undefined ? 'running' : call.isError === true ? 'error' : 'done';
  const item: BackgroundTaskItem = {
    id: call.id,
    childSessionId: call.childSessionId!,
    title: subagentTaskTitle(call.args),
    status,
  };
  if (call.durationMs !== undefined) item.durationMs = call.durationMs;
  if (call.startedAt !== undefined) item.startedAt = call.startedAt;
  return item;
}

export function collectBackgroundTasks(view: ConversationView): BackgroundTaskItem[] {
  const items: BackgroundTaskItem[] = [];
  for (const message of view.messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_call') continue;
      if (block.call.childSessionId === undefined) continue;
      items.push(toItem(block.call));
    }
  }
  return items.sort((a, b) => {
    // Newest first; missing startedAt sinks to the end.
    if (a.startedAt === undefined && b.startedAt === undefined) return 0;
    if (a.startedAt === undefined) return 1;
    if (b.startedAt === undefined) return -1;
    return b.startedAt - a.startedAt;
  });
}
