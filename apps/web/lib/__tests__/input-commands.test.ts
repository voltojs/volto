import { describe, it, expect } from 'vitest';
import {
  ACTION_COMMANDS,
  matchActionCommand,
  filterCommandItems,
  groupCommandItems,
  type CommandItem,
} from '../input-commands';

const FIXTURES: CommandItem[] = [
  { kind: 'action', name: 'clear', description: '新建会话', action: 'clear-session' },
  { kind: 'template', name: 'plan', description: '制定实施计划，确认后再执行', hasArgs: true },
  { kind: 'template', name: 'review', description: '按严重程度审查代码改动', hasArgs: true },
  { kind: 'skill', name: 'pdf', description: '处理 PDF 文档' },
];

describe('matchActionCommand', () => {
  it('trim 后精确匹配 /clear', () => {
    expect(matchActionCommand('/clear')?.action).toBe('clear-session');
    expect(matchActionCommand('  /clear  ')?.action).toBe('clear-session');
  });
  it('带参数不算（交服务端 Unknown command 兜底）', () => {
    expect(matchActionCommand('/clear now')).toBeUndefined();
  });
  it('非 / 开头与未知命令返回 undefined', () => {
    expect(matchActionCommand('hello')).toBeUndefined();
    expect(matchActionCommand('/nope')).toBeUndefined();
  });
});

describe('filterCommandItems', () => {
  it('空 query 返回全量', () => {
    expect(filterCommandItems(FIXTURES, '')).toHaveLength(4);
  });
  it('name 与 description 大小写不敏感子串匹配', () => {
    expect(filterCommandItems(FIXTURES, 'RE').map((i) => i.name)).toEqual(['review']);
    expect(filterCommandItems(FIXTURES, '会话').map((i) => i.name)).toEqual(['clear']);
    expect(filterCommandItems(FIXTURES, '实施计划').map((i) => i.name)).toEqual(['plan']);
  });
});

describe('groupCommandItems', () => {
  it('action+template 进 builtin，skill 进 skills', () => {
    const { builtin, skills } = groupCommandItems(FIXTURES);
    expect(builtin.map((i) => i.name)).toEqual(['clear', 'plan', 'review']);
    expect(skills.map((i) => i.name)).toEqual(['pdf']);
  });
});

describe('ACTION_COMMANDS', () => {
  it('只含 /clear', () => {
    expect(ACTION_COMMANDS).toEqual([
      { kind: 'action', name: 'clear', description: '新建会话', action: 'clear-session' },
    ]);
  });
});
