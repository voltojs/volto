import { describe, it, expect } from 'vitest';
import {
  ACTION_COMMANDS,
  matchActionCommand,
  matchPlanCommand,
  filterCommandItems,
  groupCommandItems,
  type CommandItem,
} from '../input-commands';

const FIXTURES: CommandItem[] = [
  { kind: 'action', name: 'clear', description: '新建会话', action: 'clear-session' },
  { kind: 'action', name: 'compact', description: '压缩当前会话上下文', action: 'compact-session' },
  { kind: 'action', name: 'plan', description: '进入计划模式：只读调研并对齐需求', action: 'enter-plan' },
  { kind: 'template', name: 'review', description: '按严重程度审查代码改动', hasArgs: true },
  { kind: 'skill', name: 'pdf', description: '处理 PDF 文档' },
];

describe('matchActionCommand', () => {
  it('trim 后精确匹配 /clear', () => {
    expect(matchActionCommand('/clear')?.action).toBe('clear-session');
    expect(matchActionCommand('  /clear  ')?.action).toBe('clear-session');
  });
  it('trim 后精确匹配 /compact', () => {
    expect(matchActionCommand('/compact')?.action).toBe('compact-session');
  });
  it('带参数不算（交服务端 Unknown command 兜底）', () => {
    expect(matchActionCommand('/clear now')).toBeUndefined();
    expect(matchActionCommand('/compact now')).toBeUndefined();
  });
  it('非 / 开头与未知命令返回 undefined', () => {
    expect(matchActionCommand('hello')).toBeUndefined();
    expect(matchActionCommand('/nope')).toBeUndefined();
  });
});

describe('matchPlanCommand', () => {
  it("matches /plan with an optional goal", () => {
    expect(matchPlanCommand("/plan")).toEqual({ goal: "" });
    expect(matchPlanCommand("/plan 重构登录")).toEqual({ goal: "重构登录" });
    expect(matchPlanCommand("/plans")).toBeUndefined();
  });
});

describe('filterCommandItems', () => {
  it('空 query 返回全量', () => {
    expect(filterCommandItems(FIXTURES, '')).toHaveLength(5);
  });
  it('name 与 description 大小写不敏感子串匹配', () => {
    expect(filterCommandItems(FIXTURES, 'RE').map((i) => i.name)).toEqual(['review']);
    expect(filterCommandItems(FIXTURES, '会话').map((i) => i.name)).toEqual(['clear', 'compact']);
    expect(filterCommandItems(FIXTURES, '计划模式').map((i) => i.name)).toEqual(['plan']);
    expect(filterCommandItems(FIXTURES, '压缩').map((i) => i.name)).toEqual(['compact']);
  });
});

describe('groupCommandItems', () => {
  it('action+template 进 builtin，skill 进 skills', () => {
    const { builtin, skills } = groupCommandItems(FIXTURES);
    expect(builtin.map((i) => i.name)).toEqual(['clear', 'compact', 'plan', 'review']);
    expect(skills.map((i) => i.name)).toEqual(['pdf']);
  });
});

describe('ACTION_COMMANDS', () => {
  it('含 /plan、/clear 与 /compact', () => {
    // Descriptions are catalog keys here; the slash panel's hook translates
    // them before rendering (see use-slash-command-items).
    expect(ACTION_COMMANDS).toEqual([
      { kind: 'action', name: 'plan', description: 'chat.commands.plan', action: 'enter-plan' },
      { kind: 'action', name: 'clear', description: 'chat.commands.clear', action: 'clear-session' },
      { kind: 'action', name: 'compact', description: 'chat.commands.compact', action: 'compact-session' },
    ]);
  });
});
