/**
 * One-line label for a tool call, used by the concise chat density.
 *
 * Kept as an explicit per-tool map rather than a heuristic: the argument that
 * best identifies a call differs per tool (a command for `bash`, a path for
 * `edit_file`), and guessing from key order produces surprises like showing a
 * file's full contents. Unknown tools degrade to their name.
 */

const MAX_LABEL_CODE_POINTS = 80;

function str(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function firstLine(value: string): string {
  return (value.split('\n')[0] ?? '').trim();
}

function clip(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  const points = Array.from(single);
  if (points.length <= MAX_LABEL_CODE_POINTS) return single;
  return `${points.slice(0, MAX_LABEL_CODE_POINTS - 1).join('')}…`;
}

/** Human-facing one-liner for a call; never throws, never empty. */
export function toolCallSummary(
  name: string,
  args: Record<string, unknown>,
  t?: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (name) {
    case 'bash': {
      const command = str(args, 'command');
      return clip(command === undefined ? name : firstLine(command) || name);
    }
    case 'read_file':
    case 'write_file':
    case 'edit_file': {
      const path = str(args, 'path', 'file_path');
      return clip(path ?? name);
    }
    case 'glob': {
      const pattern = str(args, 'pattern');
      return clip(pattern ?? name);
    }
    case 'grep': {
      const pattern = str(args, 'pattern');
      if (pattern === undefined) return name;
      const scope = str(args, 'path');
      return clip(scope === undefined ? pattern : `${pattern} in ${scope}`);
    }
    case 'task': {
      const description = str(args, 'description');
      return clip(description === undefined ? name : firstLine(description) || name);
    }
    case 'todo_write': {
      const todos = args['todos'];
      return Array.isArray(todos)
        ? t?.('tool.todoItems', { count: todos.length }) ?? name
        : name;
    }
    case 'web_fetch': {
      const url = str(args, 'url');
      return clip(url ?? name);
    }
    case 'web_search': {
      const query = str(args, 'query');
      return clip(query ?? name);
    }
    default:
      return name;
  }
}
