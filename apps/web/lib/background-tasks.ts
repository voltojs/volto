import type { ConversationView, ConversationToolCall } from '@volto/sdk/sse';

export interface BackgroundTaskItem {
  id: string;
  childSessionId: string;
  title: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
  startedAt?: number;
}

/**
 * The dispatch's display title. An explicit `title` from the task tool wins —
 * it is what the dispatching model chose to call this job — and only sessions
 * recorded before that field existed fall back to the first line of
 * `args.message`, truncated. Returns '' when neither yields anything.
 */
export function subagentTaskTitle(
  args: Record<string, unknown>,
  explicit?: string,
): string {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  if (typeof args.title === 'string' && args.title.trim() !== '') {
    return args.title.trim();
  }
  const message = args.message;
  if (typeof message !== 'string') return '';
  const firstLine = message.split('\n', 1)[0] ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

/** The sub-agent type a `task` call named, for the UI badge. */
export function subagentTypeOf(args: Record<string, unknown>): string | undefined {
  const type = args.subagent_type;
  return typeof type === 'string' && type !== '' ? type : undefined;
}

function toItem(call: ConversationToolCall): BackgroundTaskItem {
  const status: BackgroundTaskItem['status'] =
    call.result === undefined ? 'running' : call.isError === true ? 'error' : 'done';
  const item: BackgroundTaskItem = {
    id: call.id,
    childSessionId: call.childSessionId!,
    title: subagentTaskTitle(call.args, call.subagentTitle),
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
