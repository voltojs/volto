/**
 * Slash-command taxonomy for the input menu. Pure data + pure functions —
 * no React, no fetch. The "系统内置" group is action commands (defined here,
 * intercepted client-side, never sent) plus template commands (fetched from
 * GET /commands); "SKILLS" comes from GET /skills, filtered to userInvocable.
 */

export type InputAction = 'clear-session' | 'compact-session' | 'enter-plan';

export interface ActionCommandItem {
  kind: 'action';
  name: string;
  description: string;
  action: InputAction;
}
export interface TemplateCommandItem {
  kind: 'template';
  name: string;
  description: string;
  hasArgs: boolean;
}
export interface SkillCommandItem {
  kind: 'skill';
  name: string;
  description: string;
}
export type CommandItem = ActionCommandItem | TemplateCommandItem | SkillCommandItem;

/** Executed locally by InputBar on submit; never reaches the server. */
export const ACTION_COMMANDS: readonly ActionCommandItem[] = [
  { kind: 'action', name: 'clear', description: '新建会话', action: 'clear-session' },
  { kind: 'action', name: 'compact', description: '压缩当前会话上下文', action: 'compact-session' },
];

/**
 * `/clear` exact match after trimming the whole input. `/clear now` is NOT an
 * action — it falls through to the server's "Unknown command" reply, which is
 * the contract the panel's menu (listing bare /clear) sets up.
 */
export function matchActionCommand(text: string): ActionCommandItem | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const name = trimmed.slice(1);
  if (name.includes(' ')) return undefined;
  return ACTION_COMMANDS.find((c) => c.name === name);
}

/** `/plan` 前缀动作：启用计划模式，余文作为目标。非 action 的 /plan 落到模板。 */
export function matchPlanCommand(text: string): { goal: string } | undefined {
  const m = /^\/plan(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!m) return undefined;
  return { goal: (m[1] ?? "").trim() };
}

export function filterCommandItems(items: readonly CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
  );
}

export function groupCommandItems(items: readonly CommandItem[]): {
  builtin: CommandItem[];
  skills: CommandItem[];
} {
  return {
    builtin: items.filter((i) => i.kind !== 'skill'),
    skills: items.filter((i) => i.kind === 'skill'),
  };
}
